// /exchange 兌換卡「池子資訊」區的純函式（#165）。
//
// 背景：前端 ABI 是 PepeAMM 的最新版（恆定乘積 + oracle 偏離保護，有
// `oraclePrice()`），但 Base Sepolia 上 0x93be…6d63 實際跑的是**更早的版本**
// （commit 9030ff1：依 oracle 報價固定定價、無滑點）。兩版的 `getPrice()`
// selector 相同、意義相反：
//
//   | 版本            | getPrice()                    | 兌換怎麼定價          | oraclePrice() |
//   |-----------------|-------------------------------|-----------------------|---------------|
//   | plain-cp (v1)   | usdcReserve*1e18/ethReserve   | 恆定乘積              | 無            |
//   | oracle-fixed(v2)| oracle 報價 ×1e10             | oracle × 數量（扣 fee）| 無            |
//   | banded-cp (v3)  | usdcReserve*1e18/ethReserve   | 恆定乘積 + 偏離保護   | 有            |
//
// 舊頁面把 v2 的 `getPrice()`（oracle 價）標成「池內現價」，跟儲備量對不上；
// `oraclePrice()` 在 v2 不存在 → revert → 「—」。這裡改成：
//   1. 先從 bytecode 探測合約版本（能力探測），不靠「呼叫失敗了」去猜。
//   2. 池內現價一律由**同一次讀到的儲備量**算出，不可能與儲備對不上。
//   3. 讀失敗 → 「無法取得」；合約沒有該函式 → 不顯示該欄、改顯示說明。
//   4. 價格衝擊的基準跟著合約實際定價方式走（v2 以 oracle 價為基準）。
//
// #215 審查之後再加三條：
//   5. v2 的判斷不只靠排除法：bytecode 要「有 oracle()、沒有 oraclePrice()、**也沒有
//      totalShares()**」（有 LP 份額的就是某種恆定乘積池，不是 v2），而且執行期再以
//      `getPrice() == oracle 報價 × 1e10` 正向確認（`checkOracleFixed`）。
//   6. 「還沒讀完」與「無法確認」是兩種狀態、兩句話（`buildSwapCardView` 的 probing）。
//   7. v2 的 quote 不看庫存：`quotedOut` 超過輸出側庫存時整筆換不成，畫面要直接說、
//      按鈕要停用（`checkInventory`），而不是顯示一個換不到的數字。

import { minOutWithSlippage } from './ammQuote'
import { scanPush4Selectors } from './selectorScan'

/**
 * 要探測的 4-byte selector。測試會以 ethers 的 `id()` 逐一重算核對，並確認
 * 沒有一個以 0x00 開頭（`scanPush4Selectors` 只認 PUSH4，見其註解）。
 */
export const AMM_SELECTORS = {
  getPrice:     '0x98d5fdca', // getPrice()
  getReserves:  '0x0902f1ac', // getReserves()
  oracle:       '0x7dc0d1d0', // oracle()
  oraclePrice:  '0x668aa824', // oraclePrice()
  maxOracleAge: '0x7c87a993', // maxOracleAge()
  totalShares:  '0x3a98ef39', // totalShares()：有 LP 份額 → 恆定乘積池（v3），v2 沒有
} as const

export type AmmPricing = 'banded-cp' | 'oracle-fixed' | 'plain-cp' | 'unknown'

export interface AmmCapabilities {
  pricing: AmmPricing
  /** 有 `oraclePrice()` 可讀（只有 v3）。 */
  hasOraclePrice: boolean
  /** 有 `maxOracleAge()`，也就是 swap 會在 oracle 過期時 revert（只有 v3）。 */
  hasMaxOracleAge: boolean
}

export const UNKNOWN_CAPABILITIES: AmmCapabilities = {
  pricing: 'unknown',
  hasOraclePrice: false,
  hasMaxOracleAge: false,
}

