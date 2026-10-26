// 分段 getLogs，給「有游標的長駐程式」用。
//
// 與前端 chainLogs.ts 的差別：前端可以接受「某一段失敗就少那一段」（畫面會標示不完整），
// 執行者不行——游標一旦越過失敗的那一段，那段裡的發版事件就永遠漏掉了。所以這裡：
//   - 依區塊順序**一段一段**處理，每段成功才交給呼叫端（呼叫端處理完就推進游標並存檔）；
//   - 某一段重試後仍失敗就停下來，回報掃到哪裡，下一輪從那裡繼續。
// 段長預設 200 塊（sepolia.base.org 2026-10-25 實測上限，見 chainLogs.ts 的 MEASURED_GETLOGS_MAX_BLOCKS）；
// 節點回「範圍太大」時沿用前端同一套判斷（isRangeLimitError／rangeLimitFromError）對半切開，
// 並把學到的段長用在同一趟掃描接下來的段。
//
// 同一段只發一次 getLogs：address 用陣列（CopyTracker＋StrategyRegistry）、topic0 用 OR 陣列。
import {
  CHUNK_SIZE,
  chunkRanges,
  isRangeLimitError,
  rangeLimitFromError,
} from "../../../frontend/src/lib/pepefi/chainLogs.ts";

export { CHUNK_SIZE };

export interface RawLog {
  address: string;
  topics: readonly string[];
  data: string;
  blockNumber: number;
  /** ethers v6 叫 index，原始 JSON-RPC 叫 logIndex。 */
  index?: number;
  logIndex?: number;
  transactionHash?: string;
}

export interface LogFilter {
  address: string[];
  topics: Array<null | string | string[]>;
}

export interface LogSource {
  getLogs(f: LogFilter & { fromBlock: number; toBlock: number }): Promise<readonly RawLog[]>;
}

export interface ScanOptions {
  chunkSize?: number;
  /** 單段失敗後再試幾次（範圍太大不算，那會直接切開）。預設 2。 */
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 外部要求停止（SIGINT）：目前這段處理完就停。 */
  shouldStop?: () => boolean;
}

export interface ScanResult {
  /** 已完整處理到的區塊（含）；一段都沒成功時是 from − 1。 */
  scannedTo: number;
  chunks: number;
  logs: number;
  /** 有值代表在 scannedTo 之後的那一段失敗了。 */
  error?: unknown;
}

const MAX_SPLIT_DEPTH = 10;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!(ms > 0)) return p;
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new Error(`getLogs 逾時（${ms} ms）`)), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

const logIdx = (l: RawLog) => Number(l.index ?? l.logIndex ?? 0);

/**
 * 依序掃 [from, to]，每段完整成功後呼叫 onChunk（log 依 blockNumber、logIndex 排序）。
 * onChunk 丟錯就停止（游標不越過這一段），錯誤放在 result.error。
 */
export async function scanLogs(
  src: LogSource,
  filter: LogFilter,
  from: number,
  to: number,
  onChunk: (logs: RawLog[], chunkFrom: number, chunkTo: number) => Promise<void> | void,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const retries = Math.max(0, opts.retries ?? 2);
  const delay = opts.retryDelayMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budget = { maxBlocks: Math.max(1, Math.floor(opts.chunkSize ?? CHUNK_SIZE)) };

  const fetchAdaptive = async (a: number, b: number, depth: number): Promise<RawLog[]> => {
    if (b - a + 1 > budget.maxBlocks && depth < MAX_SPLIT_DEPTH) {
      const out: RawLog[] = [];
      for (const [x, y] of chunkRanges(a, b, budget.maxBlocks)) out.push(...(await fetchAdaptive(x, y, depth + 1)));
      return out;
    }
    try {
      return [...(await withTimeout(src.getLogs({ ...filter, fromBlock: a, toBlock: b }), timeoutMs))];
    } catch (e) {
      if (b <= a || depth >= MAX_SPLIT_DEPTH || !isRangeLimitError(e)) throw e;
      const span = b - a + 1;
      const stated = rangeLimitFromError(e);
      budget.maxBlocks = Math.min(budget.maxBlocks, stated !== undefined && stated < span ? stated : Math.ceil(span / 2));
      return fetchAdaptive(a, b, depth + 1);
    }
  };

  let scannedTo = from - 1;
  let chunks = 0;
  let total = 0;
  // 先依起始段長切；中途學到更小的段長時，fetchAdaptive 會在段內再切。
  for (const [a, b] of chunkRanges(from, to, budget.maxBlocks)) {
    if (opts.shouldStop?.()) break;
    let logs: RawLog[] | null = null;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries && logs === null; attempt++) {
      if (attempt > 0 && delay > 0) await sleep(delay * 2 ** (attempt - 1));
      try {
        logs = await fetchAdaptive(a, b, 0);
      } catch (e) {
        lastErr = e;
        if (isRangeLimitError(e)) break; // 切到單塊還是太大：重送只會再被拒
      }
    }
    if (logs === null) return { scannedTo, chunks, logs: total, error: lastErr };
    logs.sort((x, y) => Number(x.blockNumber) - Number(y.blockNumber) || logIdx(x) - logIdx(y));
    try {
      await onChunk(logs, a, b);
    } catch (e) {
      return { scannedTo, chunks, logs: total, error: e };
    }
    scannedTo = b;
    chunks += 1;
    total += logs.length;
  }
  return { scannedTo, chunks, logs: total };
}
