import { useRef, useState, useEffect, useCallback } from 'react'

import { readMaxPriceAge } from 'src/lib/pepefi/positionPnl'
import { mapLimit, withRetry, RPC_CONCURRENCY } from 'src/lib/pepefi/rpcBatch'

// 鏈上實際部位活動：某個標的最近有誰開了什麼倉、平掉了沒、賺賠多少。
// 是全平台的資料，不是只有自己的（自己的在下方持倉表）。
//
// 為什麼走訪 position ID 而不是查事件 log：
//   1. PositionClosed / PositionLiquidated 沒有把 asset 編進 indexed 參數，只有
//      PositionOpened 有。要湊出「這個標的的完整活動」得先撈全部平倉事件再逐一
//      回查 asset，反而更慢。
//   2. Base Sepolia 的公開 RPC 把 eth_getLogs 限制在 1,000 個 block（約 33 分鐘；
//      2026-09-29 實測，常數與方法見 lib/pepefi/chainLogs.ts 的
//      MEASURED_GETLOGS_MAX_BLOCKS），要看更早就得分段掃（getLogsChunked），成本更高。
//   3. getPosition(id) 的 struct 本身就有 asset / openedAt / closedAt /
//      realizedPnL / isOpen——開倉、平倉、損益全在裡面，不需要事件。
//
// 掃描一次涵蓋所有標的，結果放進模組層快取：切標的只是換一個過濾條件，不必重掃。
// 實測一輪掃描約 5 秒，如果每次切標的都重來，11 個標的就是 55 秒的等待。

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Contracts = any

/** 單一標的最多顯示幾列。 */
const WANT = 30

/**
 * 最多往回走訪幾個 position ID。
 *
 * 「不要為了填滿列表而把整條鏈掃過一遍」的煞車。目前 nextPositionId 是 76，實際
 * 上會全部走完；等平台成長到幾千筆時，這個上限讓載入時間維持有界，代價是冷門標
 * 的可能顯示不滿 WANT 列——那個取捨是對的，沒有人為了看第 31 筆歷史部位願意多等
 * 十秒。
 */
const MAX_SCAN = 400

/** 快取多久重掃一次。部位不是每秒都在開，一分鐘夠新。 */
const CACHE_TTL_MS = 60_000

export interface ActivityRow {
  id: bigint
  asset: string
  isLong: boolean
  entryPrice: bigint
  margin: bigint
  leverage: bigint
  openedAt: bigint
  closedAt: bigint
  realizedPnL: bigint
  isOpen: boolean
  /**
   * 未平倉才有：合約 `getPositionValue`（平倉可拿回的金額）。未實現損益由它減保證金
   * 得出，跟持倉表、投資組合頁同一個定義（lib/pepefi/positionPnl.ts）。讀不到為 null。
   */
  positionValue?: bigint | null
  /**
   * 未平倉才有：該標的 oracle 的 [價格(8 dp), 更新時間]。價格為 0 或過期時合約的
   * getPositionValue 會回 0（不 revert），不檢查就會把全平台的部位都畫成「保證金全虧」。
   * 讀不到為 null。
   */
  oracle?: readonly [bigint, bigint] | null
  /** 合約 maxPriceAge（秒），判斷過期用。 */
  maxPriceAgeSec?: number
}

export interface MarketActivity {
  rows: ActivityRow[]
  loading: boolean
  error: string | null
  /** 因為掃描上限而停止，可能還有更早的資料沒撈到。 */
  truncated: boolean
  /** 重試後仍讀不到的筆數。>0 代表這份列表可能不完整。 */
  missed: number
  refresh: () => Promise<void>
}

const ZERO_ASSET = `0x${'0'.repeat(64)}`

interface ScanResult {
  at: number
  rows: ActivityRow[]
  truncated: boolean
  missed: number
}

// 模組層快取（key = exchange 位址）。同一次掃描的結果給所有標的共用。
const cache = new Map<string, ScanResult>()
// 同一個 exchange 只允許一輪掃描在飛，避免多個元件同時觸發重複掃描。
const inFlight = new Map<string, Promise<ScanResult>>()

