// 事件掃描（getLogs）的單一真相來源：掃描範圍、出塊時間、分段查詢。
//
//
// 之前 WhaleTrackerPage 把 `DEPLOY_BLOCK = 10_874_200` 寫死——那是 **Ethereum
// Sepolia** 的區塊。連到 Base Sepolia（2 秒一塊、高度數千萬）時，它會從一個
// 五千萬塊以前的位置開始，用 9,900 塊為單位串行 getLogs，等於幾千次 RPC：頁面
// 卡住幾分鐘，公共節點直接限流。useWhaleAlerts 則反過來，單發一次 50,000 塊的
// queryFilter（Base Sepolia 公開節點的實際上限只有 1,000 塊，見 MEASURED_GETLOGS_MAX_BLOCKS）並用 12 秒/塊估時間，在 Base 上把時間高估
// 六倍。
//
// 這裡把「從哪一塊開始掃」「一塊多久」變成依 chainId 查表的純函式，讓兩邊共用
// 同一份答案，也讓它可以被測試。

/**
 * 各鏈的合約部署塊。掃描永遠不需要早於這裡，因為在那之前不可能有事件。
 * 沒有列出的鏈 → undefined，改用滾動視窗（見 scanFromBlock）。
 */
export const DEPLOY_BLOCK_BY_CHAIN: Record<number, number> = {
  // Anvil 每次重啟都從 0 開始。
  31337: 0,
  // Ethereum Sepolia：Exchange + Seed 的部署塊。
  11155111: 10_874_200,
  // Base Sepolia：contracts/broadcast/Deploy.s.sol/84532/run-latest.json 的第一筆 receipt。
  84532: 42_838_953,
}

/** 各鏈的實際出塊時間（秒）。用它把「N 塊以前」換算成時間，反之亦然。 */
export const AVG_BLOCK_TIME_BY_CHAIN: Record<number, number> = {
  31337: 1, // 本地鏈只在有交易時出塊，1 是保守估計
  11155111: 12, // Ethereum Sepolia
  84532: 2, // Base Sepolia（OP Stack，2 秒）
}

/** 不認得的鏈用 12 秒——高估比低估安全，寧可掃少一點也不要炸掉節點。 */
export const DEFAULT_AVG_BLOCK_TIME = 12

/**
 * 預設回看 24 小時。這是「近期動向」需要的範圍，不是完整鏈史。
 *
 * 2026-09-29 以前是 7 天——但實測公開節點的 getLogs 上限只有 1,000 塊（見
 * MEASURED_GETLOGS_MAX_BLOCKS），7 天在 Base Sepolia 是 302,400 塊 = 378 段序列
 * 請求，不可行。24 小時 = 43,200 塊 = 54 段，落在 MAX_CHUNKS 之內。
 */
export const DEFAULT_SCAN_WINDOW_SEC = 24 * 3600

/**
 * 實測的單次 eth_getLogs 區塊範圍上限（閉區間含頭尾的塊數）。
 *
 * 2026-09-29 實測 https://sepolia.base.org（Base Sepolia 公開 RPC，錢包預設節點）：
 *   方法：node 腳本對 MockOracle 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 發
 *   eth_getLogs（toBlock = 當下最新塊，約 47,442,721），先試 1k / 2k / 5k / 9.9k /
 *   10k / 20k / 50k / 100k 塊，再在 [1000, 2000] 之間二分搜尋。
 *   結果：1,001 塊（toBlock − fromBlock = 1000）成功，1,002 塊失敗，錯誤訊息
 *   "eth_getLogs is limited to a 1,000 range"。部署塊附近的舊區段同樣是這個上限。
 *
 * 舊值 CHUNK_SIZE = 9,900（以及 HistoryPage 自己的 1,800、各處註解寫的「2000 塊
 * 上限」）在這個節點上**每一段都會被拒**——之前的分段掃描在公開節點上實際上是
 * 全數失敗，而多數呼叫端把失敗吞成「沒有資料」。
 */
export const MEASURED_GETLOGS_MAX_BLOCKS = 1_001

/**
 * 單次 getLogs 的塊數（閉區間含頭尾）。取實測上限的約八成，給不同 RPC 後端或
 * 節點日後調整留餘裕。改這個值之前請重新實測，並更新上面的常數與日期。
 */
export const CHUNK_SIZE = 800

