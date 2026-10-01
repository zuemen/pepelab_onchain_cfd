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

import { scanPush4Selectors } from './legacyExchange'

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
  else if (has(AMM_SELECTORS.oracle)) pricing = 'oracle-fixed'
  else pricing = 'plain-cp'
  return { pricing, hasOraclePrice, hasMaxOracleAge }
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
 * 一格數字的三種狀態：
 * - `value`：讀到了、而且確定是這個欄位該有的意義。
 * - `unavailable`：這版合約有這個值，但這次讀不到 → 顯示「無法取得」。
 * - `unsupported`：這版合約根本沒有這個值 → 不顯示該欄，改顯示說明。
 */
export type Cell =
  | { kind: 'value'; text: string }
  | { kind: 'unavailable' }
  | { kind: 'unsupported' }

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
  reserves: { kind: 'value'; eth: string; usdc: string } | { kind: 'unavailable' }
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
