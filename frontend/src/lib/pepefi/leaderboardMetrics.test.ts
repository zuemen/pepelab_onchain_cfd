import { describe, it, expect } from 'vitest'

import {
  parseAllocs,
  buildVolumeMap,
  buildMarginMap,
  buildPnlMap,
  groupClosedEventsByOwner,
  computeWinRate,
  computeEquityCurve,
  computeTraderScore,
  scoreChipColor,
  fPnL,
  fWinRate,
  fReturnPct,
  buildTraderCard,
  cmpBigDesc,
  cmpNullableBigDesc,
  matchesSearch,
  type TraderRawInput,
  type TraderEventAggregates,
} from './leaderboardMetrics'

const emptyAggregates: TraderEventAggregates = {
  volumeMap: {},
  marginMap: {},
  pnlMap: {},
  closedEventsByOwner: {},
}

describe('parseAllocs', () => {
  it('把合約回傳的原始陣列轉成 RawAlloc 物件', () => {
    const raw = [{ asset: '0xsBTC', weight: 4_000n, isLong: true, leverage: 3n }]
    expect(parseAllocs(raw)).toEqual([
      { asset: '0xsBTC', weight: 4_000n, isLong: true, leverage: 3n },
    ])
  })

  it('空陣列(尚未發布策略)→ 空陣列', () => {
    expect(parseAllocs([])).toEqual([])
  })
})

describe('buildVolumeMap', () => {
  it('依 owner 加總 margin × leverage', () => {
    const map = buildVolumeMap([
      { owner: '0xAAA', margin: 100n, leverage: 2n },
      { owner: '0xAAA', margin: 50n, leverage: 4n },
      { owner: '0xBBB', margin: 10n, leverage: 1n },
    ])
    expect(map).toEqual({
      '0xaaa': 400n, // 100*2 + 50*4
      '0xbbb': 10n,
    })
  })

  it('owner 地址大小寫不同也會被合併(統一小寫)', () => {
    const map = buildVolumeMap([
      { owner: '0xAAA', margin: 100n, leverage: 1n },
      { owner: '0xaaa', margin: 200n, leverage: 1n },
    ])
    expect(map).toEqual({ '0xaaa': 300n })
  })

  it('沒有任何 PositionOpened 事件(查詢失敗降級為空陣列)→ 空物件', () => {
    expect(buildVolumeMap([])).toEqual({})
  })
})

describe('buildMarginMap', () => {
  it('依 owner 加總「投入的保證金」,不像 buildVolumeMap 那樣乘上槓桿', () => {
    const map = buildMarginMap([
      { owner: '0xAAA', margin: 100n, leverage: 5n },
      { owner: '0xAAA', margin: 50n, leverage: 2n },
    ])
    expect(map).toEqual({ '0xaaa': 150n }) // 100 + 50,不管槓桿
  })

  it('沒有任何 PositionOpened 事件 → 空物件', () => {
    expect(buildMarginMap([])).toEqual({})
  })
})

describe('buildPnlMap', () => {
  it('依 owner 加總 pnl,可正可負', () => {
    const map = buildPnlMap([
      { owner: '0xAAA', pnl: 100n },
      { owner: '0xAAA', pnl: -30n },
      { owner: '0xBBB', pnl: -5n },
    ])
    expect(map).toEqual({ '0xaaa': 70n, '0xbbb': -5n })
  })

  it('沒有任何 PositionClosed 事件(查詢失敗降級為空陣列,或這條鏈上還沒人平倉)→ 空物件', () => {
    expect(buildPnlMap([])).toEqual({})
  })
})

describe('groupClosedEventsByOwner', () => {
  it('依 owner 分組,保留原始順序', () => {
    const groups = groupClosedEventsByOwner([
      { owner: '0xAAA', pnl: 10n },
      { owner: '0xBBB', pnl: -5n },
      { owner: '0xAAA', pnl: 20n },
    ])
    expect(groups).toEqual({
      '0xaaa': [{ owner: '0xAAA', pnl: 10n }, { owner: '0xAAA', pnl: 20n }],
      '0xbbb': [{ owner: '0xBBB', pnl: -5n }],
    })
  })

  it('地址大小寫不同也會被合併到同一組', () => {
    const groups = groupClosedEventsByOwner([
      { owner: '0xAAA', pnl: 1n },
      { owner: '0xaaa', pnl: 2n },
    ])
    expect(groups['0xaaa']).toHaveLength(2)
  })

  it('空陣列 → 空物件', () => {
    expect(groupClosedEventsByOwner([])).toEqual({})
  })
})

