# AssetVault Risk Model

Audience: the risk function of an institution deploying this engine.

## What this contract is

A mint-burn vault. Users pay USDC and receive an ERC-20 tracking an oracle
price; they burn it to get USDC back at the then-current price. There is no
curve and no slippage.

## What it is not

**It is not fully collateralized, and V2 does not make it so.**

The vault is the counterparty to every long. It holds the USDC paid in, but its
liability is marked at the current price. If prices rise, the liability exceeds
what was paid in and the difference comes from operator-supplied collateral.
This is a property of the design, not a defect to be patched.

Anyone describing this engine as "fully backed", "risk-free", or "1:1 redeemable
in all conditions" is describing something else.

The behaviour is not theoretical — it is pinned by tests:

| Test | Shows |
|---|---|
| `AssetVaultSolvency.t.sol::test_priceRiseDrainsOwnerReserve` | V1: a doubling market takes the reserve to zero |
| `AssetVaultSolvency.t.sol::test_laterRedeemerCannotExitAfterDrain` | V1: first-out wins, last-out is stranded |
| `AssetVaultSolvency.t.sol::test_mintAcceptsArbitrarilyStalePrice` | V1: a year-old price is accepted |
| `AssetVaultV2Parity.t.sol::test_v2StopsTheDrainV1Allowed` | V2: the same move is refused, holder can still exit |

## Residual risk the operator carries

| Risk | Mechanism | Control |
|---|---|---|
| Directional exposure | Vault is short every long | `assetCap` per asset; `mintFeeBps`/`redeemFeeBps` price it |
| Reserve depletion | Rising market inflates liability | `minReserveRatioBps` blocks new mints before depletion; V2.3 `observeReserve()` also latches `mintingHalted` when a price move alone crosses the line, with nobody minting |
| Redemption failure | Reserve below what a redeemer is owed | `VaultDry` revert; operator/keeper calls `observeReserve()` to keep a replayable series of `reserveRatioBps()` |
| Stale oracle | Trading against a frozen quote | `maxPriceAge`; `_price` reverts `StalePrice` |
| Oracle compromise | Single key sets prices | **NOT MITIGATED HERE.** See below |
| Operator key compromise | Admin can upgrade the vault | Role separation; use a timelock + multisig |

## The controls, precisely

- **`mintFeeBps` / `redeemFeeBps`** — taken in USDC, accrue to `accruedFees`,
  excluded from `reserve()`. Capped at 1000 bps (10%) in `setRiskParams` so a
  compromised `RISK_ROLE` key cannot confiscate deposits. Fees compensate the
  operator for carrying directional risk; they do not eliminate it.
- **`assetCap[assetId]`** — maximum token units outstanding per asset. Checked
  before state changes. `0` closes an asset to new mints while leaving
  redemptions open — the correct way to wind an asset down without trapping
  existing holders (`test_capOfZeroStillAllowsRedeem`).
- **`minReserveRatioBps`** — `reserve() * 10000 / outstandingValue()`. A mint
  reverts `ReserveRatioTooLow` if it would leave coverage below this. Default
  11000 (110%). **Redemptions are never ratio-gated** — blocking exits during
  stress is the bank run, not a defence against it. `setRiskParams` (V2.3)
  rejects anything below `10000` (100%): `ratioBps` is unsigned and never
  negative, so a floor of `0` would make `ratioBps < minBps` impossible to
  ever satisfy, silently disabling both this check and `observeReserve()`'s
  breach latch below with no distinguishing event.
- **`maxPriceAge`** — default 1 hour. Must exceed the keeper's update interval
  with headroom, or normal operation will revert. The Sepolia keeper runs every
  15 minutes.
- **`pause()`** — halts mint and redeem. Held by `PAUSER_ROLE`.
- **`observeReserve()`** (V2.3) — permissionless. Snapshots `reserve()`,
  `outstandingValue()`, `reserveRatioBps()` and the unpriced-asset count into a
  `ReserveObserved` event, so the ratio becomes a replayable time series instead
  of a spot read. If the snapshot is below `minReserveRatioBps` it latches
  `mintingHalted = true` and emits `ReserveBreached` **on the crossing only**
  (not on every later observation while still below the line) — this is the
  answer to a market move alone pushing the book under water with nobody
  minting: `mint()`'s own ratio check only fires when someone happens to mint,
  so existing holders previously got no signal at all. A later fully-priced
  observation at or above the line clears the halt and emits `ReserveRestored`.
  **Redemption is not gated by `mintingHalted`** — only `mint()` checks it — so
  this control cannot become the bank run it exists to warn about. A halt that
  was latched from a stale (`unpriced > 0`) snapshot can never be cleared by
  another stale one: staleness only ever costs new mints, never a holder's
  protection.
