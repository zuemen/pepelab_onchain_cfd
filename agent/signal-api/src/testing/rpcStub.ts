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

export async function startRpcStub(): Promise<RpcStub> {
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
    const err = (id: unknown) => ({ jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message: "rpc stub: unavailable" } });
    const body = Array.isArray(parsed)
      ? parsed.map((p) => err((p as { id?: unknown })?.id))
      : err((parsed as { id?: unknown })?.id);
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
