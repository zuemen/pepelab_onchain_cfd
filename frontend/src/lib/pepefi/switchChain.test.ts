import { it, vi, expect, describe } from 'vitest'

import { BASE_SEPOLIA_PARAMS, BASE_SEPOLIA_CHAIN_ID } from './chains'
import { isUnknownChainError, switchToBaseSepolia } from './switchChain'

const err = (code: number) => Object.assign(new Error('x'), { code })

describe('switchToBaseSepolia', () => {
  it('錢包認得這條鏈 → 只呼叫 wallet_switchEthereumChain', async () => {
    const request = vi.fn().mockResolvedValue(null)
    await expect(switchToBaseSepolia(request)).resolves.toBe('switched')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] })
  })

  it('4902 → 改呼叫 wallet_addEthereumChain，帶完整 Base Sepolia 參數', async () => {
    const request = vi.fn().mockRejectedValueOnce(err(4902)).mockResolvedValueOnce(null)
    await expect(switchToBaseSepolia(request)).resolves.toBe('added')
    const [, second] = request.mock.calls
    expect(second[0].method).toBe('wallet_addEthereumChain')
    const p = second[0].params[0]
    expect(p.chainId).toBe('0x14a34')
    expect(parseInt(p.chainId, 16)).toBe(BASE_SEPOLIA_CHAIN_ID)
    expect(p.chainName).toBe('Base Sepolia')
    expect(p.nativeCurrency).toEqual({ name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 })
    expect(p.rpcUrls).toEqual(['https://sepolia.base.org'])
    expect(p.blockExplorerUrls).toEqual(['https://sepolia.basescan.org'])
  })

  it('MetaMask 行動版把 4902 包在 data.originalError 裡也要認得', () => {
    expect(isUnknownChainError({ code: -32603, data: { originalError: { code: 4902 } } })).toBe(true)
  })

  it('使用者拒絕（4001）或其他錯誤 → 原樣拋出，不去加鏈', async () => {
    const request = vi.fn().mockRejectedValueOnce(err(4001))
    await expect(switchToBaseSepolia(request)).rejects.toMatchObject({ code: 4001 })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('參數常數本身與 chainId 一致', () => {
    expect(parseInt(BASE_SEPOLIA_PARAMS.chainId, 16)).toBe(84532)
  })
})
