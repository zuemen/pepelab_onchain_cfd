# Vault Versions — which implementation is actually live

`contracts/src/v2/` holds three vault implementations. Nothing in the source
says which one the proxy runs, so anyone opening `AssetVaultV2.sol` first will
read a version that carries two fixed bugs and reasonably assume it is what is
deployed. This document is the answer, and it is read from chain rather than
from memory.

## Live on Sepolia

The proxy address never changes across upgrades — that is the point of a proxy.
Only the implementation behind it moves.

| | |
|---|---|
| Proxy (use this address for everything) | `0x3a37415981F6f4fC27FA6c8C62F1d4e47115fD17` |
| Implementation, per EIP-1967 slot | `0xA8a5B0e9C062e0Bb1Ab3a15788Ae823251C41ac1` |
| Which source that is | `src/v2/AssetVaultV2_2.sol` |
| `version()` returns | `2.2.0` |

Verified two independent ways, because `version()` alone is only a string the
contract chooses to return:

```bash
# 1. read the EIP-1967 implementation slot directly
cast storage 0x3a37415981F6f4fC27FA6c8C62F1d4e47115fD17 \
  0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc \
  --rpc-url "$SEPOLIA_RPC_URL"
# -> 0x...a8a5b0e9c062e0bb1ab3a15788ae823251c41ac1

# 2. ask the contract
cast call 0x3a37415981F6f4fC27FA6c8C62F1d4e47115fD17 'version()(string)' \
  --rpc-url "$SEPOLIA_RPC_URL"
# -> "2.2.0"
```

Both point at the same implementation, and `0xA8a5…1ac1` matches the CREATE in
`broadcast/UpgradeVaultToV2_2.s.sol/11155111/run-latest.json`.

## The three sources

| Source | Status | Implementation address |
|---|---|---|
| `AssetVaultV2.sol` | **Historical.** Two known defects. Never delete — the proxy's storage layout is defined by it. | (initial deploy) |
| `AssetVaultV2_1.sol` | **Historical.** Fixed defect 1, still carried defect 2. | `0x35967322A5705354d858c92834bb99DCEd92a65D` |
| `AssetVaultV2_2.sol` | **LIVE** | `0xA8a5B0e9C062e0Bb1Ab3a15788Ae823251C41ac1` |

They are kept as separate files rather than edited in place because a UUPS
proxy's storage layout is a contract with its own history. Each version's layout
was compared field by field against its predecessor with
`forge inspect storage-layout` before upgrading — 12 fields, identical
name/type/slot/offset every time. Rewriting the older files would destroy the
record that the comparison was ever possible.

## What changed, and why it mattered

### V2.0 → V2.1: `outstandingValue()` died against a fail-closed oracle

V2.0 called `getPrice` directly and skipped stale assets with a `continue`. That
assumes an oracle which *returns* stale data — true of MockOracle, false of
GuardedOracle, which reverts. Against a reverting oracle the loop died, taking
`reserveRatioBps()` and therefore `mint()` with it: **one stale asset blocked
minting every other asset**, and V2 stopped working until a keeper posted again.

V2.1 wraps the call in `try/catch` and adds `outstandingValueDetailed()` and
`ratioIsStale()`, because a skipped asset understates the liability and makes
the ratio optimistic — callers need to tell "ratio unknown" from "ratio
healthy".

Pinned by `test_baseline_v2BreaksWhenAPriceGoesStale` and
`test_staleAssetNoLongerBlocksMintingAnother` in
`test/v2/AssetVaultV2_1Upgrade.t.sol`, which run the same scenario against both
implementations so the fix is measured rather than asserted.

### V2.1 → V2.2: redeem fees were credited without USDC behind them

`redeem()` guarded on `reserve() >= usdcOut` — the *net* payout — then credited
the full fee on top. Any redeem in the window `usdcOut <= reserve < gross`
booked operator revenue against money that was not there.

Worse than untidy accounting: once `accruedFees` passes the balance, `reserve()`
clamps to 0 and **every later redeem reverts `VaultDry` on USDC the vault
demonstrably holds** — holders frozen out by an artefact.

V2.2 credits only the portion the vault can back. The alternative — requiring
`reserve >= gross` — would refuse the exit outright instead, and charging the
operator less is the right side to err on: blocking exits under stress is the
bank run, not a defence against it. The redeemer still receives their full
`usdcOut`.

Found by `invariant_reserveNeverCountsAccruedFees` in CI, on a fuzz seed the
local run had not hit. Reproduced deterministically in
`test/v2/AssetVaultFeeBacking.t.sol` by deriving the window from the code rather
than re-rolling the fuzzer.

## Notes for whoever works on this next

- **Address to use everywhere is the proxy.** Implementation addresses appear
  here only so the deployed bytecode can be traced back to a source file.
- **The invariant suite runs against `AssetVaultV2_2`**, so CI validates what is
  actually deployed rather than the oldest source in the directory.
- **Do not run the full suite with `--no-match-contract Invariant`.** The V2.2
  defect was found by exactly the tests that flag skips, and skipping them is
  how it reached a deployment in the first place.
- **A future V2.3 should be another new file**, layout-compared before
  upgrading, and this table updated. The proxy address stays put.

## GuardedOracle 偏離上限對稱化(2026-08-06)

`_deviationExceeded` 改以舊價為分母,上下方向容許幅度一致。舊版以「兩者中較小值」
為分母,結果 +10% 可過而 −10% 被拒(實際只容許 −9.09%)。方向是反的:崩盤時最
需要價格跟上、最需要清算啟動,而那正是舊公式最容易擋下更新的時候。

**線上實例尚未套用。** `0x32A19D04…49A1`(Sepolia)是已部署的不可升級合約,
換用新版需要重新部署並以 `AssetVaultV2.setOracle` 遷移。在遷移之前,keeper 的
`stepTowards`(`agent/keeper/core.ts`)刻意複製了**舊合約**的不對稱公式,所以
它送出的每一步都能被線上實例接受 —— `keeper/core.test.ts` 的
`deviationAccepted` 就是那份舊公式的複本。遷移時必須同步更新這兩處,否則 keeper
會低估可用步幅(功能上安全,只是收斂較慢)。