/**
 * 從線上 bytecode 判斷 PepeAMM 是哪一版。
 *
 * `code` 為 null（讀不到）、`0x`（沒部署），或連 getPrice/getReserves 都沒有 →
 * `unknown`：呼叫端應該把價格欄全部顯示成「無法取得」，而不是猜。
 */
export function detectAmmCapabilities(code: string | null | undefined): AmmCapabilities {
  if (!code || code === '0x') return UNKNOWN_CAPABILITIES
  const present = scanPush4Selectors(code)
  const has = (s: string) => present.has(s)
  if (!has(AMM_SELECTORS.getPrice) || !has(AMM_SELECTORS.getReserves)) return UNKNOWN_CAPABILITIES

  const hasOraclePrice = has(AMM_SELECTORS.oraclePrice)
  const hasMaxOracleAge = has(AMM_SELECTORS.maxOracleAge)
  let pricing: AmmPricing
  if (hasOraclePrice) pricing = 'banded-cp'
  else if (has(AMM_SELECTORS.oracle)) {
    // 有 oracle() 卻沒有 oraclePrice()：v2 的特徵，但光憑這點是排除法。v2 沒有 LP 份額
    // （addLiquidity 是 onlyOwner、不發 share）；若出現 totalShares()，那是某種我們不認得
    // 的「有 oracle 的恆定乘積池」，getPrice() 的意義不明 → unknown，不要標成 Oracle 定價。
    if (has(AMM_SELECTORS.totalShares)) return UNKNOWN_CAPABILITIES
    pricing = 'oracle-fixed'
  } else pricing = 'plain-cp'
  return { pricing, hasOraclePrice, hasMaxOracleAge }
}

/**
 * v2（oracle-fixed）的執行期正向確認：這一版的 `getPrice()` 就是 oracle 報價（8 dec）
 * 乘上 1e10。恆定乘積池的 `getPrice()` 是儲備比例，不會剛好等於它。
 *
 * - `confirmed`：兩個值都讀到、而且相等。
 * - `contradicted`：兩個值都讀到、卻不相等 → bytecode 像 v2 但行為不是，呼叫端應降為 unknown。
 * - `unverified`：有值讀不到 → 無法確認，維持 bytecode 的判斷（已含「沒有 totalShares()」）。
 */
export type OracleFixedCheck = 'confirmed' | 'contradicted' | 'unverified'

export function checkOracleFixed(getPrice: bigint | null, oraclePrice8: bigint | null): OracleFixedCheck {
  if (getPrice === null || oraclePrice8 === null || oraclePrice8 <= 0n) return 'unverified'
  return getPrice === oraclePrice8 * 10n ** 10n ? 'confirmed' : 'contradicted'
}

export function sameCapabilities(a: AmmCapabilities, b: AmmCapabilities): boolean {
  return a.pricing === b.pricing && a.hasOraclePrice === b.hasOraclePrice && a.hasMaxOracleAge === b.hasMaxOracleAge
}

/**
 * 儲備量推出的池內現價（1 ETH = ? USDC，18 dec），與合約 v1/v3 的 `getPrice()`
 * 同一條公式。任一側為 0 → null（不是 0：價格 0 是一個會被誤讀的數字）。
 */
export function reservePrice18(ethReserve: bigint, usdcReserve: bigint): bigint | null {
  if (ethReserve <= 0n || usdcReserve <= 0n) return null
  return (usdcReserve * 10n ** 18n) / ethReserve
}

/** 18 dec 的 bigint → 固定小數位字串。 */
export function format18(v: bigint, decimals = 2): string {
  return (Number(v) / 1e18).toFixed(decimals)
}

// ── 畫面模型 ────────────────────────────────────────────────────────────────

