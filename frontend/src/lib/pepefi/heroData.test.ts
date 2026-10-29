import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'

import { buildTraderCard } from './leaderboardMetrics'
import {
  parseHeroIndex,
  parseHeroDetail,
  fetchHeroIndex,
  fetchHeroDetail,
  heroByAddress,
  applyHeroSummary,
  usdToWei,
  fSignedPct,
  fDrawdown,
  fRatio,
  fUsd,
  RISK_VAR_BANDS_PCT,
  riskBandLabels,
  type HeroSummary,
} from './heroData'

const ADDR = '0x00000000000000000000000000000000000000AA'
const window = { pnlUsd: 0, marginUsd: 0, volumeUsd: 0, wins: 0, trades: 0 }
const summary: HeroSummary = {
  address: ADDR, name: 'Whale Alpha', rule: 'buy_hold',
  totalReturnPct: 12.34, maxDrawdownPct: 8.9, sharpe: 1.21, winRatePct: 62.5, closedTrades: 8,
  window7d: window,
  window30d: { pnlUsd: 123.45, marginUsd: 1000, volumeUsd: 2500, wins: 5, trades: 8 },
  sparkline: [10000, 10050.5, 9990],
  activeSince: '2024-10-01',
}
const index = {
  schemaVersion: 3, chainId: 31337, range: { from: '2024-10-01', to: '2026-10-09' }, timeCompressed: false, traders: [summary],
}
const detail = {
  ...summary,
  timeCompressed: false,
  equityCurve: [{ date: '2024-10-01', equity: 10000 }],
  monthlyReturns: [{ month: '2024-10', returnPct: 1.2 }],
  exposure: [{ asset: 'sBTC', weightPct: 50, isLong: true, leverage: 1 }],
  esgCorrelation: 0.41, avgHoldDays: 23.5,
  riskScore: 6, worstDayLossPct: 4.1, worstWeekLossPct: 9.8, maxDrawdown1yPct: 12.3,
  profitableWeeksPct: 58.3, tradesPerWeek: 1.4,
  topAssets: [{ asset: 'sBTC', trades: 12, sharePct: 40 }],
  followerHistory: [{ month: '2024-10', followers: 2 }],
  activeSince: '2024-10-01',
  strategies: [], trades: [],
}

const responding = (body: unknown, ok = true) => async () => ({ ok, json: async () => body })
const serving = (files: Record<string, unknown>) => async (url: string) => {
  const name = url.split('/').pop() as string
  return name in files ? { ok: true, json: async () => files[name] } : { ok: false, json: async () => ({}) }
}

describe('parseHeroIndex', () => {
  it('accepts data for the connected chain', () => {
    expect(parseHeroIndex(index, 31337)?.traders[0].name).toBe('Whale Alpha')
  })

  it('refuses data that belongs to another chain', () => {
    expect(parseHeroIndex(index, 84532)).toBeNull()
    expect(parseHeroIndex(index, null)).toBeNull()
  })

  it('refuses a schema version it does not know', () => {
    // 1 是還沒有 activeSince 的舊資料：排行榜靠它判斷能不能列入排名，舊檔整份不收。
    // 2 沒有 timeCompressed 與模擬日期：公開鏈的資料會被當成本機的，揭露少一句。
    expect(parseHeroIndex({ ...index, schemaVersion: 1 }, 31337)).toBeNull()
    expect(parseHeroIndex({ ...index, schemaVersion: 2 }, 31337)).toBeNull()
    expect(parseHeroIndex({ ...index, schemaVersion: 4 }, 31337)).toBeNull()
  })

  it('needs to know whether the replay was time-compressed', () => {
    const { timeCompressed: _omit, ...unknown } = index
    expect(parseHeroIndex(unknown, 31337)).toBeNull()
    expect(parseHeroIndex({ ...index, timeCompressed: 'yes' }, 31337)).toBeNull()
    expect(parseHeroIndex({ ...index, chainId: 84532, timeCompressed: true }, 84532)?.timeCompressed).toBe(true)
  })

  it('needs each trader start date, which may be null for a trader who never published', () => {
    const { activeSince: _omit, ...withoutStart } = summary
    expect(parseHeroIndex({ ...index, traders: [withoutStart] }, 31337)).toBeNull()
    expect(parseHeroIndex({ ...index, traders: [{ ...summary, activeSince: 20241001 }] }, 31337)).toBeNull()
    expect(parseHeroIndex({ ...index, traders: [{ ...summary, activeSince: null }] }, 31337)?.traders[0].activeSince).toBeNull()
  })

  it('refuses the whole file when one trader is malformed', () => {
    const broken = { ...index, traders: [summary, { ...summary, totalReturnPct: '12' }] }
    expect(parseHeroIndex(broken, 31337)).toBeNull()
    expect(parseHeroIndex({ ...index, traders: [{ ...summary, address: 'nope' }] }, 31337)).toBeNull()
    expect(parseHeroIndex('<!doctype html>', 31337)).toBeNull()
  })

  it('keeps null for figures that could not be computed', () => {
    const parsed = parseHeroIndex({ ...index, traders: [{ ...summary, winRatePct: null }] }, 31337)
    expect(parsed?.traders[0].winRatePct).toBeNull()
  })
})

