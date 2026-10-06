// 儲備與償付能力頁（/solvency）的資料層。
//
// 只讀鏈上：交易所的 USDC 餘額、未平倉部位的保證金與未實現損益（逐筆 getPosition ＋
// getUnrealizedPnL，與 useMarketActivity 同一種讀法）、保險金庫 totalAssets、ADL 開關、
// AssetVaultV2 的 reserveStatus。任何一項讀不到都是「讀取失敗」，不是 0。
//
// 準備率歷史讀 AssetVaultV2 的 ReserveObserved 事件。2026-10-06 實測公開節點
// sepolia.base.org 的 eth_getLogs 上限已降為 500 塊（chainLogs.ts 的 800 塊會被拒），
// 所以這裡每段只查 HISTORY_CHUNK 塊，並限制總段數。

import type { Reading, FnSupport } from './contractProbe'

import { chunkRanges } from './chainLogs'
import { withTimeout } from './safeRead'
import { mapLimit, withRetry, RPC_CONCURRENCY } from './rpcBatch'
import { ok, FAILED, supportMap, UNSUPPORTED } from './contractProbe'

export const SOLVENCY_EXCHANGE_VIEWS = [
  'nextPositionId()',
  'getPosition(uint256)',
  'getUnrealizedPnL(uint256)',
  'adlEnabled()',
] as const

/** 最多往回掃幾筆部位（從 nextPositionId − 1 往回）。超過時標示「不完整」。 */
export const MAX_POSITION_SCAN = 400

const UINT256_MAX = (1n << 256n) - 1n

export interface PositionTotals {
  status: 'ok' | 'partial' | 'failed' | 'unsupported'
  /** nextPositionId；讀不到為 null。 */
  nextId: number | null
  scanned: number
  open: number
  /** getPosition 讀不到的筆數。 */
  missed: number
  /** 未平倉部位的未實現損益讀不到的筆數。 */
  pnlMissed: number
  truncated: boolean
  totalMargin: bigint
  unrealizedPnl: bigint
}

export interface VaultStatus {
  reserve: bigint
  liability: bigint
  /** null = 沒有負債（合約回 uint256 max）。 */
  ratioBps: bigint | null
  unpriced: number
  stale: boolean
  halted: boolean
  minRatioBps: Reading<bigint>
}

export interface SolvencySnapshot {
  /** MockUSDC 的 decimals；讀不到為 null——畫面標「小數位數讀取失敗」、不顯示金額（不猜 18）。 */
  usdcDecimals: number | null
  exchangeBalance: Reading<bigint>
  positions: PositionTotals
  insuranceAssets: Reading<bigint>
  adl: Reading<boolean>
  vault: Reading<VaultStatus> | { status: 'notDeployed' }
}

interface RawPosition {
  isOpen: boolean
  margin: bigint
  asset?: string
}

export interface SolvencyDeps {
  exchangeCode: () => Promise<string | null>
  usdcDecimals: () => Promise<bigint | number>
  exchangeUsdcBalance: () => Promise<bigint>
  nextPositionId: () => Promise<bigint>
  getPosition: (id: number) => Promise<RawPosition>
  getUnrealizedPnL: (id: number) => Promise<bigint>
  /**
   * ADL 與組合保證金的開關，沿用 solvencyFlags.ts 的 readSolvencyFlags（Agent 監控頁同一份讀法）。
   * null＝讀不到。
   */
  solvencyFlags: () => Promise<{ adl: boolean | null | undefined }>
  /** 保險金庫沒部署（0x0）時為 null。 */
  insuranceTotalAssets: null | (() => Promise<bigint>)
  /** AssetVaultV2 沒部署時為 null。 */
  vault: null | {
    reserveStatus: () => Promise<{
      reserve_: bigint
      liability: bigint
      ratioBps: bigint
      unpriced: bigint
      stale: boolean
      halted: boolean
    }>
    minReserveRatioBps: () => Promise<bigint>
  }
  timeoutMs?: number
  maxScan?: number
}

const ZERO_ASSET = `0x${'0'.repeat(64)}`