/**
 * 一格數字的四種狀態：
 * - `value`：讀到了、而且確定是這個欄位該有的意義。
 * - `unavailable`：這版合約有這個值，但這次讀不到 → 顯示「無法取得」。
 * - `unsupported`：這版合約根本沒有這個值 → 不顯示該欄，改顯示說明。
 * - `loading`：還沒讀完 → 顯示「讀取中…」。不可以說成「無法取得」。
 */
export type Cell =
  | { kind: 'value'; text: string }
  | { kind: 'unavailable' }
  | { kind: 'unsupported' }
  | { kind: 'loading' }

export interface PoolReads {
  /** `getPrice()` 原始值；null = 讀取失敗。 */
  getPrice: bigint | null
  /** `getReserves()`；null = 讀取失敗。 */
  reserves: readonly [bigint, bigint] | null
  /** `oraclePrice()` 的 price18；null = 讀取失敗或合約沒有。 */
  oraclePrice: bigint | null
}

export interface PoolInfoView {
  pricing: AmmPricing
  /** 恆定乘積池的池內現價（由儲備算出）。oracle-fixed 版沒有這個概念 → unsupported。 */
  poolPrice: Cell
  /** oracle-fixed 版的兌換價（合約 getPrice() = oracle 報價）。其他版 → unsupported。 */
  oracleRate: Cell
  /** Oracle 參考價（v3 的 oraclePrice()）。 */
  oracleRef: Cell
  /** 儲備量；ETH 4 位、USDC 2 位小數。 */
  reserves: { kind: 'value'; eth: string; usdc: string } | { kind: 'unavailable' } | { kind: 'loading' }
}

const UNAVAILABLE: Cell = { kind: 'unavailable' }
const UNSUPPORTED: Cell = { kind: 'unsupported' }

function priceCell(v: bigint | null): Cell {
  return v !== null && v > 0n ? { kind: 'value', text: format18(v, 2) } : UNAVAILABLE
}

export function buildPoolInfoView(caps: AmmCapabilities, reads: PoolReads): PoolInfoView {
  const reserves: PoolInfoView['reserves'] = reads.reserves
    ? { kind: 'value', eth: format18(reads.reserves[0], 4), usdc: format18(reads.reserves[1], 2) }
    : { kind: 'unavailable' }
  const fromReserves = reads.reserves ? reservePrice18(reads.reserves[0], reads.reserves[1]) : null

  switch (caps.pricing) {
    case 'banded-cp':
      return {
        pricing: caps.pricing,
        poolPrice: priceCell(fromReserves),
        oracleRate: UNSUPPORTED,
        oracleRef: priceCell(reads.oraclePrice),
        reserves,
      }
    case 'plain-cp':
      return {
        pricing: caps.pricing,
        poolPrice: priceCell(fromReserves),
        oracleRate: UNSUPPORTED,
        oracleRef: UNSUPPORTED,
        reserves,
      }
    case 'oracle-fixed':
      // 這一版的 getPrice() 是 oracle 報價，兌換也照它成交；儲備只是庫存。
      return {
        pricing: caps.pricing,
        poolPrice: UNSUPPORTED,
        oracleRate: priceCell(reads.getPrice),
        oracleRef: UNSUPPORTED,
        reserves,
      }
    default:
      // 版本不明 → getPrice() 的意義不明，寧可不顯示也不要猜錯。
      return {
        pricing: 'unknown',
        poolPrice: UNAVAILABLE,
        oracleRate: UNSUPPORTED,
        oracleRef: UNAVAILABLE,
        reserves,
      }
  }
}

/**
 * 價格衝擊的中價基準，以 `priceImpactBps` 的 reserveIn/reserveOut 形式回傳。
 *
 * - 恆定乘積（v1/v3）：中價 = 儲備比例。
 * - oracle-fixed（v2）：合約照 oracle 價成交，中價 = getPrice()；拿儲備比例當
 *   基準會在 ETH→USDC 算出 50% 以上的假衝擊、在 USDC→ETH 被夾成 0%。
 * - 版本不明或缺資料 → null（不顯示衝擊）。
 */
