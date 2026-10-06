import { it, expect, describe } from 'vitest'

import { PUBLIC_RPC, pickReadSource, publicProvider, pickReadChainId } from './readChain'

describe('readChain', () => {
  it('目標鏈優先是正式部署鏈，其次是錢包所在且有部署的鏈', () => {
    expect(pickReadChainId(11155111, [31337, 11155111, 84532], 84532)).toBe(84532)
    expect(pickReadChainId(null, [84532], 84532)).toBe(84532)
    expect(pickReadChainId(11155111, [11155111], 84532)).toBe(11155111)
    expect(pickReadChainId(1, [31337], 84532)).toBe(31337)
    expect(pickReadChainId(1, [], 84532)).toBeNull()
  })

  it('錢包在目標鏈上用錢包節點；否則用公開節點；都沒有回 null', () => {
    expect(pickReadSource(84532, 84532, true)).toBe('wallet')
    expect(pickReadSource(84532, 11155111, true)).toBe('public')
    expect(pickReadSource(84532, null, false)).toBe('public')
    expect(pickReadSource(31337, null, false)).toBeNull()
    expect(pickReadSource(null, 84532, true)).toBeNull()
  })

  it('公開節點只有 Base Sepolia（CSP connect-src 已放行），每條鏈一個 provider', () => {
    expect(Object.keys(PUBLIC_RPC)).toEqual(['84532'])
    expect(PUBLIC_RPC[84532]).toBe('https://sepolia.base.org')
    const a = publicProvider(84532)
    expect(a).not.toBeNull()
    expect(publicProvider(84532)).toBe(a)
    expect(publicProvider(1)).toBeNull()
  })
})
