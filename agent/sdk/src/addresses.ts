// 位址解析：依 chainId 回傳 SDK 需要的合約位址。
//
// 唯一來源是 frontend/src/contracts/addresses.ts（與前端、agent/shared 同一份）。
// 這裡「只 import、不複製」核心合約位址。
//
// 唯一的例外是 AgentSessionManager：它的位址在 frontend/src/contracts/sessionManager.ts，
// 而那個檔案 import 了 ethers 與 `src/…` 路徑別名的 ABI JSON，agent 端（沒有安裝 frontend
// 的 node_modules，也沒有該路徑別名）無法直接 import。所以 SDK 在下方保留一份對照表，
// 並由 test/addresses.test.ts 用 scripts/check-addresses.mjs 的解析器逐鏈比對
// sessionManager.ts —— 前端改了位址、這裡沒跟上，Agent CI 就會紅燈。
import {
  CHAIN_MAP,
  ASSET_IDS,
  getV2Stack,
  type AssetSymbol,
  type ChainAddresses,
} from "../../../frontend/src/contracts/addresses.ts";
import { getAddress, isAddress, type Address, type Hex } from "viem";

export { ASSET_IDS };
export type { AssetSymbol, ChainAddresses };

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** 正式部署鏈（Base Sepolia）。交易、agent session、x402 都只在這條鏈。 */
export const PRIMARY_CHAIN_ID = 84532;

/**
 * AgentSessionManager 位址（chainId → address）。
 * ⚠ 鏡像自 frontend/src/contracts/sessionManager.ts 的 SESSION_MANAGER_ADDRESS；
 *   漂移由 test/addresses.test.ts 擋下，不要只改這裡。
 */
export const SESSION_MANAGER_BY_CHAIN: Readonly<Record<number, string>> = Object.freeze({
  84532: "0xdF9C1E53523568709f65Afe3C4AD2E6a6D99d14B",
});

/** SDK 使用的已解析位址（全部 checksum）。未部署的合約為 null。 */
export interface SdkAddresses {
  chainId: number;
  perpetualExchange: Address;
  /** 交易所結算用的 oracle（目前為 MockOracle）。 */
  oracle: Address;
  /** 保證金代幣（MockUSDC，18 位小數）。 */
  marginToken: Address;
  strategyRegistry: Address | null;
  sessionManager: Address | null;
  /** V2 hardened stack 的 GuardedOracle（僅供對照；交易所不讀它）。 */
  guardedOracle: Address | null;
}

export interface AddressOverrides {
  perpetualExchange?: string;
  oracle?: string;
  marginToken?: string;
  strategyRegistry?: string | null;
  sessionManager?: string | null;
  guardedOracle?: string | null;
}

export class UnsupportedChainError extends Error {
  readonly chainId: number;
  constructor(chainId: number) {
    super(
      `chainId ${chainId} 不在 frontend/src/contracts/addresses.ts 的 CHAIN_MAP；` +
        `可用：${Object.keys(CHAIN_MAP).join(", ")}。或以 addresses 覆寫全部核心位址。`,
    );
    this.name = "UnsupportedChainError";
    this.chainId = chainId;
  }
}

const orNull = (a: string | null | undefined): Address | null =>
  a && isAddress(a) && a.toLowerCase() !== ZERO_ADDRESS ? getAddress(a) : null;

function required(label: string, a: string | undefined, chainId: number): Address {
  const v = orNull(a);
  if (!v) throw new Error(`chainId ${chainId} 缺少 ${label} 位址（addresses.ts 為 0x0 或未提供）`);
  return v;
}

/**
 * 解析某條鏈的合約位址。`overrides` 只用於本機 anvil／測試部署；正式整合請不要覆寫。
 * 核心合約（exchange / oracle / margin token）為 0x0 時丟錯，不回傳半套設定。
 */
export function resolveAddresses(chainId: number, overrides: AddressOverrides = {}): SdkAddresses {
  const base: ChainAddresses | undefined = CHAIN_MAP[chainId];
  const hasCoreOverrides = overrides.perpetualExchange && overrides.oracle && overrides.marginToken;
  if (!base && !hasCoreOverrides) throw new UnsupportedChainError(chainId);
  const v2 = getV2Stack(chainId);
  const pick = <K extends keyof AddressOverrides>(k: K, fallback: string | undefined) =>
    k in overrides ? overrides[k] : fallback;
  return {
    chainId,
    perpetualExchange: required("PerpetualExchange", pick("perpetualExchange", base?.PerpetualExchange) ?? undefined, chainId),
    oracle: required("MockOracle", pick("oracle", base?.MockOracle) ?? undefined, chainId),
    marginToken: required("MockUSDC", pick("marginToken", base?.MockUSDC) ?? undefined, chainId),
    strategyRegistry: orNull(pick("strategyRegistry", base?.StrategyRegistry)),
    sessionManager: orNull(pick("sessionManager", SESSION_MANAGER_BY_CHAIN[chainId])),
    guardedOracle: orNull(pick("guardedOracle", v2?.GuardedOracle)),
  };
}

/** 資產代號（sBTC…）或 bytes32 assetId → bytes32 assetId。未知代號丟錯。 */
export function toAssetId(asset: string): Hex {
  if (/^0x[0-9a-fA-F]{64}$/.test(asset)) {
    if (/^0x0{64}$/.test(asset)) throw new Error("assetId 不可為 0x0");
    return asset.toLowerCase() as Hex;
  }
  const id = (ASSET_IDS as Record<string, Hex>)[asset];
  if (!id) throw new Error(`未知資產「${asset}」，可用：${Object.keys(ASSET_IDS).join(", ")}`);
  return id;
}

/** bytes32 assetId → 代號；不認得回 null。 */
export function assetSymbolOf(assetId: string): AssetSymbol | null {
  const lower = assetId.toLowerCase();
  for (const [sym, id] of Object.entries(ASSET_IDS)) if (id.toLowerCase() === lower) return sym as AssetSymbol;
  return null;
}

export const ASSET_SYMBOLS = Object.keys(ASSET_IDS) as AssetSymbol[];
