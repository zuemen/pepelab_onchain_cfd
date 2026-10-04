import { describe, it, expect } from 'vitest'

import {
  LEGACY_SHARE_DECIMALS,
  shareDecimalsOffset,
  estimateDepositShares,
  estimateWithdrawAssets,
  formatShares,
  redeemablePerWholeShare,
} from './vaultShares'

const E = (n: number | bigint) => BigInt(n) * 10n ** 18n
const NEW_DEC = 24 // 18-decimal MockUSDC + DECIMALS_OFFSET 6

describe('shareDecimalsOffset', () => {
  it('is 0 for the legacy 18-decimal vault and 6 for the virtual-share vault', () => {
    expect(shareDecimalsOffset(LEGACY_SHARE_DECIMALS)).toBe(0)
    expect(shareDecimalsOffset(NEW_DEC)).toBe(6)
    expect(shareDecimalsOffset(12, 6)).toBe(6) // 6-decimal USDC
  })
})

describe('estimateDepositShares', () => {
  it('legacy vault: 1:1 when empty, proportional afterwards', () => {
    expect(estimateDepositShares(E(1000), 0n, 0n, 18)).toBe(E(1000))
    expect(estimateDepositShares(E(1500), E(1000), E(1500), 18)).toBe(E(1000))
    expect(estimateDepositShares(E(1), E(1), 0n, 18)).toBe(0n)
  })

  it('virtual-share vault: one whole USDC buys one whole pIV on an empty vault', () => {
    const s = estimateDepositShares(E(1000), 0n, 0n, NEW_DEC)
    expect(s).toBe(1000n * 10n ** 24n)
    expect(formatShares(s, NEW_DEC)).toBe(formatShares(E(1000), 18))
  })

  it('virtual-share vault: mirrors amount × (supply + 1e6) / (assets + 1), floored', () => {
    const supply = 1000n * 10n ** 24n
    const assets = E(1500)
    expect(estimateDepositShares(E(1500), supply, assets, NEW_DEC)).toBe(
      (E(1500) * (supply + 1_000_000n)) / (assets + 1n),
    )
  })

  it('returns 0 where the contract would revert (insolvent) or for a non-positive amount', () => {
    expect(estimateDepositShares(E(1), 10n ** 24n, 0n, NEW_DEC)).toBe(0n)
    expect(estimateDepositShares(0n, 0n, 0n, NEW_DEC)).toBe(0n)
  })
})

describe('redeemable value after inflows that arrived while the supply was 0', () => {
  // 1,000 USDC reached an empty virtual-share vault (no holders), then an LP
  // deposited 1 USDC. The plain ratio shares × totalAssets / totalSupply says
  // the LP owns ~1,001 USDC; what the contract actually pays is ~0.999 USDC,
  // because the 1,000 USDC belongs to the virtual shares.
  const inflow = E(1000)
  const lpShares = estimateDepositShares(E(1), 0n, inflow, NEW_DEC)
  const supply = lpShares
  const assets = inflow + E(1)

  it('estimateWithdrawAssets reports what the contract pays, not the plain ratio', () => {
    const plainRatio = (lpShares * assets) / supply
    expect(plainRatio).toBeGreaterThan(E(1000))
    const redeemable = estimateWithdrawAssets(lpShares, supply, assets, NEW_DEC)
    expect(redeemable).toBeLessThanOrEqual(E(1))
    expect(redeemable).toBeGreaterThan((E(1) * 998n) / 1000n)
  })

  it('redeemablePerWholeShare is the contract price, not the inflated real-totals ratio', () => {
    const getSharePriceLike = (assets * 10n ** 24n) / supply // real totals only
    const perShare = redeemablePerWholeShare(supply, assets, NEW_DEC)
    // Same formula as previewWithdraw(1e24) …
    expect(perShare).toBe((10n ** 24n * (assets + 1n)) / (supply + 1_000_000n))
    // … about (supply + 1e6) / supply ≈ 1000x below the real-totals ratio here …
    expect(getSharePriceLike / perShare).toBeGreaterThanOrEqual(999n)
    // … and consistent with what a deposit pays: spending that price buys one
    // whole pIV, to within rounding.
    const bought = estimateDepositShares(perShare, supply, assets, NEW_DEC)
    expect(bought).toBeLessThanOrEqual(10n ** 24n)
    expect(10n ** 24n - bought).toBeLessThan(10n ** 24n / 1000n)
  })

  it('is 1.0 with no supply and matches the legacy ratio on the legacy vault', () => {
    expect(redeemablePerWholeShare(0n, E(5), NEW_DEC)).toBe(E(1))
    expect(redeemablePerWholeShare(0n, 0n, LEGACY_SHARE_DECIMALS)).toBe(E(1))
    expect(redeemablePerWholeShare(E(1000), E(1500), LEGACY_SHARE_DECIMALS)).toBe((E(1) * E(1500)) / E(1000))
  })

  it('in a normal state equals the share price to within a wei', () => {
    const s = 1000n * 10n ** 24n
    expect(redeemablePerWholeShare(s, E(1500), NEW_DEC)).toBe((10n ** 24n * (E(1500) + 1n)) / (s + 1_000_000n))
    expect(E(1500) * 10n ** 24n / s - redeemablePerWholeShare(s, E(1500), NEW_DEC)).toBeLessThanOrEqual(1n)
  })
})

describe('estimateWithdrawAssets', () => {
  it('legacy vault: proportional', () => {
    expect(estimateWithdrawAssets(E(500), E(1000), E(2000), 18)).toBe(E(1000))
  })

  it('virtual-share vault: never more than was deposited (round trip floors toward the vault)', () => {
    const shares = estimateDepositShares(E(1000), 0n, 0n, NEW_DEC)
    const back = estimateWithdrawAssets(shares, shares, E(1000), NEW_DEC)
    expect(back).toBeLessThanOrEqual(E(1000))
    expect(E(1000) - back).toBeLessThanOrEqual(1n)
  })

  it('is 0 with no supply', () => {
    expect(estimateWithdrawAssets(E(1), 0n, E(5), NEW_DEC)).toBe(0n)
  })
})
