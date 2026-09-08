// issue #133：資產表的每一列由這裡算出來——分級解析、費率推導、排序、
// 買賣可用性全部擠進這個純函式,元件退化成渲染器。前端測試跑在
// `environment: 'node'`,不渲染元件,所以這裡是唯一測得到這些判斷的地方。

import type { Mode } from 'src/contexts/mode-context'

import { t } from 'src/locales'

import type { AssetMeta } from './assetMeta'
import { holdingValue } from './assetClass'
import { attestationExpired, paramsFor, type Tier } from './carbon'
import { classifyFreshness, type Freshness } from './priceFreshness'

/** 合約的 maxPriceAge；預設 Base Sepolia 的 6 小時，對齊 AssetProvenanceBody。 */
export const DEFAULT_MAX_PRICE_AGE_SEC = 21600

/** 一顆資產從鏈上讀回來的原始資料——這個模組唯一需要的輸入。 */
export interface AssetRowChainData {
  symbol: string
  meta: AssetMeta | undefined
  /** 8-dec oracle 價格，0n 代表尚未讀到。 */
  price: bigint
  /** oracle updatedAt（秒），0 代表尚未讀到。 */
  updatedAtSec: number
  /** 18-dec 代幣餘額。 */
  balance: bigint
  /**
   * #136：Expert 專屬的 issuedOverCap 欄要用。舊版金庫沒有這個概念，
   * 呼叫端已經把它們正規化成 0n（跟 refresh() 對 V1 的既有作法一致）——
   * 這裡原樣帶到 AssetRow，不重新判斷「這是不是硬化版金庫」。
   */
  cap: bigint
  issued: bigint
}

/**
 * 買進／贖回的閘門狀態。三個欄位直接對應金庫的三個鏈上信號；呼叫端負責
 * 在沒有這些概念的舊版金庫上把它們正規化成不擋單的值（paused: null,
 * mintingHalted/stale: false）——這裡不重複判斷「這是不是硬化版金庫」,
 * 只讀呼叫端已經正規化過的三個旗標。
 */
export interface VaultGateState {
  /** null：這個概念在這條鏈上不存在（舊版金庫），不擋單。 */
  paused: boolean | null
  mintingHalted: boolean
  stale: boolean
}

export interface AssetRow {
  symbol: string
  name: string
  /** 見證過期一律視同未評等，見 tierForAsset。 */
  tier: Tier
  /** 買進費率（bps），來自 carbon.ts 的 paramsFor(tier)——這裡不重複定義任何數字。 */
  tradingFeeBps: number
  price: bigint
  balance: bigint
  /**
   * 持有市值，18-dec USD——用 assetClass.ts 的 holdingValue 算，全程 bigint。
   * balance(18) × price(8) 若各自先轉成 Number 再相乘，餘額大到超過 2^53
   * 就會悄悄掉精度；holdingValue 把乘法留在 bigint 裡做，只有渲染前的最後
   * 一步才轉成 Number。
   */
  usdValue: bigint
  freshness: Freshness
  canBuy: boolean
  canSell: boolean
  /** #136：Expert 專屬欄位的原始資料，逐字帶過來，見 AssetRowChainData。 */
  cap: bigint
  issued: bigint
  updatedAtSec: number
}

/**
 * 一顆資產現在的碳分級。
 *
 * 見證過期（或根本沒有 carbon 資料）一律 fail-closed 回 unrated——「沒有
 * 資料」不能被當成「沒有問題」。這是唯一的定義；AssetProvenanceBody 的
 * shownTier 呼叫這個函式，不是自己重算一次。
 */
export function tierForAsset(meta: AssetMeta | undefined, nowMs: number): Tier {
  const c = meta?.carbon
  if (!c) return 'unrated'
  return attestationExpired(c.observed, nowMs) ? 'unrated' : c.tier
}

export function buildAssetRows(
  inputs: readonly AssetRowChainData[],
  gate: VaultGateState,
  opts: { nowMs: number; maxPriceAgeSec?: number },
): AssetRow[] {
  const nowSec = Math.floor(opts.nowMs / 1000)
  const maxPriceAgeSec = opts.maxPriceAgeSec ?? DEFAULT_MAX_PRICE_AGE_SEC

  // #99：stale 之所以也擋買進，不是因為它跟這一項資產本身有關，而是因為
  // 一項資產的價格過期會讓 reserveRatioBps() 低估整個金庫的負債（那項資產
  // 從負債總和裡掉出去），使儲備率——以及 mintingHalted 的觸發條件本身——
  // 讀起來比實際健康。擋的是「整個金庫」的買入，不是只擋那一項過期的資產；
  // 該資產自己的價格若真的過期，mint() 呼叫 _price() 時還是會各自 revert。
  // 贖回不受這三者影響：docs/RISK_MODEL.md 與 CONTEXT.md 的 Unknown Ratio
  // 詞條——出場路徑不加阻力，儲備率與鑄造停止都不能擋贖回。
  const buyBlocked = gate.paused === true || gate.mintingHalted || gate.stale
  const sellBlockedByVault = gate.paused === true

  return inputs.map((input) => {
    const tier = tierForAsset(input.meta, opts.nowMs)
    const { tradingFeeBps } = paramsFor(tier)
    const freshness = classifyFreshness({
      updatedAtSec: input.updatedAtSec,
      nowSec,
      maxPriceAgeSec,
    })

    return {
      symbol: input.symbol,
      name: input.meta?.name ?? input.symbol,
      tier,
      tradingFeeBps,
      price: input.price,
      balance: input.balance,
      usdValue: holdingValue({ asset: input.symbol, balance: input.balance, price: input.price }),
      freshness,
      canBuy: !buyBlocked,
      canSell: !sellBlockedByVault && input.balance > 0n,
      cap: input.cap,
      issued: input.issued,
      updatedAtSec: input.updatedAtSec,
    }
  })
}

