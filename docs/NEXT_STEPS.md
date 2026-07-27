# Next Steps — Handover Reference

Everything a fresh session needs to finish the security work started 2026-07-27.
Written so an agent with no prior context can pick it up. Addresses are real and
verified on chain; procedures are the ones actually used, not idealised versions.

---

## State as of 2026-07-27 (commit `0a3af5b`)

### Deployed — Sepolia (chainId 11155111)

| Contract | Address |
|---|---|
| GuardedOracle | `0x32A19D04ef2ca5A7DA02Df39419729fA745749A1` |
| AssetVaultV2 (UUPS proxy) | `0x3a37415981F6f4fC27FA6c8C62F1d4e47115fD17` |
| AssetVault (V1) | `0xB4D10cBC6143E410dd7b48797334C4397b99325f` |
| PepeIncentives | `0x65b9F1B4d18822d4faBa763621E3e4eA065aE5D7` |
| PepeStaking | `0xf5d0953A443259ebdFC62fE49189998988e309f9` |
| MockUSDC | `0x167Bacef1925184f0df34A3196F834C0622Cfd36` |
| MockUSDT | `0xA08C0F92804173Bf796FDa3FA66654F96aDDB5F1` |
| PerpetualExchange | `0x0c6459d38617E60017bDc4ed69ec26137DA5c32b` |
| PepeToken | `0xa364F43627A17BE5bfbcb32693f3eD7E44ebe1D9` |

### Role holders (granted and verified 2026-07-27)

| Role | Contract | Address | Key in `.env.roles` |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` | both | `0x2a588AeA3271B159c9188d95E0d10614711f83e3` | `ADMIN_PK` |
| `KEEPER_ROLE` | GuardedOracle | `0x540aECD37E7A7885824e7b7e996eBddfb842ef17` | `KEEPER_PK` |
| `GUARDIAN_ROLE` | GuardedOracle | `0x9913f5D63817B1b98a2c07713d4516CC3b33A4e4` | `GUARDIAN_PK` |
| `PAUSER_ROLE` | AssetVaultV2 | `0x9913f5D63817B1b98a2c07713d4516CC3b33A4e4` | `GUARDIAN_PK` |
| `RISK_ROLE` | AssetVaultV2 | `0xECe96A5EC46e20E0F9A441c9D787E89CE366B165` | `RISK_PK` |

Deployer `0xE80A81360608C1342e66743F70a00f75d792Eb93` **still holds every role** —
revocation is step 4 below and is deliberately last.

`contracts/.env.roles` holds the private keys. Gitignored, verified with
`git check-ignore`. Never commit it, never paste its contents anywhere.

### Burned keys — do not use

Two keypairs were generated in a chat window on 2026-07-27, which put their
private keys in a conversation log. They hold nothing and were never granted a
role. Listed here so nobody revives them by mistake:

```
0xD0fad9BB24AB2c1830cEad15a1E5E83876c00AEe
0xeD505031EE5Da24aed2281c7d33ca4B260fa4EDa
```

---

## Remaining work, in order

Steps 1–3 gate step 4. Doing 4 first breaks the price feed and cannot be undone.

> **Done 2026-07-27, and it exposed two live bugs — read this before step 3.**
>
> The secret now holds `KEEPER_PK`. Two things surfaced the moment it did:
>
> **The keeper key cannot write MockOracle.** `MockOracle.updatePrice` is
> `onlyOwner` and the owner is still the deployer `0xE80A…Eb93`. So the first
> workflow step now fails for every asset while the GuardedOracle sync (which
> uses `KEEPER_ROLE`) works. **Unresolved — see "MockOracle ownership" below.**
>
> **The stooq stock feed is dead and was silently corrupting prices.** It serves
> an HTML 404 page. The old guard only rejected empty / `N/D` / `0`, so the HTML
> passed, `awk` coerced it to `0`, and `0` is below the lower clamp — meaning
> every run rewrote each stock price to **55% of its previous value**,
> compounding every 15 minutes. Confirmed in the live log:
> `sAAPL 3329784553 -> 1831381504`, exactly 55%.
>
> Only the missing write permission stopped that reaching the oracle. Both the
> validation and the silent-success behaviour are fixed; the feed itself is
> still dead, so stock prices are now skipped rather than fabricated.

### 1. Move the keeper key into GitHub Actions — human, 2 minutes

The scheduled keeper (`.github/workflows/price-keeper.yml`, every 15 min) still
signs with the deployer key. It needs the separated keeper key instead.

1. Read `KEEPER_PK` from `contracts/.env.roles`
2. GitHub → repo Settings → Secrets and variables → Actions
3. Update `KEEPER_PRIVATE_KEY` to that value
4. Actions tab → "Oracle Price Keeper (Sepolia)" → Run workflow
5. Confirm the run is green and a price actually moved:

```bash
cast call 0x32A19D04ef2ca5A7DA02Df39419729fA745749A1 \
  'getPrice(bytes32)(uint256,uint256)' $(cast keccak "sBTC") \
  --rpc-url "$SEPOLIA_RPC_URL"
