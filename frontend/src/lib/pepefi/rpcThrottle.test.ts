import { it, vi, expect, describe, afterEach, beforeEach } from 'vitest'

import { throttleReads, createRateGate } from './rpcThrottle'

describe('createRateGate', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('lets at most `limit` through in any one-second window, in arrival order', async () => {
    const gate = createRateGate(20)
    const start = Date.now()
    const passedAt: number[] = []
    const all = Array.from({ length: 50 }, (_, i) => gate().then(() => { passedAt[i] = Date.now() - start }))
    await vi.advanceTimersByTimeAsync(3000)
    await Promise.all(all)

    expect(passedAt.slice(0, 20).every((t) => t === 0)).toBe(true)
    expect(passedAt.slice(20, 40).every((t) => t === 1000)).toBe(true)
    expect(passedAt.slice(40).every((t) => t === 2000)).toBe(true)
  })

  it('does not hold anything back while under the limit', async () => {
    const gate = createRateGate(20)
    let passed = 0
    await Promise.all(Array.from({ length: 5 }, () => gate().then(() => { passed += 1 })))
    expect(passed).toBe(5)
  })
})

describe('throttleReads', () => {
  const fakeWallet = () => {
    const seen: string[] = []
    return { seen, request: async ({ method }: { method: string }) => { seen.push(method); return method } }
  }

  it('sends node reads through the gate', async () => {
    const wallet = fakeWallet()
    const gate = vi.fn(async () => {})
    await throttleReads(wallet, gate).request({ method: 'eth_call', params: [] })
    await throttleReads(wallet, gate).request({ method: 'eth_getLogs', params: [] })
    expect(gate).toHaveBeenCalledTimes(2)
    expect(wallet.seen).toEqual(['eth_call', 'eth_getLogs'])
  })

  it('never makes the user wait on wallet prompts', async () => {
    const wallet = fakeWallet()
    const gate = vi.fn(() => new Promise<void>(() => {}))
    const p = throttleReads(wallet, gate)
    for (const method of ['eth_requestAccounts', 'eth_sendTransaction', 'personal_sign', 'eth_signTypedData_v4', 'wallet_switchEthereumChain', 'eth_chainId', 'eth_accounts']) {
      // eslint-disable-next-line no-await-in-loop
      expect(await p.request({ method })).toBe(method)
    }
    expect(gate).not.toHaveBeenCalled()
  })
})