export function impactReference(
  caps: AmmCapabilities,
  isEthIn: boolean,
  reads: Pick<PoolReads, 'getPrice' | 'reserves'>,
): { reserveIn: bigint; reserveOut: bigint } | null {
  if (caps.pricing === 'banded-cp' || caps.pricing === 'plain-cp') {
    if (!reads.reserves) return null
    const [eth, usdc] = reads.reserves
    if (eth <= 0n || usdc <= 0n) return null
    return isEthIn ? { reserveIn: eth, reserveOut: usdc } : { reserveIn: usdc, reserveOut: eth }
  }
  if (caps.pricing === 'oracle-fixed') {
    const p = reads.getPrice
    if (p === null || p <= 0n) return null
    const ONE = 10n ** 18n
    // 1 ETH ↔ p USDC 這組「虛擬儲備」的比例就是 oracle 中價。
    return isEthIn ? { reserveIn: ONE, reserveOut: p } : { reserveIn: p, reserveOut: ONE }
  }
  return null
}

// ── 兌換卡整體的畫面模型（#215 審查）──────────────────────────────────────────

/** 後讀到的值蓋掉先讀到的；`fresh` 裡的 null（沒讀或讀失敗）不蓋。 */
export function mergePoolReads(base: PoolReads, fresh: Partial<PoolReads>): PoolReads {
  return {
    getPrice: fresh.getPrice ?? base.getPrice,
    reserves: fresh.reserves ?? base.reserves,
    oraclePrice: fresh.oraclePrice ?? base.oraclePrice,
  }
}

/**
 * 這筆 quote 換不換得出來——只看輸出側的庫存。
 *
 * v2 的 `quoteETHForUSDC` / `quoteUSDCForETH` 完全不看庫存（oracle 價 × 數量），所以
 * 0.2 ETH 會報出 542 USDC，而池裡只有 382；swap 才 revert「insufficient … reserve in pool」。
 * 恆定乘積版的 quote 數學上一定小於儲備，這裡只是多一道保險（合約是 `out >= reserve` 就拒絕）。
 *
 * 儲備讀不到 → `unknown`：不擋（送出前的 eth_call 預檢還會再擋一次），也不說「庫存足夠」。
 */
export type InventoryCheck =
  | { status: 'ok' }
  | { status: 'unknown' }
  | { status: 'exceeded'; needed: bigint; available: bigint }

export function checkInventory(
  caps: AmmCapabilities,
  isEthIn: boolean,
  quotedOut: bigint,
  reserves: readonly [bigint, bigint] | null,
): InventoryCheck {
  if (!reserves) return { status: 'unknown' }
  const available = isEthIn ? reserves[1] : reserves[0]
  const cp = caps.pricing === 'banded-cp' || caps.pricing === 'plain-cp'
  const exceeded = cp ? quotedOut >= available : quotedOut > available
  return exceeded ? { status: 'exceeded', needed: quotedOut, available } : { status: 'ok' }
}

/** 畫面上顯示的那一筆 quote（由 ammSwapFlow.readQuoteSnapshot 產生）。 */
export interface QuoteView {
  isEthIn: boolean
  /** 這筆 quote 是替哪個金額算的。與目前輸入框的金額不同，就不是「這一筆」的報價。 */
  amountIn: bigint
  out: bigint
  impactBps: number | null
  inventory: InventoryCheck
}

/**
 * 最近一次報價請求的結果，連同它是替**哪個方向、哪個金額**問的（#220 L）。
 * `quote` 為 null = 這組方向＋金額的 quote 失敗（revert／逾時）。
 */
export interface QuoteSlot<Q extends QuoteView = QuoteView> {
  isEthIn: boolean
  amountIn: bigint
  quote: Q | null
  /**
   * 這筆結果寫進 state 的時間（ms）。搭配 `resolveLiveQuote` 的 `maxAgeMs`：放太久的報價
   * （例如分頁在背景時定時器停了）在新報價回來前視為 pending（PR #223 L3）。
   */
  fetchedAt?: number
}