describe('computeWinRate', () => {
  it('勝率 = pnl>0 的筆數 / 總平倉筆數', () => {
    const wr = computeWinRate([{ owner: 'x', pnl: 10n }, { owner: 'x', pnl: -5n }, { owner: 'x', pnl: 3n }])
    expect(wr).toEqual({ wins: 2, trades: 3 })
  })

  it('零平倉 → wins 與 trades 都是 0,不是 NaN', () => {
    expect(computeWinRate([])).toEqual({ wins: 0, trades: 0 })
  })

  it('pnl 剛好為 0 不算贏', () => {
    const wr = computeWinRate([{ owner: 'x', pnl: 0n }])
    expect(wr).toEqual({ wins: 0, trades: 1 })
  })
})

describe('computeEquityCurve', () => {
  it('依原始順序累加損益', () => {
    const curve = computeEquityCurve([
      { owner: 'x', pnl: 10n },
      { owner: 'x', pnl: -3n },
      { owner: 'x', pnl: 5n },
    ])
    expect(curve).toEqual([10n, 7n, 12n])
  })

  it('少於 2 筆平倉 → 空陣列,不畫只有單點會被誤讀成持平的線', () => {
    expect(computeEquityCurve([])).toEqual([])
    expect(computeEquityCurve([{ owner: 'x', pnl: 10n }])).toEqual([])
  })

  it('剛好 2 筆 → 有曲線', () => {
    expect(computeEquityCurve([{ owner: 'x', pnl: 10n }, { owner: 'x', pnl: -4n }])).toEqual([10n, 6n])
  })
})

describe('computeTraderScore', () => {
  const wei = (n: number) => BigInt(n) * 10n ** 18n

  const base = {
    pnl7d: 0n,
    marginDeployed: 0n,
    wins: 0,
    trades: 0,
    stake: null as bigint | null,
    reputation: null as bigint | null,
    totalSlashed: null as bigint | null,
  }

  it('零質押(0n,不是 null)→ stakeScore 是 0,不會除以零爆掉', () => {
    const s = computeTraderScore({ ...base, stake: 0n })
    expect(s.stakeScore).toBe(0)
    expect(Number.isFinite(s.total)).toBe(true)
  })

  it('零平倉 → winRate 是 null(不是 0/0 的 NaN),winRateScore 是 0,標記樣本不足', () => {
    const s = computeTraderScore({ ...base, trades: 0 })
    expect(s.winRate).toBeNull()
    expect(s.winRateScore).toBe(0)
    expect(s.insufficientSample).toBe(true)
  })

  it('平倉滿 5 筆(門檻)→ 不再標記樣本不足', () => {
    const s = computeTraderScore({ ...base, wins: 3, trades: 5 })
    expect(s.insufficientSample).toBe(false)
  })

  it('罰沒超過質押 → slashRatio 封頂在 1,slashPenalty 封頂在 -20,不會因為比例 >100% 扣超過上限', () => {
    const s = computeTraderScore({ ...base, stake: wei(100), totalSlashed: wei(150) })
    expect(s.slashRatio).toBe(1)
    expect(s.slashPenalty).toBe(-20)
  })

  it('報酬率為負 → returnScore 落回 0,不會把總分往下拉超過該有的懲罰(最終總分仍 clamp 在 0 以上)', () => {
    const s = computeTraderScore({ ...base, pnl7d: -wei(50), marginDeployed: wei(1_000) })
    expect(s.returnPct).toBeLessThan(0)
    expect(s.returnScore).toBe(0)
    expect(s.total).toBeGreaterThanOrEqual(0)
  })

  it('沒有投入保證金(marginDeployed 是 0n)→ returnPct 是 null,不是除以零的 Infinity', () => {
    const s = computeTraderScore({ ...base, pnl7d: wei(10), marginDeployed: 0n })
    expect(s.returnPct).toBeNull()
    expect(s.returnScore).toBe(0)
  })

  it('五項全部拉滿 → 總分封頂在 100,不會超過', () => {
    const s = computeTraderScore({
      pnl7d: wei(1_000), marginDeployed: wei(1_000), // 100% 報酬率,遠超封頂值
      wins: 10, trades: 10,
      stake: wei(50_000), // 遠超滿分門檻
      reputation: 100n,
      totalSlashed: null,
    })
    expect(s.total).toBe(100)
  })

  it('每一項都回傳實際數值與該項得分,不是只有總分——UI 要能把算式攤開', () => {
    const s = computeTraderScore({ ...base, wins: 1, trades: 2, reputation: 60n, stake: wei(2_500) })
    expect(s.winRate).toBeCloseTo(0.5)
    expect(s.winRateScore).toBeCloseTo(12.5) // 0.5 * 25
    expect(s.reputationValue).toBe(60)
    expect(s.reputationScore).toBeCloseTo(9) // 60/100 * 15
    expect(s.stakeAmount).toBe(2_500)
    expect(s.stakeScore).toBeCloseTo(10) // 2500/5000 * 20
  })
})

