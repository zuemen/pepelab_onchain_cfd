// RWA 透明度頁要讀哪一條鏈、用哪一個節點。
//
// 這三頁是揭露頁：沒連錢包的人（評審、潛在客戶）也要看得到鏈上事實。所以：
//   - 目標鏈優先是正式部署鏈（PRIMARY_CHAIN_ID），其次是錢包所在且有部署的鏈；
//   - 錢包剛好在目標鏈上就用錢包的節點，否則用公開節點唯讀（只有 Base Sepolia 有，
//     而且 vercel.json 的 CSP connect-src 已放行 https://sepolia.base.org）。
// 只讀，不簽、不送交易。

import { JsonRpcProvider } from 'ethers'

import { BASE_SEPOLIA_RPC_URL, BASE_SEPOLIA_CHAIN_ID } from './chains'

/** 有公開唯讀節點的鏈。 */
export const PUBLIC_RPC: Readonly<Record<number, string>> = {
  [BASE_SEPOLIA_CHAIN_ID]: BASE_SEPOLIA_RPC_URL,
}

export function pickReadChainId(
  walletChainId: number | null,
  deployedChainIds: readonly number[],
  primaryChainId: number
): number | null {
  if (deployedChainIds.includes(primaryChainId)) return primaryChainId
  if (walletChainId !== null && deployedChainIds.includes(walletChainId)) return walletChainId
  return deployedChainIds[0] ?? null
}

export type ReadSource = 'wallet' | 'public' | null

/** 錢包在目標鏈上 → wallet；否則有公開節點 → public；都沒有 → null。 */
export function pickReadSource(
  target: number | null,
  walletChainId: number | null,
  hasWalletProvider: boolean
): ReadSource {
  if (target === null) return null
  if (hasWalletProvider && walletChainId === target) return 'wallet'
  return PUBLIC_RPC[target] ? 'public' : null
}

const cache = new Map<number, JsonRpcProvider>()

/**
 * 公開節點的唯讀 provider（每條鏈一個，模組層快取）。
 * batchMaxCount: 1——公開節點對大批次會靜默丟掉一部分（rpcBatch.ts），併發改由 mapLimit 控制。
 */
export function publicProvider(chainId: number): JsonRpcProvider | null {
  const url = PUBLIC_RPC[chainId]
  if (!url) return null
  let p = cache.get(chainId)
  if (!p) {
    p = new JsonRpcProvider(url, chainId, { staticNetwork: true, batchMaxCount: 1 })
    cache.set(chainId, p)
  }
  return p
}
