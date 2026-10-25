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

/** 包住 window.ethereum 給 BrowserProvider 用：讀取排隊，其他照原樣送給錢包。 */
export function throttleReads(provider: Eip1193, gate: () => Promise<void> = walletReads): Eip1193 {
  return {
    request: async (args) => {
      if (NODE_READS.has(args.method)) await gate()
      return provider.request(args)
    },
  }
}