describe('scoreChipColor', () => {
  it('>=80 success,>=60 warning,其餘 error', () => {
    expect(scoreChipColor(80)).toBe('success')
    expect(scoreChipColor(60)).toBe('warning')
    expect(scoreChipColor(59)).toBe('error')
    expect(scoreChipColor(0)).toBe('error')
  })
})

describe('fPnL', () => {
  const wei = (n: number) => BigInt(Math.round(n * 1e18))

  it('正數帶正號,千位用 k 縮寫', () => {
    expect(fPnL(wei(2_100))).toBe('+2.1k')
  })

  it('負數帶負號', () => {
    expect(fPnL(wei(-340))).toBe('-340.0')
  })

  it('0 也帶正號,不是特例', () => {
    expect(fPnL(0n)).toBe('+0.0')
  })
})

describe('fWinRate', () => {
  it('百分比四捨五入,永遠附帶樣本數', () => {
    expect(fWinRate(13, 21)).toBe('62% (21)')
  })

  it('全勝', () => {
    expect(fWinRate(4, 4)).toBe('100% (4)')
  })

  it('零平倉 → 破折號,不是 0% (0) 也不是 NaN', () => {
    expect(fWinRate(0, 0)).toBe('—')
  })
})

describe('fReturnPct', () => {
  it('正報酬率帶正號,一位小數', () => {
    expect(fReturnPct(12.37)).toBe('+12.4%')
  })

  it('負報酬率帶負號', () => {
    expect(fReturnPct(-4.2)).toBe('-4.2%')
  })

  it('剛好 0 帶正號,跟 fPnL 同一套符號語言', () => {
    expect(fReturnPct(0)).toBe('+0.0%')
  })

  it('沒有投入保證金(returnPct 為 null)→ 破折號', () => {
    expect(fReturnPct(null)).toBe('—')
  })
})

