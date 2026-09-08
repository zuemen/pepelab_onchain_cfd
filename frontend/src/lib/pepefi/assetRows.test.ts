import { describe, it, expect } from 'vitest'

import { paramsFor } from './carbon'
import type { AssetMeta } from './assetMeta'
import {
  buildAssetRows,
  sortAssetRows,
  tierForAsset,
  assetRowColumnsForMode,
  assetRowColumnLabelForMode,
  ASSET_ROW_COLUMN_LABELS,
  type AssetRowChainData,
  type VaultGateState,
} from './assetRows'

// issue #133：卡片牆 → 資產表。所有值得測的判斷（分級解析、費率推導、排序、
// 買賣可用性）都擠進這個純函式，元件退化成渲染器——這份測試就是驗證那句話。

const NOW_MS = new Date('2027-01-01T00:00:00Z').getTime()

type CarbonOverride = Partial<NonNullable<AssetMeta['carbon']>>

// carbon: null 是刻意的第三種狀態——「這顆資產沒有 carbon 欄位」,跟
// 「省略 carbon,套用底下的預設值」不一樣,兩者不能共用 undefined 表示。
function meta(over: Partial<Omit<AssetMeta, 'carbon'>> & { carbon?: CarbonOverride | null } = {}): AssetMeta {
  const { carbon: carbonOverride, ...rest } = over
  const carbon: AssetMeta['carbon'] =
    carbonOverride === null
      ? undefined
      : {
          intensity: null,
          basis: 'qualitative',
          tier: 'low',
          observed: '2026-09-02', // ~4 個月前，未過期
          sourceUrl: 'https://example.com',
          ...carbonOverride,
        }
  return {
    symbol: 'sTEST',
    name: 'Test Asset',
    category: 'equity',
    regulated: false,
    icon: '?',
    carbon,
    ...rest,
  }
}

function chainRow(over: Partial<AssetRowChainData> = {}): AssetRowChainData {
  return {
    symbol: 'sTEST',
    meta: meta(),
    price: 100_00000000n, // 8-dec
    updatedAtSec: Math.floor(NOW_MS / 1000) - 60, // 1 分鐘前
    balance: 0n,
    cap: 0n,
    issued: 0n,
    ...over,
  }
}

const OPEN_GATE: VaultGateState = { paused: false, mintingHalted: false, stale: false }

describe('tierForAsset · 分級解析', () => {
  it('見證未過期時用資產自己的分級', () => {
    expect(tierForAsset(meta({ carbon: { tier: 'high', observed: '2026-09-02' } }), NOW_MS)).toBe('high')
  })

  it('見證過期時一律回未評等，不論原本是哪一級', () => {
    const longAgo = '2020-01-01' // 遠早於一年前
    expect(tierForAsset(meta({ carbon: { tier: 'low', observed: longAgo } }), NOW_MS)).toBe('unrated')
    expect(tierForAsset(meta({ carbon: { tier: 'high', observed: longAgo } }), NOW_MS)).toBe('unrated')
  })

  it('沒有 carbon 欄位時 fail-closed 回未評等', () => {
    expect(tierForAsset(meta({ carbon: null }), NOW_MS)).toBe('unrated')
  })

  it('沒有可稽核來源（observed = "—"）視同過期 → 未評等', () => {
    expect(tierForAsset(meta({ carbon: { tier: 'low', observed: '—' } }), NOW_MS)).toBe('unrated')
  })
})

