import { describe, it, expect } from 'vitest'

import {
  firstBlocking,
  blocksTrading,
  oracleRowStale,
  stalenessNotice,
  classifyFreshness,
} from './priceFreshness'

describe('classifyFreshness', () => {
  const maxPriceAgeSec = 21600 // Base Sepolia 交易所實際值：6 小時
  // 真實的時間戳。不要用 0 當基準 —— 鏈上的 updatedAt 為 0 代表「從未寫入」，
  // 分級必須回 unknown 而不是拿它當紀元起點算年齡。
  const BASE = 1785000000

  it('沒有 updatedAt 時回 unknown,而不是假裝是 live', () => {
    const r = classifyFreshness({ updatedAtSec: undefined, nowSec: BASE, maxPriceAgeSec })
    expect(r.level).toBe('unknown')
    expect(r.ageSec).toBeNull()
  })

  it('updatedAt 為 0 代表鏈上從未寫入,同樣是 unknown', () => {
    const r = classifyFreshness({ updatedAtSec: 0, nowSec: BASE, maxPriceAgeSec })
    expect(r.level).toBe('unknown')
    expect(r.ageSec).toBeNull()
  })

  it('剛更新的價格是 live', () => {
    const r = classifyFreshness({ updatedAtSec: BASE, nowSec: BASE + 60, maxPriceAgeSec })
    expect(r.level).toBe('live')
    expect(r.ageSec).toBe(60)
  })

  it('超過一半 maxPriceAge 進入 aging', () => {
    const r = classifyFreshness({ updatedAtSec: BASE, nowSec: BASE + 12000, maxPriceAgeSec })
    expect(r.level).toBe('aging')
  })

  it('超過 maxPriceAge 就是 stale —— 這時合約會 revert StalePrice', () => {
    const r = classifyFreshness({ updatedAtSec: BASE, nowSec: BASE + 21601, maxPriceAgeSec })
    expect(r.level).toBe('stale')
  })

  it('2026-08-06 的線上情況：9.5 天前的 sBTC 必須是 stale', () => {
    const r = classifyFreshness({ updatedAtSec: 1785162620, nowSec: 1785982648, maxPriceAgeSec })
    expect(r.level).toBe('stale')
    expect(r.label).toContain('9.5')
  })

  it('未來時間戳不會產生負數年齡', () => {
    const r = classifyFreshness({ updatedAtSec: BASE + 1000, nowSec: BASE, maxPriceAgeSec })
    expect(r.ageSec).toBe(0)
    expect(r.level).toBe('live')
  })

  it('label 對不同量級用不同單位', () => {
    const at = (offset: number) =>
      classifyFreshness({ updatedAtSec: BASE, nowSec: BASE + offset, maxPriceAgeSec }).label
    expect(at(60)).toBe('60 秒前')
    expect(at(600)).toBe('10.0 分鐘前')
    expect(at(7200)).toBe('2.0 小時前')
    expect(at(172800)).toBe('2.0 天前')
  })
})

// ── 擋單接線 ────────────────────────────────────────────────────────────────
// classifyFreshness 早就正確了；漏掉的是「把它接到送單路徑上」。這一段測的是
// 那條接線本身：什麼情況要擋、擋單時要對使用者說什麼。

describe('blocksTrading', () => {
  const at = (offset: number) =>
    classifyFreshness({ updatedAtSec: 1785000000, nowSec: 1785000000 + offset, maxPriceAgeSec: 21600 })

  it('live 與 aging 都可以下單 —— 合約還會接受', () => {
    expect(blocksTrading(at(60))).toBe(false)
    expect(blocksTrading(at(12000))).toBe(false)
  })

  it('stale 要擋 —— 合約會 revert StalePrice', () => {
    expect(blocksTrading(at(21601))).toBe(true)
  })

  it('unknown 也要擋 —— 不知道年齡就不能假設它是新的', () => {
    expect(blocksTrading({ level: 'unknown', ageSec: null, label: '年齡未知' })).toBe(true)
  })
})

