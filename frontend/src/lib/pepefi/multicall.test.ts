import { Interface } from 'ethers'
import { it, expect, describe } from 'vitest'

import { readMany, type ReadCall, type ReadableContract } from './multicall'
import { Reverted, fakeContract, fakeMulticallNode, type Handler } from './__fixtures__/fakeMulticallNode'

const IFACE = new Interface([
  'function count(address who) view returns (uint256)',
  'function pair(address who) view returns (bool registered, string name, uint256 since)',
  'function boom() view returns (uint256)',
])

const TARGET = '0x00000000000000000000000000000000000000c0'
const WHO = '0x0000000000000000000000000000000000000001'
const BASE_SEPOLIA = 84532
const ANVIL = 31337

/** count 回位址最後一個位元組，pair 回三個值，boom 一律 revert。 */
const handle: Handler = (method, args) => {
  if (method === 'count') return [BigInt(parseInt(String(args[0]).slice(-2), 16))]
  if (method === 'pair') return [true, 'Whale Alpha', 7n]
  throw new Reverted('execution reverted')
}

const countOf = (contract: ReadableContract, i: number): ReadCall => ({
  contract,
  method: 'count',
  args: [`0x${i.toString(16).padStart(40, '0')}`],
})

describe('readMany on a chain with Multicall3', () => {
  it('sends every read in one request', async () => {
    const c = fakeContract(TARGET, IFACE, handle)
    const node = fakeMulticallNode([c])
    const out = await readMany(node, BASE_SEPOLIA, [countOf(c, 3), countOf(c, 9), { contract: c, method: 'pair', args: [WHO] }])
    expect(node.requests).toBe(1)
    expect(c.direct).toBe(0)
    expect(out[0]).toEqual({ status: 'ok', value: 3n })
    expect(out[1]).toEqual({ status: 'ok', value: 9n })
    // 多個回傳值照 ethers 的 Contract 呼叫給整組，單一回傳值給那一個值
    const pair = out[2]
    expect(pair.status).toBe('ok')
    expect(pair.status === 'ok' && [...(pair.value as unknown[])]).toEqual([true, 'Whale Alpha', 7n])
  })

  it('reports a call the contract rejected as reverted, not as unread', async () => {
    const c = fakeContract(TARGET, IFACE, handle)
    const out = await readMany(fakeMulticallNode([c]), BASE_SEPOLIA, [{ contract: c, method: 'boom' }, countOf(c, 1)])
    expect(out[0]).toEqual({ status: 'reverted' })
    expect(out[1]).toEqual({ status: 'ok', value: 1n })
  })

  it('splits a large batch into several requests', async () => {
    const c = fakeContract(TARGET, IFACE, handle)
    const node = fakeMulticallNode([c])
    const out = await readMany(node, BASE_SEPOLIA, Array.from({ length: 400 }, (_, i) => countOf(c, i % 200)))
    expect(node.requests).toBe(3)
    expect(out.every((o) => o.status === 'ok')).toBe(true)
    expect(out[399]).toEqual({ status: 'ok', value: 199n })
  })

  // sepolia.base.org 每秒 25 筆，超過回 429：被擋一次、重送讀到，就不能說成讀不到。
  it('retries a batch the node rejected once', async () => {
    const c = fakeContract(TARGET, IFACE, handle)
    const node = fakeMulticallNode([c], 1)
    const out = await readMany(node, BASE_SEPOLIA, [countOf(c, 5)])
    expect(node.requests).toBe(2)
    expect(out[0]).toEqual({ status: 'ok', value: 5n })
  })

  it('marks reads as unread when the node keeps rejecting their batch', async () => {
    const c = fakeContract(TARGET, IFACE, handle)
    const out = await readMany(fakeMulticallNode([c], Infinity), BASE_SEPOLIA, [countOf(c, 5)])
    expect(out[0]).toEqual({ status: 'unread' })
  })
})

describe('readMany on a chain without Multicall3', () => {
  // 本機 anvil 沒有預先部署 Multicall3，也沒有限速：一筆一筆讀。
  it('reads each call through its own contract', async () => {
    const c = fakeContract(TARGET, IFACE, handle)
    const node = fakeMulticallNode([c])
    const out = await readMany(node, ANVIL, [countOf(c, 4), { contract: c, method: 'boom' }])
    expect(node.requests).toBe(0)
    expect(c.direct).toBe(2)
    expect(out).toEqual([{ status: 'ok', value: 4n }, { status: 'reverted' }])
  })

  it('marks a call that kept failing for another reason as unread', async () => {
    const c = fakeContract(TARGET, IFACE, () => {
      throw new Error('network down')
    })
    expect(await readMany(null, ANVIL, [countOf(c, 1)])).toEqual([{ status: 'unread' }])
  })
})