/**
 * 一次掃描最多切幾段。就算視窗算出來很大，也不讓頁面送出上百次 RPC；
 * 超過就從尾端截斷（保留最新的區塊，那才是使用者在看的東西）。
 *
 * 以 CHUNK_SIZE = 800 計，60 段 = 48,000 塊 ≈ Base Sepolia 上 26.7 小時，
 * 足以涵蓋 DEFAULT_SCAN_WINDOW_SEC（24 小時）。
 * 呼叫端以 describeScanWindow 把實際掃到的長度告訴使用者。
 */
export const MAX_CHUNKS = 60

export function avgBlockTime(chainId: number | null | undefined): number {
  if (chainId === null || chainId === undefined) return DEFAULT_AVG_BLOCK_TIME
  return AVG_BLOCK_TIME_BY_CHAIN[chainId] ?? DEFAULT_AVG_BLOCK_TIME
}

/** 把一段時間換算成該鏈的塊數。 */
export function blocksForSeconds(chainId: number | null | undefined, seconds: number): number {
  return Math.max(1, Math.ceil(seconds / avgBlockTime(chainId)))
}

export function deployBlock(chainId: number | null | undefined): number | undefined {
  if (chainId === null || chainId === undefined) return undefined
  return DEPLOY_BLOCK_BY_CHAIN[chainId]
}

/**
 * 掃描起點。
 *
 * 規則：滾動視窗（現在往回 windowSec）與部署塊取「較晚」的那個。
 *  - 部署塊已知且很近（剛部署的鏈）→ 不會掃到部署之前的空白區。
 *  - 部署塊已知但很遠（Base 上已經跑了幾個月）→ 視窗把它夾住，不會退化成掃全鏈。
 *  - 部署塊未知（新鏈 / 沒登記）→ 純滾動視窗，仍然有界。
 *
 * 另外硬性套用 MAX_CHUNKS：任何情況下切出來的段數都不會超過上限。
 */
export function scanFromBlock(a: {
  chainId: number | null | undefined
  currentBlock: number
  windowSec?: number
  maxChunks?: number
}): number {
  const windowSec = a.windowSec ?? DEFAULT_SCAN_WINDOW_SEC
  const maxChunks = a.maxChunks ?? MAX_CHUNKS
  const current = Math.max(0, Math.floor(a.currentBlock))

  const windowStart = Math.max(0, current - blocksForSeconds(a.chainId, windowSec))
  const dep = deployBlock(a.chainId)
  // 部署塊比節點回報的鏈高度還大 = 我們認錯鏈了（本地 fork、重置的 Anvil、
  // RPC 指到別條鏈）。這時不能拿部署塊當起點，退回滾動視窗。
  const usableDeploy = dep !== undefined && dep <= current ? dep : undefined
  let from = usableDeploy === undefined ? windowStart : Math.max(usableDeploy, windowStart)

  // 硬上限：不論上面算出什麼，段數都不能超過 maxChunks。
  const hardFloor = Math.max(0, current - maxChunks * CHUNK_SIZE + 1)
  if (from < hardFloor) from = hardFloor

  return Math.min(from, current)
}

/**
 * 把 [from, to] 切成不超過 CHUNK_SIZE 的閉區間清單。
 * 分開成純函式是為了能直接測邊界——off-by-one 在這裡會靜默漏掉整塊事件。
 */
export function chunkRanges(
  from: number,
  to: number,
  size: number = CHUNK_SIZE,
): Array<[number, number]> {
  if (to < from) return []
  const step = Math.max(1, Math.floor(size))
  const out: Array<[number, number]> = []
  for (let start = from; start <= to; start += step) {
    out.push([start, Math.min(start + step - 1, to)])
  }
  return out
}

/**
 * 給 UI 顯示用：這次掃了多久的鏈史。
 *
 * 輸出英文——whale tracker 的介面統一英文，而這個字串是直接印在畫面上的，
 * 不是給人讀的除錯訊息。
 */
