// PepeLab MCP Server
// 把協議狀態包成 MCP tools，讓 Claude 這類 agent 直接查詢與下單：
//   read:
//     - get_trader_performance  → StrategyRegistry + 鏈上 PnL 聚合
//     - get_funding_rate        → PerpetualExchange.getFundingRate
//     - get_position            → PerpetualExchange.getPosition (+ unrealized/funding)
//     - get_session             → AgentSessionManager.sessions（限額/預算/到期）
//   write（Phase 2，經 AgentSessionManager session 限額）:
//     - open_position           → openPositionForSession
//     - close_position          → closePositionForSession
//     兩者預設需人類確認（writeTools.ts：送出前以 MCP elicitation 在 client 介面詢問人類，
//     答案不經模型；client 不支援 elicitation 就拒絕寫入。MCP_WRITE_REQUIRE_CONFIRM=false
//     可關閉並會警告），送出時再經 policy gate。
// 透過 stdio 傳輸；合約讀取走 Base Sepolia（chainId 84532）。寫操作需 AGENT_PRIVATE_KEY
// （session key）+ SESSION_MANAGER_ADDRESS；缺任一時 tool 回明確錯誤、不 crash。
// 必須是第一個 import：在 @pepelab/shared 其他模組求值（例如 addresses.ts 讀
// AGENT_CHAIN_ID）之前先載入 agent/.env。下方的 loadEnv() 保留為冪等的保險。
import "@pepelab/shared/autoload-env";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ethers } from "ethers";
import {
  loadEnv,
  makeProvider,
  makeContracts,
  makeSigner,
  getSessionManagerAddress,
  ADDRESSES,
  getTraderPerformance,
  getFundingRate,
  getPositionDetail,
  openPositionForSession,
  closePositionForSession,
  getSession,
  agentDid,
  parseDidPkh,
  buildAgentVerification,
  type AuthorizationVC,
  type ContractTarget,
  jsonSafe,
  assetIdOf,
  symbolOfAssetId,
  loadPolicyConfig,
  readPolicyState,
  evaluatePolicy,
  defaultStatePath,
  redactSecrets,
} from "@pepelab/shared";
import {
  TOOL_ANNOTATIONS,
  registerWriteTools,
  writeConfirmRequired,
  CONFIRM_DISABLED_WARNING,
} from "./writeTools.ts";

loadEnv();

const provider = makeProvider();
const contracts = makeContracts(provider);

// ERC-8126 verifier identity（VERIFIER_PRIVATE_KEY 優先，否則一次性隨機）。
const VERIFIER_WALLET = (() => {
  const pk = process.env.VERIFIER_PRIVATE_KEY?.trim();
  if (pk && pk.startsWith("0x") && pk.length === 66) return new ethers.Wallet(pk);
  return ethers.Wallet.createRandom();
})();

const server = new McpServer({
  name: "pepelab-cfd",
  version: "0.1.0",
});

function ok(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(jsonSafe(data), null, 2) },
    ],
  };
}

function fail(err: unknown) {
  return {
    isError: true,
    content: [
      { type: "text" as const, text: `Error: ${redactSecrets((err as Error).message)}` },
    ],
  };
}

// ── 寫入工具的人類確認（writeTools.ts）─────────────────────────────────────
const REQUIRE_CONFIRM = writeConfirmRequired();
if (!REQUIRE_CONFIRM) console.error(CONFIRM_DISABLED_WARNING);

const FEE_ABI = [
  "function tradingFeeBpsForAsset(bytes32 asset) view returns (uint256)",
  "function TRADING_FEE_BPS() view returns (uint256)",
  "function executionFee() view returns (uint256)",
];
const feeReader = new ethers.Contract(ADDRESSES.PerpetualExchange, FEE_ABI, provider);

const writeDeps: Parameters<typeof registerWriteTools>[1] = {
  requireConfirm: REQUIRE_CONFIRM,
  open: (a) =>
    openPositionForSession({
      sessionId: a.sessionId,
      symbol: a.asset,
      isLong: a.isLong,
      marginUsdc: a.marginUsdc,
      leverage: a.leverage,
      authVc: JSON.parse(a.authVcJson) as AuthorizationVC,
    }) as any,
  close: (a) =>
    closePositionForSession({
      sessionId: a.sessionId,
      positionId: a.positionId,
      authVc: JSON.parse(a.authVcJson) as AuthorizationVC,
    }) as any,
  readFees: async (asset) => {
    let tradingFeeBps: number | null = null;
    if (asset) {
      try {
        tradingFeeBps = Number(await feeReader.tradingFeeBpsForAsset(assetIdOf(asset)));
      } catch {
        tradingFeeBps = null;
      }
    }
    if (tradingFeeBps === null) {
      try {
        tradingFeeBps = Number(await feeReader.TRADING_FEE_BPS());
      } catch {
        tradingFeeBps = null;
      }
    }
    let executionFeeEth: string | null = null;
    try {
      executionFeeEth = ethers.formatEther((await feeReader.executionFee()) as bigint);
    } catch {
      executionFeeEth = null;
    }
    return { tradingFeeBps, executionFeeEth };
  },
  readPosition: async (positionId) => {
    const p: any = await contracts.perp.getPosition(positionId);
    return {
      asset: symbolOfAssetId(String(p.asset)) ?? null,
      isLong: Boolean(p.isLong),
      marginUsdc: Number(ethers.formatUnits(p.margin as bigint, 18)),
      leverage: Number(p.leverage),
      isOpen: Boolean(p.isOpen),
    };
  },
  policyPreview: (req) => {
    const signer = makeSigner(provider);
    if (!signer) return null;
    try {
      const cfg = loadPolicyConfig();
      const state = readPolicyState(defaultStatePath());
      return evaluatePolicy({ ...req, agent: signer.address }, cfg, state, Date.now());
    } catch (err) {
      return { allowed: false, reasonCode: "PREVIEW_FAILED", message: redactSecrets((err as Error).message) };
    }
  },
  warn: (m) => console.error(m),
};

