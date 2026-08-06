// 事件掃描（getLogs）的單一真相來源：掃描範圍、出塊時間、分段查詢。
//
//
// 之前 WhaleTrackerPage 把 `DEPLOY_BLOCK = 10_874_200` 寫死——那是 **Ethereum
// Sepolia** 的區塊。連到 Base Sepolia（2 秒一塊、高度數千萬）時，它會從一個
// 五千萬塊以前的位置開始，用 9,900 塊為單位串行 getLogs，等於幾千次 RPC：頁面
// 卡住幾分鐘，公共節點直接限流。useWhaleAlerts 則反過來，單發一次 50,000 塊的
// queryFilter（多數節點的上限是 10k）並用 12 秒/塊估時間，在 Base 上把時間高估
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

/** 預設只回看 7 天。這是「近期鯨魚動向」需要的範圍，不是完整鏈史。 */
export const DEFAULT_SCAN_WINDOW_SEC = 7 * 24 * 3600

/**
 * 單次 getLogs 的塊數上限。Infura / Alchemy 的公開端點是 10,000，
 * 留一點餘裕避免邊界剛好被拒。
 */
export const CHUNK_SIZE = 9_900

/**
 * 一次掃描最多切幾段。就算視窗算出來很大，也不讓頁面送出上百次 RPC；
 * 超過就從尾端截斷（保留最新的區塊，那才是使用者在看的東西）。
 */
export const MAX_CHUNKS = 40

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

/** 給 UI 顯示用：這次掃了多久的鏈史。 */
export function describeScanWindow(chainId: number | null | undefined, blocks: number): string {
  const sec = blocks * avgBlockTime(chainId)
  if (sec < 3600) return `${Math.round(sec / 60)} 分鐘`
  if (sec < 86400) return `${(sec / 3600).toFixed(1)} 小時`
  return `${(sec / 86400).toFixed(1)} 天`
}

// ── 分段查詢 ─────────────────────────────────────────────────────────────────
// `Contract` 只當型別用（import type 在編譯後會被抹掉），所以這個檔案在測試裡
// 不會把 ethers 拉進來。

/**
 * 分段掃 getLogs，單段不超過 CHUNK_SIZE。
 * 單段失敗只丟掉那一段（節點暫時性錯誤很常見），不讓整次查詢歸零。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function queryLogsChunked(
  contract: { queryFilter: (f: any, from: number, to: number) => Promise<any[]> },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filter: any,
  fromBlock: number,
  toBlock: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: any[] = []
  for (const [from, to] of chunkRanges(fromBlock, toBlock)) {
    try {
      all.push(...(await contract.queryFilter(filter, from, to)))
    } catch (e) {
      console.warn('[queryLogsChunked] chunk failed', from, '-', to, e)
    }
  }
  return all
}