describe('buildAssetRows · 費率推導', () => {
  it('費率取自 carbon.ts 的 paramsFor，不是這裡自己寫死的數字', () => {
    const rows = buildAssetRows(
      [
        chainRow({ symbol: 'sLOW', meta: meta({ symbol: 'sLOW', carbon: { tier: 'low' } }) }),
        chainRow({ symbol: 'sMID', meta: meta({ symbol: 'sMID', carbon: { tier: 'mid' } }) }),
        chainRow({ symbol: 'sHIGH', meta: meta({ symbol: 'sHIGH', carbon: { tier: 'high' } }) }),
      ],
      OPEN_GATE,
      { nowMs: NOW_MS },
    )
    expect(rows.find((r) => r.symbol === 'sLOW')!.tradingFeeBps).toBe(paramsFor('low').tradingFeeBps)
    expect(rows.find((r) => r.symbol === 'sMID')!.tradingFeeBps).toBe(paramsFor('mid').tradingFeeBps)
    expect(rows.find((r) => r.symbol === 'sHIGH')!.tradingFeeBps).toBe(paramsFor('high').tradingFeeBps)
  })

  it('未評等資產拿到最保守級的費率（與 high 同一份 paramsFor 結果）', () => {
    const [row] = buildAssetRows(
      [chainRow({ meta: meta({ carbon: { observed: '2020-01-01' } }) })],
      OPEN_GATE,
      { nowMs: NOW_MS },
    )
    expect(row.tier).toBe('unrated')
    expect(row.tradingFeeBps).toBe(paramsFor('unrated').tradingFeeBps)
    expect(row.tradingFeeBps).toBe(paramsFor('high').tradingFeeBps)
  })
})

describe('buildAssetRows · 買進可用性', () => {
  it('三者皆正常時可以買', () => {
    const [row] = buildAssetRows([chainRow()], { paused: false, mintingHalted: false, stale: false }, { nowMs: NOW_MS })
    expect(row.canBuy).toBe(true)
  })

  it('暫停時不能買', () => {
    const [row] = buildAssetRows([chainRow()], { paused: true, mintingHalted: false, stale: false }, { nowMs: NOW_MS })
    expect(row.canBuy).toBe(false)
  })

  it('鑄造停止時不能買', () => {
    const [row] = buildAssetRows([chainRow()], { paused: false, mintingHalted: true, stale: false }, { nowMs: NOW_MS })
    expect(row.canBuy).toBe(false)
  })

  it('儲備率不可信（stale）時不能買', () => {
    const [row] = buildAssetRows([chainRow()], { paused: false, mintingHalted: false, stale: true }, { nowMs: NOW_MS })
    expect(row.canBuy).toBe(false)
  })

  it('paused 為 null（沒有這個概念的舊版金庫）時不擋買進', () => {
    const [row] = buildAssetRows([chainRow()], { paused: null, mintingHalted: false, stale: false }, { nowMs: NOW_MS })
    expect(row.canBuy).toBe(true)
  })
})

describe('buildAssetRows · 贖回可用性', () => {
  it('只有暫停擋得住贖回——鑄造停止與比率不可信都不影響', () => {
    const withBalance = chainRow({ balance: 1_000000000000000000n })
    expect(buildAssetRows([withBalance], { paused: false, mintingHalted: true, stale: false }, { nowMs: NOW_MS })[0].canSell).toBe(true)
    expect(buildAssetRows([withBalance], { paused: false, mintingHalted: false, stale: true }, { nowMs: NOW_MS })[0].canSell).toBe(true)
    expect(buildAssetRows([withBalance], { paused: true, mintingHalted: false, stale: false }, { nowMs: NOW_MS })[0].canSell).toBe(false)
  })

  it('餘額為零仍然出現在表上，只是贖回不可用；買進不受影響', () => {
    const rows = buildAssetRows([chainRow({ balance: 0n })], OPEN_GATE, { nowMs: NOW_MS })
    expect(rows).toHaveLength(1)
    expect(rows[0].canSell).toBe(false)
    expect(rows[0].canBuy).toBe(true)
  })

  it('paused 為 null 時不擋贖回', () => {
    const [row] = buildAssetRows(
      [chainRow({ balance: 1_000000000000000000n })],
      { paused: null, mintingHalted: false, stale: false },
      { nowMs: NOW_MS },
    )
    expect(row.canSell).toBe(true)
  })
})

