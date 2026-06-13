// PepeLab MCP Server（Phase 1, read-only）
// 把協議唯讀狀態包成 MCP tools，讓 Claude 這類 agent 直接查詢：
//   - get_trader_performance  → StrategyRegistry + 鏈上 PnL 聚合
//   - get_funding_rate        → PerpetualExchange.getFundingRate
//   - get_position            → PerpetualExchange.getPosition (+ unrealized/funding)
// 透過 stdio 傳輸；合約讀取走 Ethereum Sepolia。
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  loadEnv,
  makeProvider,
  makeContracts,
  getTraderPerformance,
  getFundingRate,
  getPositionDetail,
  jsonSafe,
} from "@pepelab/shared";

loadEnv();

const provider = makeProvider();
const contracts = makeContracts(provider);

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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("▶ pepelab-cfd MCP server ready (stdio, read-only)");
