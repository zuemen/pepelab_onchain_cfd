import { it, vi, expect, describe, afterEach, beforeEach } from 'vitest'

import { throttleReads, createRateGate, createRpcFailover, isTransientNodeFailure } from './rpcThrottle'

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

describe('讀取備援', () => {
  const noGate = async () => {}
  const wallet = (fail: unknown) => ({
    request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x14a34'
      throw fail
    }),
  })

  it('節點限流時改問公開節點', async () => {
    const failover = vi.fn(async () => ({ result: '0xabc' }))
    const w = wallet({ code: -32005, message: 'rate limit exceeded' })
    await expect(throttleReads(w, noGate, failover).request({ method: 'eth_call', params: [] })).resolves.toBe('0xabc')
    expect(failover).toHaveBeenCalledWith(84532, { method: 'eth_call', params: [] })
  })

  it('eth_call 回空值也改問公開節點', async () => {
    const failover = vi.fn(async () => ({ result: '0xabc' }))
    const w = { request: vi.fn(async ({ method }: { method: string }) => (method === 'eth_chainId' ? '0x14a34' : null)) }
    await expect(throttleReads(w, noGate, failover).request({ method: 'eth_call', params: [] })).resolves.toBe('0xabc')
  })

  it('合約 revert 不換節點，原樣丟回', async () => {
    const failover = vi.fn(async () => ({ result: '0x' }))
    const revert = { code: 3, message: 'execution reverted', data: '0x4f402872' }
    await expect(throttleReads(wallet(revert), noGate, failover).request({ method: 'eth_call', params: [] })).rejects.toBe(revert)
    expect(failover).not.toHaveBeenCalled()
  })

  it('簽名與送交易不走備援', async () => {
    const failover = vi.fn(async () => ({ result: '0x1' }))
    const fail = { code: 429, message: 'too many' }
    await expect(throttleReads(wallet(fail), noGate, failover).request({ method: 'eth_sendTransaction', params: [] })).rejects.toBe(fail)
    expect(failover).not.toHaveBeenCalled()
  })

  it('備援也沒有答案時丟原本的錯誤', async () => {
    const fail = { code: 429, message: 'too many' }
    await expect(throttleReads(wallet(fail), noGate, async () => undefined).request({ method: 'eth_call', params: [] })).rejects.toBe(fail)
  })

  it('沒有設定備援節點的鏈不送任何請求', async () => {
    const fetchImpl = vi.fn()
    await expect(createRpcFailover(fetchImpl as unknown as typeof fetch, noGate)(31337, { method: 'eth_call' })).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('第一個節點失敗換下一個；節點回 revert 視為答案', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ error: { code: 3, message: 'execution reverted', data: '0x11' } }) })
    await expect(createRpcFailover(fetchImpl as unknown as typeof fetch, noGate)(84532, { method: 'eth_call' })).resolves.toEqual({
      rpcError: { code: 3, message: 'execution reverted', data: '0x11' },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('備援節點的 eth_call 回 null 就換下一個', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: null }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: '0x12' }) })
    await expect(createRpcFailover(fetchImpl as unknown as typeof fetch, noGate)(84532, { method: 'eth_call' })).resolves.toEqual({ result: '0x12' })
  })

  it('其他方法的 null 是合法答案（例如還沒上鏈的收據）', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ result: null }) })
    await expect(createRpcFailover(fetchImpl as unknown as typeof fetch, noGate)(84532, { method: 'eth_getTransactionReceipt' })).resolves.toEqual({ result: null })
  })

  it('每個備援請求都帶逾時訊號；卡住的節點會換下一個', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ result: '0x1' }) })
    await expect(createRpcFailover(fetchImpl as unknown as typeof fetch, noGate)(84532, { method: 'eth_call' })).resolves.toEqual({ result: '0x1' })
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })

  it('ethers 包裝過的限流錯誤仍判定為節點故障', () => {
    const wrapped = {
      code: 'CALL_EXCEPTION',
      message: 'missing revert data (action="call", data=null, reason=null, revert=null, code=CALL_EXCEPTION, version=6.17.0)',
      info: { error: { code: -32007, message: '25/second request limit reached' } },
    }
    expect(isTransientNodeFailure(wrapped)).toBe(true)
  })

  it('分得出節點故障與合約 revert', () => {
    expect(isTransientNodeFailure({ code: -32603, message: 'Internal JSON-RPC error.' })).toBe(true)
    expect(isTransientNodeFailure(new Error('Failed to fetch'))).toBe(true)
    expect(isTransientNodeFailure({ code: -32603, message: 'x', data: { data: '0x4f402872' } })).toBe(false)
    expect(isTransientNodeFailure({ code: 4001, message: 'User rejected' })).toBe(false)
  })
})
