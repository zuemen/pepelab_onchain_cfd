import { ethers } from "ethers";
import { ADDRESSES, AGENT_CHAIN_ID } from "./addresses.ts";
import {
  PERPETUAL_EXCHANGE_ABI,
  MOCK_ORACLE_ABI,
  STRATEGY_REGISTRY_ABI,
  AGENT_SESSION_MANAGER_ABI,
} from "./abis.ts";

/** 建立指向 Base Sepolia（預設）的唯讀 provider。RPC 由 env 提供，不寫死。
 *  優先 BASE_SEPOLIA_RPC_URL；保留 SEPOLIA_RPC_URL 作回退（向後相容）。 */
export function makeProvider(rpcUrl?: string): ethers.JsonRpcProvider {
  const url =
    rpcUrl ??
    process.env.BASE_SEPOLIA_RPC_URL ??
    process.env.SEPOLIA_RPC_URL;
  if (!url) {
    throw new Error(
      "缺少 BASE_SEPOLIA_RPC_URL：請在 .env 設定 Base Sepolia RPC（見 .env.example）",
    );
  }
  return new ethers.JsonRpcProvider(url, {
    chainId: AGENT_CHAIN_ID,
    name: AGENT_CHAIN_ID === 84532 ? "base-sepolia" : "sepolia",
  });
}

/** 一次建好三個唯讀合約實例，給聚合層使用。 */
export function makeContracts(provider: ethers.JsonRpcProvider) {
  return {
    perp: new ethers.Contract(
      ADDRESSES.PerpetualExchange,
      PERPETUAL_EXCHANGE_ABI,
      provider,
    ),
    oracle: new ethers.Contract(ADDRESSES.MockOracle, MOCK_ORACLE_ABI, provider),
    registry: new ethers.Contract(
      ADDRESSES.StrategyRegistry,
      STRATEGY_REGISTRY_ABI,
      provider,
    ),
  };
}

export type Contracts = ReturnType<typeof makeContracts>;

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * 從 env 建立 agent 簽署者（自管 EOA / session key）。
 * 沒有 AGENT_PRIVATE_KEY 時回 null（呼叫端據此優雅降級，不 crash）。
 */
export function makeSigner(
  provider?: ethers.JsonRpcProvider,
): ethers.Wallet | null {
  const pk = process.env.AGENT_PRIVATE_KEY?.trim();
  if (!pk || !pk.startsWith("0x") || pk.length !== 66) return null;
  return new ethers.Wallet(pk, provider ?? makeProvider());
}

/**
 * AgentSessionManager 位址：沿用「位址不寫死」原則，從 env 注入
 * （Deploy.s.sol 印出的 "AgentSessionMgr :"）。未設定時回 ZERO。
 * 此合約尚未納入 frontend 的 ChainAddresses，故獨立由 env 提供。
 */
export function getSessionManagerAddress(): string {
  return process.env.SESSION_MANAGER_ADDRESS?.trim() || ZERO;
}

/**
 * 建立可寫的 AgentSessionManager 實例（綁 signer）。
 * 缺 signer 或缺位址時回 null，呼叫端回明確錯誤、不 crash。
 */
export function makeSessionManager(
  signer: ethers.Wallet,
): ethers.Contract | null {
  const addr = getSessionManagerAddress();
  if (addr === ZERO) return null;
  return new ethers.Contract(addr, AGENT_SESSION_MANAGER_ABI, signer);
}
