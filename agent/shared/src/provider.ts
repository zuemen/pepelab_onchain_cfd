import { ethers } from "ethers";
import { ADDRESSES } from "./addresses.ts";
import {
  PERPETUAL_EXCHANGE_ABI,
  MOCK_ORACLE_ABI,
  STRATEGY_REGISTRY_ABI,
} from "./abis.ts";

/** 建立指向 Ethereum Sepolia 的唯讀 provider。RPC 由 env 提供，不寫死。 */
export function makeProvider(rpcUrl?: string): ethers.JsonRpcProvider {
  const url = rpcUrl ?? process.env.SEPOLIA_RPC_URL;
  if (!url) {
    throw new Error(
      "缺少 SEPOLIA_RPC_URL：請在 .env 設定 Ethereum Sepolia RPC（見 .env.example）",
    );
  }
  return new ethers.JsonRpcProvider(url, {
    chainId: 11155111,
    name: "sepolia",
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
