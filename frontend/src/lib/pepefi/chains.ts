// 正式部署鏈的參數。錢包切鏈（wallet_addEthereumChain）、MCP 設定匯出與
// vercel.json 的 CSP connect-src 都以這一份為準（securityHeaders.test.ts 會核對）。

export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** EIP-3085 `wallet_addEthereumChain` 的完整參數。 */
export const BASE_SEPOLIA_PARAMS = {
  chainId: '0x14a34',
  chainName: 'Base Sepolia',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://sepolia.base.org'],
  blockExplorerUrls: ['https://sepolia.basescan.org'],
} as const;

export const BASE_SEPOLIA_RPC_URL = BASE_SEPOLIA_PARAMS.rpcUrls[0];
