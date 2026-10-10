// CarbonRetirement（碳權退役，模擬碳權）位址設定 —— issue #105、docs/ADR-022-carbon-retirement-splitter.md。
//
// 刻意不放進 addresses.ts：退役合約是選配的新元件，目前**任何鏈都沒有部署**
// （contracts/script/DeployCarbonRetirement.s.sol 尚未執行）。沒有位址時 ESG 頁的退役區塊
// 整塊不渲染、不留「本網路尚未部署」之類的提示（CONTEXT.md 的 The Vault 詞條）。位址來源（先到先用）：
//   1. 建置時的 VITE_CARBON_RETIREMENT（本機 anvil／預覽環境用）
//   2. 下面的 per-chain 表（正式部署後由 owner 填入，與 addresses.ts 同樣走 PR 審查）

const ADDR = /^0x[0-9a-fA-F]{40}$/
const ZERO = '0x0000000000000000000000000000000000000000'

/** chainId → CarbonRetirement。目前沒有任何公開鏈部署。 */
export const CARBON_RETIREMENT_BY_CHAIN: Readonly<Record<number, string>> = {}

const usable = (a: string | undefined | null): a is string => !!a && ADDR.test(a) && a.toLowerCase() !== ZERO

/** 純函式：給測試注入 env 值與表。沒有可用位址時回 null（＝畫面不顯示退役區塊）。 */
export function resolveCarbonRetirement(
  chainId: number | null,
  envValue: string | undefined,
  table: Readonly<Record<number, string>> = CARBON_RETIREMENT_BY_CHAIN,
): string | null {
  const fromEnv = (envValue ?? '').trim()
  if (usable(fromEnv)) return fromEnv
  if (chainId === null) return null
  const fromTable = table[chainId]
  return usable(fromTable) ? fromTable : null
}

/** 這個 build 在 `chainId` 上的 CarbonRetirement 位址；沒有就是 null。 */
export function getCarbonRetirementAddress(chainId: number | null): string | null {
  return resolveCarbonRetirement(chainId, import.meta.env.VITE_CARBON_RETIREMENT as string | undefined)
}

/**
 * 只列畫面會呼叫的 view（human-readable）。合約尚未部署，repo 裡沒有 ABI 檔；
 * 函式簽章以 contracts/src/CarbonRetirement.sol 為準。
 */
export const CARBON_RETIREMENT_ABI = [
  'function SIMULATED() view returns (bool)',
  'function usdc() view returns (address)',
  'function pricePerTonne() view returns (uint256)',
  'function budget() view returns (uint256)',
  'function totalRetiredTonnes() view returns (uint256)',
  'function totalSpent() view returns (uint256)',
  'function retirementCount() view returns (uint256)',
  'function getRecentRetirements(uint256 offset, uint256 limit) view returns (tuple(uint256 amount, uint256 tonnesCO2e, uint256 timestamp, address retiredBy)[])',
  'event CarbonRetired(uint256 amount, uint256 tonnesCO2e, uint256 timestamp)',
] as const

export const CARBON_ERC20_DECIMALS_ABI = ['function decimals() view returns (uint8)'] as const
