// VCKycRegistry（VC 准入的 KYC 登錄）位址設定 —— docs/SSI_RWA_ACCESS.md。
//
// 刻意不放進 addresses.ts：登錄是選配的新元件，正式部署（Base Sepolia）目前**沒有**部署，
// 前端在沒有位址時降級顯示「此部署尚未啟用 VC 准入」。位址來源（先到先用）：
//   1. 建置時的 VITE_VC_KYC_REGISTRY（本機 anvil／Besu PoC 用）
//   2. 下面的 per-chain 表（正式部署後由 owner 填入，與 addresses.ts 同樣走 PR 審查）
//   3. 專屬租戶（kind: "dedicated"）登記裡的 contracts.KYCRegistry——**候選**，不是定論：
//      租戶的 KYC 登錄可能是 allowlist（KYCRegistry）也可能是 VC（VCKycRegistry，schema v4
//      的 params.kycRegistry），登記檔不記種類，所以要由 useVcKycRegistry 探測 requiredType()
//      成功才當成 VC 登錄。專屬部署時 1. 的 env 必須等於這一顆才採用（不同就忽略並警告）。
//      平台部署（default／示範租戶）沒有候選、也不探測，行為與改版前相同。

import { getAddresses, isPlatformDeployment } from './deployment'

const ADDR = /^0x[0-9a-fA-F]{40}$/
const ZERO = '0x0000000000000000000000000000000000000000'

/** chainId → VCKycRegistry。目前沒有任何公開鏈部署。 */
export const VC_KYC_REGISTRY_BY_CHAIN: Readonly<Record<number, string>> = {}

const usable = (a: string | undefined | null): a is string => !!a && ADDR.test(a) && a.toLowerCase() !== ZERO

/** 純函式：給測試注入 env 值。只回「已確定是 VC 登錄」的來源（env 或表），不含專屬租戶的候選。 */
export function resolveVcKycRegistry(chainId: number | null, envValue: string | undefined): string | null {
  const fromEnv = (envValue ?? '').trim()
  if (usable(fromEnv)) return fromEnv
  if (chainId === null) return null
  const fromTable = VC_KYC_REGISTRY_BY_CHAIN[chainId]
  return usable(fromTable) ? fromTable : null
}

export function getVcKycRegistryAddress(chainId: number | null): string | null {
  return resolveVcKycRegistry(chainId, import.meta.env.VITE_VC_KYC_REGISTRY as string | undefined)
}

/**
 * 解析 VC 登錄的來源。`known`＝已確定是 VC 登錄（平台部署的 env／表，或專屬部署 env 等於登記），直接用；
 * `probe`＝專屬租戶登記的 KYCRegistry，要探測 requiredType() 才知道是不是 VC 登錄；`none`＝沒有 VC 准入。
 * 專屬部署時 env 與登記不同就忽略 env（warn），不讓面板改連交易所不讀的登錄。
 * 純函式（測試注入 dedicatedKyc）。
 */
export type VcKycSource = { kind: 'known'; address: string } | { kind: 'probe'; address: string } | { kind: 'none' }

export function vcKycSource(
  chainId: number | null,
  envValue: string | undefined,
  dedicatedKyc: string | null | undefined,
  warn: (msg: string) => void = () => {},
): VcKycSource {
  if (usable(dedicatedKyc)) {
    // 專屬部署：交易所接的 KYC 登錄就是登記裡這一顆。env 只能「確認」它，不能換成別的位址——
    // 否則面板會把憑證送到交易所根本不讀的登錄，使用者以為取得資格、開倉仍被拒。
    const fromEnv = (envValue ?? '').trim()
    if (usable(fromEnv)) {
      if (fromEnv.toLowerCase() === dedicatedKyc.toLowerCase()) return { kind: 'known', address: dedicatedKyc }
      warn(`[vc-kyc] VITE_VC_KYC_REGISTRY=${fromEnv} is not this dedicated deployment's KYCRegistry (${dedicatedKyc}); ignoring it and probing the registered one`)
    }
    return { kind: 'probe', address: dedicatedKyc }
  }
  const known = resolveVcKycRegistry(chainId, envValue)
  return known ? { kind: 'known', address: known } : { kind: 'none' }
}

const warned = new Set<string>()
const warnOnce = (msg: string) => {
  if (warned.has(msg)) return
  warned.add(msg)
  console.warn(msg)
}

/** 這個 build 的來源：只有專屬部署會給候選。 */
export function getVcKycSource(chainId: number | null): VcKycSource {
  const dedicatedKyc = isPlatformDeployment ? null : getAddresses(chainId)?.KYCRegistry
  return vcKycSource(chainId, import.meta.env.VITE_VC_KYC_REGISTRY as string | undefined, dedicatedKyc, warnOnce)
}
