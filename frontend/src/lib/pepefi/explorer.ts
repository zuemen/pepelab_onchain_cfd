// 區塊瀏覽器連結的唯一出口。
//
// 以前 TokenizedAssetsPage 把 GuardedOracle 的連結寫死成 sepolia.etherscan.io——
// 在 Base Sepolia（正式站的主鏈）上點下去是一個不存在的位址。連結一律依 chainId
// 從這裡取，不要在元件裡拼網址。
//
//   84532    Base Sepolia       → BaseScan（sepolia.basescan.org）
//   11155111 Ethereum Sepolia   → Etherscan（sepolia.etherscan.io）
//   其他（Anvil / 未知）         → null，呼叫端不渲染連結

export const EXPLORERS: Readonly<Record<number, { base: string; name: string }>> = {
  84532: { base: 'https://sepolia.basescan.org', name: 'BaseScan' },
  11155111: { base: 'https://sepolia.etherscan.io', name: 'Etherscan' },
}

/** x402 的結算固定在 Base Sepolia（官方 USDC 部署在那裡），與錢包目前連的鏈無關。 */
export const X402_SETTLEMENT_CHAIN_ID = 84532

export const explorerBase = (chainId: number | null | undefined): string | null =>
  chainId !== null && chainId !== undefined ? (EXPLORERS[chainId]?.base ?? null) : null

/** 交易連結；本機或未知鏈回 null。 */
export const explorerTx = (hash: string, chainId: number | null | undefined): string | null => {
  const base = explorerBase(chainId)
  return base ? `${base}/tx/${hash}` : null
}

/** 位址連結；本機或未知鏈回 null。 */
export const explorerAddr = (address: string, chainId: number | null | undefined): string | null => {
  const base = explorerBase(chainId)
  return base ? `${base}/address/${address}` : null
}

/** 連結文字用的瀏覽器名稱。 */
export const explorerName = (chainId: number | null | undefined): string =>
  (chainId !== null && chainId !== undefined ? EXPLORERS[chainId]?.name : undefined) ?? 'Explorer'