describe('parseHeroDetail', () => {
  it('accepts a detail file for the address asked for', () => {
    expect(parseHeroDetail(detail, ADDR.toLowerCase())?.equityCurve).toHaveLength(1)
  })

  it('refuses a file about a different trader or without the detail sections', () => {
    expect(parseHeroDetail(detail, '0x00000000000000000000000000000000000000BB')).toBeNull()
    expect(parseHeroDetail(summary, ADDR)).toBeNull()
  })

  it('refuses a detail file that does not say whether it is time-compressed', () => {
    const { timeCompressed: _omit, ...older } = detail
    expect(parseHeroDetail(older, ADDR)).toBeNull()
  })

  it('refuses a detail file from before the risk statistics existed', () => {
    const older: Record<string, unknown> = { ...detail }
    delete older.riskScore
    expect(parseHeroDetail(older, ADDR)).toBeNull()
    expect(parseHeroDetail({ ...detail, riskScore: null, profitableWeeksPct: null, activeSince: null }, ADDR)).not.toBeNull()
  })
})

// 解析一筆不合格就整份不收，所以管線重新產生的資料若少了欄位，畫面會悄悄退回「沒有資料」。
// 這裡直接拿進版控的那份資料檔跑解析，讓它在測試裡失敗，而不是在展示時才發現。
// 每條鏈一個目錄（#344）：31337 是本機回放，84532 是公開站的時間壓縮回放（cutover 之後才有）。
describe('committed hero data', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'public', 'data', 'heroes')
  const chains = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^\d+$/.test(d)) : []

  it('keeps one directory per chain and nothing loose at the top', () => {
    expect(chains).toContain('31337')
    expect(fs.readdirSync(root).filter((f) => f.endsWith('.json'))).toEqual([])
  })

  it.each(chains)('chain %s: every trader in the index has a detail file the page accepts', (chain) => {
    const read = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(root, chain, name), 'utf8'))
    const committed = parseHeroIndex(read('index.json'), Number(chain))
    expect(committed).not.toBeNull()
    // 本機回放的區塊時間就是模擬時間；公開鏈（84532）的回放一定是時間壓縮的
    expect(committed!.timeCompressed).toBe(chain !== '31337')
    for (const trader of committed!.traders) {
      const name = `${trader.address.toLowerCase()}.json`
      const parsed = parseHeroDetail(read(name), trader.address)
      expect(parsed, name).not.toBeNull()
      expect(parsed!.timeCompressed, name).toBe(committed!.timeCompressed)
      for (const trade of parsed!.trades) expect(trade.openDate, name).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe('fetching', () => {
  it('returns null instead of throwing when the file is missing or is not JSON', async () => {
    expect(await fetchHeroIndex(31337, responding({}, false))).toBeNull()
    expect(await fetchHeroIndex(31337, async () => ({ ok: true, json: async () => { throw new Error('html') } }))).toBeNull()
    expect(await fetchHeroIndex(31337, async () => { throw new Error('offline') })).toBeNull()
  })

  it('does not fetch at all without a chain', async () => {
    let calls = 0
    const counting = async () => { calls += 1; return { ok: true, json: async () => index } }
    expect(await fetchHeroIndex(null, counting)).toBeNull()
    expect(calls).toBe(0)
  })

  it('reads the dataset of the connected chain from its own directory', async () => {
    const compressed = { ...index, chainId: 84532, timeCompressed: true }
    const byChain: Record<string, unknown> = { '/data/heroes/31337/index.json': index, '/data/heroes/84532/index.json': compressed }
    const urls: string[] = []
    const fetchByUrl = async (url: string) => {
      urls.push(url)
      return url in byChain ? { ok: true, json: async () => byChain[url] } : { ok: false, json: async () => ({}) }
    }
    expect((await fetchHeroIndex(31337, fetchByUrl))?.timeCompressed).toBe(false)
    expect((await fetchHeroIndex(84532, fetchByUrl))?.timeCompressed).toBe(true)
    expect(await fetchHeroIndex(11155111, fetchByUrl)).toBeNull()
    expect(urls).toEqual(['/data/heroes/31337/index.json', '/data/heroes/84532/index.json', '/data/heroes/11155111/index.json'])
  })

  it('reads a detail file only for a trader the index lists', async () => {
    const files = { 'index.json': index, [`${ADDR.toLowerCase()}.json`]: detail }
    expect((await fetchHeroDetail(ADDR, 31337, serving(files)))?.avgHoldDays).toBe(23.5)
    expect(await fetchHeroDetail('0x00000000000000000000000000000000000000BB', 31337, serving(files))).toBeNull()
    expect(await fetchHeroDetail(ADDR, 84532, serving(files))).toBeNull()
  })
})

describe('applyHeroSummary', () => {
  const empty = { volumeMap: {}, marginMap: {}, pnlMap: {}, closedEventsByOwner: {} }
  const card = buildTraderCard(
    { address: ADDR, displayName: 'Whale Alpha', allocs: [], followerCount: 3n, reputation: 90n, stake: 5_000n * 10n ** 18n, totalSlashed: 0n },
    empty,
  )

  it('converts dollars to 18-decimal wei without float drift', () => {
    expect(usdToWei(123.45)).toBe(123_450_000n * 10n ** 12n)
    expect(usdToWei(-0.5)).toBe(-500_000n * 10n ** 12n)
  })

  it('feeds the 30-day window into the existing leaderboard fields', () => {
    const applied = applyHeroSummary(card, summary)
    expect(applied.pnl7d).toBe(usdToWei(123.45))
    expect(applied.totalVolume).toBe(usdToWei(2500))
    expect(applied.marginDeployed).toBe(usdToWei(1000))
    expect([applied.wins, applied.trades]).toEqual([5, 8])
    expect(applied.hero).toBe(summary)
  })

  it('recomputes TraderScore from the window and keeps what was read from chain', () => {
    const applied = applyHeroSummary(card, summary)
    expect(applied.score.returnPct).toBeCloseTo(12.345)
    expect(applied.score.winRate).toBeCloseTo(0.625)
    expect(applied.score.insufficientSample).toBe(false)
    expect(applied.score.stakeScore).toBe(card.score.stakeScore)
    expect([applied.followerCount, applied.reputation, applied.stake]).toEqual([3n, 90n, card.stake])
  })

  it('draws the sparkline as change since the first point', () => {
    expect(applyHeroSummary(card, summary).equityCurve).toEqual([0n, usdToWei(50.5), usdToWei(-10)])
    expect(applyHeroSummary(card, { ...summary, sparkline: [10000] }).equityCurve).toEqual([])
  })

  it('indexes traders by lower-case address', () => {
    expect(heroByAddress(parseHeroIndex(index, 31337)!).get(ADDR.toLowerCase())).toEqual(summary)
  })
})

describe('formatting', () => {
  it('never shows a missing figure as zero', () => {
    expect([fSignedPct(undefined), fSignedPct(null), fDrawdown(undefined), fRatio(null), fUsd(null)])
      .toEqual(['—', '—', '—', '—', '—'])
  })

  it('always signs a return, and shows a drawdown as a loss', () => {
    expect([fSignedPct(12.34), fSignedPct(-4.2), fSignedPct(0)]).toEqual(['+12.3%', '-4.2%', '+0.0%'])
    expect([fDrawdown(8.9), fDrawdown(0)]).toEqual(['-8.9%', '0.0%'])
    expect(fRatio(1.214)).toBe('1.21')
    expect([fUsd(1234.5), fUsd(-20)]).toEqual(['1,234.50', '-20.00'])
  })
})

// 個人頁在風險分數量表下標出每一級的 VaR 範圍。門檻在資料管線（heroes/herolab/analytics.py 的
// RISK_BANDS）裡決定分數，畫面上的標示必須是同一組數字，否則格子下的範圍跟分數對不上。
describe('risk score bands', () => {
  it('match the bands the data pipeline grades with', () => {
    const python = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'heroes', 'herolab', 'analytics.py'),
      'utf8',
    )
    const tuple = /^RISK_BANDS = \(([^)]*)\)/m.exec(python)
    expect(tuple, 'RISK_BANDS not found in analytics.py').not.toBeNull()
    expect(RISK_VAR_BANDS_PCT).toEqual(tuple![1].split(',').map((s) => Number(s.trim())))
  })

  it('labels each of the ten levels with its VaR range', () => {
    expect(riskBandLabels()).toEqual([
      '≤0.25%', '≤0.5%', '≤1%', '≤1.5%', '≤2%', '≤3%', '≤4%', '≤6%', '≤10%', '>10%',
    ])
  })
})
