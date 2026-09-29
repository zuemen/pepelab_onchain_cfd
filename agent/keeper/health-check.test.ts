// 健檢核心：RPC 故障與價格過期分開（審查 Medium 2）。
//   cd agent && npx tsx keeper/health-check.test.ts
//
// 第一段真的走 RPC 失敗路徑：起一個只會回 HTTP 503 的本機 JSON-RPC 伺服器，
// 用 ethers 的 JsonRpcProvider + Contract 去讀，和 health.ts 線上走的是同一條路。
import assert from "node:assert";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ethers } from "ethers";
import { checkFunding, checkHealth, isMajorityUnreadable } from "./health-check.ts";
import { decideAlert } from "./alert.ts";

const SYMBOLS = ["sBTC", "sETH", "sAAPL", "sTSLA", "sNVDA"] as const;
const NOW = 1_790_000_000;
const MAX_AGE = 5 * 3600;
const quiet = () => {};

// ── 1. 真的 RPC 故障：全部讀不到 → status=error，不是 stale ─────────────────
{
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("upstream unavailable");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const provider = new ethers.JsonRpcProvider(url, { chainId: 84532, name: "base-sepolia" }, {
      batchMaxCount: 1,
      staticNetwork: true,
    });
    const oracle = new ethers.Contract(
      "0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3",
      ["function getPrice(bytes32 assetId) view returns (uint256 price, uint256 updatedAt)"],
      provider,
    );
    const report = await checkHealth({
      chain: "base-sepolia",
      symbols: SYMBOLS,
      nowSec: NOW,
      maxAgeSec: MAX_AGE,
      getPrice: async (s) => (await oracle.getPrice(ethers.id(s))) as [bigint, bigint],
      fetchSession: async () => null,
      log: quiet,
    });
    provider.destroy();
    assert.ok(hits > 0, "必須真的打到 RPC");
    assert.equal(report.status, "error", JSON.stringify(report));
    assert.deepEqual(report.stale, [], "RPC 故障不得被算成價格過期");
    assert.deepEqual(report.unreadable, [...SYMBOLS]);
    // 告警端：error 不開 issue、也不關既有 issue。
    assert.equal(decideAlert({ report, open: null, nowSec: NOW }).action, "none");
    assert.equal(
      decideAlert({ report, open: { number: 9, lastSignature: "sBTC", lastUpdatedSec: 0 }, nowSec: NOW }).action,
      "none",
    );
  } finally {
    server.close();
  }
}

// ── 2. 少數讀不到：其餘判 ok／stale；讀不到的不算 stale，且擋住自動關閉 ─────────
{
  const fresh: [bigint, bigint] = [100n * 10n ** 8n, BigInt(NOW - 600)];
  const old: [bigint, bigint] = [100n * 10n ** 8n, BigInt(NOW - 10 * 3600)];
  const table: Record<string, [bigint, bigint] | Error> = {
    sBTC: fresh, sETH: new Error("socket hang up"), sAAPL: fresh, sTSLA: fresh, sNVDA: fresh,
  };
  const report = await checkHealth({
    chain: "base-sepolia", symbols: SYMBOLS, nowSec: NOW, maxAgeSec: MAX_AGE, log: quiet,
    getPrice: async (s) => {
      const v = table[s];
      if (v instanceof Error) throw v;
      return v;
    },
    fetchSession: async () => null,
  });
  assert.equal(report.status, "ok");
  assert.deepEqual(report.unreadable, ["sETH"]);
  assert.deepEqual(report.stale, []);
  const d = decideAlert({ report, open: { number: 9, lastSignature: "sETH", lastUpdatedSec: 0 }, nowSec: NOW });
  assert.equal(d.action, "none", "讀不到的資產不能證明已恢復，不關 issue");

  // 同一輪另有真的過期 → stale，且只列真的過期那個。
  table.sBTC = old;
  const r2 = await checkHealth({
    chain: "base-sepolia", symbols: SYMBOLS, nowSec: NOW, maxAgeSec: MAX_AGE, log: quiet,
    getPrice: async (s) => {
      const v = table[s];
      if (v instanceof Error) throw v;
      return v;
    },
    fetchSession: async () => null,
  });
  assert.equal(r2.status, "stale");
  assert.deepEqual(r2.stale, ["sBTC(10.0h)"]);
}

// ── 3. 多數門檻 ─────────────────────────────────────────────────────────
assert.equal(isMajorityUnreadable(6, 11), true);
assert.equal(isMajorityUnreadable(5, 11), false);
assert.equal(isMajorityUnreadable(11, 11), true);
assert.equal(isMajorityUnreadable(0, 0), false);

// ── 4. funding 結算延遲：超過 2 × FUNDING_INTERVAL 就 stale（窄複審 5） ───────────
{
  const INTERVAL = 8 * 3600;
  const last: Record<string, number | Error> = {
    sBTC: NOW - 9 * 3600, // 正常（< 16h）
    sETH: NOW - 17 * 3600, // 超過 2×
    sAAPL: 0, // 未初始化，不算延遲
    sTSLA: new Error("429"),
  };
  const rep = await checkFunding({
    chain: "base-sepolia", symbols: ["sBTC", "sETH", "sAAPL", "sTSLA"], nowSec: NOW, intervalSec: INTERVAL, log: quiet,
    lastFundingAt: async (s) => {
      const v = last[s];
      if (v instanceof Error) throw v;
      return v;
    },
  });
  assert.equal(rep.kind, "funding");
  assert.equal(rep.status, "stale");
  assert.deepEqual(rep.stale, ["sETH(17.0h)"]);
  assert.deepEqual(rep.unreadable, ["sTSLA"]);
  assert.equal(rep.maxAgeSec, 2 * INTERVAL);
  assert.equal(decideAlert({ report: rep, open: null, nowSec: NOW }).action, "create");
  // 全部正常 → ok
  const ok = await checkFunding({
    chain: "base-sepolia", symbols: ["sBTC"], nowSec: NOW, intervalSec: INTERVAL, log: quiet,
    lastFundingAt: async () => NOW - 3600,
  });
  assert.equal(ok.status, "ok");
}

console.log("health-check.test.ts ✓ all assertions passed");
