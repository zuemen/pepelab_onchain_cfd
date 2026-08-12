import type { Contract, BrowserProvider } from 'ethers'

import type { OpenedTrade } from './useExchangeActivity'

import { useExchangeActivity } from './useExchangeActivity'

export { WHALE_THRESHOLD } from 'src/lib/pepefi/whale'

/**
 * 近期鯨魚開倉。
 *
 * 現在只是 useExchangeActivity 的一層薄殼——掃描、分段、時間戳、門檻判定
 * 全在那裡，這裡只負責取前 N 筆。這麼做是因為同一份 PositionOpened 原本被
 * 掃了兩次（這個 hook 一次、WhaleTrackerPage 的 fetchGlobal 一次），兩邊各自
 * 最多 40 段序列 getLogs。
 *
 * 保留這個名字與回傳形狀，是為了讓 Dashboard 不必跟著改。
 */
export type WhaleAlert = OpenedTrade

export function useWhaleAlerts(
  exchange: Contract | null,
  provider: BrowserProvider | null,
  limit    = 20,
  chainId: number | null = null,
): { alerts: WhaleAlert[]; loading: boolean; refetch: () => void } {
  const { feed, loading, refetch } = useExchangeActivity(exchange, provider, chainId)
  return { alerts: feed.slice(0, limit), loading, refetch }
}
