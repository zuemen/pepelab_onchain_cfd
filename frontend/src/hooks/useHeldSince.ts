import type { Provider } from 'ethers'

import { Contract } from 'ethers'
import { useState, useEffect } from 'react'

import { streakStart, type TransferLike } from 'src/lib/pepefi/heldSince'
import {
  CHUNK_SIZE,
  UI_RETRIES,
  scanFromBlock,
  isChunkScanAborted,
  scanContractEvents,
} from 'src/lib/pepefi/chainLogs'

/** 代幣只需要這兩個介面；V1／V2 的 SyntheticAsset 都是標準 ERC-20 Transfer。 */
const ERC20_TRANSFER_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address) view returns (uint256)',
]

/** 每一步往回掃幾段。持有剛開始的人通常第一步就找到，不必一次送出整個視窗。 */
const CHUNKS_PER_STEP = 5

/**
 * 使用者「現在手上這檔代幣」是從什麼時候開始持有的（unix 秒）——#134「你已持有 N 天」。
 *
 * 從鏈上 Transfer 事件倒推（lib/pepefi/heldSince.ts），由新往舊一步步掃，找到就停。
 * 掃描範圍沿用 chainLogs 的 scanFromBlock（部署塊與滾動視窗取較晚者，硬上限 MAX_CHUNKS
 * 段）——公開節點 getLogs 一次只收 1,000 塊，整條鏈史在瀏覽器裡掃不完。
 *
 * 回傳 undefined 的情況（畫面就不顯示持有天數，**不猜**）：
 *   - 沒有 provider（模擬錢包）、沒有持有、沒有代幣位址
 *   - 持有早於掃描範圍（例如 Base Sepolia 上超過約一天前買的）
 *   - 任何一段 getLogs 失敗、倒推對不上、讀不到區塊時間
 */
export function useHeldSince(a: {
  provider: Provider | null
  token: string | null | undefined
  user: string | null | undefined
  chainId: number | null
  /** 餘額有變（買進／贖回後）就重算；0n 或 undefined 代表沒有持有，不發任何請求。 */
  balance: bigint | undefined
}): number | undefined {
  const { provider, token, user, chainId, balance } = a
  const [heldSinceSec, setHeldSinceSec] = useState<number | undefined>(undefined)

  useEffect(() => {
    setHeldSinceSec(undefined)
    if (!provider || !token || !user || balance === undefined || balance <= 0n) return undefined

    const ctrl = new AbortController()
    const contract = new Contract(token, ERC20_TRANSFER_ABI, provider)

    void (async () => {
      try {
        // 釘住一個塊：餘額與事件都以這一塊為準，否則掃描途中新進的交易會讓倒推對不上。
        const head = await provider.getBlockNumber()
        const bal = (await contract.balanceOf(user, { blockTag: head })) as bigint
        if (bal <= 0n) return
        const floor = scanFromBlock({ chainId, currentBlock: head })

        const transfers: TransferLike[] = []
        const step = CHUNK_SIZE * CHUNKS_PER_STEP
        for (let to = head; to >= floor; to -= step) {
          const from = Math.max(floor, to - step + 1)
          const r = await scanContractEvents(
            provider,
            contract,
            [contract.filters.Transfer(null, user), contract.filters.Transfer(user, null)],
            from,
            to,
            { retries: UI_RETRIES, signal: ctrl.signal }
          )
          if (r.failedChunks > 0) return // 有缺段就不可能確定起點
          for (const ev of r.events) {
            transfers.push({
              blockNumber: ev.blockNumber,
              index: ev.index,
              from: String(ev.args.from),
              to: String(ev.args.to),
              value: BigInt(ev.args.value),
            })
          }
          const s = streakStart(bal, user, transfers)
          if (s.kind === 'inconsistent') return
          if (s.kind === 'found') {
            const block = await provider.getBlock(s.blockNumber)
            if (block && !ctrl.signal.aborted) setHeldSinceSec(Number(block.timestamp))
            return
          }
        }
        // 掃到範圍下緣仍沒有歸零：持有早於掃描範圍——不顯示。
      } catch (e) {
        if (!isChunkScanAborted(e)) console.warn('[useHeldSince]', e)
      }
    })()

    return () => ctrl.abort()
  }, [provider, token, user, chainId, balance])

  return heldSinceSec
}
