// ERC-8004 Identity Registry 註冊準備工具（P2-11）。**只產生資料，不簽、不送、不連鏈。**
// 送出與否由擁有者決定；本 repo 目前沒有任何 8004 註冊交易。
//
// 查證（2026-10-02，見 docs/AGENT_ECONOMY_STANDARDS.md §3）：
//   ERC-8004 狀態 Draft（https://eips.ethereum.org/EIPS/eip-8004）。
//   Base Sepolia 上的官方部署（erc-8004/erc-8004-contracts，各測試網同一組 CREATE2 位址）：
//     Identity   0x8004A818BFB912233c491871b3d84c89A494BD9e（README「Base Sepolia」表）
//     Reputation 0x8004B663056A597Dffe9eCcC1965A193B7388713（README「Base Sepolia」表）
//     Validation 0x8004Cb1BF31DAf7788923b405b754f57acEB4272（README 未列；scripts/addresses.ts 的 TESTNET_ADDRESSES）
//   規格要點：register(string agentURI) 回傳 agentId（ERC-721 tokenId）；agentURI 指向 registration file；
//   agentRegistry 字串 = "eip155:84532:<Identity Registry 位址>"。
//
//   npx tsx examples/erc8004-register.ts registration-file --agent 0x… --name "…" [--description "…"]
//       [--api https://…] [--mcp <endpoint>] [--image https://…] [--agent-id N]
//       印出 agent registration file（ERC-8004 registration-v1）。放到 https／ipfs 後，它的 URI 就是 agentURI。
//   npx tsx examples/erc8004-register.ts calldata --uri <agentURI>
//       印出 register(string) 的未簽交易 {to, data, value, chainId}（由擁有者自己的錢包送出）。
//   npx tsx examples/erc8004-register.ts wallet-typed-data --agent-id N --wallet 0x… --owner 0x… --deadline <unix 秒>
//       印出 setAgentWallet 的 EIP-712 typed data（依參考實作；deadline 必須在送出時的 5 分鐘內）。
import { ethers } from "ethers";
import { pathToFileURL } from "node:url";

export const ERC8004_BASE_SEPOLIA = {
  chainId: 84532,
  identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  validationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
} as const;

export const REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

const IDENTITY_ABI = [
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)",
];

export interface RegistrationParams {
  agent: string;
  name: string;
  description?: string;
  image?: string;
  /** x402 付費 API base URL。 */
  api?: string;
  /** MCP endpoint（若對外提供）。 */
  mcp?: string;
  /** 已註冊時填入（registrations 陣列）；未註冊為空陣列。 */
  agentId?: number;
}

/** ERC-8004 registration file。DID 服務放 agent 的 did:pkh，與授權 VC 的 holder 相同。 */
export function buildRegistrationFile(p: RegistrationParams) {
  const agent = ethers.getAddress(p.agent);
  const services: Array<{ name: string; endpoint: string; version?: string }> = [
    { name: "DID", endpoint: `did:pkh:eip155:${ERC8004_BASE_SEPOLIA.chainId}:${agent}` },
  ];
  if (p.api) services.push({ name: "web", endpoint: p.api });
  // version 是 SHOULD；本工具不替使用者猜協定版本，需要時在產出的 JSON 手動補上。
  if (p.mcp) services.push({ name: "MCP", endpoint: p.mcp });
  return {
    type: REGISTRATION_TYPE,
    name: p.name,
    description: p.description ?? "",
    image: p.image ?? "",
    services,
    x402Support: Boolean(p.api),
    active: true,
    registrations:
      p.agentId === undefined
        ? []
        : [{ agentId: p.agentId, agentRegistry: `eip155:${ERC8004_BASE_SEPOLIA.chainId}:${ERC8004_BASE_SEPOLIA.identityRegistry}` }],
    supportedTrust: [] as string[],
  };
}

/** register(string agentURI) 的未簽交易。 */
export function registerCalldata(agentURI: string) {
  if (!/^(https:\/\/|ipfs:\/\/|data:application\/json;base64,)/.test(agentURI)) {
    throw new Error("agentURI 必須是 https://、ipfs:// 或 data:application/json;base64,");
  }
  const iface = new ethers.Interface(IDENTITY_ABI);
  return {
    chainId: ERC8004_BASE_SEPOLIA.chainId,
    to: ERC8004_BASE_SEPOLIA.identityRegistry,
    value: "0",
    data: iface.encodeFunctionData("register", [agentURI]),
  };
}

/** setAgentWallet 的 EIP-712 typed data（參考實作：domain ERC8004IdentityRegistry/1）。 */
export function agentWalletTypedData(p: { agentId: number; wallet: string; owner: string; deadline: number }) {
  return {
    domain: {
      name: "ERC8004IdentityRegistry",
      version: "1",
      chainId: ERC8004_BASE_SEPOLIA.chainId,
      verifyingContract: ERC8004_BASE_SEPOLIA.identityRegistry,
    },
    types: {
      AgentWalletSet: [
        { name: "agentId", type: "uint256" },
        { name: "newWallet", type: "address" },
        { name: "owner", type: "address" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "AgentWalletSet",
    message: { agentId: String(p.agentId), newWallet: ethers.getAddress(p.wallet), owner: ethers.getAddress(p.owner), deadline: String(p.deadline) },
  };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const cmd = process.argv[2];
  const need = (k: string) => {
    const v = arg(k);
    if (!v) {
      console.error(`✗ 缺 --${k}`);
      process.exit(1);
    }
    return v!;
  };
  if (cmd === "registration-file") {
    const id = arg("agent-id");
    console.log(JSON.stringify(buildRegistrationFile({
      agent: need("agent"), name: need("name"), description: arg("description"), image: arg("image"),
      api: arg("api"), mcp: arg("mcp"), agentId: id === undefined ? undefined : Number(id),
    }), null, 2));
  } else if (cmd === "calldata") {
    console.log(JSON.stringify(registerCalldata(need("uri")), null, 2));
    console.error("（未送出。由 agent 擁有者以自己的錢包送出；送出前先核對 to 與 chainId。）");
  } else if (cmd === "wallet-typed-data") {
    console.log(JSON.stringify(agentWalletTypedData({
      agentId: Number(need("agent-id")), wallet: need("wallet"), owner: need("owner"), deadline: Number(need("deadline")),
    }), null, 2));
  } else {
    console.error("用法見檔案開頭註解：registration-file | calldata | wallet-typed-data");
    process.exit(2);
  }
}
