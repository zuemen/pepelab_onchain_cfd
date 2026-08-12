import { describe, it, expect } from 'vitest'

import {
  fUsd,
  timeAgo,
  fCompact,
  sideLabel,
  notionalOf,
  fSignedUsd,
  isWhaleTrade,
  MEGA_THRESHOLD,
  positionProfile,
  HIGH_LEVERAGE_X,
  WHALE_THRESHOLD,
  WHALE_THRESHOLD_OPTIONS,
} from './whale'

/** 把人看得懂的美金金額變成 18-dec，保留 6 位小數的精度。 */
const usd = (n: number): bigint => BigInt(Math.round(n * 1e6)) * 10n ** 12n

describe('isWhaleTrade', () => {
  it('門檻是閉區間——剛好 5,000 就算', () => {
    expect(isWhaleTrade(WHALE_THRESHOLD)).toBe(true)
    expect(isWhaleTrade(WHALE_THRESHOLD - 1n)).toBe(false)
    expect(isWhaleTrade(usd(4_999.99))).toBe(false)
    expect(isWhaleTrade(usd(12_400))).toBe(true)
  })

  it('門檻可以換,語意不變', () => {
    // 固定 $5k 跟實際鏈上規模對不上：實測一週 27 筆開倉、平均 $1.2k，
    // 沒有一筆過得了 $5k，主角區永遠空著。
    const oneK = usd(1_000)
    expect(isWhaleTrade(usd(1_200), oneK)).toBe(true)
    expect(isWhaleTrade(usd(1_200))).toBe(false)
    expect(isWhaleTrade(oneK, oneK)).toBe(true)
    expect(isWhaleTrade(oneK - 1n, oneK)).toBe(false)
  })

  it('選項由小到大,而且都是正的', () => {
    const values = WHALE_THRESHOLD_OPTIONS.map(o => o.value)
    expect(values).toEqual([...values].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0)))
    expect(values.every(v => v > 0n)).toBe(true)
    expect(values).toContain(WHALE_THRESHOLD)
  })

  it('所有門檻都套在同一個量上：單筆 notional', () => {
    // 這是這個模組存在的理由。舊版有兩個單位：banner 用「單筆 ≥ 5k」，
    // 排行榜用「累積 ≥ 50k / 10k」分 Mega Whale / Whale / Fish。於是一筆
    // 剛被 banner 稱作鯨魚的交易，其地址在排行榜可能顯示 🐟 Fish。
    // 現在 Mega 只是同一把尺上更遠的一格，不可能與鯨魚判定互相矛盾。
    expect(MEGA_THRESHOLD).toBeGreaterThan(WHALE_THRESHOLD)
    const mega = { notional: MEGA_THRESHOLD, leverage: 2n }
    expect(isWhaleTrade(mega.notional)).toBe(true)
    expect(positionProfile(mega).map(t => t.id)).toContain('mega')
  })
})

describe('notionalOf', () => {
  it('margin × leverage', () => {
    expect(notionalOf(usd(1_000), 12n)).toBe(usd(12_000))
  })
})

describe('positionProfile', () => {
  it('平凡的鯨魚開倉不掛標籤——它已經在 feed 上了,不需要自我重複', () => {
    expect(positionProfile({ notional: usd(8_000), leverage: 3n })).toEqual([])
  })

  it('Mega 看單筆 notional', () => {
    expect(positionProfile({ notional: MEGA_THRESHOLD, leverage: 2n })[0].id).toBe('mega')
    expect(positionProfile({ notional: MEGA_THRESHOLD - 1n, leverage: 2n })).toEqual([])
  })

  it('高槓桿的門檻也是閉區間', () => {
    const at = positionProfile({ notional: usd(6_000), leverage: HIGH_LEVERAGE_X })
    expect(at.map(t => t.id)).toEqual(['high-leverage'])
    expect(at[0].label).toBe('20× leverage')
    expect(positionProfile({ notional: usd(6_000), leverage: HIGH_LEVERAGE_X - 1n })).toEqual([])
  })

  it('新面孔由呼叫端判定,這裡只負責標', () => {
    expect(positionProfile({ notional: usd(6_000), leverage: 2n, isFirstSeen: true })
      .map(t => t.id)).toEqual(['new-face'])
    expect(positionProfile({ notional: usd(6_000), leverage: 2n, isFirstSeen: false })).toEqual([])
  })

  it('多個標籤依重要性排序,金額在前', () => {
    const tags = positionProfile({ notional: usd(120_000), leverage: 50n, isFirstSeen: true })
    expect(tags.map(t => t.id)).toEqual(['mega', 'high-leverage', 'new-face'])
  })

  it('每個標籤都帶得起 tooltip 的解釋', () => {
    for (const tag of positionProfile({ notional: usd(120_000), leverage: 50n, isFirstSeen: true })) {
      expect(tag.hint.length).toBeGreaterThan(0)
    }
  })
})

describe('fCompact', () => {
  it('依量級換單位', () => {
    expect(fCompact(usd(840))).toBe('$840')
    expect(fCompact(usd(12_400))).toBe('$12.4k')
    expect(fCompact(usd(1_200_000))).toBe('$1.2M')
  })

  it('負號在錢字號外面,不是 $-500', () => {
    expect(fCompact(usd(-500))).toBe('-$500')
  })

  it('零不會掉進某個量級的分支', () => {
    expect(fCompact(0n)).toBe('$0')
  })
})

describe('fUsd / fSignedUsd', () => {
  it('表格用完整位數與千分位', () => {
    expect(fUsd(usd(12_400))).toBe('$12,400.00')
  })

  it('PnL 的正號要顯示,負號不重複', () => {
    expect(fSignedUsd(usd(1_240))).toBe('+$1,240.00')
    expect(fSignedUsd(usd(-85))).toBe('-$85.00')
    expect(fSignedUsd(0n)).toBe('+$0.00')
  })
})

describe('timeAgo', () => {
  const now = 1_700_000_000

  it('依量級換單位', () => {
    expect(timeAgo(now - 30, now)).toBe('just now')
    expect(timeAgo(now - 8 * 60, now)).toBe('8m ago')
    expect(timeAgo(now - 3 * 3600, now)).toBe('3h ago')
    expect(timeAgo(now - 2 * 86400, now)).toBe('2d ago')
  })

  it('邊界不會跳過單位', () => {
    expect(timeAgo(now - 59, now)).toBe('just now')
    expect(timeAgo(now - 60, now)).toBe('1m ago')
    expect(timeAgo(now - 3599, now)).toBe('59m ago')
    expect(timeAgo(now - 3600, now)).toBe('1h ago')
  })

  it('未來的時間戳不顯示負秒數', () => {
    // 節點時鐘偏移、或用出塊時間推估未來區塊時，ts 可能大於 now。
    expect(timeAgo(now + 120, now)).toBe('just now')
  })
})

describe('sideLabel', () => {
  it('UI 統一英文', () => {
    expect(sideLabel(true)).toBe('LONG')
    expect(sideLabel(false)).toBe('SHORT')
  })
})