describe('buildAssetRows · 價格新鮮度', () => {
  it('剛更新的價格分級為 live', () => {
    const [row] = buildAssetRows([chainRow({ updatedAtSec: Math.floor(NOW_MS / 1000) - 60 })], OPEN_GATE, {
      nowMs: NOW_MS,
      maxPriceAgeSec: 21600,
    })
    expect(row.freshness.level).toBe('live')
  })

  it('超過 maxPriceAgeSec 的價格分級為 stale', () => {
    const [row] = buildAssetRows(
      [chainRow({ updatedAtSec: Math.floor(NOW_MS / 1000) - 999999 })],
      OPEN_GATE,
      { nowMs: NOW_MS, maxPriceAgeSec: 21600 },
    )
    expect(row.freshness.level).toBe('stale')
  })

  it('updatedAtSec 為 0（從未讀到）分級為 unknown', () => {
    const [row] = buildAssetRows([chainRow({ updatedAtSec: 0 })], OPEN_GATE, { nowMs: NOW_MS })
    expect(row.freshness.level).toBe('unknown')
  })
})

describe('buildAssetRows · 缺失資料時 fail-closed', () => {
  it('meta 是 undefined 時仍然回一列，name 退回 symbol、分級為未評等', () => {
    const [row] = buildAssetRows([chainRow({ meta: undefined })], OPEN_GATE, { nowMs: NOW_MS })
    expect(row.symbol).toBe('sTEST')
    expect(row.name).toBe('sTEST')
    expect(row.tier).toBe('unrated')
  })
})

describe('sortAssetRows · 預設排序（依碳分級）', () => {
  const rows = buildAssetRows(
    [
      chainRow({ symbol: 'sHighA', meta: meta({ symbol: 'sHighA', name: 'Zeta Corp', carbon: { tier: 'high' } }) }),
      chainRow({ symbol: 'sLowA', meta: meta({ symbol: 'sLowA', name: 'Beta Corp', carbon: { tier: 'low' } }) }),
      chainRow({ symbol: 'sUnratedA', meta: meta({ symbol: 'sUnratedA', name: 'Alpha Corp', carbon: { observed: '2020-01-01' } }) }),
      chainRow({ symbol: 'sMidA', meta: meta({ symbol: 'sMidA', name: 'Delta Corp', carbon: { tier: 'mid' } }) }),
      chainRow({ symbol: 'sLowB', meta: meta({ symbol: 'sLowB', name: 'Gamma Corp', carbon: { tier: 'low' } }) }),
    ],
    OPEN_GATE,
    { nowMs: NOW_MS },
  )

  it('低碳在前、未評等排在最後', () => {
    const order = sortAssetRows(rows, 'tier').map((r) => r.tier)
    expect(order).toEqual(['low', 'low', 'mid', 'high', 'unrated'])
  })

  it('同級內順序穩定，不重新洗牌', () => {
    const order = sortAssetRows(rows, 'tier').map((r) => r.symbol)
    // sLowA 在輸入陣列裡排在 sLowB 前面，兩者同為 low，排序後仍要維持這個相對順序。
    expect(order.indexOf('sLowA')).toBeLessThan(order.indexOf('sLowB'))
  })

  it('依名稱排序時不修改原陣列', () => {
    const before = rows.map((r) => r.symbol)
    sortAssetRows(rows, 'name')
    expect(rows.map((r) => r.symbol)).toEqual(before)
  })

  it('依名稱排序是依 AssetRow.name（畫面上顯示的名稱），不是代號', () => {
    // 特意讓代號的字母序（sHighA/sLowA/sLowB/sMidA/sUnratedA）跟名稱的字母序
    // （Alpha/Beta/Delta/Gamma/Zeta）不一致，這樣代號排序不會巧合地通過。
    const order = sortAssetRows(rows, 'name').map((r) => r.name)
    expect(order).toEqual(['Alpha Corp', 'Beta Corp', 'Delta Corp', 'Gamma Corp', 'Zeta Corp'])
  })

  it('依價格排序時最低價在前', () => {
    const priced = buildAssetRows(
      [
        chainRow({ symbol: 'sExpensive', price: 300_00000000n }),
        chainRow({ symbol: 'sCheap', price: 10_00000000n }),
        chainRow({ symbol: 'sMid', price: 100_00000000n }),
      ],
      OPEN_GATE,
      { nowMs: NOW_MS },
    )
    expect(sortAssetRows(priced, 'price').map((r) => r.symbol)).toEqual(['sCheap', 'sMid', 'sExpensive'])
  })

  it('依我的持有排序時持有最多的在前', () => {
    const held = buildAssetRows(
      [
        chainRow({ symbol: 'sSmall', balance: 1_000000000000000000n }),
        chainRow({ symbol: 'sNone', balance: 0n }),
        chainRow({ symbol: 'sBig', balance: 9_000000000000000000n }),
      ],
      OPEN_GATE,
      { nowMs: NOW_MS },
    )
    expect(sortAssetRows(held, 'balance').map((r) => r.symbol)).toEqual(['sBig', 'sSmall', 'sNone'])
  })
})

