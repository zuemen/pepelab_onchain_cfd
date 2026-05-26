/** Returns Sepolia Etherscan tx URL, or null for other chains / local. */
export const explorerTx = (hash: string, chainId: number | null): string | null =>
  chainId === 11155111 ? `https://sepolia.etherscan.io/tx/${hash}` : null

/** Returns Sepolia Etherscan address URL, or null. */
export const explorerAddr = (address: string, chainId: number | null): string | null =>
  chainId === 11155111 ? `https://sepolia.etherscan.io/address/${address}` : null
