import { describe, it, expect } from 'vitest'

import { netWorthOf, type NetWorthParts, isPortfolioProvablyEmpty, type PortfolioEmptinessCheck } from './portfolio'

/** 把人看得懂的美金金額變成 18-dec。 */
const usd = (n: number): bigint => BigInt(Math.round(n * 1e6)) * 10n ** 12n

const parts = (over: Partial<NetWorthParts> = {}): NetWorthParts => ({
  walletCash:    usd(1_000),
  freeMargin:    usd(500),
  lockedMargin:  usd(2_000),
  unrealisedPnl: 0n,
  staked:        usd(300),
  vault:         usd(200),
  ...over,
})

describe('netWorthOf', () => {
  it('把每一處的錢加起來', () => {
    expect(netWorthOf(parts()).total).toBe(usd(4_000))
  })

  it('未實現損益會計入——這正是舊公式漏掉的那一項', () => {
    // 舊版是 wallet + staked + totalMargin + freeMargin + vault，沒有 PnL，
    // 於是倉位賺了錢，畫面上的「總資產」文風不動。這條測試釘住修正。
    const flat = netWorthOf(parts({ unrealisedPnl: 0n })).total
    const up   = netWorthOf(parts({ unrealisedPnl: usd(500) })).total
    expect(up).toBe(flat + usd(500))
    expect(up).not.toBe(flat)
  })

  it('虧損會讓淨值變小,不是取絕對值', () => {
    const flat = netWorthOf(parts({ unrealisedPnl: 0n })).total
    const down = netWorthOf(parts({ unrealisedPnl: usd(-800) })).total
    expect(down).toBe(flat - usd(800))
    expect(down).toBeLessThan(flat)
  })

  it('虧損大於本金時可以是負的,不會夾成 0', () => {
    const wiped = netWorthOf({
      walletCash: 0n, freeMargin: 0n, lockedMargin: usd(100),
      unrealisedPnl: usd(-500), staked: 0n, vault: 0n,
    })
    expect(wiped.total).toBe(usd(-400))
  })

  it('全部讀到時 incomplete 是 false', () => {
    const r = netWorthOf(parts())
    expect(r.incomplete).toBe(false)
    expect(r.missing).toEqual([])
  })

  it('讀不到的欄位被指名,而且不會被當成 0 混進總額', () => {
    // TraderStake 在某些鏈上是 0x0，staked 讀不到是真的會發生的情況。
    // 靜默當成 0 會端出一個看起來很篤定的錯數字。
    const r = netWorthOf(parts({ staked: null, vault: null }))
    expect(r.incomplete).toBe(true)
    expect(r.missing).toEqual(['staked', 'vault'])
    // 300 + 200 沒有被算進去
    expect(r.total).toBe(usd(3_500))
  })

  it('全部讀不到時回 0 並標記不完整,而不是假裝使用者身無分文', () => {
    const r = netWorthOf({
      walletCash: null, freeMargin: null, lockedMargin: null,
      unrealisedPnl: null, staked: null, vault: null,
    })
    expect(r.total).toBe(0n)
    expect(r.incomplete).toBe(true)
    expect(r.missing).toHaveLength(6)
  })
})

const usd18 = (n: number): bigint => BigInt(Math.round(n * 1e6)) * 10n ** 12n

const allEmpty = (over: Partial<PortfolioEmptinessCheck> = {}): PortfolioEmptinessCheck => ({
  copyRecordsCount: 0,
  positionsCount:   0,
  freeMargin:       0n,
  walletCash:       0n,
  staked:           0n,
  vault:            0n,
  ...over,
})

describe('isPortfolioProvablyEmpty', () => {
  it('是 true,當六項都讀到而且都是空的', () => {
    expect(isPortfolioProvablyEmpty(allEmpty())).toBe(true)
  })

  it('任何一項讀不到(null)就不能算空 — 未知不是空', () => {
    expect(isPortfolioProvablyEmpty(allEmpty({ copyRecordsCount: null }))).toBe(false)
    expect(isPortfolioProvablyEmpty(allEmpty({ positionsCount: null }))).toBe(false)
    expect(isPortfolioProvablyEmpty(allEmpty({ freeMargin: null }))).toBe(false)
    expect(isPortfolioProvablyEmpty(allEmpty({ walletCash: null }))).toBe(false)
    expect(isPortfolioProvablyEmpty(allEmpty({ staked: null }))).toBe(false)
    expect(isPortfolioProvablyEmpty(allEmpty({ vault: null }))).toBe(false)
  })

  it('任何一項讀到但不是空的,就不算空', () => {
    expect(isPortfolioProvablyEmpty(allEmpty({ copyRecordsCount: 1 }))).toBe(false)
    expect(isPortfolioProvablyEmpty(allEmpty({ positionsCount: 2 }))).toBe(false)
    expect(isPortfolioProvablyEmpty(allEmpty({ freeMargin: usd18(10) }))).toBe(false)
    expect(isPortfolioProvablyEmpty(allEmpty({ walletCash: usd18(1_000) }))).toBe(false)
    expect(isPortfolioProvablyEmpty(allEmpty({ staked: usd18(5) }))).toBe(false)
    expect(isPortfolioProvablyEmpty(allEmpty({ vault: usd18(5) }))).toBe(false)
  })

  it('混合案例:有些讀不到、有些不是空的,都不算空', () => {
    expect(isPortfolioProvablyEmpty(allEmpty({ walletCash: null, staked: usd18(50) }))).toBe(false)
  })

  it('回歸測試:fetchAll 因為 catch 而回退成空值時,若有一項是真的讀不到就不能顯示「空」', () => {
    // 這正是上線過的 bug：交易帳戶那三項因為 catch 落回預設值([]、[]、0n)，
    // 跟真的讀到「空」在數值上長得一模一樣。這裡如果只看數值、不看是否
    // 讀成功,會把「這三項讀失敗」誤判成「這三項是空的」。
    const afterCaughtError = allEmpty({
      copyRecordsCount: 0,
      positionsCount:   0,
      freeMargin:       0n,
      walletCash:       null, // 錢包餘額還沒讀到 —— 不是真的 0
    })
    expect(isPortfolioProvablyEmpty(afterCaughtError)).toBe(false)
  })
})