export type AssetSortKey = 'tier' | 'price' | 'balance' | 'name'

// unrated 排最後——CarbonTiers.Tier 在合約端把 Unrated 放在序數 0（見
// contracts/src/CarbonTiers.sol 的 NatSpec），但那是「未評等與 high 同一份
// 費率參數」的實作巧合,不是畫面該有的順序。使用者看到的順序要說「這是我們
// 最不希望你碰的東西」,未評等（不知道有沒有問題）跟 high（已知有問題）
// 一樣不該排在低碳前面。
const TIER_RANK: Record<Tier, number> = { low: 0, mid: 1, high: 2, unrated: 3 }

/**
 * 依欄位排序，一律回傳新陣列（不修改呼叫端傳進來的 rows）。
 *
 * 'tier' 是預設排序：低碳在前、未評等在後，同級內順序穩定——Array.prototype.sort
 * 自 ES2019 起保證穩定,不需要額外的 tie-break key。
 */
export function sortAssetRows(rows: readonly AssetRow[], sortKey: AssetSortKey): AssetRow[] {
  const copy = [...rows]
  switch (sortKey) {
    case 'tier':
      return copy.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])
    case 'price':
      // 便宜的在前——瀏覽時由小額資產開始看起。
      return copy.sort((a, b) => (a.price < b.price ? -1 : a.price > b.price ? 1 : 0))
    case 'balance':
      // 持有最多的在前——這個排序是給「我已經買了什麼」用的,由大到小才有用。
      return copy.sort((a, b) => (a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0))
    case 'name':
      // 排序標籤說的是「名稱」（AssetRow.name，畫面上的第二行說明），不是
      // 代號——兩者的字母序不保證一致（sGOOGL 排在最後,但它的名稱
      // 「Synthetic Alphabet Inc.」該排最前面附近）。
      return copy.sort((a, b) => a.name.localeCompare(b.name))
  }
}

// ── 欄位集 ───────────────────────────────────────────────────────────────────
//
// issue #136：Mode 分流。比照 openPositionColumns.ts 的
// openPositionColumnsForMode 作法——欄位是什麼、標籤在哪、哪個模式看得到,
// 判斷全部擠進這裡,元件不必自己決定表格長什麼樣。
//
// Expert 多出來的三欄是工程證據（發行量／上限、預言機更新時間、資產
// id）,Simple 不需要知道這些機制細節就能決定要不要買。見證筆數與離散度
// （#93 user story 14）目前沒有資料來源——ESGRegistryV2 的多見證者讀取是
// #128 才會接上的東西,frontend 現在的碳資料是單一解析後的分級,不是原始
// 見證紀錄——所以這裡先不放這一欄，而不是塞一個編出來的數字。

export type AssetRowColumnKey =
  | 'asset' | 'provenance' | 'tradingFee' | 'price' | 'balance' | 'actions'
  | 'issuedOverCap' | 'priceUpdatedAt' | 'assetId'

/** 資產／身世／買入費率三欄相鄰且順序固定——碳分級決定買入費率這件事,
 *  版面上必須是看得出來的因果,不是兩個各自獨立的欄位。操作欄固定排最後。 */
const SIMPLE_COLUMNS: AssetRowColumnKey[] = [
  'asset', 'provenance', 'tradingFee', 'price', 'balance', 'actions',
]

const EXPERT_COLUMNS: AssetRowColumnKey[] = [
  'asset', 'provenance', 'tradingFee', 'price', 'balance',
  'issuedOverCap', 'priceUpdatedAt', 'assetId', 'actions',
]

export function assetRowColumnsForMode(mode: Mode): AssetRowColumnKey[] {
  return mode === 'simple' ? SIMPLE_COLUMNS : EXPERT_COLUMNS
}

export const ASSET_ROW_COLUMN_LABELS: Record<AssetRowColumnKey, string> = t.tokens.table.column

// issue #136 code review：ticket 原文列 Simple 的欄位是「資產、價格、碳分級、
// 買入費率、我的持有」——是「價格」，不是「Oracle 價格」。Simple Mode 的
// 整條原則是機制不點名（CONTEXT.md 的 Perpetual 詞條、Simple Mode 定義都是
// 同一句話），Expert 才刻意保留交易桌的用字。比照 openPositionColumns.ts 的
// columnLabelForMode：沒有 Simple 專屬覆寫的欄位沿用同一份標籤。
// t.tokens.table.sort.price 已經是「價格」/「Price」，直接借用，不重新定義
// 第二個同樣意思的字串。
const SIMPLE_COLUMN_LABELS: Partial<Record<AssetRowColumnKey, string>> = {
  price: t.tokens.table.sort.price,
}

export function assetRowColumnLabelForMode(key: AssetRowColumnKey, mode: Mode): string {
  if (mode === 'simple') return SIMPLE_COLUMN_LABELS[key] ?? ASSET_ROW_COLUMN_LABELS[key]
  return ASSET_ROW_COLUMN_LABELS[key]
}
