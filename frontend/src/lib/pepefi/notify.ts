// Block-explorer URL helpers. Base Sepolia (84532) is the canonical PepeLab
// deployment → BaseScan; Ethereum Sepolia (11155111) kept for the legacy
// ESG / Pepe* contracts that still live there.
const EXPLORERS: Record<number, string> = {
  84532: 'https://sepolia.basescan.org',
  11155111: 'https://sepolia.etherscan.io',
}

/** Returns the block-explorer tx URL for the chain, or null for local/unknown. */
export const explorerTx = (hash: string, chainId: number | null): string | null =>
  chainId !== null && EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/tx/${hash}` : null

/** Returns the block-explorer address URL for the chain, or null. */
export const explorerAddr = (address: string, chainId: number | null): string | null =>
  chainId !== null && EXPLORERS[chainId] ? `${EXPLORERS[chainId]}/address/${address}` : null

/** Human label of the explorer for a chain (for link text). */
export const explorerName = (chainId: number | null): string =>
  chainId === 84532 ? 'BaseScan' : chainId === 11155111 ? 'Etherscan' : 'Explorer'
