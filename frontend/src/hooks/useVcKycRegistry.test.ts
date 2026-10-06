import { it, expect, describe } from 'vitest'

import { CHAIN_MAP } from 'src/contracts/addresses'
import { getVcKycSource, vcKycSource } from 'src/contracts/vcKycRegistry'
import { resolveDeployment, parseTenantDeployment } from 'src/contracts/tenantDeployment'

import { kycGateApplies } from './useOnchainRwa'
import { vcStateFromProbe, isVcKycRegistry } from './useVcKycRegistry'

// ----------------------------------------------------------------------

const A = (n: number) => `0x${n.toString(16).padStart(40, 'c')}`
const ZERO = '0x0000000000000000000000000000000000000000'
const QI = `0x${'ab'.repeat(32)}`

/** 假的專屬部署登記（只在測試裡；不提交任何 rwa-poc 的假部署登記）。 */
const dedicated = resolveDeployment(
  parseTenantDeployment(
    {
      schemaVersion: 1,
      tenant: 'bank-a',
      kind: 'dedicated',
      chainId: 84532,
      oracleKind: 'guarded',
      contracts: {
        SettlementToken: CHAIN_MAP[84532].MockUSDC,
        Oracle: A(1),
        ESGRegistryV2: A(2),
        KYCRegistry: A(3),
        InsuranceVault: A(4),
        FeeRouter: A(5),
        TraderStake: A(6),
        PerpetualExchange: A(7),
        StrategyRegistry: A(8),
        CopyTracker: A(9),
        AgentSessionManager: A(10),
      },
      shared: ['contracts.SettlementToken'],
    },
    'bank-a',
  ),
)

describe('VC 准入登錄的來源', () => {
  it('專屬部署：登記的 KYCRegistry 是要探測的候選（只在它自己的鏈）', () => {
    const kyc = dedicated.getAddresses(84532)?.KYCRegistry
    expect(vcKycSource(84532, undefined, kyc)).toEqual({ kind: 'probe', address: A(3) })
    expect(vcKycSource(11155111, undefined, dedicated.getAddresses(11155111)?.KYCRegistry)).toEqual({ kind: 'none' })
  })

  it('env 覆寫優先於候選，且不需探測', () => {
    expect(vcKycSource(84532, A(99), A(3))).toEqual({ kind: 'known', address: A(99) })
  })

  it('零位址與壞位址不算候選', () => {
    expect(vcKycSource(84532, undefined, ZERO)).toEqual({ kind: 'none' })
    expect(vcKycSource(84532, 'nope', '0x123')).toEqual({ kind: 'none' })
  })

  it('這個 build（default 平台部署）沒有候選，也不探測——行為與改版前相同', () => {
    for (const id of [31337, 11155111, 84532, null]) {
      expect(getVcKycSource(id).kind).not.toBe('probe')
    }
  })
})

describe('探測結果 → 狀態', () => {
  const probe = { kind: 'probe', address: A(3) } as const

  it('requiredType() 讀到非零值 → VC 登錄', () => {
    expect(vcStateFromProbe(probe, { ok: true, value: QI })).toEqual({ status: 'vc', address: A(3) })
  })

  it('函式不存在（allowlist KYCRegistry）→ 不是 VC 登錄', () => {
    expect(vcStateFromProbe(probe, { ok: false, missing: true })).toEqual({ status: 'none', address: null })
  })

  it('RPC 失敗 → 無法確認，不當成 VC 也不當成 allowlist', () => {
    expect(vcStateFromProbe(probe, { ok: false, missing: false })).toEqual({ status: 'unknown', address: null })
  })

  it('requiredType 是 0 或格式不對 → 不當成可用的 VC 登錄', () => {
    expect(vcStateFromProbe(probe, { ok: true, value: `0x${'0'.repeat(64)}` }).status).toBe('none')
    expect(vcStateFromProbe(probe, { ok: true, value: '0x01' }).status).toBe('none')
  })

  it('探測中、已知、沒有', () => {
    expect(vcStateFromProbe(probe, null).status).toBe('checking')
    expect(vcStateFromProbe({ kind: 'known', address: A(5) }, null)).toEqual({ status: 'vc', address: A(5) })
    expect(vcStateFromProbe({ kind: 'none' }, null).status).toBe('none')
  })
})

describe('交易所的 KYC 登錄是不是 VC 登錄', () => {
  it('位址相同（不分大小寫）才算；探測中或不同位址都不算', () => {
    const vc = { status: 'vc', address: A(3) } as const
    expect(isVcKycRegistry(vc, A(3).toUpperCase().replace('0X', '0x'))).toBe(true)
    expect(isVcKycRegistry(vc, A(4))).toBe(false)
    expect(isVcKycRegistry({ status: 'checking', address: null }, A(3))).toBe(false)
    expect(isVcKycRegistry(vc, null)).toBe(false)
  })
})

describe('開倉 KYC 閘門：靜態表 ∪ 鏈上 rwaAsset', () => {
  it('鏈上追加的 RWA（例如 sGOLD）也要擋', () => {
    expect(kycGateApplies(false, true)).toBe(true)
  })
  it('鏈上讀不到或為 false 不放寬靜態表', () => {
    expect(kycGateApplies(true, null)).toBe(true)
    expect(kycGateApplies(true, false)).toBe(true)
    expect(kycGateApplies(true, undefined)).toBe(true)
  })
  it('兩邊都不是 RWA 才不擋', () => {
    expect(kycGateApplies(false, false)).toBe(false)
    expect(kycGateApplies(undefined, null)).toBe(false)
  })
})
