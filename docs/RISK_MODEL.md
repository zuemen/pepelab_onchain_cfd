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
| Reserve depletion | Rising market inflates liability | `minReserveRatioBps` blocks new mints before depletion |
| Redemption failure | Reserve below what a redeemer is owed | `VaultDry` revert; operator monitors `reserveRatioBps()` |
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
  stress is the bank run, not a defence against it.
- **`maxPriceAge`** — default 1 hour. Must exceed the keeper's update interval
  with headroom, or normal operation will revert. The Sepolia keeper runs every
  15 minutes.
- **`pause()`** — halts mint and redeem. Held by `PAUSER_ROLE`.

## Known limitation: `outstandingValue()` and stale prices

`outstandingValue()` **skips** assets whose price is stale or zero instead of
reverting, so risk dashboards remain readable during an oracle outage. This
understates the liability, which means `reserveRatioBps()` is optimistic while
any asset is stale. Treat a stale oracle as *ratio unknown*, not as *ratio
healthy*. `mint` independently calls `_price` and reverts on staleness, so no
mint can be admitted on the strength of an optimistic ratio.

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
