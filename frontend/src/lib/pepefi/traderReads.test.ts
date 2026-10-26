import type { InterfaceAbi } from 'ethers'

import { Interface } from 'ethers'
import { it, expect, describe } from 'vitest'

import TraderStakeABI from 'src/contracts/abi/TraderStake.json'
import StrategyRegistryABI from 'src/contracts/abi/StrategyRegistry.json'

import { readTraderBasics, readStrategyVersions } from './traderReads'
import { Reverted, fakeContract, fakeMulticallNode, type Handler } from './__fixtures__/fakeMulticallNode'

const T = '0x00000000000000000000000000000000000000AA'
const X = '0x00000000000000000000000000000000000000BB'
const SAAPL = `0x${'11'.repeat(32)}`
const SBOND = `0x${'22'.repeat(32)}`
const BASE_SEPOLIA = 84532

const leg = (asset: string, weight: bigint) => [asset, weight, true, 2n]

/** T 是有兩版策略的交易者；X 註冊了但還沒發布策略（合約對 getLatestStrategy revert）。 */
const registryHandle: Handler = (method, args) => {
  const who = String(args[0]).toLowerCase()
  const isT = who === T.toLowerCase()
  if (method === 'traders') return isT ? [true, 'Whale Alpha', 1n] : [true, '', 2n]
  if (method === 'getLatestStrategy') {
    if (!isT) throw new Reverted('StrategyRegistry: no strategies')
    return [[leg(SAAPL, 6000n), leg(SBOND, 4000n)], 1n]
  }
  if (method === 'getStrategyCount') return [isT ? 2n : 0n]
  if (method === 'getStrategyVersion') {
    const v = Number(args[1])
    return [v === 0 ? [leg(SAAPL, 10000n)] : [leg(SAAPL, 6000n), leg(SBOND, 4000n)], BigInt(1000 + v)]
  }
  throw new Error(`unexpected ${method}`)
}

const stakeHandle: Handler = (method, args) => {
  const isT = String(args[0]).toLowerCase() === T.toLowerCase()
  if (method === 'reputationScore') return [isT ? 80n : 50n]
  if (method === 'getStake') return [[isT ? 1000n : 100n, isT ? 50n : 0n, 0n, 0n]]
  throw new Error(`unexpected ${method}`)
}

const setup = (rejectFirst = 0) => {
  const registry = fakeContract('0x00000000000000000000000000000000000000e1', new Interface(StrategyRegistryABI as InterfaceAbi), registryHandle)
  const traderStake = fakeContract('0x00000000000000000000000000000000000000e2', new Interface(TraderStakeABI as InterfaceAbi), stakeHandle)
  const node = fakeMulticallNode([registry, traderStake], rejectFirst)
  return { registry, traderStake, node }
}

describe('readTraderBasics', () => {
  it('reads name, latest strategy, reputation and stake of every trader in one request', async () => {
    const { registry, traderStake, node } = setup()
    const [t, x] = await readTraderBasics([T, X], { registry, traderStake }, node, BASE_SEPOLIA)
    expect(node.requests).toBe(1)
    expect(t).toEqual({
      displayName: 'Whale Alpha',
      allocs: [
        { asset: SAAPL, weight: 6000n, isLong: true, leverage: 2n },
        { asset: SBOND, weight: 4000n, isLong: true, leverage: 2n },
      ],
      reputation: 80n,
      stake: 1000n,
      totalSlashed: 50n,
    })
    // 沒有策略是合約給的答案：空的配置，其他欄位照讀
    expect(x).toEqual({ displayName: '', allocs: [], reputation: 50n, stake: 100n, totalSlashed: 0n })
  })

  it('leaves reputation and stake unknown when the node keeps rejecting the batch', async () => {
    const { registry, traderStake, node } = setup(Infinity)
    const [t] = await readTraderBasics([T], { registry, traderStake }, node, BASE_SEPOLIA)
    expect(t).toEqual({ displayName: '', allocs: [], reputation: null, stake: null, totalSlashed: null })
  })
})

describe('readStrategyVersions', () => {
  it('reads every version in one request, oldest first', async () => {
    const { registry, node } = setup()
    const versions = await readStrategyVersions(registry, T, 2, node, BASE_SEPOLIA)
    expect(node.requests).toBe(1)
    expect(versions).toEqual([
      { versionId: 0, createdAt: 1000n, allocs: [{ asset: SAAPL, weight: 10000n, isLong: true, leverage: 2n }] },
      {
        versionId: 1,
        createdAt: 1001n,
        allocs: [
          { asset: SAAPL, weight: 6000n, isLong: true, leverage: 2n },
          { asset: SBOND, weight: 4000n, isLong: true, leverage: 2n },
        ],
      },
    ])
  })

  // 少一版的歷史會讓人以為策略只改過這幾次：任何一版讀不到就整份不給
  it('gives null when any version could not be read', async () => {
    const { registry, node } = setup(Infinity)
    expect(await readStrategyVersions(registry, T, 2, node, BASE_SEPOLIA)).toBeNull()
  })
})
