import { Interface } from 'ethers'
import { it, expect, describe } from 'vitest'

import {
  CARBON_RETIREMENT_ABI,
  resolveCarbonRetirement,
  CARBON_RETIREMENT_BY_CHAIN,
} from './carbonRetirement'

const ADDR = '0x1234567890abcdef1234567890abcdef12345678'
const OTHER = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
const ZERO = '0x0000000000000000000000000000000000000000'

describe('CarbonRetirement 位址解析（#105）', () => {
  it('目前沒有任何鏈部署：表是空的，未設 env 時一律回 null（畫面不顯示退役區塊）', () => {
    expect(Object.keys(CARBON_RETIREMENT_BY_CHAIN)).toEqual([])
    expect(resolveCarbonRetirement(84532, undefined)).toBeNull()
    expect(resolveCarbonRetirement(84532, '')).toBeNull()
    expect(resolveCarbonRetirement(null, undefined)).toBeNull()
  })

  it('env 優先於表', () => {
    expect(resolveCarbonRetirement(84532, ADDR, { 84532: OTHER })).toBe(ADDR)
    expect(resolveCarbonRetirement(null, `  ${ADDR}  `)).toBe(ADDR)
  })

  it('沒有 env 時用該鏈的表', () => {
    expect(resolveCarbonRetirement(84532, undefined, { 84532: OTHER })).toBe(OTHER)
    expect(resolveCarbonRetirement(1, undefined, { 84532: OTHER })).toBeNull()
  })

  it('零位址與格式不對的值都當成沒設定，不會拿去發 RPC', () => {
    expect(resolveCarbonRetirement(84532, ZERO)).toBeNull()
    expect(resolveCarbonRetirement(84532, '0x1234')).toBeNull()
    expect(resolveCarbonRetirement(84532, 'not-an-address', { 84532: ZERO })).toBeNull()
  })
})

describe('CarbonRetirement ABI 片段', () => {
  const iface = new Interface(CARBON_RETIREMENT_ABI as unknown as string[])

  it('事件簽章與合約一致：CarbonRetired(amount, tonnesCO2e, timestamp)', () => {
    expect(iface.getEvent('CarbonRetired')?.format('sighash')).toBe('CarbonRetired(uint256,uint256,uint256)')
  })

  it('畫面用到的 view 都在', () => {
    for (const fn of [
      'SIMULATED',
      'usdc',
      'budget',
      'totalRetiredTonnes',
      'totalSpent',
      'retirementCount',
      'getRecentRetirements',
    ]) {
      expect(iface.getFunction(fn), fn).not.toBeNull()
    }
  })
})
