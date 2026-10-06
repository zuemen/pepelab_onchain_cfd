import path from 'node:path'
import { it, expect, describe } from 'vitest'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ASSET_IDS, type AssetSymbol } from 'src/contracts/addresses'

import { RWA_CLASS, RWA_CARD_ORDER, keeperPrimary, keeperSecondary, refersToRealWorldAsset } from './rwaProfile'

// /rwa 卡片上的「參考價格來源」必須就是 keeper 實際用的來源。這支測試直接載入
// agent/keeper/feeds.ts 逐鍵比對（作法同 marketHours.keeper.test.ts：動態 import，
// 不讓前端的 tsc 收進 keeper 的檔案）。

const KEEPER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../agent/keeper')

type KeeperSource = { kind: 'coingecko'; id: string } | { kind: 'yahoo'; symbol: string }
interface KeeperFeeds {
  SOURCES: Record<string, KeeperSource>
  SECONDARY_SOURCES: Record<string, KeeperSource>
}

const load = (): Promise<KeeperFeeds> =>
  import(/* @vite-ignore */ pathToFileURL(path.join(KEEPER_DIR, 'feeds.ts')).href) as Promise<KeeperFeeds>

const tickerOf = (s: KeeperSource) => (s.kind === 'coingecko' ? s.id : s.symbol)

describe('rwaProfile vs agent/keeper/feeds.ts', () => {
  it('每檔的主來源與 keeper SOURCES 相同', async () => {
    const { SOURCES } = await load()
    expect(new Set(Object.keys(SOURCES))).toEqual(new Set(Object.keys(ASSET_IDS)))
    for (const [sym, src] of Object.entries(SOURCES)) {
      expect(keeperPrimary(sym as AssetSymbol), sym).toEqual({ provider: src.kind, ticker: tickerOf(src) })
    }
  })

  it('第二來源與 keeper SECONDARY_SOURCES 相同（股票、ETF、黃金沒有）', async () => {
    const { SECONDARY_SOURCES } = await load()
    for (const sym of Object.keys(ASSET_IDS) as AssetSymbol[]) {
      const k = SECONDARY_SOURCES[sym]
      expect(keeperSecondary(sym), sym).toEqual(k ? { provider: k.kind, ticker: tickerOf(k) } : null)
    }
  })
})

describe('RWA 類別', () => {
  it('11 檔都有類別、卡片順序涵蓋全部且不重複', () => {
    expect(new Set(RWA_CARD_ORDER)).toEqual(new Set(Object.keys(ASSET_IDS)))
    expect(RWA_CARD_ORDER).toHaveLength(Object.keys(ASSET_IDS).length)
    for (const s of RWA_CARD_ORDER) expect(RWA_CLASS[s]).toBeTruthy()
  })

  it('9 檔參照現實世界資產，2 檔加密不是', () => {
    expect(RWA_CARD_ORDER.filter(refersToRealWorldAsset)).toHaveLength(9)
    expect(refersToRealWorldAsset('sGOLD')).toBe(true)
    expect(refersToRealWorldAsset('sBTC')).toBe(false)
    expect(RWA_CLASS.sICLN).toBe('esgEtf')
    expect(RWA_CLASS.sBOND).toBe('bondEtf')
  })
})