describe('buildTraderCard', () => {
  const base: TraderRawInput = {
    address: '0xAAA',
    displayName: 'Demo Alpha',
    allocs: [],
    followerCount: 0n,
    reputation: null,
    stake: null,
    totalSlashed: null,
  }

  it('無平倉紀錄的交易者 → totalVolume/pnl7d 落回 0n,不是 undefined 或拋錯', () => {
    const card = buildTraderCard(base, emptyAggregates)
    expect(card.totalVolume).toBe(0n)
    expect(card.pnl7d).toBe(0n)
  })

  it('getAllTraders 回傳但沒發布過策略的地址 → hasStrategy 為 false', () => {
    const card = buildTraderCard(base, emptyAggregates)
    expect(card.hasStrategy).toBe(false)
  })

  it('有策略(allocs 非空)→ hasStrategy 為 true', () => {
    const card = buildTraderCard(
      { ...base, allocs: [{ asset: '0xsBTC', weight: 10_000n, isLong: true, leverage: 1n }] },
      emptyAggregates,
    )
    expect(card.hasStrategy).toBe(true)
  })

  it('volumeMap/marginMap/pnlMap 有對應地址的資料時,依小寫地址查得到', () => {
    const card = buildTraderCard(base, {
      volumeMap: { '0xaaa': 500n },
      marginMap: { '0xaaa': 200n },
      pnlMap: { '0xaaa': -20n },
      closedEventsByOwner: {},
    })
    expect(card.totalVolume).toBe(500n)
    expect(card.marginDeployed).toBe(200n)
    expect(card.pnl7d).toBe(-20n)
  })

  it('Promise.allSettled 某一路(reputationScore/getStake)rejected 的降級 → reputation/stake/totalSlashed 保持 null,不影響其他欄位組裝', () => {
    const card = buildTraderCard(base, emptyAggregates)
    expect(card.reputation).toBeNull()
    expect(card.stake).toBeNull()
    expect(card.totalSlashed).toBeNull()
    expect(card.address).toBe('0xAAA')
    expect(card.displayName).toBe('Demo Alpha')
  })

  it('closedEventsByOwner 有這位交易者的平倉紀錄時,wins/trades/equityCurve/score 都算得出來', () => {
    const card = buildTraderCard(base, {
      volumeMap: {},
      marginMap: {},
      pnlMap: { '0xaaa': 30n },
      closedEventsByOwner: {
        '0xaaa': [{ owner: '0xAAA', pnl: 10n }, { owner: '0xAAA', pnl: 20n }],
      },
    })
    expect(card.wins).toBe(2)
    expect(card.trades).toBe(2)
    expect(card.equityCurve).toEqual([10n, 30n])
    expect(card.score.total).toBeGreaterThanOrEqual(0)
  })

  it('這位交易者沒有平倉紀錄 → wins/trades 是 0,equityCurve 是空陣列,不拋錯', () => {
    const card = buildTraderCard(base, emptyAggregates)
    expect(card.wins).toBe(0)
    expect(card.trades).toBe(0)
    expect(card.equityCurve).toEqual([])
  })
})

describe('cmpBigDesc', () => {
  it('大到小排序', () => {
    expect(cmpBigDesc(100n, 50n)).toBeLessThan(0)
    expect(cmpBigDesc(50n, 100n)).toBeGreaterThan(0)
  })

  it('平手回傳 0', () => {
    expect(cmpBigDesc(10n, 10n)).toBe(0)
  })
})

describe('cmpNullableBigDesc', () => {
  it('兩個都有資料時等同 cmpBigDesc', () => {
    expect(cmpNullableBigDesc(100n, 50n)).toBeLessThan(0)
  })

  it('null 一律墊底,不當成 0——質押 0n 的人要排在 null(沒讀到)前面', () => {
    expect(cmpNullableBigDesc(0n, null)).toBeLessThan(0)
    expect(cmpNullableBigDesc(null, 0n)).toBeGreaterThan(0)
  })

  it('兩個都是 null → 0(順序不變)', () => {
    expect(cmpNullableBigDesc(null, null)).toBe(0)
  })
})

describe('matchesSearch', () => {
  const trader = { displayName: 'Demo Alpha', address: '0xAbCdEf0123456789' }

  it('空白查詢(含只有空白)永遠放行', () => {
    expect(matchesSearch(trader, '')).toBe(true)
    expect(matchesSearch(trader, '   ')).toBe(true)
  })

  it('比對名稱,大小寫不敏感', () => {
    expect(matchesSearch(trader, 'alpha')).toBe(true)
    expect(matchesSearch(trader, 'ALPHA')).toBe(true)
  })

  it('比對地址子字串,大小寫不敏感', () => {
    expect(matchesSearch(trader, 'abcdef')).toBe(true)
    expect(matchesSearch(trader, '0xABCDEF')).toBe(true)
  })

  it('沒比對到 → false', () => {
    expect(matchesSearch(trader, 'beta')).toBe(false)
  })
})
