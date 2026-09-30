# Vault Versions — which implementation is actually live

`contracts/src/v2/` holds five vault implementations (V2.0 – V2.4). Nothing in
the source says which one a proxy runs, so anyone opening `AssetVaultV2.sol` first
will read a version that carries two fixed bugs and reasonably assume it is what
is deployed. This document is the answer, and it is read from chain rather than
from memory.

> **2026-09-30 update:** Base Sepolia (84532) — the primary chain — runs its own
> proxy on **V2.4 (`2.4.0`)**; see "Live on Base Sepolia" below. The Sepolia proxy
> is still on V2.2. The two chains are separate deployments, not upgrades of one
> proxy.

## Live on Base Sepolia

| | |
|---|---|
| Proxy (use this address for everything) | `0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a` |
| Implementation, per EIP-1967 slot | `0xA2D967221da278b26E0432F4A6BD231D7e0a3733` |
| Which source that is | `src/v2/AssetVaultV2_4.sol` |
| `version()` returns | `2.4.0` |
| Oracle | GuardedOracle `0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842` |
| Carbon registry (`esgRegistry()`) | ESGRegistryV2 `0xBF5B9cD78566791d79c687A732b4ed5bc3E95dFf` |

Read on 2026-09-30 from the EIP-1967 slot and `version()` (same two methods as
below, with the Base Sepolia RPC). The implementation matches the
`AssetVaultV2_4` CREATE in
`broadcast/DeployHardenedVault129.s.sol/84532/run-latest.json`; the proxy was
deployed directly on V2.4 by that script (#129), not upgraded from an earlier
version.

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

## The sources

| Source | Status | Implementation address |
|---|---|---|
| `AssetVaultV2.sol` | **Historical.** Two known defects. Never delete — the proxy's storage layout is defined by it. | (initial deploy) |
| `AssetVaultV2_1.sol` | **Historical.** Fixed defect 1, still carried defect 2. | `0x35967322A5705354d858c92834bb99DCEd92a65D` (Sepolia) |
| `AssetVaultV2_2.sol` | **LIVE on Sepolia** | `0xA8a5B0e9C062e0Bb1Ab3a15788Ae823251C41ac1` (Sepolia) |
| `AssetVaultV2_3.sol` | **Not deployed as a live implementation** (not found in any broadcast on 2026-09-30). Adds observability: `observeReserve()` emits `ReserveObserved`, a reserve-ratio breach latches `mintingHalted`, `reserveStatus()` pairs the ratio with whether it can be trusted. | — |
| `AssetVaultV2_4.sol` | **LIVE on Base Sepolia** (`2.4.0`). Everything in V2.3, plus the mint fee derived per asset from the witnessed carbon tier (`ESGRegistryV2.medianCarbonTier`, ADR-005/006); redeem stays a flat settable fee. Storage layout identical to V2.3 except `_esgRegistry` taken from `__gap`. | `0xA2D967221da278b26E0432F4A6BD231D7e0a3733` (Base Sepolia) |

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
  deployed on Sepolia rather than the oldest source in the directory.
  *2026-09-30:* `test/v2/AssetVaultV2Invariant.t.sol` still targets V2.2 only;
  V2.4 (live on Base) is covered by `test/v2/AssetVaultV2_4Upgrade.t.sol` and
  `test/CarbonPricing.t.sol`, not by the invariant suite.
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
`deviationAccepted`(`agent/keeper/core.ts`)刻意複製了**舊合約**的不對稱公式,
用來在送出前判斷完整價格會不會被拒。(2026-09-29 起 keeper 不再用 `stepTowards`
分段逼近:被拒就記為 failed、由人處置,見 `RUNBOOK_KEEPER.md`「價格熔斷」。)
遷移時必須同步更新 `deviationAccepted`,否則 keeper 會把可接受的價格誤判為會被拒。