describe('buildAssetRows · 逐字傳遞給 Expert 專屬欄位用的原始資料', () => {
  it('cap / issued / updatedAtSec 原樣帶到 AssetRow 上，不重新計算', () => {
    const [row] = buildAssetRows(
      [chainRow({ cap: 500_000000000000000000n, issued: 120_000000000000000000n, updatedAtSec: 12345 })],
      OPEN_GATE,
      { nowMs: NOW_MS },
    )
    expect(row.cap).toBe(500_000000000000000000n)
    expect(row.issued).toBe(120_000000000000000000n)
    expect(row.updatedAtSec).toBe(12345)
  })
})

describe('assetRowColumnsForMode · issue #136 Mode 分流', () => {
  it('Simple 只有六欄：資產／身世／買入費率／價格／持有／操作', () => {
    expect(assetRowColumnsForMode('simple')).toEqual([
      'asset', 'provenance', 'tradingFee', 'price', 'balance', 'actions',
    ])
  })

  it('Expert 在 Simple 的基礎上多發行量／上限、預言機更新時間、資產 id 三欄', () => {
    const expert = assetRowColumnsForMode('expert')
    const simple = assetRowColumnsForMode('simple')
    for (const key of simple) expect(expert).toContain(key)
    expect(expert).toEqual(expect.arrayContaining(['issuedOverCap', 'priceUpdatedAt', 'assetId']))
    expect(expert.length).toBe(simple.length + 3)
  })

  it('操作欄永遠排最後', () => {
    expect(assetRowColumnsForMode('simple').at(-1)).toBe('actions')
    expect(assetRowColumnsForMode('expert').at(-1)).toBe('actions')
  })

  it('兩個模式都是資產、身世、買入費率三欄相鄰（碳分級與費率不能被拆開）', () => {
    for (const mode of ['simple', 'expert'] as const) {
      const cols = assetRowColumnsForMode(mode)
      const provenanceIdx = cols.indexOf('provenance')
      const feeIdx = cols.indexOf('tradingFee')
      expect(feeIdx, mode).toBe(provenanceIdx + 1)
    }
  })

  it('每一欄都有非空標籤，兩個模式各自的欄位集都涵蓋', () => {
    for (const mode of ['simple', 'expert'] as const) {
      for (const key of assetRowColumnsForMode(mode)) {
        expect(ASSET_ROW_COLUMN_LABELS[key].length, key).toBeGreaterThan(0)
      }
    }
  })
})

describe('assetRowColumnLabelForMode · Simple 不點名機制', () => {
  it('Simple 的價格欄叫「價格」，不是「Oracle 價格」——機制詞不該出現在 Simple', () => {
    expect(assetRowColumnLabelForMode('price', 'simple')).not.toBe(ASSET_ROW_COLUMN_LABELS.price)
    expect(assetRowColumnLabelForMode('price', 'simple').length).toBeGreaterThan(0)
  })

  it('Expert 的價格欄維持原本的標籤，一個字不動', () => {
    expect(assetRowColumnLabelForMode('price', 'expert')).toBe(ASSET_ROW_COLUMN_LABELS.price)
  })

  it('沒有 Simple 專屬覆寫的欄位沿用同一份標籤（例如資產、操作）', () => {
    expect(assetRowColumnLabelForMode('asset', 'simple')).toBe(ASSET_ROW_COLUMN_LABELS.asset)
    expect(assetRowColumnLabelForMode('actions', 'simple')).toBe(ASSET_ROW_COLUMN_LABELS.actions)
  })
})