- **`clearMintingHalt()`** (V2.3, `RISK_ROLE`) — manual override for the case
  the automatic path above cannot reach on its own: a single asset whose price
  feed is permanently gone (not just temporarily stale) holds `unpriced > 0`
  forever, and since `unregisterAsset` refuses while that asset still has
  nonzero outstanding, nothing short of an operator decision can restore
  minting for every *other*, healthy asset. Emits `MintingHaltCleared`, kept
  distinct from `ReserveRestored` so a manual override never reads as an
  automatic, fully-priced recovery in the replayed history.

## Known limitation: `outstandingValue()` and stale prices

`outstandingValue()` **skips** assets whose price is stale or zero instead of
reverting, so risk dashboards remain readable during an oracle outage. This
understates the liability, which means `reserveRatioBps()` is optimistic while
any asset is stale. Treat a stale oracle as *ratio unknown*, not as *ratio
healthy*. `mint` independently calls `_price` and reverts on staleness, so no
mint can be admitted on the strength of an optimistic ratio.

`ratioIsStale()` reports this (`unpriced > 0`); before V2.3 nothing consumed it
on-chain. `reserveStatus()` now returns the ratio and its `stale` flag together
in one call, and `observeReserve()`'s `ReserveObserved.unpriced` field carries
the same signal into the event history — a replayed series can distinguish a
genuinely healthy point from an optimistic one instead of averaging them
together.

## Upgrade authority

`AssetVaultV2` is a UUPS proxy. `DEFAULT_ADMIN_ROLE` can replace the
implementation and therefore can change any rule in this document. Treat that
key as equivalent to custody of the reserve.

`SyntheticAssetV2` is deliberately **not** upgradeable — holder balances live in
a plain ERC-20. The vault's authority over it is a revocable `MINTER_ROLE`, so
the vault can be replaced without redeploying tokens or touching balances
(`test_vaultCanBeRotatedWithoutRedeploy`). V1's `SyntheticAsset` hardcoded the
vault as `immutable` and did not have this property.

## Not addressed by this contract

- **Oracle decentralization.** `MockOracle.updatePrice` is `onlyOwner`. A single
  compromised key can set any price and drain the vault. Production deployments
  must point at a decentralized feed. Chainlink/Pyth adapters exist and are
  queryable, but are not wired into the exchange — `PerpetualExchange.oracle` is
  `immutable`, so switching requires a redeploy.
- **Mock stablecoins.** `MockUSDC.mint` and `MockUSDT.mint` are unrestricted by
  design for testnet. Never deploy them to a network carrying value.
- **Third-party audit.** None of the contracts has been audited.
- **Regulatory status.** Six of the eleven assets reference real securities
  (sAAPL, sTSLA, sNVDA, sMSFT, sGOOGL, sBOND). Offering them is the licensee's
  regulatory responsibility, in its own jurisdiction, under its own licence.
  This engine takes no position on that and provides no compliance guarantee.

## Pre-deployment checklist for a licensee

- [ ] Third-party audit completed, findings resolved
- [ ] Oracle is a decentralized feed, not a single key
- [ ] Real USDC, not `MockUSDC`
- [ ] `DEFAULT_ADMIN_ROLE` held by a multisig behind a timelock
- [ ] `RISK_ROLE` and `PAUSER_ROLE` on separate keys from admin
- [ ] `assetCap` set for every asset per the risk committee's limits
      (caps ship at 0 — every asset is closed until this is done)
- [ ] `maxPriceAge` exceeds the production keeper interval
- [ ] Monitoring alerts on `reserveRatioBps()` and oracle age
- [ ] Runbook for `pause()` and for winding an asset down via `assetCap = 0`
- [ ] Keeper configured with `KEEPER_VAULT_ADDRESS` (V2.3+) so `observeReserve()`
      runs on a schedule — without it, `mintingHalted` has no automatic caller
      to clear it once a breach recovers (see `agent/.env.example`)
- [ ] Runbook for `clearMintingHalt()` — when it is and isn't appropriate to
      use, and who holds `RISK_ROLE`
