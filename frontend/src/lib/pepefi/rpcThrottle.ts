// 錢包 provider 的讀取限速：全站的讀鏈共用一個每秒額度。
//
// 讀鏈一律經過錢包（站台 CSP 不放行直連節點），錢包再轉給 Base Sepolia 的公開節點
// sepolia.base.org——它每個 IP 每秒只收 25 筆，超過回 429（-32007 "25/second request
// limit reached"）。實測個人頁載入的前幾秒每秒送出 30–60 筆（eth_call 加上分段 getLogs），
// 被擋掉的那幾筆被各處的 catch 讀成「沒有資料」：跟隨者變「—」、跟單按鈕變「尚無可跟單的策略」。
//
// rpcBatch.ts 的 mapLimit 只管得到呼叫它的那一段，同一頁上其他 hook 照樣在送。這裡在所有讀取
// 共用的入口排隊，整站每秒送出的讀取就不會超過上限。錢包互動（簽名、送交易、切鏈）不排隊。

/** 會轉給節點的讀取方法。不在這裡的（簽名、送交易、wallet_*、eth_chainId、eth_accounts）直接放行。 */
const NODE_READS = new Set([
  'eth_call',
  'eth_getLogs',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
])

/** 每秒放行幾筆讀取。比節點的 25 低，留給錢包自己的輪詢（區塊高度、餘額）。 */
export const READS_PER_SECOND = 20

/** 任何 windowMs 之內最多放行 limit 次；超過的依到達順序排隊，不丟掉。 */
export function createRateGate(limit: number, windowMs = 1000): () => Promise<void> {
  const passed: number[] = []
  let tail: Promise<void> = Promise.resolve()
  return () => {
    const turn = tail.then(async () => {
      for (;;) {
        const now = Date.now()
        while (passed.length > 0 && now - passed[0] >= windowMs) passed.shift()
        if (passed.length < limit) {
          passed.push(now)
          return
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => {
          setTimeout(r, windowMs - (now - passed[0]))
        })
      }
    })
    tail = turn
    return turn
  }
}

interface Eip1193 {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>
}

const walletReads = createRateGate(READS_PER_SECOND)

/**
 * 錢包的節點被限流時改走的公開節點（只放行讀取，順序即嘗試順序）。
 * 錢包預設也打 sepolia.base.org，限額算在同一個 IP 上，所以先試另一家。
 * 新增網址要同步加到 vercel.json 的 CSP connect-src。
 */
export const READ_FAILOVER_RPCS: Readonly<Record<number, readonly string[]>> = {
  84532: ['https://base-sepolia-rpc.publicnode.com', 'https://sepolia.base.org'],
}

const failoverReads = createRateGate(READS_PER_SECOND)

const TRANSIENT_CODES = new Set([-32002, -32005, -32007, -32603, 429, 413])
const TRANSIENT_TEXT = /\b429\b|\b413\b|rate.?limit|too many|payload too large|request limit|failed to fetch|networkerror|load failed|timeout|timed out/i

/**
 * 節點暫時失敗才換節點。合約 revert 是答案，不是故障：換節點只會得到同樣的 revert，
 * 還可能把真正的錯誤訊息蓋掉；使用者拒絕（4001）等錢包層錯誤也不能換。
 */
export function isTransientNodeFailure(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; data?: unknown } | null | undefined
  if (!e) return false
  const data = e.data as { data?: unknown } | string | undefined
  const nested = typeof data === 'object' && data !== null ? data.data : data
  if (typeof nested === 'string' && nested.startsWith('0x') && nested.length > 2) return false
  const message = typeof e.message === 'string' ? e.message : String(err)
  if (e.code === 3 || /revert/i.test(message)) return false
  if (typeof e.code === 'number' && TRANSIENT_CODES.has(e.code)) return true
  return TRANSIENT_TEXT.test(message)
}

type RpcError = { code?: number; message?: string; data?: unknown }
type FailoverAnswer = { result: unknown } | { rpcError: RpcError } | undefined
type RpcFailover = (chainId: number, args: { method: string; params?: unknown }) => Promise<FailoverAnswer>

/** 依序問公開節點。節點回 revert 等明確答案就回傳；全部連不上回 undefined。 */
export function createRpcFailover(
  fetchImpl: typeof fetch = (...a) => fetch(...a),
  gate: () => Promise<void> = failoverReads,
  urls: Readonly<Record<number, readonly string[]>> = READ_FAILOVER_RPCS
): RpcFailover {
  return async (chainId, { method, params }) => {
    for (const url of urls[chainId] ?? []) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await gate()
        // eslint-disable-next-line no-await-in-loop
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
        })
        if (res.ok) {
          // eslint-disable-next-line no-await-in-loop
          const body = (await res.json()) as { result?: unknown; error?: RpcError }
          if (body.error) {
            if (!isTransientNodeFailure(body.error)) return { rpcError: body.error }
          } else if ('result' in body) {
            return { result: body.result }
          }
        }
      } catch {
        // 這個節點連不上，換下一個。
      }
    }
    return undefined
  }
}

const publicFailover = createRpcFailover()

/**
 * 包住 window.ethereum 給 BrowserProvider 用：讀取排隊，其他照原樣送給錢包。
 * 讀取遇到節點限流或連線失敗時改問公開節點；簽名與送交易一律只走錢包。
 */
export function throttleReads(
  provider: Eip1193,
  gate: () => Promise<void> = walletReads,
  failover: RpcFailover = publicFailover
): Eip1193 {
  return {
    request: async (args) => {
      if (!NODE_READS.has(args.method)) return provider.request(args)
      await gate()
      try {
        const result = await provider.request(args)
        // eth_call 一定有回傳值（至少 0x）；null 是節點沒給答案，不能交給 ethers 當資料解。
        if (args.method === 'eth_call' && (result === null || result === undefined)) {
          throw new Error('rate limit: node returned no result for eth_call')
        }
        return result
      } catch (err) {
        if (!isTransientNodeFailure(err)) throw err
        let chainId: number
        try {
          chainId = Number(await provider.request({ method: 'eth_chainId' }))
        } catch {
          throw err
        }
        const answer = await failover(chainId, args)
        if (!answer) throw err
        if ('rpcError' in answer) throw answer.rpcError
        return answer.result
      }
    },
  }
}
