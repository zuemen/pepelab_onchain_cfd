import type { InterfaceAbi } from 'ethers'

import { Interface } from 'ethers'
import { it, expect, describe } from 'vitest'

import CopyTrackerABI from 'src/contracts/abi/CopyTracker.json'

import { fakeContract, fakeMulticallNode, type Handler } from './__fixtures__/fakeMulticallNode'
import {
  activeFollowers,
  combineFollowers,
  followerReaderOf,
  readActiveFollowers,
  readFollowersAcross,
  type CopyRecordView,
  type FollowerReader,
} from './activeFollowers'

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
  /** 批次讀的假 reader：記下每一批問了什麼。recordsOf 的值是 'fail' 代表那位跟單者讀不到。 */
  const fakeReader = (lists: Record<string, string[] | 'fail'>, recordsOf: Record<string, CopyRecordView[] | 'fail'> = {}) => {
    const batches = { counts: [] as string[][], slots: [] as number[], records: [] as string[][] }
    const reader: FollowerReader = {
      followerCounts: async (traders) => {
        batches.counts.push([...traders])
        return traders.map((t) => (lists[t] === 'fail' ? null : BigInt((lists[t] as string[] | undefined)?.length ?? 0)))
      },
      followersAt: async (slots) => {
        batches.slots.push(slots.length)
        return slots.map(({ trader, index }) => (lists[trader] as string[])[index] ?? null)
      },
      copyRecords: async (followers) => {
        batches.records.push([...followers])
        return followers.map((f) => (recordsOf[f] === 'fail' ? null : ((recordsOf[f] as CopyRecordView[] | undefined) ?? [])))
      },
    }
    return { reader, batches }
  }

  it('reads each follower once even when they copied several traders', async () => {
    const { reader, batches } = fakeReader(
      { [T]: [A, B], [X]: [A] },
      { [A]: [{ trader: T, active: true }, { trader: X, active: true }], [B]: [{ trader: T, active: false }] },
    )
    const result = await readActiveFollowers([T, X], reader)
    expect(result.get(T.toLowerCase())).toEqual([A])
    expect(result.get(X.toLowerCase())).toEqual([A])
    expect(batches.records).toEqual([[A, B]])
  })

  // 每一步一批：交易者再多，也只有三次讀取（readMany 再把每一批併成 Multicall3）
  it('asks for every trader in one batch per step', async () => {
    const { reader, batches } = fakeReader({ [T]: [A, B], [X]: [C] })
    await readActiveFollowers([T, X], reader)
    expect(batches.counts).toEqual([[T, X]])
    expect(batches.slots).toEqual([3])
    expect(batches.records).toHaveLength(1)
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

  it('gives null when the follower list itself cannot be read', async () => {
    const { reader } = fakeReader({ [T]: 'fail' })
    expect((await readActiveFollowers([T], reader)).get(T.toLowerCase())).toBeNull()
  })

  it('gives null when one entry of the follower list cannot be read', async () => {
    const { reader } = fakeReader({ [T]: [A] })
    reader.followersAt = async (slots) => slots.map(() => null)
    expect((await readActiveFollowers([T], reader)).get(T.toLowerCase())).toBeNull()
  })
})

describe('followerReaderOf', () => {
  const COPY_TRACKER = '0x00000000000000000000000000000000000000c7'
  const IFACE = new Interface(CopyTrackerABI as InterfaceAbi)
  const lists: Record<string, string[]> = { [T.toLowerCase()]: [A, B], [X.toLowerCase()]: [A] }
  const record = (trader: string, active: boolean) => [trader, 0n, 0n, [], 0n, active, 0n]
  const recordsOf: Record<string, unknown[]> = {
    [A.toLowerCase()]: [record(T, true), record(X, false)],
    [B.toLowerCase()]: [record(T, false)],
  }
  const handle: Handler = (method, args) => {
    const key = String(args[0]).toLowerCase()
    if (method === 'getFollowerCount') return [BigInt(lists[key]?.length ?? 0)]
    if (method === 'followersByTrader') return [lists[key][Number(args[1])]]
    if (method === 'getCopyRecords') return [recordsOf[key] ?? []]
    throw new Error(`unexpected ${method}`)
  }

  it('reads the active followers of many traders in three requests on Base Sepolia', async () => {
    const copyTracker = fakeContract(COPY_TRACKER, IFACE, handle)
    const node = fakeMulticallNode([copyTracker])
    const result = await readActiveFollowers([T, X], followerReaderOf(copyTracker, node, 84532))
    expect(result.get(T.toLowerCase())).toEqual([A])
    expect(result.get(X.toLowerCase())).toEqual([])
    expect(node.requests).toBe(3)
    expect(copyTracker.direct).toBe(0)
  })

  it('gives null for a trader when the node keeps rejecting the reads', async () => {
    const copyTracker = fakeContract(COPY_TRACKER, IFACE, handle)
    const result = await readActiveFollowers([T], followerReaderOf(copyTracker, fakeMulticallNode([copyTracker], Infinity), 84532))
    expect(result.get(T.toLowerCase())).toBeNull()
  })
})

describe('followers across the current and a replaced CopyTracker', () => {
  it('adds people still following on the old tracker, once each, and says how many', () => {
    expect(combineFollowers([A], [[A, B], [C]])).toEqual({ all: [A, B, C], legacyOnly: 2 })
    // 大小寫不同仍是同一個人
    expect(combineFollowers([A], [[A.toLowerCase()]])).toEqual({ all: [A], legacyOnly: 0 })
  })

  it('never turns an unreadable current tracker into a number', () => {
    expect(combineFollowers(null, [[A]])).toBeNull()
  })

  it('falls back to the current count when an old tracker cannot be read', () => {
    expect(combineFollowers([A], [null])).toEqual({ all: [A], legacyOnly: 0 })
  })

  it('reads every tracker and merges per trader; a failing old tracker only drops itself', async () => {
    // 批次 reader（見 FollowerReader）：lists 是每位交易者的 followersByTrader，active 是還在跟 T 的人
    const reader = (lists: Record<string, string[]>, active: string[]): FollowerReader => ({
      followerCounts: async (traders) => traders.map((t) => BigInt(lists[t]?.length ?? 0)),
      followersAt: async (slots) => slots.map(({ trader, index }) => lists[trader][index]),
      copyRecords: async (followers) => followers.map((f) => (active.includes(f) ? [{ trader: T, active: true }] : [])),
    })
    const current = reader({ [T]: [A] }, [A])
    const old = reader({ [T]: [A, B, C] }, [B, C])
    const broken: FollowerReader = {
      followerCounts: async () => { throw new Error('rpc down') },
      followersAt: async (slots) => slots.map(() => A),
      copyRecords: async (followers) => followers.map(() => []),
    }
    const out = await readFollowersAcross([T], current, [old, broken])
    expect(out.get(T.toLowerCase())).toEqual({ all: [A, B, C], legacyOnly: 2 })
  })
})
