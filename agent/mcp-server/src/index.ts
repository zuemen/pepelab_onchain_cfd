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
// 透過 stdio 傳輸；合約讀取走 Ethereum Sepolia。寫操作需 AGENT_PRIVATE_KEY
// （session key）+ SESSION_MANAGER_ADDRESS；缺任一時 tool 回明確錯誤、不 crash。
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
} from "@pepelab/shared";

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
      { type: "text" as const, text: `Error: ${(err as Error).message}` },
    ],
  };
}

server.tool(
  "get_trader_performance",
  "取得某 trader 的績效摘要：註冊狀態、最新策略配置、鏈上 PnL 聚合（已實現/未實現/淨值）與開倉建議。",
  { trader: z.string().describe("trader 的鏈上地址 0x…") },
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

// ── write: 經 AgentSessionManager 在 session 限額內下單 ───────────────────────
server.tool(
  "open_position",
  "【寫】在指定 session 限額內為 session 使用者開一筆受限部位（受 per-trade cap / budget / leverage cap / expiry 約束）。需 AGENT_PRIVATE_KEY + SESSION_MANAGER_ADDRESS；缺則回明確錯誤。可選帶 authVcJson（使用者簽發的授權 VC）→ 下單前驗簽+鏈上交叉比對，不符即拒絕。回傳 tx hash 與 positionId。",
  {
    sessionId: z.number().int().nonnegative().describe("鏈上 session id"),
    asset: z.string().describe("資產代號，如 sBTC / sETH / sAAPL"),
    isLong: z.boolean().describe("true=做多，false=做空"),
    marginUsdc: z.number().positive().describe("保證金（USDC，人類單位）"),
    leverage: z.number().int().positive().describe("槓桿（受 session.maxLeverage 約束）"),
    authVcJson: z.string().optional().describe("（可選）使用者簽發的授權 VC JSON 字串；提供時下單前必須驗證通過"),
  },
  async ({ sessionId, asset, isLong, marginUsdc, leverage, authVcJson }) => {
    try {
      let authVc: AuthorizationVC | undefined;
      if (authVcJson) {
        try {
          authVc = JSON.parse(authVcJson) as AuthorizationVC;
        } catch (e) {
          return fail(new Error(`authVcJson 解析失敗：${(e as Error).message}`));
        }
      }
      const res = await openPositionForSession({
        sessionId,
        symbol: asset,
        isLong,
        marginUsdc,
        leverage,
        authVc,
      });
      return res.ok ? ok(res) : fail(new Error(res.error));
    } catch (err) {
      return fail(err);
    }
  },
);

server.tool(
  "close_position",
  "【寫】平掉指定 session 使用者的一筆部位。需 AGENT_PRIVATE_KEY + SESSION_MANAGER_ADDRESS；缺則回明確錯誤。回傳 tx hash。",
  {
    sessionId: z.number().int().nonnegative().describe("鏈上 session id"),
    positionId: z.number().int().nonnegative().describe("要平的倉位 ID"),
  },
  async ({ sessionId, positionId }) => {
    try {
      const res = await closePositionForSession({ sessionId, positionId });
      return res.ok ? ok(res) : fail(new Error(res.error));
    } catch (err) {
      return fail(err);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  "▶ pepelab-cfd MCP server ready (stdio) — read tools + session-bounded write tools",
);
