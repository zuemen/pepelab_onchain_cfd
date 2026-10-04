import { it, expect, describe } from 'vitest'

import { loadAssetModes, modeSupportFromCode, ASSET_MODE_SELECTOR } from './assetModeProbe'

/** 一段最小的 runtime bytecode：每個 selector 都是 PUSH4 <selector> 接 EQ。 */
const codeWith = (...selectors: string[]) => `0x${selectors.map((s) => `63${s.slice(2)}14`).join('')}00`

describe('assetMode 支援度探測', () => {
  it('selector 是 0x6ca3a705，不以 0x00 開頭（PUSH4 掃得到）', () => {
    expect(ASSET_MODE_SELECTOR).toBe('0x6ca3a705')
  })

  it('bytecode 有 selector → supported；沒有 → unsupported；讀不到／沒有合約 → unknown', () => {
    expect(modeSupportFromCode(codeWith('0x1584410a', ASSET_MODE_SELECTOR))).toBe('supported')
    expect(modeSupportFromCode(codeWith('0x1584410a'))).toBe('unsupported')
    expect(modeSupportFromCode(null)).toBe('unknown')
    expect(modeSupportFromCode('0x')).toBe('unknown')
  })

  it('supported：逐資產讀模式；單一資產讀不到是 mode = null，不猜 Active', async () => {
    const out = await loadAssetModes(
      {
        getCode: async () => codeWith(ASSET_MODE_SELECTOR),
        readMode: async (a) => {
          if (a === 'b') throw new Error('rpc')
          return a === 'a' ? 1n : 0n
        },
      },
      ['a', 'b', 'c']
    )
    expect(out.support).toBe('supported')
    expect(out.modes).toEqual({
      a: { kind: 'supported', mode: 1 },
      b: { kind: 'supported', mode: null },
      c: { kind: 'supported', mode: 0 },
    })
  })

  it('unsupported：不呼叫 assetMode', async () => {
    let calls = 0
    const out = await loadAssetModes(
      {
        getCode: async () => codeWith('0x1584410a'),
        readMode: async () => {
          calls += 1
          return 0n
        },
      },
      ['a']
    )
    expect(out.modes).toEqual({ a: { kind: 'unsupported' } })
    expect(calls).toBe(0)
  })

  it('getCode 失敗 → unknown；上一次已知支援度時不重讀 bytecode', async () => {
    const failed = await loadAssetModes(
      { getCode: () => Promise.reject(new Error('rpc')), readMode: async () => 0n },
      ['a']
    )
    expect(failed).toEqual({ support: 'unknown', modes: { a: { kind: 'unknown' } } })

    let codeReads = 0
    const cached = await loadAssetModes(
      {
        getCode: async () => {
          codeReads += 1
          return null
        },
        readMode: async () => 2n,
      },
      ['a'],
      'supported'
    )
    expect(codeReads).toBe(0)
    expect(cached.modes.a).toEqual({ kind: 'supported', mode: 2 })
  })
})
