// 測試用的假 JSON-RPC 節點：每個請求立刻回 JSON-RPC error。
//
// 為什麼不用 `http://127.0.0.1:1`（連不上）：連線被拒時 ethers 要等到重試用完才放棄，一個請求
// 就是好幾秒；這個 stub 讓「RPC 讀不到」的路徑在毫秒內走完。/oracle 的新鮮度閘門讀不到時回 503
// （fail-closed），要看到 402 就開 `freshOraclePrices`。只給離線測試用，不會被打包進 Vercel bundle。
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
  /**
   * true = 對任何地址的 `eth_call` 回答 /oracle 新鮮度閘門要讀的兩個 view：`getPrice(bytes32)` 回
   * (1e8, 現在時間)、`maxPriceAge()` 回 21600。其餘 `eth_call` 照樣回錯誤。冒煙測試用。
   */
  freshOraclePrices?: boolean;
}

const GET_PRICE_SELECTOR = "0x31d98b3f"; // getPrice(bytes32)
const MAX_PRICE_AGE_SELECTOR = "0x1584410a"; // maxPriceAge()
const word = (n: number | bigint) => BigInt(n).toString(16).padStart(64, "0");

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
    const answer = (p: { id?: unknown; method?: unknown; params?: unknown } | null) => {
      const id = p?.id ?? null;
      if (opts.freshOraclePrices && p?.method === "eth_call") {
        const data = String((p.params as [{ data?: unknown; input?: unknown }] | undefined)?.[0]?.data ??
          (p.params as [{ input?: unknown }] | undefined)?.[0]?.input ?? "").toLowerCase();
        if (data.startsWith(GET_PRICE_SELECTOR))
          return { jsonrpc: "2.0", id, result: `0x${word(100_000_000)}${word(Math.floor(Date.now() / 1000))}` };
        if (data.startsWith(MAX_PRICE_AGE_SELECTOR)) return { jsonrpc: "2.0", id, result: `0x${word(21_600)}` };
      }
      if (opts.everyAddressIsEoa && p?.method === "eth_getCode") return { jsonrpc: "2.0", id, result: "0x" };
      if (opts.everyAddressIsEoa && p?.method === "eth_chainId") return { jsonrpc: "2.0", id, result: "0x14a34" };
      return { jsonrpc: "2.0", id, error: { code: -32000, message: "rpc stub: unavailable" } };
    };
    const body = Array.isArray(parsed)
      ? parsed.map((p) => answer(p as { id?: unknown; method?: unknown; params?: unknown }))
      : answer(parsed as { id?: unknown; method?: unknown; params?: unknown });
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
