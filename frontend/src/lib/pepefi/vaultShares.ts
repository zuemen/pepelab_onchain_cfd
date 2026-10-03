// InsuranceVault share (pIV) math for display.
//
// P1-05: the redeployed InsuranceVault prices shares with virtual shares and a
// virtual asset (OZ ERC-4626 decimals-offset construction) and its shares carry
// `asset decimals + offset` decimals — 24 on the 18-decimal MockUSDC. The vault
// that is deployed today still uses 18-decimal shares and the plain
// `amount × supply / assets` formula.
//
// The page talks to whichever vault addresses.ts points at, so share decimals
// are read from the vault's own `decimals()` (both versions expose it) and the
// offset is derived from it. Nothing here may assume 18.

import { formatUnits } from 'ethers'

/** Share decimals of the vault deployed before P1-05 (and the read fallback). */
export const LEGACY_SHARE_DECIMALS = 18

/** Decimals of the vault's asset (MockUSDC). */
export const VAULT_ASSET_DECIMALS = 18

/**
 * log10 of the virtual share count, derived from the vault's share decimals.
 * 0 means the legacy vault (no virtual shares).
 */
export function shareDecimalsOffset(shareDecimals: number, assetDecimals = VAULT_ASSET_DECIMALS): number {
  const off = shareDecimals - assetDecimals
  return off > 0 ? off : 0
}

/**
 * Shares a deposit of `amount` asset units would mint — mirrors
 * `previewDeposit` of either vault version (rounded down, as on chain).
 */
export function estimateDepositShares(
  amount: bigint,
  totalSupply: bigint,
  totalAssets: bigint,
  shareDecimals: number,
  assetDecimals = VAULT_ASSET_DECIMALS,
): bigint {
  if (amount <= 0n) return 0n
  const off = shareDecimalsOffset(shareDecimals, assetDecimals)
  if (off === 0) {
    // Legacy vault: 1:1 on an empty vault, proportional afterwards.
    if (totalSupply === 0n) return amount
    if (totalAssets === 0n) return 0n // the contract reverts (VaultInsolvent)
    return (amount * totalSupply) / totalAssets
  }
  if (totalSupply > 0n && totalAssets === 0n) return 0n // VaultInsolvent
  return (amount * (totalSupply + 10n ** BigInt(off))) / (totalAssets + 1n)
}

/**
 * Asset units `shares` would redeem — mirrors `previewWithdraw` of either
 * vault version (rounded down, as on chain).
 */
export function estimateWithdrawAssets(
  shares: bigint,
  totalSupply: bigint,
  totalAssets: bigint,
  shareDecimals: number,
  assetDecimals = VAULT_ASSET_DECIMALS,
): bigint {
  if (shares <= 0n || totalSupply === 0n) return 0n
  const off = shareDecimalsOffset(shareDecimals, assetDecimals)
  if (off === 0) return (shares * totalAssets) / totalSupply
  return (shares * (totalAssets + 1n)) / (totalSupply + 10n ** BigInt(off))
}

/**
 * Asset units ONE WHOLE pIV (10^shareDecimals units) redeems right now —
 * `previewWithdraw(10^decimals())` semantics, i.e. what the contract would
 * actually pay. Use this for the displayed share price instead of
 * `getSharePrice()`, which divides the real totals and ignores the virtual
 * shares: after inflows that arrived while the supply was 0 it can overstate
 * a holder's redeemable value by orders of magnitude. 1.0 when nothing is
 * outstanding (same as `getSharePrice()`).
 */
export function redeemablePerWholeShare(
  totalSupply: bigint,
  totalAssets: bigint,
  shareDecimals: number,
  assetDecimals = VAULT_ASSET_DECIMALS,
): bigint {
  if (totalSupply === 0n) return 10n ** BigInt(assetDecimals)
  return estimateWithdrawAssets(10n ** BigInt(shareDecimals), totalSupply, totalAssets, shareDecimals, assetDecimals)
}

/** Format a share amount with the vault's own decimals. */
export function formatShares(v: bigint, shareDecimals: number, digits = 2): string {
  return Number(formatUnits(v, shareDecimals)).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}
