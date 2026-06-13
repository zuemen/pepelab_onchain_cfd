// 合約位址「不寫死」：直接從現有前端設定讀取，與前端永遠一致。
// frontend/src/contracts/addresses.ts 是純資料模組（無 runtime 依賴），可安全 import。
import {
  getAddresses,
  ASSET_IDS,
  type AssetSymbol,
  type ChainAddresses,
} from "../../../frontend/src/contracts/addresses";

// Phase 1 目標鏈：Ethereum Sepolia（合約部署所在）
export const SEPOLIA_CHAIN_ID = 11155111;

const sepolia = getAddresses(SEPOLIA_CHAIN_ID);
if (!sepolia) {
  throw new Error(
    `addresses.ts 找不到 chainId ${SEPOLIA_CHAIN_ID} 的設定；請確認 frontend/src/contracts/addresses.ts 已部署 Sepolia 區塊`,
  );
}

export const ADDRESSES: ChainAddresses = sepolia;
export { ASSET_IDS };
export type { AssetSymbol, ChainAddresses };

/** 把資產代號（sBTC…）轉成鏈上 bytes32 assetId；未知代號丟錯。 */
export function assetIdOf(symbol: string): `0x${string}` {
  const id = (ASSET_IDS as Record<string, `0x${string}`>)[symbol];
  if (!id) {
    const known = Object.keys(ASSET_IDS).join(", ");
    throw new Error(`未知資產 "${symbol}"，可用：${known}`);
  }
  return id;
}

/** 反查 assetId → 代號，用於把鏈上資料對應回人類可讀符號。 */
export function symbolOfAssetId(assetId: string): string | undefined {
  const lower = assetId.toLowerCase();
  for (const [sym, id] of Object.entries(ASSET_IDS)) {
    if (id.toLowerCase() === lower) return sym;
  }
  return undefined;
}

export const ASSET_SYMBOLS = Object.keys(ASSET_IDS) as AssetSymbol[];
