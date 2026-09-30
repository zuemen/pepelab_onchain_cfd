// 測試用的極簡 JSON-RPC 節點：只回答註冊過的 eth_call（依 selector），其餘回錯誤。
// 不連任何真實網路、不接受交易。
import http from "node:http";
import { ethers } from "ethers";

export type CallHandler = (data: string, to: string) => string;

export async function startFakeRpc(handlers: Record<string, CallHandler>): Promise<{ url: string; close: () => Promise<void>; calls: string[] }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reqs = JSON.parse(body);
      const one = (r: any) => {
        calls.push(r.method);
        if (r.method === "eth_call") {
          const { data, to } = r.params[0];
          const h = handlers[String(data).slice(0, 10).toLowerCase()];
          if (h) return { jsonrpc: "2.0", id: r.id, result: h(data, to) };
          return { jsonrpc: "2.0", id: r.id, error: { code: 3, message: "execution reverted", data: "0x" } };
        }
        if (r.method === "eth_chainId") return { jsonrpc: "2.0", id: r.id, result: "0x14a34" };
        return { jsonrpc: "2.0", id: r.id, error: { code: -32601, message: `fake rpc: ${r.method} not supported` } };
      };
      const out = Array.isArray(reqs) ? reqs.map(one) : one(reqs);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const SESSIONS = new ethers.Interface([
  "function sessions(uint256) view returns (address user, address agent, uint256 maxMarginPerTrade, uint256 totalMarginBudget, uint256 spentMargin, uint256 maxLeverage, uint256 expiry, bool revoked)",
]);

/** sessions(uint256) 的 handler：回固定的 session。 */
export function sessionsHandler(s: { user: string; agent: string }): Record<string, CallHandler> {
  const fn = SESSIONS.getFunction("sessions")!;
  return {
    [fn.selector]: () =>
      SESSIONS.encodeFunctionResult(fn, [s.user, s.agent, 10n ** 20n, 10n ** 21n, 0n, 5n, 2n ** 40n, false]),
  };
}