describe('stalenessNotice', () => {
  const stale = classifyFreshness({ updatedAtSec: 1785000000, nowSec: 1785000000 + 100000, maxPriceAgeSec: 21600 })
  const fresh = classifyFreshness({ updatedAtSec: 1785000000, nowSec: 1785000000 + 60, maxPriceAgeSec: 21600 })

  it('可以交易時回 null,呼叫端就不渲染提示', () => {
    expect(stalenessNotice(fresh)).toBeNull()
  })

  it('undefined / null（還沒拿到報價）不會被誤判成要擋單', () => {
    expect(stalenessNotice(undefined)).toBeNull()
    expect(stalenessNotice(null)).toBeNull()
  })

  it('擋單時一定帶上價齡 —— 只把按鈕變灰不算解釋', () => {
    const msg = stalenessNotice(stale)
    expect(msg).not.toBeNull()
    expect(msg).toContain(stale.label)
    expect(msg).toContain('StalePrice')
  })

  it('有標的名稱時會指名道姓', () => {
    expect(stalenessNotice(stale, 'sBTC')).toContain('sBTC')
  })

  it('unknown 的說法和 stale 不同 —— 「無法確認」不是「已過期」', () => {
    const unknown = stalenessNotice({ level: 'unknown', ageSec: null, label: '年齡未知' })
    expect(unknown).toContain('無法確認')
    expect(stalenessNotice(stale)).not.toContain('無法確認')
  })
})

describe('firstBlocking', () => {
  const fresh = classifyFreshness({ updatedAtSec: 1785000000, nowSec: 1785000000 + 60, maxPriceAgeSec: 21600 })
  const stale = classifyFreshness({ updatedAtSec: 1785000000, nowSec: 1785000000 + 100000, maxPriceAgeSec: 21600 })

  it('全部新鮮回 null', () => {
    expect(firstBlocking([{ label: 'sBTC', freshness: fresh }, { label: 'sETH', freshness: fresh }])).toBeNull()
  })

  it('挑出第一個過期的標的 —— 跟單只要一檔過期整筆就 revert', () => {
    const bad = firstBlocking([
      { label: 'sBTC', freshness: fresh },
      { label: 'sTSLA', freshness: stale },
      { label: 'sETH', freshness: stale },
    ])
    expect(bad?.label).toBe('sTSLA')
  })

  it('還沒拿到報價的標的不算擋單條件', () => {
    expect(firstBlocking([{ label: 'sBTC', freshness: undefined }])).toBeNull()
  })

  it('空清單回 null', () => {
    expect(firstBlocking([])).toBeNull()
  })
})

describe('oracleRowStale（監控頁的過期欄）', () => {
  const NOW = 1785000000
  const DAY = 86400

  it('平台部署：照舊採用 oracle.isStale()，結果與時間戳無關（default 租戶的顯示不變）', async () => {
    const calls: string[] = []
    const read = (v: boolean) => async () => {
      calls.push('isStale')
      return v
    }
    // 30 天前的時間戳，但平台的 isStale() 說不過期 → 顯示不過期（與改版前相同）。
    expect(await oracleRowStale({ platform: true, updatedAtSec: NOW - 30 * DAY, nowSec: NOW, readIsStale: read(false) })).toBe(false)
    // 剛寫入，但 isStale() 說過期 → 顯示過期。
    expect(await oracleRowStale({ platform: true, updatedAtSec: NOW, nowSec: NOW, readIsStale: read(true) })).toBe(true)
    expect(calls).toEqual(['isStale', 'isStale'])
  })

  it('平台部署：isStale() 讀取失敗時當成不過期（與改版前相同）', async () => {
    const r = await oracleRowStale({
      platform: true,
      updatedAtSec: NOW,
      nowSec: NOW,
      readIsStale: async () => {
        throw new Error('revert')
      },
    })
    expect(r).toBe(false)
  })

  it('專屬租戶：不問 isStale()（它永遠回 false），以時間戳對照 6 小時', async () => {
    const neverAsk = async () => {
      throw new Error('dedicated tenants must not depend on isStale()')
    }
    const at = (ageSec: number) =>
      oracleRowStale({ platform: false, updatedAtSec: NOW - ageSec, nowSec: NOW, readIsStale: neverAsk })
    expect(await at(0)).toBe(false)
    expect(await at(21600)).toBe(false)
    expect(await at(21601)).toBe(true)
    expect(await at(30 * DAY)).toBe(true)
    // 從未寫入
    expect(await oracleRowStale({ platform: false, updatedAtSec: 0, nowSec: NOW, readIsStale: neverAsk })).toBe(true)
  })
})