```

The second return value is `updatedAt`. It must be newer than before the run.
If `getPrice` reverts, the price is stale — the keeper did not post.

### 2. Build a Safe 2-of-3 — human, 5 minutes, needs two teammate addresses

This is the one item nothing else can substitute for. The current admin is a
single EOA. It is better than the deployer (which also holds funds and every
other role) but it is still one key, and a compromised admin can widen the
deviation cap, repoint the oracle, or upgrade the vault. The cap bounds a
compromised keeper; nothing bounds a compromised admin.

1. Collect a Sepolia address from each teammate (廷翊, 偉翔)
2. app.safe.global → connect wallet → switch to **Sepolia**
3. Create new Safe → owners = the three of you → threshold = **2**
4. Deploy (free on testnet) and note the Safe address
5. Test it: propose any transaction, confirm it needs two signatures

A multisig with one signer is not a multisig. Until this exists, `ROLE_SEPARATION.md`
and `KNOWN_LIMITATIONS.md` #13 describe the admin as an interim EOA rather than
counting it as done. Keep it that way if this step slips.

### 3. Hand admin to the Safe — agent-runnable once the Safe exists

```bash
cd contracts
set -a && source .env && source .env.roles && set +a

export GUARDED_ORACLE=0x32A19D04ef2ca5A7DA02Df39419729fA745749A1
export ASSET_VAULT=0x3a37415981F6f4fC27FA6c8C62F1d4e47115fD17
export NEW_ADMIN=<SAFE_ADDRESS>
export HANDOVER_DRY_RUN=false
export REVOKE_DEPLOYER=false

forge script script/HandoverRoles.s.sol \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast
```

Verify, then revoke the interim EOA — in that order, never the reverse:

```bash
cast call 0x32A19D04ef2ca5A7DA02Df39419729fA745749A1 \
  'hasRole(bytes32,address)(bool)' \
  0x0000000000000000000000000000000000000000000000000000000000000000 \
  <SAFE_ADDRESS> --rpc-url "$SEPOLIA_RPC_URL"
```

Must return `true` before running either revoke:

```bash
cast send 0x32A19D04ef2ca5A7DA02Df39419729fA745749A1 \
  'revokeRole(bytes32,address)' \
  0x0000000000000000000000000000000000000000000000000000000000000000 \
  0x2a588AeA3271B159c9188d95E0d10614711f83e3 \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$ADMIN_PK"
```

```bash
cast send 0x3a37415981F6f4fC27FA6c8C62F1d4e47115fD17 \
  'revokeRole(bytes32,address)' \
  0x0000000000000000000000000000000000000000000000000000000000000000 \
  0x2a588AeA3271B159c9188d95E0d10614711f83e3 \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$ADMIN_PK"
```

### 4. Revoke the deployer — irreversible, only after 1–3

```bash
cd contracts
set -a && source .env && source .env.roles && set +a
export GUARDED_ORACLE=0x32A19D04ef2ca5A7DA02Df39419729fA745749A1
export ASSET_VAULT=0x3a37415981F6f4fC27FA6c8C62F1d4e47115fD17
export NEW_ADMIN=<SAFE_ADDRESS>
export HANDOVER_DRY_RUN=false
export REVOKE_DEPLOYER=true

forge script script/HandoverRoles.s.sol \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast
```

The script re-reads `hasRole` for the replacement admin and reverts
`WouldLeaveNoAdmin` rather than proceeding if it is missing. That check is the
only thing standing between a typo and a permanently frozen contract:
AccessControl has no recovery from zero admins — no role can ever be granted
again, risk parameters freeze, and the proxy can never be upgraded.

Confirm afterwards (expect `false`):

```bash
cast call 0x32A19D04ef2ca5A7DA02Df39419729fA745749A1 \
  'hasRole(bytes32,address)(bool)' \
  0x0000000000000000000000000000000000000000000000000000000000000000 \
  0xE80A81360608C1342e66743F70a00f75d792Eb93 \
  --rpc-url "$SEPOLIA_RPC_URL"