/**
 * 對目前輸入而言，畫面能用的報價狀態：
 * - `noAmount`：沒有有效金額。
 * - `pending`：金額或方向改了，新報價還沒回來——**舊數字一律不顯示**，按鈕停用。
 * - `failed`：這組金額的 quote 失敗（換不成）。
 * - `ready`：報價就是替目前這組方向＋金額算的。
 */
export type LiveQuote<Q extends QuoteView = QuoteView> =
  | { status: 'noAmount' }
  | { status: 'pending' }
  | { status: 'failed' }
  | { status: 'ready'; quote: Q }

/**
 * #220：只認「目前方向、**目前金額**」的那筆報價。原本只比對方向，把 30 改成 60 之後、
 * 60 的報價回來之前，畫面會顯示 30 的收到數量／衝擊／最低收到，按鈕還能按。
 */
export function resolveLiveQuote<Q extends QuoteView>(
  slot: QuoteSlot<Q> | null,
  isEthIn: boolean,
  amountIn: bigint | null,
  freshness?: { now: number; maxAgeMs: number },
): LiveQuote<Q> {
  if (amountIn === null || amountIn <= 0n) return { status: 'noAmount' }
  if (!slot || slot.isEthIn !== isEthIn || slot.amountIn !== amountIn) return { status: 'pending' }
  // 太舊（或沒有時間戳卻要求新鮮度）→ 等新報價。
  if (freshness && (slot.fetchedAt === undefined || freshness.now - slot.fetchedAt > freshness.maxAgeMs)) {
    return { status: 'pending' }
  }
  if (!slot.quote) return { status: 'failed' }
  // slot 與 quote 本身各帶一份方向＋金額；兩份都要對得上（防止把別筆 quote 塞進這個 slot）。
  if (slot.quote.isEthIn !== isEthIn || slot.quote.amountIn !== amountIn) return { status: 'pending' }
  return { status: 'ready', quote: slot.quote }
}

/**
 * 輸入框的字串 → 18 位小數的金額。空字串、0、負數、格式不對、小數超過 18 位 → null
 * （＝沒有有效金額）。與 `parseEther` 同一套規則，但不丟例外。
 */
export function parseAmountIn(text: string): bigint | null {
  const s = text.trim()
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s)
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null
  const frac = m[2] ?? ''
  if (frac.length > 18) return null
  const v = BigInt(m[1] || '0') * 10n ** 18n + BigInt((frac + '0'.repeat(18)).slice(0, 18) || '0')
  return v > 0n ? v : null
}

export interface SwapCardInput {
  /** 版本探測還沒回來。和「探測完了但認不出來」是兩回事。 */
  probing: boolean
  caps: AmmCapabilities
  reads: PoolReads
  isEthIn: boolean
  /** 對目前方向＋金額而言的報價狀態（`resolveLiveQuote`）。 */
  live: LiveQuote
  oracleStale: boolean
  busy: boolean
}

/** `t.exchange.swap` 底下的 key。畫面模型只回 key，文字由頁面查 catalog。 */
export type SwapNoteKey =
  | 'oracleFixedNote'
  | 'constantProductNote'
  | 'noOracleRefNote'
  | 'unknownVersionNote'
  | 'checkingVersionNote'

export type SwapButtonLabel =
  | 'swapping'
  | 'oracleStale'
  | 'enterAmount'
  | 'quoting'
  | 'quoteUnavailable'
  | 'amountTooSmall'
  | 'exceedsInventory'
  | 'swap'

