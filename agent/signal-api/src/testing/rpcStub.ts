// 測試用的假 JSON-RPC 節點：每個請求立刻回 JSON-RPC error。
//
// 為什麼不用 `http://127.0.0.1:1`（連不上）：/oracle 的新鮮度閘門會打 RPC，連線被拒時 ethers
// 要等到重試用完才放棄，一個請求就是好幾秒；這個 stub 讓同一條「讀不到就交給下游」的降級路徑
// 在毫秒內走完。只給離線測試用，不會被打包進 Vercel bundle。
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RpcStub {
  url: string;
  /** 收到的請求數（斷言「這條路徑完全沒打 RPC」用）。 */
  hits(): number;
  close(): Promise<void>;
}

export interface RpcStubOptions {
  /**
   * true = `eth_getCode` 一律回 "0x"（所有地址都當成沒有 code 的 EOA）、`eth_chainId` 回 Base Sepolia。
   * 讓「真的走 provider」的收款地址守門能通過，其餘呼叫照樣回錯誤。本機啟動 src/index.ts 的冒煙測試用。
   */
  everyAddressIsEoa?: boolean;
}

export async function startRpcStub(opts: RpcStubOptions = {}): Promise<RpcStub> {
  let hits = 0;
  const server: Server = createServer(async (req, res) => {
    hits += 1;
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      parsed = {};
    }
    const answer = (p: { id?: unknown; method?: unknown } | null) => {
      const id = p?.id ?? null;
      if (opts.everyAddressIsEoa && p?.method === "eth_getCode") return { jsonrpc: "2.0", id, result: "0x" };
      if (opts.everyAddressIsEoa && p?.method === "eth_chainId") return { jsonrpc: "2.0", id, result: "0x14a34" };
      return { jsonrpc: "2.0", id, error: { code: -32000, message: "rpc stub: unavailable" } };
    };
    const body = Array.isArray(parsed)
      ? parsed.map((p) => answer(p as { id?: unknown; method?: unknown }))
      : answer(parsed as { id?: unknown; method?: unknown });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
