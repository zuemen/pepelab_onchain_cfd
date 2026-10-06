import type { RwaCardDeps } from './rwaCards'
import type { AssetSymbol } from 'src/contracts/addresses'

import { it, expect, describe } from 'vitest'

import { ASSET_IDS } from 'src/contracts/addresses'

import { RWA_CARD_ORDER } from './rwaProfile'
import { ok, FAILED, selectorOf, UNSUPPORTED } from './contractProbe'
import {
  bpsToPct,
  closureRule,
  rwaFlagNote,
  attestorNote,
  kycRequirement,
  EXCHANGE_VIEWS,
  loadRwaSnapshot,
} from './rwaCards'

const codeWith = (sigs: readonly string[]) => `0x${sigs.map((s) => `63${selectorOf(s).slice(2)}`).join('')}00`

const KYC = '0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d'
const RWA_FLAGGED = new Set<string>(['sAAPL', 'sTSLA', 'sNVDA', 'sMSFT', 'sGOOGL', 'sBOND', 'sICLN', 'sESGU'].map((s) => ASSET_IDS[s as AssetSymbol]))

/** 模擬線上的舊部署：有 kyc／rwaAsset／槓桿／維持保證金，沒有 assetMode。 */
function liveLikeDeps(over: Partial<RwaCardDeps> = {}): RwaCardDeps {
  return {
    exchangeCode: async () => codeWith(EXCHANGE_VIEWS.filter((v) => v !== 'assetMode(bytes32)')),
    kyc: async () => KYC,
    rwaAsset: async (id) => RWA_FLAGGED.has(id),
    maxLeverageForAsset: async () => 5n,
    maintenanceMarginBpsForAsset: async () => 500n,
    assetMode: async () => {
      throw new Error('should not be called on a deployment without assetMode')
    },
    esg: {
      code: async () => codeWith(['medianCarbonTier(bytes32)', 'getAttestors(bytes32)']),
      medianCarbonTier: async () => ({ tier: 1n, count: 1n, isRated: true }),
      getAttestors: async () => ['0x' + '11'.repeat(20)],
    },
    ...over,
  }
}