```

Then update `ROLE_SEPARATION.md` and `KNOWN_LIMITATIONS.md` #13 — the "still
open" paragraphs describe a state that will no longer be true.

---

## Smaller open items

~~**`MockSwapRouter` has no test file.**~~ **Done** (`4d9b7cb`) —
`contracts/test/MockSwapRouter.t.sol`, 19 tests. Every contract in `src/` now
has one. Two asymmetries pinned while writing it: the ETH→USDC leg mints rather
than paying from a reserve so it can never run dry, while USDC→ETH pays from the
router's own balance and can be drained to zero; and `ethOut` is integer
division by `RATE`, so under 3000 wei of USDC rounds to zero ETH while the USDC
burns anyway.

**MockOracle ownership — a decision, not a task.** The keeper key now signs the
workflow but `MockOracle.updatePrice` is `onlyOwner`, owner = deployer, so V1
and PerpetualExchange prices have stopped updating. Two ways out, and the
tradeoff is real enough that it should be chosen deliberately:

- **Transfer MockOracle ownership to the keeper.** One key, correct privileges,
  one more thing off the deployer. But MockOracle has **no deviation cap** —
  unlike GuardedOracle, whoever owns it can set any price instantly, and
  PerpetualExchange prices off it with an `immutable` oracle address. That puts
  unbounded price power in a key that is necessarily hot (CI, every 15 min).
- **Give the MockOracle step its own secret** holding the owner key, and leave
  `KEEPER_PRIVATE_KEY` for the GuardedOracle sync. Keeps unbounded power in a
  colder key, at the cost of the deployer key still appearing in CI — which is
  where it already was before this change, so not a regression.

Deliberately not chosen here. The second is the smaller change and the safer
default; the first is tidier and worse.

**Stock price feed is dead.** stooq serves HTML 404s on every URL variant tried
(`stooq.com` and `stooq.pl`, with and without the `f=`/`h` params). sBTC and
sETH still work — those come from Coinbase/Binance via `fetchCryptoPrices`.
Stock and commodity assets are skipped rather than fabricated until a feed is
picked. `scripts/priceKeeper.ts` has a working pattern to copy.

**Frontend `any` escapes: 19 remaining** (down from 42). Mostly ethers return
values. `KNOWN_LIMITATIONS.md` #12 has the detail.

**Not in this workstream** — K-line chart (TradingView `lightweight-charts`) and
the tadpole → frog → frog-king progression are owned by another team member.

---

## Verification commands

Role check, any role/holder pair:

```bash
cast call <CONTRACT> 'hasRole(bytes32,address)(bool)' <ROLE_HASH> <ADDRESS> \
  --rpc-url "$SEPOLIA_RPC_URL"
```

Role hashes: `DEFAULT_ADMIN_ROLE` is 32 zero bytes; the rest are
`cast keccak "KEEPER_ROLE"` and so on for `GUARDIAN_ROLE`, `RISK_ROLE`,
`PAUSER_ROLE`.

Oracle price, and why it might revert:

```bash
cast call 0x32A19D04ef2ca5A7DA02Df39419729fA745749A1 \
  'getPrice(bytes32)(uint256,uint256)' $(cast keccak "sBTC") \
  --rpc-url "$SEPOLIA_RPC_URL"
```

`getPrice` reverts on staleness or freeze. `peek(bytes32)` returns
`(price, updatedAt, exists, frozen)` and never reverts — use it to see *why*
`getPrice` failed rather than guessing.

Vault paused state:

```bash
cast call 0x3a37415981F6f4fC27FA6c8C62F1d4e47115fD17 'paused()(bool)' \
  --rpc-url "$SEPOLIA_RPC_URL"
```

---

## Related documents

- `docs/VAULT_VERSIONS.md` — which of the three vault sources is actually live,
  read from the EIP-1967 slot, and what changed between them
- `docs/ROLE_SEPARATION.md` — what was done, with the on-chain verification log
- `docs/KNOWN_LIMITATIONS.md` — all 13 limitations with current status
- `docs/audit/ADERYN_TRIAGE.md` — Aderyn findings, each triaged with reasoning
- `docs/audit/aderyn-v2-report.md` — raw Aderyn output
- `docs/KEY_MANAGEMENT.md` — key handling procedure
- `contracts/script/HandoverRoles.s.sol` — the handover script itself