async function scanPositions(
  deps: SolvencyDeps,
  sup: Record<(typeof SOLVENCY_EXCHANGE_VIEWS)[number], FnSupport>,
  ms: number
): Promise<PositionTotals> {
  const empty: PositionTotals = {
    status: 'failed',
    nextId: null,
    scanned: 0,
    open: 0,
    missed: 0,
    pnlMissed: 0,
    truncated: false,
    totalMargin: 0n,
    unrealizedPnl: 0n,
  }
  if (sup['nextPositionId()'] === 'unsupported' || sup['getPosition(uint256)'] === 'unsupported') {
    return { ...empty, status: 'unsupported' }
  }
  let next: number
  try {
    next = Number(await withRetry(() => deps.nextPositionId(), 3, 150, ms))
  } catch {
    return empty
  }
  const max = deps.maxScan ?? MAX_POSITION_SCAN
  const count = Math.min(next, max)
  const ids = Array.from({ length: count }, (_, i) => next - 1 - i)

  let missed = 0
  let pnlMissed = 0
  let open = 0
  let totalMargin = 0n
  let unrealizedPnl = 0n
  const pnlSupported = sup['getUnrealizedPnL(uint256)'] !== 'unsupported'

  await mapLimit(ids, RPC_CONCURRENCY, async (id) => {
    let p: RawPosition
    try {
      p = await withRetry(() => deps.getPosition(id), 3, 150, ms)
    } catch {
      missed += 1
      return
    }
    if (!p.isOpen || p.asset === ZERO_ASSET) return
    open += 1
    totalMargin += BigInt(p.margin)
    if (!pnlSupported) {
      pnlMissed += 1
      return
    }
    try {
      // 先 await 再累加：`x += await y` 會在 await 之前就讀 x，併發時互相覆蓋。
      const pnl = BigInt(await withRetry(() => deps.getUnrealizedPnL(id), 3, 150, ms))
      unrealizedPnl += pnl
    } catch {
      pnlMissed += 1
    }
  })

  return {
    status: missed > 0 || pnlMissed > 0 ? 'partial' : 'ok',
    nextId: next,
    scanned: count,
    open,
    missed,
    pnlMissed,
    truncated: next > max,
    totalMargin,
    unrealizedPnl,
  }
}

export async function loadSolvency(deps: SolvencyDeps): Promise<SolvencySnapshot> {
  const ms = deps.timeoutMs ?? 8000
  const code = await deps.exchangeCode().catch(() => null)
  const sup = supportMap(code, SOLVENCY_EXCHANGE_VIEWS)

  const read = async <T,>(fn: () => Promise<T>): Promise<Reading<T>> => {
    try {
      return ok(await withRetry(fn, 2, 150, ms))
    } catch {
      return FAILED
    }
  }

  const v = deps.vault
  const vaultP: Promise<SolvencySnapshot['vault']> = v
    ? (async () => {
        const [st, min] = await Promise.all([read(() => v.reserveStatus()), read(() => v.minReserveRatioBps())])
        if (st.status !== 'ok') return st
        const s = st.value
        return ok({
          reserve: BigInt(s.reserve_),
          liability: BigInt(s.liability),
          ratioBps: BigInt(s.ratioBps) === UINT256_MAX ? null : BigInt(s.ratioBps),
          unpriced: Number(s.unpriced),
          stale: Boolean(s.stale),
          halted: Boolean(s.halted),
          minRatioBps: min.status === 'ok' ? ok(BigInt(min.value)) : min,
        })
      })()
    : Promise.resolve({ status: 'notDeployed' as const })

  const [decimals, exchangeBalance, positions, insuranceAssets, adl, vault] = await Promise.all([
    withTimeout(Promise.resolve(deps.usdcDecimals()), ms).then(
      (d) => {
        const n = Number(d)
        return Number.isInteger(n) && n >= 0 && n <= 36 ? n : null
      },
      () => null
    ),
    read(() => deps.exchangeUsdcBalance()),
    scanPositions(deps, sup, ms),
    deps.insuranceTotalAssets ? read(deps.insuranceTotalAssets) : Promise.resolve(UNSUPPORTED),
    // 函式不存在就不呼叫；存在（或無法判斷）時走 readSolvencyFlags，null 一律是讀取失敗。
    sup['adlEnabled()'] === 'unsupported'
      ? Promise.resolve(UNSUPPORTED)
      : withTimeout(deps.solvencyFlags(), ms).then(
          (f): Reading<boolean> => (typeof f.adl === 'boolean' ? ok(f.adl) : FAILED),
          (): Reading<boolean> => FAILED
        ),
    vaultP,
  ])

  return {
    usdcDecimals: decimals,
    exchangeBalance,
    positions,
    insuranceAssets,
    adl,
    vault,
  }
}

// ── 損失吸收瀑布 ─────────────────────────────────────────────────────────────

export type WaterfallKey = 'margin' | 'insurance' | 'adl' | 'badDebt'

export interface WaterfallLayer {
  key: WaterfallKey
  /** margin／insurance：目前可吸收的金額；其他層沒有金額。 */
  amount: Reading<bigint> | null
  /** adl 層：鏈上是否開啟。 */
  enabled?: Reading<boolean>
}

/** 依 docs/RISK_WATERFALL.md §2.3 的順位。金額只是「此刻的規模」，不是保證。 */
export function buildWaterfall(s: SolvencySnapshot): WaterfallLayer[] {
  const marginAmount: Reading<bigint> =
    s.positions.status === 'ok' || s.positions.status === 'partial'
      ? ok(s.positions.totalMargin)
      : s.positions.status === 'unsupported'
        ? UNSUPPORTED
        : FAILED
  return [
    { key: 'margin', amount: marginAmount },
    { key: 'insurance', amount: s.insuranceAssets },
    { key: 'adl', amount: null, enabled: s.adl },
    { key: 'badDebt', amount: null },
  ]
}