describe('loadRwaSnapshot', () => {
  it('線上舊部署：assetMode 不存在 → unsupported、休市規則照實揭露「未啟用休市停單」', async () => {
    const s = await loadRwaSnapshot(liveLikeDeps(), RWA_CARD_ORDER)
    expect(s.modeSupport).toBe('unsupported')
    expect(s.perAsset.sAAPL.mode).toEqual({ kind: 'unsupported' })
    expect(closureRule('sAAPL', s.modeSupport)).toBe('noStop')
    expect(closureRule('sGOLD', s.modeSupport)).toBe('noStop')
    expect(closureRule('sBTC', s.modeSupport)).toBe('crypto')
    expect(s.kycAddress).toEqual(ok(KYC))
    expect(s.perAsset.sAAPL.maxLeverage).toEqual(ok(5))
    expect(s.perAsset.sAAPL.maintenanceBps).toEqual(ok(500))
    expect(s.perAsset.sAAPL.attestors).toEqual(ok(1))
    expect(s.perAsset.sAAPL.carbon).toEqual(ok({ tier: 'low', freshCount: 1, isRated: true }))
  })

  it('sGOLD 鏈上未標記：照實回 false，並產生「黃金未標記」揭露；不需要 KYC', async () => {
    const s = await loadRwaSnapshot(liveLikeDeps(), ['sGOLD', 'sAAPL', 'sBTC'])
    expect(s.perAsset.sGOLD.rwaFlag).toEqual(ok(false))
    expect(rwaFlagNote('sGOLD', s.perAsset.sGOLD.rwaFlag)).toBe('goldMismatch')
    expect(kycRequirement(s.kycAddress, s.perAsset.sGOLD.rwaFlag)).toBe('notRequired')
    expect(kycRequirement(s.kycAddress, s.perAsset.sAAPL.rwaFlag)).toBe('required')
    expect(rwaFlagNote('sAAPL', s.perAsset.sAAPL.rwaFlag)).toBeNull()
    expect(rwaFlagNote('sBTC', s.perAsset.sBTC.rwaFlag)).toBe('cryptoNotRwa')
  })

  it('函式不存在 → unsupported（不呼叫）；讀取失敗 → failed；兩者都不是 0', async () => {
    let called = 0
    const s = await loadRwaSnapshot(
      liveLikeDeps({
        exchangeCode: async () => codeWith(['kyc()', 'rwaAsset(bytes32)']),
        maxLeverageForAsset: async () => {
          called += 1
          return 5n
        },
        rwaAsset: () => Promise.reject(new Error('rpc down')),
      }),
      ['sAAPL']
    )
    expect(called).toBe(0)
    expect(s.perAsset.sAAPL.maxLeverage).toEqual(UNSUPPORTED)
    expect(s.perAsset.sAAPL.maintenanceBps).toEqual(UNSUPPORTED)
    expect(s.perAsset.sAAPL.rwaFlag).toEqual(FAILED)
    expect(kycRequirement(s.kycAddress, s.perAsset.sAAPL.rwaFlag)).toBe('unknown')
  })

  it('bytecode 讀不到：照常呼叫、讀不到就 failed；assetMode 不猜（unknown）', async () => {
    const s = await loadRwaSnapshot(
      liveLikeDeps({
        exchangeCode: async () => null,
        kyc: () => Promise.reject(new Error('timeout')),
      }),
      ['sAAPL']
    )
    expect(s.modeSupport).toBe('unknown')
    expect(s.perAsset.sAAPL.mode).toEqual({ kind: 'unknown' })
    expect(s.kycAddress).toEqual(FAILED)
    expect(s.perAsset.sAAPL.maxLeverage).toEqual(ok(5))
    expect(closureRule('sAAPL', s.modeSupport)).toBe('unknown')
  })

  it('支援 assetMode 的部署：讀到 ReduceOnly；某一檔讀不到是 mode = null', async () => {
    const s = await loadRwaSnapshot(
      liveLikeDeps({
        exchangeCode: async () => codeWith(EXCHANGE_VIEWS),
        assetMode: async (id) => {
          if (id === ASSET_IDS.sTSLA) throw new Error('revert')
          return 1n
        },
      }),
      ['sAAPL', 'sTSLA']
    )
    expect(s.modeSupport).toBe('supported')
    expect(s.perAsset.sAAPL.mode).toEqual({ kind: 'supported', mode: 1 })
    expect(s.perAsset.sTSLA.mode).toEqual({ kind: 'supported', mode: null })
    expect(closureRule('sAAPL', s.modeSupport)).toBe('stop')
  })

  it('沒有 ESGRegistryV2：碳分級與見證者是 unsupported，不是 0 位', async () => {
    const s = await loadRwaSnapshot(liveLikeDeps({ esg: null }), ['sAAPL'])
    expect(s.esgDeployed).toBe(false)
    expect(s.perAsset.sAAPL.attestors).toEqual(UNSUPPORTED)
    expect(attestorNote(s.perAsset.sAAPL.attestors)).toBeNull()
  })
})

describe('純函式', () => {
  it('kycRequirement：kyc() 不存在或零地址 → gateOff', () => {
    expect(kycRequirement(UNSUPPORTED, ok(true))).toBe('gateOff')
    expect(kycRequirement(ok('0x0000000000000000000000000000000000000000'), ok(true))).toBe('gateOff')
    expect(kycRequirement(ok(KYC), UNSUPPORTED)).toBe('unknown')
  })

  it('rwaFlagNote：非黃金的 RWA 未標記、加密被標記', () => {
    expect(rwaFlagNote('sBOND', ok(false))).toBe('unflaggedRwa')
    expect(rwaFlagNote('sETH', ok(true))).toBe('cryptoFlagged')
    expect(rwaFlagNote('sGOLD', FAILED)).toBeNull()
  })

  it('attestorNote：只有一位見證者要照實揭露', () => {
    expect(attestorNote(ok(1))).toBe('single')
    expect(attestorNote(ok(0))).toBe('none')
    expect(attestorNote(ok(3))).toBeNull()
    expect(attestorNote(FAILED)).toBeNull()
  })

  it('bpsToPct', () => {
    expect(bpsToPct(500)).toBe('5%')
    expect(bpsToPct(750)).toBe('7.5%')
    expect(bpsToPct(1)).toBe('0.01%')
  })
})
