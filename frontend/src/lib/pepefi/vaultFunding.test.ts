import { vi, it, expect, describe } from 'vitest'

import { VAULT_FUNDED_TOPIC, loadOperatorFunding } from './vaultFunding'

const VAULT = '0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a'

const logOf = (amount: bigint, overrides: Record<string, unknown> = {}) => ({
  address: VAULT.toLowerCase(),
  topics: [VAULT_FUNDED_TOPIC, '0x00'],
  data: '0x' + amount.toString(16).padStart(64, '0'),
  ...overrides,
})

const jsonFetch = (body: unknown, ok = true) =>
  vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch

describe('loadOperatorFunding', () => {
  it('加總這個金庫的每一筆 VaultFunded，查詢帶上地址與事件 topic', async () => {
    const fetchImpl = jsonFetch({ status: '1', message: 'OK', result: [logOf(200n), logOf(50n)] })
    await expect(loadOperatorFunding({ chainId: 84532, vault: VAULT, fetchImpl })).resolves.toBe(250n)
    const url = String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])
    expect(url).toContain('base-sepolia.blockscout.com')
    expect(url).toContain(VAULT)
    expect(url).toContain(VAULT_FUNDED_TOPIC)
  })

  it('瀏覽器回「沒有事件」就是確實沒有注資', async () => {
    const fetchImpl = jsonFetch({ status: '0', message: 'No logs found', result: [] })
    await expect(loadOperatorFunding({ chainId: 84532, vault: VAULT, fetchImpl })).resolves.toBe(0n)
  })

  it('其他錯誤是讀取失敗，不是 0', async () => {
    const fetchImpl = jsonFetch({ status: '0', message: 'NOTOK', result: null })
    await expect(loadOperatorFunding({ chainId: 84532, vault: VAULT, fetchImpl })).resolves.toBeNull()
  })

  it('HTTP 失敗或網路錯誤是讀取失敗', async () => {
    await expect(
      loadOperatorFunding({ chainId: 84532, vault: VAULT, fetchImpl: jsonFetch({}, false) }),
    ).resolves.toBeNull()
    const boom = vi.fn(async () => { throw new Error('network') }) as unknown as typeof fetch
    await expect(loadOperatorFunding({ chainId: 84532, vault: VAULT, fetchImpl: boom })).resolves.toBeNull()
  })

  it('回傳別的地址或別的事件時整筆不採信', async () => {
    const wrongAddr = jsonFetch({ status: '1', result: [logOf(1n, { address: '0x0000000000000000000000000000000000000001' })] })
    await expect(loadOperatorFunding({ chainId: 84532, vault: VAULT, fetchImpl: wrongAddr })).resolves.toBeNull()
    const wrongTopic = jsonFetch({ status: '1', result: [logOf(1n, { topics: ['0xdead'] })] })
    await expect(loadOperatorFunding({ chainId: 84532, vault: VAULT, fetchImpl: wrongTopic })).resolves.toBeNull()
  })

  it('結果達到單頁上限時可能被截斷，視為讀取失敗', async () => {
    const fetchImpl = jsonFetch({ status: '1', result: Array.from({ length: 1000 }, () => logOf(1n)) })
    await expect(loadOperatorFunding({ chainId: 84532, vault: VAULT, fetchImpl })).resolves.toBeNull()
  })

  it('本機鏈節點沒有範圍上限，直接掃事件', async () => {
    const queryLocal = vi.fn(async () => [7n, 3n])
    await expect(loadOperatorFunding({ chainId: 31337, vault: VAULT, queryLocal })).resolves.toBe(10n)
  })

  it('本機鏈掃描失敗是讀取失敗', async () => {
    const queryLocal = vi.fn(async () => { throw new Error('rpc') })
    await expect(loadOperatorFunding({ chainId: 31337, vault: VAULT, queryLocal })).resolves.toBeNull()
  })

  it('沒有對應區塊瀏覽器的鏈回 null', async () => {
    const fetchImpl = jsonFetch({ status: '1', result: [] })
    await expect(loadOperatorFunding({ chainId: 1, vault: VAULT, fetchImpl })).resolves.toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
