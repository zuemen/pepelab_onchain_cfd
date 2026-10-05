// 測試用的假 Upstash REST：記憶體內的 list + string，支援 worker 用到的指令子集
// （RPUSH / LMOVE / LREM / LLEN / LPOP / GET / SET [NX] [EX] / DEL / INCR / EXPIRE / EVAL 的幾支固定腳本）。
// 只給離線測試用，不會被打包進 Vercel bundle（vercel-entry 不 import 它）。
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeUpstash {
  url: string;
  lists: Map<string, string[]>;
  strings: Map<string, string>;
  list(key: string): string[];
  /** 記錄每個指令名稱，方便斷言「有沒有呼叫某指令」。 */
  log: string[];
  /** 讓第 (skip+1) 次符合的指令以連線中斷失敗（模擬 process 在那一步崩潰）。 */
  failNext(cmd: string, skip?: number): void;
  close(): Promise<void>;
}

export async function startFakeUpstash(): Promise<FakeUpstash> {
  const lists = new Map<string, string[]>();
  const strings = new Map<string, string>();
  const log: string[] = [];
  const failing = new Map<string, number>(); // cmd → 還要放行幾次
  const list = (k: string) => {
    let l = lists.get(k);
    if (!l) {
      l = [];
      lists.set(k, l);
    }
    return l;
  };

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const args = JSON.parse(Buffer.concat(chunks).toString() || "[]") as (string | number)[];
    const cmd = String(args[0]).toUpperCase();
    log.push(cmd);
    if (failing.has(cmd)) {
      const left = failing.get(cmd)!;
      if (left <= 0) {
        failing.delete(cmd);
        res.destroy();
        return;
      }
      failing.set(cmd, left - 1);
    }
    const ok = (result: unknown) =>
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ result }));
    const k = String(args[1]);
    switch (cmd) {
      case "RPUSH":
        list(k).push(String(args[2]));
        return ok(list(k).length);
      case "LLEN":
        return ok(list(k).length);
      case "LPOP": {
        const n = Number(args[2] ?? 1);
        const out = list(k).splice(0, n);
        return ok(out.length ? out : null);
      }
      case "LMOVE": {
        const src = list(k);
        const dst = list(String(args[2]));
        const from = String(args[3]).toUpperCase();
        const to = String(args[4]).toUpperCase();
        const v = from === "LEFT" ? src.shift() : src.pop();
        if (v === undefined) return ok(null);
        if (to === "LEFT") dst.unshift(v);
        else dst.push(v);
        return ok(v);
      }
      case "LREM": {
        const l = list(k);
        let count = Number(args[2]);
        const v = String(args[3]);
        let removed = 0;
        for (let i = 0; i < l.length && (count === 0 || removed < count); ) {
          if (l[i] === v) {
            l.splice(i, 1);
            removed += 1;
          } else i += 1;
        }
        return ok(removed);
      }
      case "GET":
        return ok(strings.get(k) ?? null);
      case "SET": {
        const opts = args.slice(3).map((a) => String(a).toUpperCase());
        if (opts.includes("NX") && strings.has(k)) return ok(null);
        strings.set(k, String(args[2]));
        return ok("OK");
      }
      case "LRANGE": {
        const l = list(k);
        const start = Number(args[2]);
        const stop = Number(args[3]);
        return ok(l.slice(start, stop < 0 ? l.length + stop + 1 : stop + 1));
      }
      case "EVAL": {
        const script = String(args[1]);
        const numKeys = Number(args[2]);
        const KEYS = args.slice(3, 3 + numKeys).map(String);
        const ARGV = args.slice(3 + numKeys).map(String);
        // ledger.ts 的 x402:settlement:unknown 腳本（以開頭的標記辨認；語意與 Lua 逐行相同）。
        if (script.startsWith("-- pepelab:unknown_push")) {
          if (list(KEYS[0]).length >= Number(ARGV[1])) {
            list(KEYS[1]).push(ARGV[2]);
            strings.set(KEYS[2], String(Number(strings.get(KEYS[2]) ?? "0") + 1));
            return ok(0);
          }
          list(KEYS[0]).push(ARGV[0]);
          return ok(1);
        }
        if (script.startsWith("-- pepelab:unknown_move")) {
          const l = list(KEYS[0]);
          const i = l.indexOf(ARGV[0]);
          if (i < 0) return ok(0);
          l.splice(i, 1);
          list(KEYS[1]).push(ARGV[1]);
          return ok(1);
        }
        // 其餘只實作鎖釋放那一支：GET KEYS[1] == ARGV[1] 才 DEL。
        const key = String(args[3]);
        const argv1 = String(args[4]);
        if (!/redis\.call\('GET', KEYS\[1\]\) == ARGV\[1\].*redis\.call\('DEL', KEYS\[1\]\)/.test(script)) {
          return void res.writeHead(400).end(JSON.stringify({ error: "unsupported script" }));
        }
        if (strings.get(key) === argv1) {
          strings.delete(key);
          return ok(1);
        }
        return ok(0);
      }
      case "INCR": {
        const v = Number(strings.get(k) ?? "0") + 1;
        strings.set(k, String(v));
        return ok(v);
      }
      case "EXPIRE":
        return ok(strings.has(k) ? 1 : 0);
      case "DEL":
        return ok(strings.delete(k) ? 1 : 0);
      default:
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: `unhandled cmd ${cmd}` }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    lists,
    strings,
    list,
    log,
    failNext: (c, skip = 0) => void failing.set(c.toUpperCase(), skip),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
