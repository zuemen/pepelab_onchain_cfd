import { it, expect, describe } from 'vitest'

import {
  ok,
  FAILED,
  mapReading,
  selectorOf,
  supportMap,
  readGuarded,
  UNSUPPORTED,
  loadProbeCode,
  supportFromCode,
  EIP1967_IMPL_SLOT,
} from './contractProbe'

/** 一段只有 PUSH4 selector 的假 bytecode。 */
const codeWith = (sigs: string[]) => `0x${sigs.map((s) => `63${selectorOf(s).slice(2)}`).join('')}00`

describe('supportFromCode / supportMap', () => {
  it('bytecode 讀不到時一律 unknown（不下結論）', () => {
    expect(supportFromCode(null, 'kyc()')).toBe('unknown')
    expect(supportFromCode('0x', 'kyc()')).toBe('unknown')
    expect(supportMap(undefined, ['kyc()', 'rwaAsset(bytes32)'])).toEqual({
      'kyc()': 'unknown',
      'rwaAsset(bytes32)': 'unknown',
    })
  })

  it('有 selector → supported；沒有 → unsupported（舊部署沒有 assetMode）', () => {
    const code = codeWith(['kyc()', 'rwaAsset(bytes32)'])
    expect(supportFromCode(code, 'kyc()')).toBe('supported')
    expect(supportMap(code, ['rwaAsset(bytes32)', 'assetMode(bytes32)'])).toEqual({
      'rwaAsset(bytes32)': 'supported',
      'assetMode(bytes32)': 'unsupported',
    })
  })

  it('這幾頁要探測的 selector 都不以 0x00 開頭（PUSH4 掃得到）', () => {
    for (const s of [
      'kyc()',
      'rwaAsset(bytes32)',
      'maxLeverageForAsset(bytes32)',
      'maintenanceMarginBpsForAsset(bytes32)',
      'assetMode(bytes32)',
      'medianCarbonTier(bytes32)',
      'getAttestors(bytes32)',
      'nextPositionId()',
      'getPosition(uint256)',
      'getUnrealizedPnL(uint256)',
      'adlEnabled()',
    ]) {
      expect(selectorOf(s).startsWith('0x00'), s).toBe(false)
    }
  })
})

describe('readGuarded', () => {
  it('unsupported 時不呼叫', async () => {
    let called = false
    const r = await readGuarded('unsupported', async () => {
      called = true
      return 1
    })
    expect(r).toEqual(UNSUPPORTED)
    expect(called).toBe(false)
  })

  it('revert 或逾時都是 failed，不是 0', async () => {
    expect(await readGuarded('supported', () => Promise.reject(new Error('revert')))).toEqual(FAILED)
    expect(await readGuarded('unknown', () => new Promise<number>(() => undefined), 20)).toEqual(FAILED)
    expect(await readGuarded('unknown', async () => 0n)).toEqual(ok(0n))
  })

  it('mapReading 只轉換 ok', () => {
    expect(mapReading(ok(2), (v) => v * 2)).toEqual(ok(4))
    expect(mapReading(FAILED, (v: number) => v * 2)).toEqual(FAILED)
  })
})

describe('loadProbeCode', () => {
  const IMPL = '0x' + 'ab'.repeat(20)
  it('EIP-1967 proxy 回實作合約的 bytecode', async () => {
    const code = await loadProbeCode(
      {
        getCode: async (a) => (a.toLowerCase() === IMPL ? '0x6311223344' : '0xproxy00'),
        getStorage: async (_a, slot) => {
          expect(slot).toBe(EIP1967_IMPL_SLOT)
          return `0x${'0'.repeat(24)}${IMPL.slice(2)}`
        },
      },
      '0x' + '01'.repeat(20)
    )
    expect(code).toBe('0x6311223344')
  })

  it('不是 proxy（槽為 0）回自己的 bytecode；沒有合約回 null；getCode 失敗回 null', async () => {
    const plain = await loadProbeCode(
      { getCode: async () => '0x6311223344', getStorage: async () => `0x${'0'.repeat(64)}` },
      '0x' + '01'.repeat(20)
    )
    expect(plain).toBe('0x6311223344')
    expect(await loadProbeCode({ getCode: async () => '0x' }, '0x' + '01'.repeat(20))).toBeNull()
    expect(await loadProbeCode({ getCode: () => Promise.reject(new Error('rpc')) }, '0x' + '01'.repeat(20))).toBeNull()
  })
})