// ── 準備率歷史 ───────────────────────────────────────────────────────────────

/** 公開節點 2026-10-06 的 eth_getLogs 上限是 500 塊；留一點餘裕。 */
export const HISTORY_CHUNK = 450
/** Base Sepolia 約 2 秒一塊：24 小時 ≈ 43,200 塊 ≈ 96 段。 */
export const HISTORY_WINDOW_BLOCKS = 43_200
export const HISTORY_MAX_CHUNKS = 100

export interface ReservePoint {
  block: number
  /** 事件裡的 timestamp（鏈上區塊時間）。 */
  timestamp: number
  reserve: bigint
  liability: bigint
  /** null = 沒有負債（uint256 max）。 */
  ratioBps: bigint | null
  unpriced: number
}

export interface RawReserveLog {
  blockNumber: number
  args: { reserve: bigint; liability: bigint; ratioBps: bigint; unpriced: bigint; timestamp: bigint }
}

export interface ReserveHistory {
  status: 'ok' | 'partial' | 'failed'
  points: ReservePoint[]
  failedChunks: number
  totalChunks: number
  fromBlock: number
  toBlock: number
}

export interface HistoryDeps {
  latestBlock: () => Promise<number>
  getLogs: (from: number, to: number) => Promise<RawReserveLog[]>
  windowBlocks?: number
  chunk?: number
  concurrency?: number
  retries?: number
  timeoutMs?: number
}

export function toReservePoint(l: RawReserveLog): ReservePoint {
  const ratio = BigInt(l.args.ratioBps)
  return {
    block: l.blockNumber,
    timestamp: Number(l.args.timestamp),
    reserve: BigInt(l.args.reserve),
    liability: BigInt(l.args.liability),
    ratioBps: ratio === UINT256_MAX ? null : ratio,
    unpriced: Number(l.args.unpriced),
  }
}

/** 可以畫進曲線的點：有負債、且所有資產都有計價（unpriced > 0 的點負債被低估，視為未知）。 */
export function plottablePoints(points: readonly ReservePoint[]): ReservePoint[] {
  return points.filter((p) => p.ratioBps !== null && p.unpriced === 0)
}

export async function loadReserveHistory(deps: HistoryDeps): Promise<ReserveHistory> {
  const ms = deps.timeoutMs ?? 15_000
  let latest: number
  try {
    latest = await withRetry(() => deps.latestBlock(), 3, 200, ms)
  } catch {
    return { status: 'failed', points: [], failedChunks: 0, totalChunks: 0, fromBlock: 0, toBlock: 0 }
  }
  const chunk = Math.max(1, Math.min(deps.chunk ?? HISTORY_CHUNK, 500))
  const window = Math.min(deps.windowBlocks ?? HISTORY_WINDOW_BLOCKS, chunk * HISTORY_MAX_CHUNKS)
  const fromBlock = Math.max(0, latest - window + 1)
  const ranges = chunkRanges(fromBlock, latest, chunk)
  let failed = 0
  // 併發 2：96 段對公開節點已經不少，實測併發 3 會零星收到 429（有重試，但沒必要逼它）。
  const results = await mapLimit(ranges, deps.concurrency ?? 2, async ([from, to]) => {
    try {
      return await withRetry(() => deps.getLogs(from, to), (deps.retries ?? 2) + 1, 300, ms)
    } catch {
      failed += 1
      return [] as RawReserveLog[]
    }
  })
  const points = results
    .flat()
    .map(toReservePoint)
    .sort((a, b) => a.block - b.block)
  const status = failed === 0 ? 'ok' : failed === ranges.length ? 'failed' : 'partial'
  return { status, points, failedChunks: failed, totalChunks: ranges.length, fromBlock, toBlock: latest }
}

// ── 格式 ─────────────────────────────────────────────────────────────────────

/** bigint 金額（decimals 位小數）→ 有千分位的字串，保留 dp 位。 */
export function formatAmount(v: bigint, decimals: number, dp = 2): string {
  const neg = v < 0n
  const abs = neg ? -v : v
  const base = 10n ** BigInt(decimals)
  const scale = 10n ** BigInt(dp)
  const rounded = (abs * scale + base / 2n) / base
  const whole = rounded / scale
  const frac = rounded % scale
  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fracStr = dp > 0 ? `.${frac.toString().padStart(dp, '0')}` : ''
  return `${neg ? '-' : ''}${wholeStr}${fracStr}`
}

/** 準備率 bps → 百分比字串（1,463,658 → "14,636.58%"）。 */
export function formatRatio(bps: bigint): string {
  return `${formatAmount(bps, 2, 2)}%`
}
