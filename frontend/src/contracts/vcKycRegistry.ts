// VCKycRegistry（VC 准入的 KYC 登錄）位址設定 —— docs/SSI_RWA_ACCESS.md。
//
// 刻意不放進 addresses.ts：登錄是選配的新元件，正式部署（Base Sepolia）目前**沒有**部署，
// 前端在沒有位址時降級顯示「此部署尚未啟用 VC 准入」。位址來源（先到先用）：
//   1. 建置時的 VITE_VC_KYC_REGISTRY（本機 anvil／Besu PoC 用）
//   2. 下面的 per-chain 表（正式部署後由 owner 填入，與 addresses.ts 同樣走 PR 審查）

const ADDR = /^0x[0-9a-fA-F]{40}$/
const ZERO = '0x0000000000000000000000000000000000000000'

/** chainId → VCKycRegistry。目前沒有任何公開鏈部署。 */
export const VC_KYC_REGISTRY_BY_CHAIN: Readonly<Record<number, string>> = {}

/** 純函式：給測試注入 env 值。 */
export function resolveVcKycRegistry(chainId: number | null, envValue: string | undefined): string | null {
  const fromEnv = (envValue ?? '').trim()
  if (ADDR.test(fromEnv) && fromEnv.toLowerCase() !== ZERO) return fromEnv
  if (chainId === null) return null
  const fromTable = VC_KYC_REGISTRY_BY_CHAIN[chainId]
  return fromTable && ADDR.test(fromTable) && fromTable.toLowerCase() !== ZERO ? fromTable : null
}

export function getVcKycRegistryAddress(chainId: number | null): string | null {
  return resolveVcKycRegistry(chainId, import.meta.env.VITE_VC_KYC_REGISTRY as string | undefined)
}
