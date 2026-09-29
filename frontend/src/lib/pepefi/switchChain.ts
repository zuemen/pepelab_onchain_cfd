// 錢包切到 Base Sepolia：先 wallet_switchEthereumChain，錢包不認得這條鏈（4902）
// 才 wallet_addEthereumChain（EIP-3085，帶完整參數；多數錢包加完會順便切過去）。

import { BASE_SEPOLIA_PARAMS } from './chains'

export type Eip1193Request = (args: { method: string; params?: unknown[] }) => Promise<unknown>

/** 錢包「不認得這條鏈」的錯誤碼。MetaMask 行動版會包在 data.originalError 裡。 */
export function isUnknownChainError(err: unknown): boolean {
  const e = err as { code?: number; data?: { originalError?: { code?: number } } } | null
  return e?.code === 4902 || e?.data?.originalError?.code === 4902
}

export async function switchToBaseSepolia(request: Eip1193Request): Promise<'switched' | 'added'> {
  try {
    await request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_SEPOLIA_PARAMS.chainId }] })
    return 'switched'
  } catch (err) {
    if (!isUnknownChainError(err)) throw err
    await request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          ...BASE_SEPOLIA_PARAMS,
          rpcUrls: [...BASE_SEPOLIA_PARAMS.rpcUrls],
          blockExplorerUrls: [...BASE_SEPOLIA_PARAMS.blockExplorerUrls],
        },
      ],
    })
    return 'added'
  }
}
