// 本機部署（contracts/script/DeployLocalDemo.s.sol）的位址：從 forge 的 broadcast 紀錄取出，
// 寫回前端位址表的本機鏈區塊。

import { ethers } from "ethers";

export const ZERO = ethers.ZeroAddress;

/**
 * frontend/src/contracts/addresses.ts 的 ChainAddresses 欄位（順序相同）→ broadcast 裡的合約名稱。
 * null = 本機部署沒有這個合約，寫 0x0。
 */
const FIELD_SOURCES: Record<string, string | null> = {
  MockUSDC: "MockUSDC",
  MockUSDT: null,
  MockOracle: "MockOracle",
  TraderStake: "TraderStake",
  InsuranceVault: "InsuranceVault",
  FeeRouter: "FeeRouter",
  PerpetualExchange: "PerpetualExchange",
  StrategyRegistry: "StrategyRegistry",
  CopyTracker: "CopyTracker",
  MockSwapRouter: "MockSwapRouter",
  ESGRegistry: "ESGRegistryV2",
  KYCRegistry: "KYCRegistry",
  PepeAMM: null,
  PepeToken: null,
  PepeClaim: null,
  EsgRewardDistributor: null,
  PepeIncentives: null,
  PepeStaking: null,
  AssetVault: null,
};

export const FRONTEND_FIELDS = Object.keys(FIELD_SOURCES);

/** 回放需要、但前端的 ChainAddresses 沒有的合約。 */
const EXTRA_SOURCES: Record<string, string> = { AgentSessionManager: "AgentSessionManager" };

export interface BroadcastFile {
  transactions?: { transactionType?: string; contractName?: string | null; contractAddress?: string | null }[];
}

export function addressesFromBroadcast(broadcast: BroadcastFile): Record<string, string> {
  const created = new Map<string, string>();
  for (const tx of broadcast.transactions ?? []) {
    if (tx.transactionType === "CREATE" && tx.contractName && tx.contractAddress) {
      created.set(tx.contractName, ethers.getAddress(tx.contractAddress));
    }
  }
  const out: Record<string, string> = {};
  for (const [field, source] of [...Object.entries(FIELD_SOURCES), ...Object.entries(EXTRA_SOURCES)]) {
    if (source === null) {
      out[field] = ZERO;
      continue;
    }
    const address = created.get(source);
    if (!address) throw new Error(`broadcast has no CREATE for ${source}`);
    out[field] = address;
  }
  return out;
}

export function renderAnvilBlock(addresses: Record<string, string>): string {
  const lines = FRONTEND_FIELDS.map((field) => `  ${(field + ":").padEnd(24)}"${addresses[field]}",`);
  return ["const ANVIL: ChainAddresses = {", ...lines, "}"].join("\n");
}

const ANVIL_BLOCK = /const ANVIL: ChainAddresses = \{[^}]*\}/;

export function replaceAnvilBlock(source: string, block: string): string {
  if (!ANVIL_BLOCK.test(source)) throw new Error("ANVIL block not found in addresses.ts");
  return source.replace(ANVIL_BLOCK, block);
}