async function scanAll(contracts: Contracts): Promise<ScanResult> {
  const ex = contracts.exchange
  const next = Number(await ex.nextPositionId())

  const rows: ActivityRow[] = []
  let missed = 0
  let scanned = 0
  let cursor = next - 1

  while (cursor >= 0 && scanned < MAX_SCAN) {
    const batch: number[] = []
    for (let i = 0; i < RPC_CONCURRENCY && cursor >= 0 && scanned < MAX_SCAN; i += 1) {
      batch.push(cursor)
      cursor -= 1
      scanned += 1
    }

    // eslint-disable-next-line no-await-in-loop
    const results = await mapLimit(batch, RPC_CONCURRENCY, async (id) => {
      try {
        // 重試而不是直接跳過：公開 RPC 即使在併發 6 也會零星丟包（實測掃 76 筆
        // 有 8 筆失敗；加了重試之後多數輪次歸零，但仍非保證）。靜默跳過會讓列表
        // 無聲地少幾列，看起來像「這個標的就只有這些部位」。
        const p = (await withRetry(() => ex.getPosition(id))) as ActivityRow
        if (!p.isOpen) return p
        // ethers 的 Result 是唯讀的 array-like，展開成一般物件才能加欄位。
        const positionValue = await withRetry(() => ex.getPositionValue(id))
          .then((v: unknown) => v as bigint)
          .catch(() => null)
        return {
          id: p.id ?? BigInt(id),
          asset: p.asset,
          isLong: p.isLong,
          entryPrice: p.entryPrice,
          margin: p.margin,
          leverage: p.leverage,
          openedAt: p.openedAt,
          closedAt: p.closedAt,
          realizedPnL: p.realizedPnL,
          isOpen: p.isOpen,
          positionValue,
        } satisfies ActivityRow
      } catch {
        missed += 1
        return null
      }
    })

    for (const p of results) {
      if (!p) continue
      // nextPositionId 之下未必每個 ID 都存在；未初始化的 asset 是 0x0。
      if (!p.asset || p.asset === ZERO_ASSET) continue
      rows.push(p)
    }
  }

  // 未平倉部位的標的價格：每個標的讀一次 oracle（不是每個部位一次）。
  const openAssets = [...new Set(rows.filter((r) => r.isOpen).map((r) => r.asset))]
  if (openAssets.length) {
    const [maxPriceAgeSec, quotes] = await Promise.all([
      readMaxPriceAge(ex),
      mapLimit(openAssets, RPC_CONCURRENCY, async (asset) => {
        try {
          const q = (await withRetry(() => contracts.oracle.getPrice(asset))) as [bigint, bigint]
          return [q[0], q[1]] as const
        } catch {
          return null
        }
      }),
    ])
    const byAsset = new Map(openAssets.map((a, i) => [a, quotes[i]]))
    for (const r of rows) {
      if (!r.isOpen) continue
      r.oracle = byAsset.get(r.asset) ?? null
      r.maxPriceAgeSec = maxPriceAgeSec
    }
  }

  rows.sort((a, b) => Number(b.openedAt) - Number(a.openedAt))
  return { at: Date.now(), rows, truncated: scanned >= MAX_SCAN && cursor >= 0, missed }
}

function getScan(contracts: Contracts, force: boolean): Promise<ScanResult> {
  const key = String(contracts?.exchange?.target ?? '')
  if (!force) {
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit)
    const flying = inFlight.get(key)
    if (flying) return flying
  }
  const p = scanAll(contracts)
    .then((res) => {
      cache.set(key, res)
      return res
    })
    .finally(() => {
      inFlight.delete(key)
    })
  inFlight.set(key, p)
  return p
}

export function useMarketActivity(
  contracts: Contracts,
  assetId: string | undefined,
): MarketActivity {
  const [scan, setScan] = useState<ScanResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const runIdRef = useRef(0)

  const load = useCallback(
    async (force: boolean) => {
      if (!contracts?.exchange) {
        setScan(null)
        return
      }
      const myRun = runIdRef.current + 1
      runIdRef.current = myRun
      setLoading(true)
      setError(null)
      try {
        const res = await getScan(contracts, force)
        if (myRun !== runIdRef.current) return
        setScan(res)
      } catch (e) {
        if (myRun !== runIdRef.current) return
        setError((e as Error).message)
      } finally {
        if (myRun === runIdRef.current) setLoading(false)
      }
    },
    [contracts],
  )

  useEffect(() => {
    void load(false)
  }, [load])

  const refresh = useCallback(() => load(true), [load])

  // 過濾是純計算，切標的不會重新打鏈。
  const target = assetId?.toLowerCase()
  const rows = scan && target
    ? scan.rows.filter((p) => p.asset.toLowerCase() === target).slice(0, WANT)
    : []

  return {
    rows,
    loading,
    error,
    truncated: scan?.truncated ?? false,
    missed: scan?.missed ?? 0,
    refresh,
  }
}
