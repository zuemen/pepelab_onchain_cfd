import type { Provider } from 'ethers'

import { Contract } from 'ethers'
import { useRef, useState, useEffect, useCallback } from 'react'

import { UI_RETRIES, isChunkScanAborted, scanContractEvents } from 'src/lib/pepefi/chainLogs'
import {
  peekHeldSince,
  queryHeldSince,
  type HeldSinceDeps,
  type HeldSinceState,
  type HeldSinceTarget,
} from 'src/lib/pepefi/heldSinceQuery'

/** 代幣只需要這兩個介面；V1／V2 的 SyntheticAsset 都是標準 ERC-20 Transfer。 */
const ERC20_TRANSFER_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address) view returns (uint256)',
]

function ethersDeps(provider: Provider, token: string, user: string): HeldSinceDeps {
  const contract = new Contract(token, ERC20_TRANSFER_ABI, provider)
  return {
    head: () => provider.getBlockNumber(),
    balanceAt: (blockTag) => contract.balanceOf(user, { blockTag }) as Promise<bigint>,
    scan: async (from, to, { signal }) => {
      const r = await scanContractEvents(
        provider,
        contract,
        [contract.filters.Transfer(null, user), contract.filters.Transfer(user, null)],
        from,
        to,
        { retries: UI_RETRIES, signal }
      )
      return {
        failed: r.failedChunks > 0,
        transfers: r.events.map((ev) => ({
          blockNumber: ev.blockNumber,
          index: ev.index,
          from: String(ev.args.from),
          to: String(ev.args.to),
          value: BigInt(ev.args.value),
        })),
      }
    },
    blockTime: async (n) => {
      const block = await provider.getBlock(n)
      return block ? Number(block.timestamp) : null
    },
  }
}

export interface UseHeldSinceResult {
  state: HeldSinceState
  /** 使用者點了「查詢持有天數」。沒有持有或沒有 provider 時是 null——不顯示按鈕。 */
  query: (() => void) | null
}

/**
 * 「你已持有 N 天」（#134）。**預設不發任何請求**：只同步讀快取（查過的直接顯示），
 * 沒查過就回 idle，由詳情層顯示按鈕；使用者按下才呼叫 queryHeldSince 掃鏈上 Transfer。
 * 查詢流程、快取規則與「找不到不顯示」見 lib/pepefi/heldSinceQuery.ts。
 */
export function useHeldSince(a: {
  provider: Provider | null
  token: string | null | undefined
  user: string | null | undefined
  chainId: number | null
  balance: bigint | undefined
}): UseHeldSinceResult {
  const { provider, token, user, chainId, balance } = a
  const target: HeldSinceTarget | null =
    token && user && balance !== undefined && balance > 0n ? { chainId, token, user, balance } : null
  const targetKey = target ? `${chainId}:${token}:${user}:${balance}` : null

  const [state, setState] = useState<HeldSinceState>({ status: 'idle' })
  const ctrlRef = useRef<AbortController | null>(null)

  // 目標一變（換資產、換錢包、買賣後餘額變了）：中止進行中的查詢，只讀快取——不發請求。
  useEffect(() => {
    ctrlRef.current?.abort()
    ctrlRef.current = null
    setState(target ? peekHeldSince(target) : { status: 'idle' })
    return () => ctrlRef.current?.abort()
    // targetKey 涵蓋 target 的每個欄位
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey])

  const query = useCallback(() => {
    if (!provider || !target) return
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setState({ status: 'loading' })
    queryHeldSince(target, ethersDeps(provider, target.token, target.user), ctrl.signal)
      .then((s) => {
        if (!ctrl.signal.aborted) setState(s)
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || isChunkScanAborted(e)) return
        console.warn('[useHeldSince]', e)
        setState({ status: 'unknown' })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, targetKey])

  return { state, query: provider && target ? query : null }
}