export function describeScanWindow(chainId: number | null | undefined, blocks: number): string {
  const sec = blocks * avgBlockTime(chainId)
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`
  return `${(sec / 86400).toFixed(1)}d`
}

// ── 分段查詢 ─────────────────────────────────────────────────────────────────
// `Contract` 只當型別用（import type 在編譯後會被抹掉），所以這個檔案在測試裡
// 不會把 ethers 拉進來。

/**
 * 分段掃 getLogs 期間的進度回報。一次掃描可能是 40 段序列 RPC，在 UI 上
 * 只顯示一句「載入中」等於讓使用者對著不動的畫面猜還要多久。
 * 每一段結束都會叫一次，**包含失敗的那些**——進度講的是做完的工作量，
 * 不是成功的筆數，否則遇到節點暫時性錯誤進度條會卡住不動。
 */
export type ChunkProgress = (done: number, total: number) => void

/**
 * 一段查詢失敗時回報，讓呼叫端可以決定「靜默丟棄可以接受」還是「必須讓使用者
 * 知道結果不完整」。**任何會把「查不到」顯示給使用者的地方都必須在乎**——
 * 讀取失敗不能被畫成「沒有資料」。
 */
export type ChunkFailure = (from: number, to: number, error: unknown) => void

export interface ChunkScanOptions {
  onChunk?: ChunkProgress
  onChunkFailed?: ChunkFailure
  /** 單段失敗後再試幾次（預設 0）。公開 RPC 的 429 很常見，UI 呼叫端統一用 UI_RETRIES。 */
  retries?: number
  /** 第一次重試前等多久，之後每次加倍。預設 400ms。 */
  retryDelayMs?: number
  /**
   * 同時在飛的段數（預設 1＝序列）。公開節點對突發請求會回 429，UI 建議 2–3。
   * 結果仍依區塊順序串接，與併發度無關。
   */
  concurrency?: number
  /** 中止訊號。每一段開始前（含重試前）檢查；中止時整個掃描以 ChunkScanAbortedError 結束。 */
  signal?: AbortSignal
}

/** 每段查詢以外的選項（給 getLogsChunked / queryLogsChunked 這種位置參數介面用）。 */
export type ChunkRunOptions = Pick<ChunkScanOptions, 'retries' | 'retryDelayMs' | 'concurrency' | 'signal'>

/** UI 呼叫端統一的重試次數。 */
export const UI_RETRIES = 2

export interface ChunkScanResult<T> {
  logs: T[]
  /** 重試後仍失敗的段數。> 0 代表結果不完整，UI 必須顯示「讀取失敗」而非「沒有資料」。 */
  failedChunks: number
  totalChunks: number
}

/** 掃描被 AbortSignal 中止。呼叫端通常直接忽略（元件已卸載或查詢已過期）。 */
export class ChunkScanAbortedError extends Error {
  constructor() {
    super('chunk scan aborted')
    this.name = 'ChunkScanAbortedError'
  }
}

export const isChunkScanAborted = (e: unknown): boolean => e instanceof ChunkScanAbortedError

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function scanChunks<T>(
  fromBlock: number,
  toBlock: number,
  fetchRange: (from: number, to: number) => Promise<T[]>,
  tag: string,
  opts: ChunkScanOptions,
): Promise<ChunkScanResult<T>> {
  const ranges = chunkRanges(fromBlock, toBlock)
  const perRange: T[][] = new Array(ranges.length)
  const retries = Math.max(0, opts.retries ?? 0)
  const baseDelay = opts.retryDelayMs ?? 400
  const checkAbort = () => {
    if (opts.signal?.aborted) throw new ChunkScanAbortedError()
  }
  let failedChunks = 0
  let done = 0
  let next = 0

  const worker = async () => {
    for (;;) {
      checkAbort()
      const i = next
      next += 1
      if (i >= ranges.length) return
      const [from, to] = ranges[i]
      let lastErr: unknown
      let ok = false
      for (let attempt = 0; attempt <= retries && !ok; attempt++) {
        if (attempt > 0) {
          if (baseDelay > 0) await sleep(baseDelay * 2 ** (attempt - 1))
          checkAbort()
        }
        try {
          perRange[i] = await fetchRange(from, to)
          ok = true
        } catch (e) {
          lastErr = e
        }
      }
      if (!ok) {
        perRange[i] = []
        failedChunks += 1
        console.warn(`[${tag}] chunk failed`, from, '-', to, lastErr)
        opts.onChunkFailed?.(from, to, lastErr)
      }
      done += 1
      opts.onChunk?.(done, ranges.length)
    }
  }

  const n = Math.max(1, Math.min(Math.floor(opts.concurrency ?? 1), ranges.length || 1))
  await Promise.all(Array.from({ length: n }, () => worker()))
  return { logs: perRange.flat(), failedChunks, totalChunks: ranges.length }
}

/**
 * 分段掃**原始** getLogs，並回報失敗段數。
 *
 * 存在的理由是實測出來的：whale tracker 要 PositionOpened / Closed /
 * Liquidated 三種事件，用三個 `contract.queryFilter` 就是三倍的 getLogs，在
 * Base Sepolia 的公開節點上足以讓同時間的其他請求直接失敗。
 *
 * topics[0] 可以是一個陣列，語意是 OR。所以同一個合約上的多種事件可以合成
 * 一趟掃完。呼叫端拿到原始 log 之後用 `interface.parseLog` 還原成具名事件，
 * 或直接用下面的 scanContractEvents。
 */
export async function getLogsChunkedDetailed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: { getLogs: (f: any) => Promise<any[]> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filter: { address?: string; topics?: any[] },
  fromBlock: number,
  toBlock: number,
  opts: ChunkScanOptions = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<ChunkScanResult<any>> {
  return scanChunks(
    fromBlock,
    toBlock,
    (from, to) => provider.getLogs({ ...filter, fromBlock: from, toBlock: to }),
    'getLogsChunked',
    opts,
  )
}

/**
 * 同 getLogsChunkedDetailed，只回 log 陣列（舊呼叫端的介面）。
 * 單段失敗只丟掉那一段；要知道結果完不完整就傳 onChunkFailed，或改用 Detailed 版。
 */
export async function getLogsChunked(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: { getLogs: (f: any) => Promise<any[]> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filter: { address?: string; topics?: any[] },
  fromBlock: number,
  toBlock: number,
  onChunk?: ChunkProgress,
  onChunkFailed?: ChunkFailure,
  run: ChunkRunOptions = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  const r = await getLogsChunkedDetailed(provider, filter, fromBlock, toBlock, { ...run, onChunk, onChunkFailed })
  return r.logs
}

/**
 * 分段掃 getLogs（透過 contract.queryFilter），單段不超過 CHUNK_SIZE。
 * 單段失敗只丟掉那一段（節點暫時性錯誤很常見），不讓整次查詢歸零。
 * 呼叫端若在乎「掉了幾段」，傳 onChunkFailed 取得每一段失敗的通知。
 */
export async function queryLogsChunked(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contract: { queryFilter: (f: any, from: number, to: number) => Promise<any[]> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filter: any,
  fromBlock: number,
  toBlock: number,
  onChunk?: ChunkProgress,
  onChunkFailed?: ChunkFailure,
  run: ChunkRunOptions = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  const r = await scanChunks(
    fromBlock,
    toBlock,
    (from, to) => contract.queryFilter(filter, from, to),
    'queryLogsChunked',
    { ...run, onChunk, onChunkFailed },
  )
  return r.logs
}

// ── 合約事件：多個 filter 合併成最少趟數 ─────────────────────────────────────

/** ethers v6 TopicFilter 的形狀：每一格是 null（不限）、單一 topic 或 OR 陣列。 */
export type TopicFilterShape = ReadonlyArray<null | string | ReadonlyArray<string>>

/** topic0 為單一事件的 filter，例如 `contract.filters.Foo(user)`（ethers DeferredTopicFilter）。 */
export interface DeferredTopicFilterLike {
  getTopicFilter: () => Promise<TopicFilterShape>
}

export interface TopicGroup {
  /** 可以直接交給 getLogs 的 topics。 */
  topics: Array<null | string | string[]>
  /** 這一組對應到原本 filters 的哪幾個索引。 */
  members: number[]
}

/**
 * 把同一個合約上多個事件的 topic filter 分組：topic0 以外的條件（去掉尾端 null
 * 之後）一樣的合成一組，topic0 變成 OR 陣列。一組 = 一趟分段掃描。
 *
 * 例：mine 模式下 SwapEthToUsdc(user) 與 SwapUsdcToEth(user) 都是 [t0, user] → 一趟；
 * PositionOpened(null, user) 是 [t0, null, user]，另成一組。
 */
export function groupTopicFilters(filters: readonly TopicFilterShape[]): TopicGroup[] {
  const byKey = new Map<string, { t0: string[]; rest: Array<null | string | string[]>; members: number[] }>()
  filters.forEach((f, i) => {
    const t0 = f[0]
    if (typeof t0 !== 'string') throw new Error('groupTopicFilters: topic0 must be a single event topic')
    const rest = f.slice(1).map((x) => (x === null || typeof x === 'string' ? x : [...x]))
    while (rest.length > 0 && rest[rest.length - 1] === null) rest.pop()
    const key = JSON.stringify(rest)
    const g = byKey.get(key)
    if (g) {
      if (!g.t0.includes(t0)) g.t0.push(t0)
      g.members.push(i)
    } else {
      byKey.set(key, { t0: [t0], rest, members: [i] })
    }
  })
  return [...byKey.values()].map((g) => ({
    topics: [g.t0.length === 1 ? g.t0[0] : g.t0, ...g.rest],
    members: g.members,
  }))
}

/** 解析後的事件：保留 EventLog 常用的欄位，呼叫端照舊寫 `log.args.user`。 */
export interface ParsedEventLog {
  eventName: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any
  blockNumber: number
  transactionHash: string
  index: number
  address: string
}

export interface EventSourceLike {
  getAddress: () => Promise<string>
  interface: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parseLog: (log: { topics: ReadonlyArray<string>; data: string }) => { name: string; args: any } | null
  }
}

export interface ContractEventsResult {
  events: ParsedEventLog[]
  failedChunks: number
  totalChunks: number
}

/**
 * 掃一個合約上的多種事件：分組（groupTopicFilters）→ 每組一趟 getLogsChunked →
 * 用合約 ABI 解析。回傳依 (blockNumber, index) 排序的事件與失敗段數。
 *
 * **failedChunks > 0 時結果不完整**，呼叫端必須顯示讀取失敗，不能顯示「沒有資料」。
 */
export async function scanContractEvents(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: { getLogs: (f: any) => Promise<any[]> },
  contract: EventSourceLike,
  filters: readonly DeferredTopicFilterLike[],
  fromBlock: number,
  toBlock: number,
  opts: ChunkScanOptions = {},
): Promise<ContractEventsResult> {
  if (filters.length === 0 || toBlock < fromBlock) return { events: [], failedChunks: 0, totalChunks: 0 }
  const [address, topicFilters] = await Promise.all([
    contract.getAddress(),
    Promise.all(filters.map((f) => f.getTopicFilter())),
  ])
  const groups = groupTopicFilters(topicFilters)

  const events: ParsedEventLog[] = []
  let failedChunks = 0
  let totalChunks = 0
  for (const g of groups) {
    const r = await getLogsChunkedDetailed(provider, { address, topics: g.topics }, fromBlock, toBlock, opts)
    failedChunks += r.failedChunks
    totalChunks += r.totalChunks
    for (const log of r.logs) {
      const parsed = contract.interface.parseLog({ topics: log.topics, data: log.data })
      if (!parsed) continue
      events.push({
        eventName: parsed.name,
        args: parsed.args,
        blockNumber: Number(log.blockNumber),
        transactionHash: log.transactionHash,
        index: Number(log.index ?? log.logIndex ?? 0),
        address: log.address,
      })
    }
  }
  events.sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index)
  return { events, failedChunks, totalChunks }
}

/** 有任何一段失敗就丟出——給「部分結果沒有意義，只要失敗就該整個顯示讀取失敗」的呼叫端。 */
export class ChunkedLogsError extends Error {
  readonly failedChunks: number

  readonly totalChunks: number

  constructor(failedChunks: number, totalChunks: number) {
    super(`getLogs: ${failedChunks}/${totalChunks} chunk(s) failed`)
    this.name = 'ChunkedLogsError'
    this.failedChunks = failedChunks
    this.totalChunks = totalChunks
  }
}

export async function scanContractEventsStrict(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: { getLogs: (f: any) => Promise<any[]> },
  contract: EventSourceLike,
  filters: readonly DeferredTopicFilterLike[],
  fromBlock: number,
  toBlock: number,
  opts: ChunkScanOptions = {},
): Promise<ParsedEventLog[]> {
  const r = await scanContractEvents(provider, contract, filters, fromBlock, toBlock, opts)
  if (r.failedChunks > 0) throw new ChunkedLogsError(r.failedChunks, r.totalChunks)
  return r.events
}
