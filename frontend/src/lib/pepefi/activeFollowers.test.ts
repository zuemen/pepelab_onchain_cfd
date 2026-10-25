import { it, expect, describe } from 'vitest'

import { RPC_CONCURRENCY } from './rpcBatch'
import { activeFollowers, readActiveFollowers, type CopyRecordView, type FollowerReader } from './activeFollowers'

const T = '0x00000000000000000000000000000000000000AA'
const X = '0x00000000000000000000000000000000000000BB'
const A = '0x0000000000000000000000000000000000000001'
const B = '0x0000000000000000000000000000000000000002'
const C = '0x0000000000000000000000000000000000000003'

describe('activeFollowers', () => {
  // followersByTrader 每次跟單 push 一次、取消不移除：A 跟過、取消、又跟一次，所以出現兩次。
  const everFollowed = [A, B, A, C]
  const records = new Map<string, CopyRecordView[]>([
    [A.toLowerCase(), [{ trader: T, active: false }, { trader: T.toLowerCase(), active: true }]],
    [B.toLowerCase(), [{ trader: T, active: false }]],
    [C.toLowerCase(), [{ trader: T, active: false }, { trader: X, active: true }]],
  ])

  it('keeps only the people who still have an active copy of this trader, once each', () => {
    expect(activeFollowers(T, everFollowed, records)).toEqual([A])
  })

  it('does not count an active copy of a different trader', () => {
    expect(activeFollowers(X, [C], records)).toEqual([C])
    expect(activeFollowers(T, [C], records)).toEqual([])
  })

  it('is empty for a trader nobody has copied', () => {
    expect(activeFollowers(T, [], records)).toEqual([])
  })
})

describe('readActiveFollowers', () => {
  const fakeReader = (lists: Record<string, string[]>, recordsOf: Record<string, CopyRecordView[] | 'fail'>) => {
    const calls = { copyRecords: 0 }
    const reader: FollowerReader = {
      followerCount: async (trader) => BigInt(lists[trader]?.length ?? 0),
      followerAt: async (trader, i) => lists[trader][i],
      copyRecords: async (follower) => {
        calls.copyRecords += 1
        const value = recordsOf[follower]
        if (value === 'fail') throw new Error('rpc down')
        return value ?? []
      },
    }
    return { reader, calls }
  }

  it('reads each follower once even when they copied several traders', async () => {
    const { reader, calls } = fakeReader(
      { [T]: [A, B], [X]: [A] },
      { [A]: [{ trader: T, active: true }, { trader: X, active: true }], [B]: [{ trader: T, active: false }] },
    )
    const result = await readActiveFollowers([T, X], reader)
    expect(result.get(T.toLowerCase())).toEqual([A])
    expect(result.get(X.toLowerCase())).toEqual([A])
    expect(calls.copyRecords).toBe(2)
  })

  it('gives null, not an empty list, for a trader whose followers could not be read', async () => {
    const { reader } = fakeReader(
      { [T]: [A, B], [X]: [C] },
      { [A]: [{ trader: T, active: true }], [B]: 'fail', [C]: [{ trader: X, active: true }] },
    )
    const result = await readActiveFollowers([T, X], reader)
    expect(result.get(T.toLowerCase())).toBeNull()
    expect(result.get(X.toLowerCase())).toEqual([C])
  })

  // sepolia.base.org 每秒 25 筆，超過回 429；第一次被擋、第二次讀到，就不能說成讀不到。
  it('retries a read that was rate-limited once instead of giving null', async () => {
    let failedOnce = false
    const reader: FollowerReader = {
      followerCount: async () => 1n,
      followerAt: async () => A,
      copyRecords: async () => {
        if (!failedOnce) {
          failedOnce = true
          throw new Error('25/second request limit reached')
        }
        return [{ trader: T, active: true }]
      },
    }
    expect((await readActiveFollowers([T], reader)).get(T.toLowerCase())).toEqual([A])
  })

  it('keeps at most RPC_CONCURRENCY reads in flight', async () => {
    let inFlight = 0
    let peak = 0
    const track = async <V>(value: V): Promise<V> => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => { setTimeout(r, 1) })
      inFlight -= 1
      return value
    }
    const traders = Array.from({ length: 20 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`)
    const reader: FollowerReader = {
      followerCount: (trader) => track(BigInt(traders.indexOf(trader) % 3)),
      followerAt: (trader, i) => track(`0x${(100 + i).toString(16).padStart(40, '0')}`),
      copyRecords: () => track([]),
    }
    await readActiveFollowers(traders, reader)
    expect(peak).toBeLessThanOrEqual(RPC_CONCURRENCY)
  })

  it('gives null when the follower list itself cannot be read', async () => {
    const reader: FollowerReader = {
      followerCount: async () => { throw new Error('rpc down') },
      followerAt: async () => A,
      copyRecords: async () => [],
    }
    expect((await readActiveFollowers([T], reader)).get(T.toLowerCase())).toBeNull()
  })
})
