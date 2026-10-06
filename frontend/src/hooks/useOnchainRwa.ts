import type { Contract } from 'ethers'

import { useState, useEffect } from 'react'

import { safeRead } from 'src/lib/pepefi/safeRead'

// ----------------------------------------------------------------------

/**
 * 交易所鏈上的 rwaAsset(id) 旗標。開倉時合約只看這個旗標決定要不要檢查 KYC，
 * 而靜態表的 `regulated` 只是「這檔參照現實世界資產」的事實。專屬租戶可以在部署時
 * 追加 RWA（schema v4 的 assets.additionalRwa，例如 sGOLD），靜態表不會知道，
 * 所以 UI 的 KYC 閘門要把鏈上旗標也算進去，否則按鈕看似可按、送出才 revert。
 *
 * 讀不到（null）時退回靜態表——只會「多擋」不會「少擋」：見 kycGateApplies。
 */
export function useOnchainRwaFlags(
  exchange: Contract | null | undefined,
  assetIds: readonly string[],
): Readonly<Record<string, boolean | null>> {
  const key = assetIds.join(',')
  const [flags, setFlags] = useState<{ ex: unknown; key: string; v: Record<string, boolean | null> } | null>(null)

  useEffect(() => {
    if (!exchange || !assetIds.length) return undefined
    let cancelled = false
    void Promise.all(
      assetIds.map(async (id) => [id, await safeRead<boolean | null>(exchange.rwaAsset(id) as Promise<boolean>, null)] as const),
    ).then((rows) => {
      if (!cancelled) setFlags({ ex: exchange, key, v: Object.fromEntries(rows) })
    })
    return () => {
      cancelled = true
    }
    // key 已涵蓋 assetIds 的內容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exchange, key])

  return flags && flags.ex === exchange && flags.key === key ? flags.v : {}
}

/** 開倉要不要過 KYC：靜態表說要、或鏈上旗標是 true 就要。鏈上讀不到不放寬靜態表。 */
export function kycGateApplies(staticRegulated: boolean | undefined, onchainRwa: boolean | null | undefined): boolean {
  return (staticRegulated ?? false) || onchainRwa === true
}