server.tool(
  "get_trader_performance",
  "取得某 trader 的績效摘要：註冊狀態、最新策略配置、鏈上 PnL 聚合（已實現/未實現/淨值）與開倉建議。",
  { trader: z.string().describe("trader 的鏈上地址 0x…") },
  TOOL_ANNOTATIONS.read,
  async ({ trader }) => {
    try {
      return ok(await getTraderPerformance(contracts, trader));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "get_funding_rate",
  "取得某資產當前每-interval 資金費率（bps 與 %），正值代表多方付費。",
  { asset: z.string().describe("資產代號，如 sBTC / sETH / sAAPL") },
  TOOL_ANNOTATIONS.read,
  async ({ asset }) => {
    try {
      return ok(await getFundingRate(contracts, asset));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "get_position",
  "取得單一倉位詳情：方向、進場價、保證金、槓桿、未實現 PnL 與待結算 funding。",
  { positionId: z.number().int().nonnegative().describe("倉位 ID") },
  TOOL_ANNOTATIONS.read,
  async ({ positionId }) => {
    try {
      return ok(await getPositionDetail(contracts, positionId));
    } catch (err) {
      return fail(err);
    }
  },
);

// ── read: session 設定 ───────────────────────────────────────────────────────
server.tool(
  "get_session",
  "讀取某 session 的委派限額：使用者/agent、每筆上限、總預算、已用、最大槓桿、到期、是否撤銷。下單前先用它自我檢查。",
  { sessionId: z.number().int().nonnegative().describe("鏈上 session id") },
  TOOL_ANNOTATIONS.read,
  async ({ sessionId }) => {
    try {
      return ok(await getSession(sessionId));
    } catch (err) {
      return fail(err);
    }
  },
);

// ── read: ERC-8126 agent 驗證 ────────────────────────────────────────────────
server.tool(
  "get_agent_verification",
  "取得某 agent 的 ERC-8126 驗證 attestation：ETV/SCV/WAV/WV 四項檢查 + MCV(N/A) + 統一 0–100 風險分數（越低越安全）+ verifier 簽章。用來判斷『這個 agent 可不可信』，可與授權 VC 並用。",
  { did: z.string().describe("agent 的 did:pkh 或裸 0x 地址") },
  TOOL_ANNOTATIONS.read,
  async ({ did }) => {
    try {
      const subject = did.startsWith("did:") ? did : agentDid(did);
      parseDidPkh(subject); // 驗格式
      const etvTargets: ContractTarget[] = [
        { label: "USDC (settlement)", address: process.env.X402_SETTLEMENT_TOKEN?.trim() || "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
        { label: "PerpetualExchange", address: ADDRESSES.PerpetualExchange },
      ];
      const scvTargets: ContractTarget[] = [
        { label: "PerpetualExchange", address: ADDRESSES.PerpetualExchange },
        { label: "FeeRouter", address: ADDRESSES.FeeRouter },
        { label: "AgentSessionManager", address: getSessionManagerAddress() },
      ];
      const signer = makeSigner(provider);
      const holderSigner =
        signer && ethers.getAddress(signer.address) === parseDidPkh(subject).address
          ? signer
          : undefined;
      const av = await buildAgentVerification({
        did: subject,
        verifier: VERIFIER_WALLET,
        provider,
        apiBaseUrl: process.env.SIGNAL_API_PUBLIC_URL?.trim() || "http://localhost:4021",
        etvTargets,
        scvTargets,
        explorerApiKey:
          process.env.ETHERSCAN_API_KEY?.trim() || process.env.BASESCAN_API_KEY?.trim(),
        paidPath: "/oracle/sBTC",
        holderSigner,
      });
      return ok(av);
    } catch (err) {
      return fail(err);
    }
  },
);

// ── write: 經 AgentSessionManager 在 session 限額內下單（人類確認走 MCP elicitation）──
registerWriteTools(server, writeDeps);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  "▶ pepelab-cfd MCP server ready (stdio) — read tools + session-bounded write tools",
);