export interface SwapCardView {
  /** 'loading' = 還在確認版本。 */
  version: AmmPricing | 'loading'
  pool: PoolInfoView
  badge: 'oracleFixedBadge' | 'poolBadge' | null
  reservesLabel: 'poolInventory' | 'poolReserves'
  notes: readonly SwapNoteKey[]
  /** 新報價還沒回來（金額或方向剛改）：「你將收到」顯示讀取中，不顯示舊數字。 */
  quotePending: boolean
  /** 「你將收到」那一格；null = 沒有可成交的數字（顯示 0，不顯示換不到的數字）。 */
  receive: bigint | null
  impactBps: number | null
  /** 尚未套用滑點的 quote；null = 不顯示「最低收到數量」。 */
  minReceivedBase: bigint | null
  inventoryExceeded: { needed: bigint; available: bigint } | null
  button: { disabled: boolean; label: SwapButtonLabel }
}

const LOADING: Cell = { kind: 'loading' }

export function buildSwapCardView(input: SwapCardInput): SwapCardView {
  const { probing, caps, reads, isEthIn, live, oracleStale, busy } = input
  // 方向或金額改了、新 quote 回來前，舊的 quote 不可以拿來顯示（#220）。方向再檢查一次：
  // 呼叫端傳錯方向的 ready 也不採用。
  const quote = live.status === 'ready' && live.quote.isEthIn === isEthIn ? live.quote : null

  const version: SwapCardView['version'] = probing ? 'loading' : caps.pricing
  const pool: PoolInfoView = probing
    ? {
        pricing: 'unknown',
        poolPrice: LOADING,
        oracleRate: UNSUPPORTED,
        oracleRef: UNSUPPORTED,
        reserves: reads.reserves ? buildPoolInfoView(caps, reads).reserves : { kind: 'loading' },
      }
    : buildPoolInfoView(caps, reads)

  let notes: readonly SwapNoteKey[]
  if (version === 'loading') notes = ['checkingVersionNote']
  else if (version === 'oracle-fixed') notes = ['oracleFixedNote']
  else if (version === 'plain-cp') notes = ['constantProductNote', 'noOracleRefNote']
  else if (version === 'unknown') notes = ['unknownVersionNote']
  else notes = ['constantProductNote']

  const inventoryExceeded =
    quote && quote.inventory.status === 'exceeded'
      ? { needed: quote.inventory.needed, available: quote.inventory.available }
      : null
  const tradable = quote && !inventoryExceeded ? quote : null

  let label: SwapButtonLabel
  if (busy) label = 'swapping'
  else if (oracleStale) label = 'oracleStale'
  else if (live.status === 'noAmount') label = 'enterAmount'
  else if (!quote && live.status !== 'failed') label = 'quoting'
  // quote 失敗，或報出 0：這筆金額換不成。executeSwap 的 minOut 由畫面上的報價算出，
  // 沒有報價就沒有可以送出的 minOut。
  else if (!quote || quote.out <= 0n) label = 'quoteUnavailable'
  // 報價小到打 0.5% 之後最低收到是 0：minOut 0 等於沒有滑點保護，不讓送（PR #223 M1）。
  else if (minOutWithSlippage(quote.out) <= 0n) label = 'amountTooSmall'
  else if (inventoryExceeded) label = 'exceedsInventory'
  else label = 'swap'

  let badge: SwapCardView['badge'] = null
  if (version === 'oracle-fixed') badge = 'oracleFixedBadge'
  else if (version === 'banded-cp' || version === 'plain-cp') badge = 'poolBadge'

  return {
    version,
    pool,
    badge,
    reservesLabel: version === 'oracle-fixed' ? 'poolInventory' : 'poolReserves',
    notes,
    quotePending: live.status === 'pending' || (live.status === 'ready' && !quote),
    receive: tradable ? tradable.out : null,
    impactBps: tradable ? tradable.impactBps : null,
    minReceivedBase: tradable && minOutWithSlippage(tradable.out) > 0n ? tradable.out : null,
    inventoryExceeded,
    button: { disabled: label !== 'swap', label },
  }
}
