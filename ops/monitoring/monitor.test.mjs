// 監控引擎與通知的測試：用假的 JSON-RPC／HTTP（注入 fetch），不連任何網路。
//   node --test ops/monitoring/monitor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, selector } from "./keccak.mjs";
import { decodeLog, formatUnits, isRangeError, isTransient, makeRpc, reconcile, runOnce, toUnits } from "./engine.mjs";
import { channelsOf, parseMuteKeys, shouldSend } from "./notify.mjs";
import { BASELINES_KEY, STATE_KEY, tick } from "./tick.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FULL = JSON.parse(readFileSync(join(here, "monitors.json"), "utf8"));
const RPC = "https://rpc.test";
const API = "https://api.test";
const E18 = 10n ** 18n;

/** 只保留指定規則的設定（其餘規則不呼叫，假鏈不需要準備它們的資料）。 */
const only = (...ids) => ({ ...FULL, rules: FULL.rules.filter((r) => ids.includes(r.id)) });
const ruleOf = (id) => FULL.rules.find((r) => r.id === id);
const addrOf = (id, ref) => ruleOf(id).contracts.find((c) => c.ref === ref || c.as === ref).address;
const env0 = { RPC_URL: RPC, SIGNAL_API_URL: API };

const word = (...vals) => "0x" + vals.map((v) => BigInt(v).toString(16).padStart(64, "0")).join("");
const topicAddr = (a) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();

/** 假鏈：logs、eth_call 回應、餘額、HTTP 端點都可在測試中改。 */
function fakeWorld() {
  const w = {
    head: 1000,
    logs: [],
    calls: new Map(), // `${to}|${data}` 或 `${to}|${selector}` → hex 或 { revert: true }
    balances: new Map(),
    failGetLogs: false,
    rangeLimit: null, // 節點的 eth_getLogs 區塊數上限（超過回 HTTP 413，與 sepolia.base.org 實測相同）
    getLogsHttp: null, // (from, to) => { status, body } | null：讓某些範圍回 HTTP 錯誤
    spans: [], // 每個 eth_getLogs 請求的區塊數
    rpcHttp: null, // (body) => { status, body } | "throw" | "timeout" | null：整個 RPC 請求層級的故障
    rpcPosts: 0, // 送到 RPC 的 HTTP 請求數（含重試）
    itemError: null, // (req) => { code, message } | null：batch 內單筆的 JSON-RPC 錯誤（例如 -32007 限流）
    http: new Map(), // url → () => ({ status, body }) 或丟錯
    sent: [], // 通知通道收到的請求
  };
  w.setCall = (to, fnSig, args, ret) => {
    const data = selector(fnSig) + args.map((a) => a.replace(/^0x/, "").padStart(64, "0")).join("");
    w.calls.set(`${to.toLowerCase()}|${data}`, ret);
  };
  const handle = (req) => {
    switch (req.method) {
      case "eth_blockNumber":
        return "0x" + w.head.toString(16);
      case "eth_getLogs": {
        if (w.failGetLogs) throw new Error("query returned more than 10000 results");
        const f = req.params[0];
        const [from, to] = [Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock))];
        const addrs = f.address.map((a) => a.toLowerCase());
        return w.logs.filter((l) => {
          const bn = Number(BigInt(l.blockNumber));
          return bn >= from && bn <= to && addrs.includes(l.address.toLowerCase()) && f.topics[0].includes(l.topics[0]);
        });
      }
      case "eth_call": {
        const { to, data } = req.params[0];
        const v = w.calls.get(`${to.toLowerCase()}|${data}`) ?? w.calls.get(`${to.toLowerCase()}|${data.slice(0, 10)}`);
        if (v === undefined || v?.revert) throw new Error("execution reverted");
        return v;
      }
      case "eth_getBalance":
        return "0x" + (w.balances.get(req.params[0].toLowerCase()) ?? 10n * E18).toString(16);
      default:
        throw new Error(`unsupported ${req.method}`);
    }
  };
  w.fetch = async (url, init = {}) => {
    if (url === RPC) {
      const body = JSON.parse(init.body);
      w.rpcPosts++;
      const forcedRpc = w.rpcHttp?.(body);
      if (forcedRpc === "throw") throw new TypeError("fetch failed");
      if (forcedRpc === "timeout") throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      if (forcedRpc) return new Response(forcedRpc.body, { status: forcedRpc.status });
      if (!Array.isArray(body) && body.method === "eth_getLogs") {
        const [from, to] = [Number(BigInt(body.params[0].fromBlock)), Number(BigInt(body.params[0].toBlock))];
        w.spans.push(to - from + 1);
        if (w.rangeLimit && to - from + 1 > w.rangeLimit) {
          const err = { code: -32614, message: `eth_getLogs is limited to a ${w.rangeLimit.toLocaleString("en-US")} range` };
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: err }), { status: 413 });
        }
        const forced = w.getLogsHttp?.(from, to);
        if (forced) return new Response(forced.body, { status: forced.status });
      }
      const one = (r) => {
        const ie = w.itemError?.(r);
        if (ie) return { jsonrpc: "2.0", id: r.id, error: ie };
        try {
          return { jsonrpc: "2.0", id: r.id, result: handle(r) };
        } catch (e) {
          return { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: e.message } };
        }
      };
      return Response.json(Array.isArray(body) ? body.map(one) : one(body));
    }
    if (w.http.has(url)) {
      const r = w.http.get(url)();
      return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
    }
    // 其他一律視為通知通道
    w.sent.push({ url, init });
    return new Response("ok", { status: w.channelStatus ?? 200 });
  };
  return w;
}

function makeLog(w, { address, sig, topics = [], data = "0x", block = w.head - 5, tx = "0x" + "ab".repeat(32), logIndex = 0 }) {
  w.logs.push({
    address,
    topics: [keccak256(sig), ...topics],
    data,
    blockNumber: "0x" + block.toString(16),
    transactionHash: tx,
    logIndex: "0x" + logIndex.toString(16),
    removed: false,
  });
}

const fakeKv = () => {
  const m = new Map();
  return { m, get: async (k, t) => (m.has(k) ? (t === "json" ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k) };
};

// ── keccak ───────────────────────────────────────────────────────────────────

test("keccak256 已知向量（含跨 rate 邊界）", () => {
  assert.equal(keccak256(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256("Transfer(address,address,uint256)"), "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  assert.equal(keccak256("OwnershipTransferred(address,address)"), "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0");
  assert.equal(selector("owner()"), "0x8da5cb5b");
  // 135／136／200 bytes（以 ethers.keccak256 交叉核對過）。
  assert.equal(keccak256("x".repeat(135)), "0x16570bdb055e663ea1cb57ac6f09194f4bc7b7070847971fc0b86710366dc34f");
  assert.equal(keccak256("x".repeat(136)), "0x50da8ef3747b7a7f01d08563aa11c72a2a668563fb928adc6e8d2a1ab4e36096");
  assert.equal(keccak256("a".repeat(200)), "0x96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d");
});

test("金額換算與 log 解碼", () => {
  assert.equal(toUnits("10000", 18), 10000n * E18);
  assert.equal(toUnits("0.02", 18), 2n * 10n ** 16n);
  assert.equal(formatUnits(12345678n * 10n ** 16n, 18), "123,456.78");
  const f = decodeLog(
    [
      { name: "role", type: "bytes32", indexed: true },
      { name: "account", type: "address", indexed: true },
      { name: "note", type: "string", indexed: false },
      { name: "pnl", type: "int256", indexed: false },
    ],
    { topics: ["0x0", "0x" + "0".repeat(64), topicAddr("0x1111111111111111111111111111111111111111")], data: word(64, (1n << 256n) - 5n) },
    { ["0x" + "0".repeat(64)]: "DEFAULT_ADMIN_ROLE" },
  );
  assert.match(f[0].value, /^DEFAULT_ADMIN_ROLE/);
  assert.equal(f[1].value, "0x1111111111111111111111111111111111111111");
  assert.equal(f[2].value, "(動態型別略)");
  assert.equal(f[3].value, "-5");
});

// ── event 規則 ───────────────────────────────────────────────────────────────

test("owner 變更：SEV-1 事件、解出新舊 owner、檢查點前進、不重複告警", async () => {
  const w = fakeWorld();
  const cfg = only("owner-transferred");
  const ex = addrOf("owner-transferred", "PerpetualExchange");
  makeLog(w, {
    address: ex,
    sig: "OwnershipTransferred(address,address)",
    topics: [topicAddr("0x00000000000000000000000000000000000000aa"), topicAddr("0x00000000000000000000000000000000000000bb")],
  });
  const state = {};
  const r1 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 1_000_000 });
  assert.equal(r1.errors.length, 0, r1.errors.join());
  assert.equal(r1.notes.length, 1);
  const n = r1.notes[0];
  assert.equal(n.severity, "SEV-1");
  assert.equal(n.status, "事件");
  assert.ok(n.lines.some((l) => l.includes("newOwner=0x00000000000000000000000000000000000000bb")), n.lines.join("\n"));
  assert.ok(n.lines.some((l) => l.includes("https://sepolia.basescan.org/tx/0x")));
  assert.equal(state.checkpoint, w.head - 3);

  const r2 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 1_000_300 });
  assert.equal(r2.notes.length, 0, "同一筆 log 不可重複告警");
});

test("角色授予：解出角色名稱", async () => {
  const w = fakeWorld();
  const cfg = only("access-role-changed");
  const minter = keccak256("MINTER_ROLE");
  makeLog(w, {
    address: addrOf("access-role-changed", "V2_STACK.tokens.sBTC"),
    sig: "RoleGranted(bytes32,address,address)",
    topics: [minter, topicAddr("0x00000000000000000000000000000000000000cc"), topicAddr("0x00000000000000000000000000000000000000dd")],
  });
  const { notes } = await runOnce({ config: cfg, env: env0, state: {}, fetchImpl: w.fetch, now: 1 });
  assert.equal(notes.length, 1);
  assert.match(notes[0].lines[1], /role=MINTER_ROLE/);
});

test("getLogs 失敗：檢查點不前進、開「監控本身」告警；恢復後補掃並發恢復通知", async () => {
  const w = fakeWorld();
  const cfg = only("owner-transferred");
  const state = { checkpoint: 900 };
  w.failGetLogs = true;
  const r0 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 100 });
  assert.equal(state.checkpoint, 900);
  assert.equal(r0.errors.length, 1);
  assert.equal(r0.notes.length, 0, "單輪失敗不告警（M3：連續 SELF_ERRORS_BEFORE_ALERT 輪才告警）");
  const r1 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 250 });
  assert.equal(state.checkpoint, 900);
  assert.ok(r1.notes.some((n) => n.key === "monitor-self:errors" && n.status === "觸發"));
  assert.ok(r1.notes[0].lines.some((l) => /連續 2 輪失敗/.test(l)));

  w.failGetLogs = false;
  makeLog(w, { address: addrOf("owner-transferred", "InsuranceVault"), sig: "OwnershipTransferred(address,address)", topics: [word(0), word(1)], block: 950 });
  const r2 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 400 });
  assert.ok(r2.notes.some((n) => n.status === "事件"), "失敗期間的 log 必須在恢復後補到");
  assert.ok(r2.notes.some((n) => n.key === "monitor-self:errors" && n.status === "恢復"));
});

// ── RPC 重試與抖動（審查 M3）─────────────────────────────────────────────────

const noSleep = async () => {};

test("M3：RPC 429／5xx／逾時／連線錯誤 → 退避重試後成功，不算錯誤；413 不重試", async () => {
  for (const fault of [{ status: 429, body: "rate limited" }, { status: 503, body: "upstream" }, "timeout", "throw"]) {
    const w = fakeWorld();
    const cfg = only("owner-transferred");
    ownerLog(w, w.head - 5, 1);
    let n = 0;
    w.rpcHttp = () => (n++ % 2 === 0 ? fault : null); // 每個請求第一次都失敗、重試才過
    const waits = [];
    const r = await runOnce({ config: cfg, env: env0, state: {}, fetchImpl: w.fetch, now: 1, sleep: async (ms) => void waits.push(ms) });
    assert.equal(r.errors.length, 0, `${JSON.stringify(fault)}：${r.errors.join()}`);
    assert.equal(r.notes.filter((x) => x.status === "事件").length, 1);
    assert.equal(r.summary.rpcRetries, 2, "eth_blockNumber 與 eth_getLogs 各重試一次");
    assert.deepEqual(waits, [400, 400]);
  }
  assert.equal(isTransient({ status: 413, message: "RPC HTTP 413" }), false);
  assert.equal(isRangeError({ status: 413 }), true);
  assert.equal(isTransient({ code: -32007, message: "25/second request limit reached" }), true);
  assert.equal(isTransient({ code: -32000, message: "execution reverted" }), false, "revert 不是暫時性失敗，不重試");
  assert.equal(isRangeError({ code: -32005, message: "project ID request rate exceeded" }), false, "-32005 的限流不是範圍錯誤");
  assert.equal(isTransient({ code: -32005, message: "project ID request rate exceeded" }), true);
});

test("M3：batch 裡被限流的那幾筆（-32007）單獨重送；整輪重試額度有上限", async () => {
  const w = fakeWorld();
  const cfg = only("oracle-stale");
  const now = 2_000_000;
  stubOracle(w, { now });
  const seen = new Map();
  // 每一筆 getPrice 第一次都回 -32007（公開 RPC 每秒 25 個請求，batch 內逐筆計）。
  w.itemError = (req) => {
    if (req.method !== "eth_call" || !req.params[0].data.startsWith(selector("getPrice(bytes32)"))) return null;
    const k = req.params[0].data;
    seen.set(k, (seen.get(k) ?? 0) + 1);
    return seen.get(k) === 1 ? { code: -32007, message: "25/second request limit reached - reduce calls per second" } : null;
  };
  const r = await runOnce({ config: cfg, env: env0, state: {}, fetchImpl: w.fetch, now, sleep: noSleep });
  assert.equal(r.errors.length, 0, r.errors.join());
  assert.equal(w.rpcPosts, 3, "eth_blockNumber + 原 batch + 只含被限流那幾筆的重送");

  // RPC 整個掛掉：每個請求最多重試 2 次，但整輪合計最多 6 次——不會把 subrequest 配額燒光。
  const w2 = fakeWorld();
  w2.rpcHttp = () => ({ status: 503, body: "down" });
  const full = { ...FULL, rules: FULL.rules.filter((x) => x.kind !== "http") };
  const r2 = await runOnce({ config: full, env: env0, state: {}, fetchImpl: w2.fetch, now, sleep: noSleep });
  const stateRules = full.rules.filter((x) => x.kind === "state" && x.status === "active").length;
  assert.equal(r2.summary.rpcRetries, 6);
  assert.equal(w2.rpcPosts, 1 + stateRules + 6, "每條規則一個請求 + 事件掃描一個 + 6 次重試");
  assert.ok(w2.rpcPosts < 30, `RPC 全掛時一輪用了 ${w2.rpcPosts} 個 subrequest`);
});

test("M3：節流——一秒內的呼叫數不超過上限，超過就先等", async () => {
  let t = 1_000_000;
  const waits = [];
  const sizes = [];
  const rpc = makeRpc("https://rpc.test", async (_u, init) => {
    const b = JSON.parse(init.body);
    sizes.push(Array.isArray(b) ? b.length : 1);
    return Response.json(Array.isArray(b) ? b.map((x) => ({ id: x.id, result: "0x1" })) : { id: b.id, result: "0x1" });
  }, { callsPerSec: 20, clock: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
  const req = { method: "eth_call", params: [{ to: "0x0", data: "0x" }, "latest"] };
  await rpc.batch(Array(12).fill(req)); // 12
  await rpc.batch(Array(8).fill(req)); // 20：剛好
  assert.deepEqual(waits, []);
  await rpc.batch(Array(5).fill(req)); // 25 > 20：要等最早的 5 筆滿一秒
  assert.equal(waits.length, 1);
  assert.ok(waits[0] >= 1000 && waits[0] <= 1020, String(waits[0]));
  t += 2000;
  await rpc.call("eth_blockNumber", []); // 視窗已清空，不必等
  assert.equal(waits.length, 1);
  assert.deepEqual(sizes, [12, 8, 5, 1]);
});

test("M3：RPC 隔輪失敗 12 輪 → 0 則通知；連續失敗才告警一次，恢復時解除", async () => {
  const w = fakeWorld();
  const kv = fakeKv();
  const env = { ...env0, MONITOR_STATE: kv, DISCORD_WEBHOOK_URL: DISCORD("x") };
  const cfg = only("owner-transferred", "oracle-stale");
  let now = 2_000_000;
  let down = false;
  w.rpcHttp = () => (down ? { status: 429, body: "rate limited" } : null);
  const sent = () => w.sent.filter((s) => s.url.startsWith("https://discord.com/")).map((s) => JSON.parse(s.init.body).content.split("\n")[0]);
  for (let i = 0; i < 12; i++) {
    down = i % 2 === 1;
    stubOracle(w, { now });
    await tick({ config: cfg, env, now, fetchImpl: w.fetch, log: () => {}, sleep: noSleep }).catch(() => {});
    now += 300;
    w.head += 150;
  }
  // 第一輪的「監控狀態重置」（M5）不算；這裡只看抖動造成的通知。
  assert.deepEqual(sent().filter((l) => !/狀態重置/.test(l)), [], "隔輪失敗不該有任何觸發／恢復通知");

  down = true;
  for (let i = 0; i < 3; i++) {
    await tick({ config: cfg, env, now, fetchImpl: w.fetch, log: () => {}, sleep: noSleep }).catch(() => {});
    now += 300;
  }
  assert.equal(sent().filter((l) => /監控本身有規則讀取失敗/.test(l)).length, 1, "連續失敗只告警一次（之後靠 REMIND_SEC 提醒）");
  down = false;
  stubOracle(w, { now });
  await tick({ config: cfg, env, now, fetchImpl: w.fetch, log: () => {}, sleep: noSleep });
  assert.ok(sent().some((l) => /恢復｜監控本身有規則讀取失敗/.test(l)));
});

test("M3：x402 payTo 單次逾時不告警、不算錯誤、也不把開啟中的告警當成恢復；連續失敗才算監控錯誤", async () => {
  const w = fakeWorld();
  const cfg = only("x402-payto");
  const A = "0x00000000000000000000000000000000000000a1";
  let mode = "unsafe";
  w.http.set(`${API}/`, () => {
    if (mode === "timeout") throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    if (mode === "500") return { status: 500, body: "oops" };
    return { status: 200, body: { payTo: A, payToSafety: { safe: mode !== "unsafe" } } };
  });
  const state = {};
  const logs = [];
  const run = (now) => runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now, log: (l) => logs.push(l) });
  assert.deepEqual((await run(1)).notes.filter((n) => !n.key.includes(":baseline:")).map((n) => [n.key, n.status]), [["x402-payto:unsafe", "觸發"]]);

  mode = "timeout";
  const r2 = await run(301);
  assert.deepEqual(r2.errors, [], "單次逾時不算監控錯誤");
  assert.equal(r2.notes.length, 0);
  assert.ok(state.open["x402-payto:unsafe"], "讀不到不等於恢復");
  assert.ok(logs.some((l) => /SOFT x402-payto: GET \/ 逾時（連續 1 次）/.test(l)));

  mode = "500";
  const r3 = await run(601);
  assert.match(r3.errors[0], /x402-payto: GET \/ 回 HTTP 500（連續 2 次）/);

  mode = "ok";
  const r4 = await run(901);
  assert.deepEqual(r4.errors, []);
  assert.equal(state.httpFails["x402-payto"], 0);
  assert.ok(r4.notes.some((n) => n.key === "x402-payto:unsafe" && n.status === "恢復"));
});

// ── 追趕與範圍上限（審查 H1）────────────────────────────────────────────────

const ownerLog = (w, block, n) =>
  makeLog(w, {
    address: addrOf("owner-transferred", "PerpetualExchange"),
    sig: "OwnershipTransferred(address,address)",
    topics: [word(0), word(n)],
    block,
    tx: "0x" + n.toString(16).padStart(64, "0"),
  });

test("H1：節點限 1000 塊、積欠 5000 塊 → 一輪內分段追上，每筆 log 恰好一次", async () => {
  const w = fakeWorld();
  w.head = 2_000_003;
  w.rangeLimit = 1000;
  const cfg = only("owner-transferred");
  const latest = w.head - 3;
  const state = { checkpoint: latest - 5000 };
  // 每一段各放一筆，再加上段落邊界的兩筆（邊界最容易漏或重複）。
  const blocks = [latest - 4999, latest - 4000, latest - 3999, latest - 2500, latest - 1500, latest - 1, latest];
  blocks.forEach((b, i) => ownerLog(w, b, i + 1));
  const r1 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 100 });
  assert.equal(r1.errors.length, 0, r1.errors.join());
  assert.equal(FULL.params.MAX_BLOCK_RANGE.default, "1000", "預設值不可超過公開 RPC 的上限");
  assert.deepEqual(w.spans, [1000, 1000, 1000, 1000, 1000]);
  assert.equal(state.checkpoint, latest, "一輪追上");
  assert.equal(r1.notes.filter((n) => n.status === "事件").length, blocks.length);
  assert.equal(new Set(r1.notes.map((n) => n.key)).size, blocks.length, "不重複");
  assert.ok(!r1.notes.some((n) => n.ruleId === "monitor-self"), "追上了就不該有落後告警");
  const r2 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 400 });
  assert.equal(r2.notes.length, 0, "下一輪不重送");
});

test("H1：MAX_BLOCK_RANGE 設得比節點上限大 → 413／-32614 後自動減半重試，不卡死", async () => {
  const w = fakeWorld();
  w.head = 2_000_003;
  w.rangeLimit = 1000;
  const cfg = only("owner-transferred");
  const latest = w.head - 3;
  const state = { checkpoint: latest - 5000 };
  ownerLog(w, latest - 4500, 1);
  ownerLog(w, latest - 10, 2);
  const r = await runOnce({ config: cfg, env: { ...env0, MAX_BLOCK_RANGE: "2000" }, state, fetchImpl: w.fetch, now: 100 });
  assert.equal(r.errors.length, 0, r.errors.join());
  assert.deepEqual(w.spans, [2000, 1000, 1000, 1000, 1000, 1000]);
  assert.equal(state.checkpoint, latest);
  assert.equal(r.notes.filter((n) => n.status === "事件").length, 2);
});

test("H1：積欠超過一輪額度 → 檢查點每輪前進、發落後告警、幾輪後追上並恢復", async () => {
  const w = fakeWorld();
  w.head = 3_000_003;
  w.rangeLimit = 1000;
  const cfg = only("owner-transferred");
  const state = { checkpoint: w.head - 3 - 25_000 };
  ownerLog(w, w.head - 3 - 100, 7); // 最新的一筆：要到追上那一輪才看得到
  const r1 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 0 });
  assert.equal(r1.errors.length, 0, r1.errors.join());
  assert.equal(w.spans.length, 10, "每輪最多 MAX_SCAN_REQUESTS 個 eth_getLogs");
  assert.equal(state.checkpoint, w.head - 3 - 15_000);
  assert.ok(r1.notes.some((n) => n.key === "monitor-self:lag" && n.status === "觸發"));
  await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 300 });
  const r3 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 600 });
  assert.equal(state.checkpoint, w.head - 3);
  assert.ok(r3.notes.some((n) => n.status === "事件"));
  assert.ok(r3.notes.some((n) => n.key === "monitor-self:lag" && n.status === "恢復"));
});

test("H1：中途某段失敗 → 已成功的段落保留、檢查點停在最後成功處、錯誤訊息帶 RPC 回應內文", async () => {
  const w = fakeWorld();
  w.head = 2_000_003;
  w.rangeLimit = 1000;
  const cfg = only("owner-transferred");
  const latest = w.head - 3;
  const state = { checkpoint: latest - 3000 };
  ownerLog(w, latest - 2500, 1);
  ownerLog(w, latest - 500, 2);
  w.getLogsHttp = (from) => (from > latest - 2000 ? { status: 500, body: '{"error":"upstream exploded"}' } : null);
  const r1 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 0 });
  assert.equal(r1.notes.filter((n) => n.status === "事件").length, 1, "第一段的事件不可因後面失敗而丟掉");
  assert.equal(state.checkpoint, latest - 2000);
  assert.equal(r1.errors.length, 1);
  assert.match(r1.errors[0], /event-scan: RPC HTTP 500：{"error":"upstream exploded"}/);
  // 413 的內文同樣帶回來（值班的人要看得出是「範圍」而不是節點故障）。
  w.getLogsHttp = null;
  w.rangeLimit = 0.5; // 連 1 塊都拒絕：減半到底仍失敗
  const r2 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 300 });
  assert.equal(state.checkpoint, latest - 2000, "沒有任何一段成功時檢查點不動");
  assert.match(r2.errors[0], /HTTP 413：.*eth_getLogs is limited to a/);
  w.rangeLimit = 1000;
  const r3 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 600 });
  assert.equal(r3.errors.length, 0);
  assert.equal(r3.notes.filter((n) => n.status === "事件").length, 1, "失敗期間的那一筆在恢復後補到，且只有一次");
  assert.equal(state.checkpoint, latest);
});

test("大額提領：低於門檻不告警、達門檻告警、一小時內累計達門檻另開告警", async () => {
  const w = fakeWorld();
  const cfg = only("large-margin-withdrawal");
  const ex = addrOf("large-margin-withdrawal", "PerpetualExchange");
  const user = topicAddr("0x00000000000000000000000000000000000000ee");
  makeLog(w, { address: ex, sig: "MarginWithdrawn(address,uint256)", topics: [user], data: word(9_000n * E18), block: 990, logIndex: 0 });
  makeLog(w, { address: ex, sig: "MarginWithdrawn(address,uint256)", topics: [user], data: word(20_000n * E18), block: 991, logIndex: 1 });
  const state = { checkpoint: 980 };
  const { notes } = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 10_000 });
  const ev = notes.filter((n) => n.status === "事件");
  assert.equal(ev.length, 1);
  assert.ok(ev[0].lines.some((l) => l.includes("金額：20,000")));

  // 拆單：再 3 筆 9000，累計 9000+20000+27000 = 56000 ≥ 50000
  for (let i = 0; i < 3; i++) {
    makeLog(w, { address: ex, sig: "MarginWithdrawn(address,uint256)", topics: [user], data: word(9_000n * E18), block: 998, logIndex: i });
  }
  w.head = 1010;
  const r2 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 10_600 });
  assert.ok(r2.notes.some((n) => n.key === "large-margin-withdrawal:window" && n.status === "觸發"), JSON.stringify(r2.notes));
  // 門檻可由 Worker 變數覆寫
  const r3 = await runOnce({ config: cfg, env: { ...env0, LARGE_WITHDRAWAL_WINDOW_USDC: "1000000" }, state, fetchImpl: w.fetch, now: 10_900 });
  assert.ok(r3.notes.some((n) => n.key === "large-margin-withdrawal:window" && n.status === "恢復"));
  // 視窗過期後清空
  await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 10_600 + 3600 });
  assert.equal(state.windows["large-margin-withdrawal"].length, 0);
});

// ── state 規則 ───────────────────────────────────────────────────────────────

function stubOracle(w, { now, ages = {}, prices = {}, maxAge = 21600 }) {
  const r = ruleOf("oracle-stale");
  const oracle = addrOf("oracle-stale", "oracle");
  w.setCall(addrOf("oracle-stale", "exchange"), "maxPriceAge()", [], word(maxAge));
  for (const s of r.assets) {
    w.setCall(oracle, "getPrice(bytes32)", [FULL.assets[s]], word(prices[s] ?? 100n * 10n ** 8n, now - (ages[s] ?? 60)));
  }
}

test("價格過期：加密資產預警／過期分級、非加密放寬、持續提醒、恢復；RPC 失敗不算恢復", async () => {
  const w = fakeWorld();
  const cfg = only("oracle-stale");
  const state = {};
  let now = 2_000_000;
  stubOracle(w, { now, ages: { sBTC: 5 * 3600, sETH: 7 * 3600, sAAPL: 48 * 3600 } });
  const r1 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now });
  const by = Object.fromEntries(r1.notes.map((n) => [n.key, n]));
  assert.equal(by["oracle-stale:sBTC"].severity, "SEV-3");
  assert.equal(by["oracle-stale:sETH"].severity, "SEV-2");
  assert.equal(by["oracle-stale:sAAPL"], undefined, "股票 48 小時（週末）不告警");

  // 5 分鐘後仍過期：不重複送
  now += 300;
  stubOracle(w, { now, ages: { sBTC: 5 * 3600 + 300, sETH: 7 * 3600 + 300 } });
  assert.equal((await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now })).notes.length, 0);

  // sBTC 升級為 SEV-2：立刻提醒
  now += 300;
  stubOracle(w, { now, ages: { sBTC: 6.5 * 3600, sETH: 7 * 3600 + 600 } });
  const r3 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now });
  assert.deepEqual(r3.notes.map((n) => [n.key, n.status, n.severity]), [["oracle-stale:sBTC", "持續", "SEV-2"]]);

  // RPC 全部失敗：不能當成恢復
  now += 300;
  w.calls.clear();
  const r4 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now });
  assert.ok(r4.notes.every((n) => n.status !== "恢復" || n.ruleId === "monitor-self"));
  assert.ok(state.open["oracle-stale:sETH"]);

  // 價格恢復新鮮
  now += 300;
  stubOracle(w, { now });
  const r5 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now });
  const recovered = r5.notes.filter((n) => n.status === "恢復").map((n) => n.key).sort();
  assert.deepEqual(recovered, ["oracle-stale:sBTC", "oracle-stale:sETH"], "RPC 只失敗一輪：沒開過 monitor-self，也就沒有它的恢復");
});

test("超過 REMIND_SEC 仍未解除 → 持續提醒", () => {
  const state = {};
  const f = { ruleId: "x", key: "x:1", severity: "SEV-3", title: "t", lines: [] };
  const ev = new Set(["x"]);
  assert.equal(reconcile({ config: FULL, env: {}, state, findings: [f], evaluated: ev, now: 0 })[0].status, "觸發");
  assert.equal(reconcile({ config: FULL, env: {}, state, findings: [f], evaluated: ev, now: 21_599 }).length, 0);
  assert.equal(reconcile({ config: FULL, env: {}, state, findings: [f], evaluated: ev, now: 21_600 })[0].status, "持續");
});

test("價格偏離：參考來源不支援的資產略過；3% 以上 SEV-2、10% 以上 SEV-1", async () => {
  const w = fakeWorld();
  const cfg = only("oracle-deviation");
  const now = 3_000_000;
  const primary = addrOf("oracle-deviation", "primary");
  const ref = addrOf("oracle-deviation", "reference");
  const p8 = (n) => BigInt(Math.round(n * 1e8));
  const set = (sym, pp, rp, refAge = 60) => {
    w.setCall(primary, "getPrice(bytes32)", [FULL.assets[sym]], word(p8(pp), now - 60));
    if (rp !== null) w.setCall(ref, "getPrice(bytes32)", [FULL.assets[sym]], word(p8(rp), now - refAge));
  };
  set("sBTC", 50_000, 50_100); // 0.2%
  set("sETH", 3_000, 2_880); // 4.2%
  set("sAAPL", 200, 250); // 20%
  set("sTSLA", 250, null); // 參考 revert
  set("sGOLD", 2_650, 2_000, 99_999); // 參考過期
  const { notes, errors } = await runOnce({ config: cfg, env: env0, state: {}, fetchImpl: w.fetch, now });
  assert.equal(errors.length, 0, errors.join());
  assert.deepEqual(notes.map((n) => [n.key, n.severity]).sort(), [["oracle-deviation:sAAPL", "SEV-1"], ["oracle-deviation:sETH", "SEV-2"]]);
});

test("M1：參考來源全部讀不到或過期 → SEV-3「沒有可用的參考價」（不空轉）；有一檔可比就解除", async () => {
  const w = fakeWorld();
  const cfg = only("oracle-deviation");
  let now = 3_000_000;
  const primary = addrOf("oracle-deviation", "primary");
  const ref = addrOf("oracle-deviation", "reference");
  const assets = ruleOf("oracle-deviation").assets;
  // 現況：主 oracle 全部有價，AggregatorOracle 對每一檔 revert（NoLiveSource）；其中一檔改成「有價但過期」。
  for (const s of assets) w.setCall(primary, "getPrice(bytes32)", [FULL.assets[s]], word(100n * 10n ** 8n, now - 60));
  w.setCall(ref, "getPrice(bytes32)", [FULL.assets.sGOLD], word(100n * 10n ** 8n, now - 99_999));
  const state = {};
  const r1 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now });
  assert.equal(r1.errors.length, 0, r1.errors.join());
  assert.deepEqual(r1.notes.map((n) => [n.key, n.severity, n.status]), [["oracle-deviation:no-reference", "SEV-3", "觸發"]]);
  assert.match(r1.notes[0].lines[0], /參考來源讀不到 4 檔、參考價過期 1 檔/);
  // 參考來源恢復一檔（且沒有偏離）→ 恢復。
  now += 300;
  w.setCall(ref, "getPrice(bytes32)", [FULL.assets.sBTC], word(100n * 10n ** 8n, now - 60));
  const r2 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now });
  assert.deepEqual(r2.notes.map((n) => [n.key, n.status]), [["oracle-deviation:no-reference", "恢復"]]);
});

test("金庫儲備率、mint 停止、保險金下降、keeper gas", async () => {
  const w = fakeWorld();
  const cfg = only("vault-reserve", "insurance-fund", "keeper-gas");
  const vault = addrOf("vault-reserve", "vault");
  const ins = addrOf("insurance-fund", "vault");
  const oracle = addrOf("keeper-gas", "oracle");
  const keeper = "0x00000000000000000000000000000000000000f1";
  // 儲備 90、負債 100 → 90%；下限 100% → 低於下限；mint 已停止
  w.setCall(vault, "reserveStatus()", [], word(90n * E18, 100n * E18, 9000, 0, 0, 1));
  w.setCall(vault, "minReserveRatioBps()", [], word(10000));
  w.setCall(vault, "paused()", [], word(0));
  w.setCall(ins, "totalAssets()", [], word(10_000n * E18));
  w.setCall(oracle, "owner()", [], word(BigInt(keeper)));
  w.balances.set(keeper, 3n * 10n ** 15n); // 0.003 ETH < 0.005
  const state = {};
  const r1 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 7200 });
  assert.equal(r1.errors.length, 0, r1.errors.join());
  const keys = Object.fromEntries(r1.notes.map((n) => [n.key, n.severity]));
  assert.equal(keys["vault-reserve:below-min"], "SEV-2");
  assert.equal(keys["vault-reserve:halted"], "SEV-2");
  assert.equal(keys[`keeper-gas:${keeper}`], "SEV-2");
  assert.equal(keys["insurance-fund:min"], undefined);

  // 一小時後保險金掉到 7000（-30%）→ 下降告警
  w.setCall(ins, "totalAssets()", [], word(7_000n * E18));
  const r2 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 7200 + 3600 });
  assert.ok(r2.notes.some((n) => n.key === "insurance-fund:drop" && n.severity === "SEV-2"), JSON.stringify(r2.notes));
  // 額外錢包：格式錯誤要報錯，不能默默略過
  const r3 = await runOnce({ config: cfg, env: { ...env0, EXTRA_GAS_WALLETS: "0x123" }, state, fetchImpl: w.fetch, now: 7200 + 3700 });
  assert.ok(r3.errors.some((e) => /EXTRA_GAS_WALLETS/.test(e)));
});

// ── 接線（審查 H2：部署版 setter 不發事件，只能輪詢 getter）──────────────────

function stubWiring(w, id, overrides = {}) {
  const r = ruleOf(id);
  for (const c of r.calls) {
    const k = r.contracts.find((x) => x.as === c.on);
    const key = `${k.ref}.${c.fn}`;
    const v = key in overrides ? overrides[key] : c.expected;
    w.setCall(k.address, c.fn, [], v === null ? { revert: true } : word(BigInt(v)));
  }
}

test("H2：接線狀態規則——與預期一致不告警；InsuranceVault.exchange() 被改 → SEV-1；改回後恢復", async () => {
  const w = fakeWorld();
  const cfg = only("insurance-wiring", "feerouter-wiring", "core-wiring");
  for (const id of ["insurance-wiring", "feerouter-wiring", "core-wiring"]) stubWiring(w, id);
  const state = {};
  const r1 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 1 });
  assert.equal(r1.errors.length, 0, r1.errors.join());
  assert.equal(r1.notes.length, 0, JSON.stringify(r1.notes));

  const evil = "0x00000000000000000000000000000000000000ee";
  stubWiring(w, "insurance-wiring", { "InsuranceVault.exchange()": evil });
  // x402 那顆的 exchange 預期是零位址：被設成任何非零值都要響。
  stubWiring(w, "feerouter-wiring", { "X402FeeRouter.exchange()": evil });
  const r2 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 301 });
  const by = Object.fromEntries(r2.notes.map((n) => [n.key, n]));
  assert.equal(by["insurance-wiring:InsuranceVault.exchange()"].severity, "SEV-1");
  assert.equal(by["insurance-wiring:InsuranceVault.exchange()"].status, "觸發");
  assert.ok(by["insurance-wiring:InsuranceVault.exchange()"].lines[0].includes(evil));
  assert.ok(by["insurance-wiring:InsuranceVault.exchange()"].lines[0].includes(addrOf("owner-transferred", "PerpetualExchange")));
  assert.equal(by["feerouter-wiring:X402FeeRouter.exchange()"].severity, "SEV-1");
  assert.equal(r2.notes.length, 2);

  stubWiring(w, "insurance-wiring");
  stubWiring(w, "feerouter-wiring");
  const r3 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 601 });
  assert.deepEqual(r3.notes.map((n) => n.status), ["恢復", "恢復"]);
});

test("H2：接線 getter 讀取失敗 → 算監控自身錯誤；其他已讀到的不一致照樣告警、不發恢復", async () => {
  const w = fakeWorld();
  const cfg = only("feerouter-wiring");
  const evil = "0x00000000000000000000000000000000000000ee";
  stubWiring(w, "feerouter-wiring", { "FeeRouter.copyTracker()": evil });
  const state = {};
  await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 1 });
  assert.ok(state.open["feerouter-wiring:FeeRouter.copyTracker()"]);
  // 下一輪：copyTracker 仍然不對，另一個 getter 讀不到。
  stubWiring(w, "feerouter-wiring", { "FeeRouter.copyTracker()": evil, "FeeRouter.exchange()": null });
  const r = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 301 });
  assert.match(r.errors[0], /feerouter-wiring: 接線讀取失敗：FeeRouter\.exchange\(\)/);
  assert.ok(state.open["feerouter-wiring:FeeRouter.copyTracker()"], "讀取失敗不可被當成恢復");
  assert.ok(!r.notes.some((n) => n.status === "恢復"));
});

test("H2：部署版不發的事件不在 active 規則裡；現行設定的 active 事件規則都不含全數未部署的事件", () => {
  for (const id of ["insurance-wiring-changed", "feerouter-config-changed", "kyc-verifier-changed"]) {
    assert.equal(ruleOf(id).status, "pending-deploy", id);
    assert.ok(ruleOf(id).contracts.every((c) => c.address === null));
  }
  for (const id of ["insurance-wiring", "feerouter-wiring"]) {
    assert.equal(ruleOf(id).status, "active");
    assert.equal(ruleOf(id).severity, "SEV-1");
    assert.ok(ruleOf(id).calls.every((c) => /^0x[0-9a-fA-F]{40}$/.test(c.expected)), id);
  }
});

// ── http 規則 ────────────────────────────────────────────────────────────────

test("signal-api 健康檢查：連續兩次失敗才告警；payTo 變更 SEV-1、守門不安全 SEV-3", async () => {
  const w = fakeWorld();
  const cfg = only("signal-api-health", "x402-payto");
  const A = "0x00000000000000000000000000000000000000a1";
  const B = "0x00000000000000000000000000000000000000b2";
  let health = { status: 200, body: "ok" };
  let root = { status: 200, body: { payTo: A, payToSafety: { safe: true } } };
  w.http.set(`${API}/healthz`, () => health);
  w.http.set(`${API}/`, () => root);
  const state = {};
  const first = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 1 });
  assert.deepEqual(first.notes.map((n) => [n.key, n.severity, n.status]), [[`x402-payto:baseline:${A}`, "SEV-3", "事件"]], "首次觀察當基準時要講出來");
  assert.equal(state.baselines["x402-payto"], A);

  health = { status: 503, body: "down" };
  assert.equal((await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 2 })).notes.length, 0, "單次失敗不告警");
  const r = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 3 });
  assert.deepEqual(r.notes.map((n) => [n.key, n.severity]), [["signal-api-health", "SEV-3"]]);

  root = { status: 200, body: { payTo: B, payToSafety: { safe: false, reason: "known-leaked" } } };
  const r2 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 4 });
  const k = Object.fromEntries(r2.notes.map((n) => [n.key, n.severity]));
  assert.equal(k["x402-payto:changed"], "SEV-1");
  assert.equal(k["x402-payto:unsafe"], "SEV-3");
  // 明確設定 EXPECTED_PAY_TO 時以它為準
  const r3 = await runOnce({ config: cfg, env: { ...env0, EXPECTED_PAY_TO: B }, state, fetchImpl: w.fetch, now: 5 });
  assert.ok(r3.notes.some((n) => n.key === "x402-payto:changed" && n.status === "恢復"));
});

// ── 通知與 tick ──────────────────────────────────────────────────────────────

// 假憑證以拼接產生：原文不符合秘密掃描的樣式（check-monitoring.mjs 也掃本目錄的測試檔）。
const TG = ["123456789", "AAH-fakeTokenForTestsOnly_abcdefghijklmn"].join(":");
const DISCORD = (tail) => ["https://discord.com/api/webhooks", "1", tail].join("/");

test("沒有任何通道 → 丟錯；通道設定格式錯誤 → 丟錯", async () => {
  await assert.rejects(tick({ config: only(), env: { MONITOR_STATE: fakeKv() }, fetchImpl: fakeWorld().fetch, log: () => {} }), /沒有設定任何告警通道/);
  assert.throws(() => channelsOf({ TELEGRAM_BOT_TOKEN: TG }), /必須同時設定/);
  assert.throws(() => channelsOf({ DISCORD_WEBHOOK_URL: "https://evil.example/hook" }), /discord\.com/);
  assert.throws(() => channelsOf({ ALERT_WEBHOOK_URL: "http://plain" }), /https/);
});

test("tick：三種通道的格式、HMAC 簽章、log 不含憑證、心跳", async () => {
  const w = fakeWorld();
  const kv = fakeKv();
  const logs = [];
  makeLog(w, { address: addrOf("owner-transferred", "PerpetualExchange"), sig: "OwnershipTransferred(address,address)", topics: [word(0), word(1)] });
  const env = {
    ...env0,
    MONITOR_STATE: kv,
    TELEGRAM_BOT_TOKEN: TG,
    TELEGRAM_CHAT_ID: "-100123",
    DISCORD_WEBHOOK_URL: DISCORD("secretpart"),
    ALERT_WEBHOOK_URL: "https://hooks.example/alert",
    ALERT_WEBHOOK_SECRET: "s3cret",
    HEARTBEAT_URL: "https://hc.example/ping/abc",
  };
  await tick({ config: only("owner-transferred"), env, now: 50, fetchImpl: w.fetch, log: (l) => logs.push(l) });
  const tg = w.sent.find((s) => s.url.startsWith("https://api.telegram.org/"));
  const dc = w.sent.find((s) => s.url.startsWith("https://discord.com/"));
  const hk = w.sent.find((s) => s.url === "https://hooks.example/alert");
  assert.ok(tg && dc && hk, w.sent.map((s) => s.url).join());
  const tgBody = JSON.parse(tg.init.body);
  assert.equal(tgBody.chat_id, "-100123");
  assert.equal(tgBody.parse_mode, undefined, "純文字送出，不讓鏈上資料被解讀成格式");
  assert.match(tgBody.text, /^🔴\[SEV-1\] 事件｜合約 owner 變更/);
  assert.match(tgBody.text, /處置：https:\/\/github\.com\/.*INCIDENT_RESPONSE\.md#1-嚴重度分級/);
  assert.deepEqual(JSON.parse(dc.init.body).allowed_mentions, { parse: [] });
  const sig = hk.init.headers["X-Pepelab-Signature"];
  const { createHmac } = await import("node:crypto");
  assert.equal(sig, `sha256=${createHmac("sha256", "s3cret").update(hk.init.body).digest("hex")}`);
  assert.ok(w.sent.some((s) => s.url === "https://hc.example/ping/abc"), "整輪乾淨時打心跳");
  const all = logs.join("\n");
  for (const secret of [TG, "secretpart", "s3cret", "hc.example"]) assert.ok(!all.includes(secret), `log 洩漏 ${secret}`);
  assert.ok(JSON.parse(kv.m.get(STATE_KEY)).checkpoint > 0);
});

test("tick：通道全掛 → 留在 outbox、丟錯、不打心跳；下一輪重送成功", async () => {
  const w = fakeWorld();
  const kv = fakeKv();
  makeLog(w, { address: addrOf("owner-transferred", "PerpetualExchange"), sig: "OwnershipTransferred(address,address)", topics: [word(0), word(1)] });
  const env = { ...env0, MONITOR_STATE: kv, DISCORD_WEBHOOK_URL: DISCORD("x"), HEARTBEAT_URL: "https://hc.example/p" };
  w.channelStatus = 500;
  await assert.rejects(tick({ config: only("owner-transferred"), env, now: 1, fetchImpl: w.fetch, log: () => {} }), /2 則告警未送達/);
  assert.equal(JSON.parse(kv.m.get(STATE_KEY)).outbox.length, 2, "owner 事件＋首輪的「監控狀態重置」");
  assert.ok(!w.sent.some((s) => s.url === "https://hc.example/p"));

  w.channelStatus = 200;
  w.sent.length = 0;
  await tick({ config: only("owner-transferred"), env, now: 400, fetchImpl: w.fetch, log: () => {} });
  assert.equal(w.sent.filter((s) => s.url.startsWith("https://discord.com/")).length, 2, "outbox 的兩則各重送一次");
  assert.equal(JSON.parse(kv.m.get(STATE_KEY)).outbox.length, 0);
});

test("MIN_SEVERITY：低於門檻不送；恢復依原嚴重度判斷", () => {
  assert.equal(shouldSend({ severity: "SEV-3", status: "觸發" }, "SEV-2"), false);
  assert.equal(shouldSend({ severity: "SEV-1", status: "事件" }, "SEV-2"), true);
  assert.equal(shouldSend({ severity: "SEV-4", origSeverity: "SEV-2", status: "恢復" }, "SEV-2"), true);
  assert.equal(shouldSend({ severity: "SEV-4", origSeverity: "SEV-3", status: "恢復" }, "SEV-2"), false);
  assert.throws(() => shouldSend({ severity: "SEV-1", status: "事件" }, "SEV-9"), /MIN_SEVERITY/);
});

test("M2：monitor-self 永遠送（不受 MIN_SEVERITY／MUTE_KEYS 影響）；MUTE_KEYS 只靜音指定 key", async () => {
  const self = { ruleId: "monitor-self", key: "monitor-self:errors", severity: "SEV-3", status: "觸發" };
  assert.equal(shouldSend(self, "SEV-1"), true);
  assert.equal(shouldSend(self, "SEV-1", ["monitor-self", "monitor-self:errors"]), true);
  assert.equal(shouldSend({ ...self, severity: "SEV-4", origSeverity: "SEV-3", status: "恢復" }, "SEV-1"), true);
  assert.deepEqual(parseMuteKeys(" x402-payto:unsafe , monitor-self:errors,monitor-self, bad key ,fee-withdrawals"), {
    keys: ["x402-payto:unsafe", "fee-withdrawals"],
    ignored: ["monitor-self:errors", "monitor-self", "bad key"],
  });
  const unsafe = { ruleId: "x402-payto", key: "x402-payto:unsafe", severity: "SEV-3", status: "觸發" };
  assert.equal(shouldSend(unsafe, "SEV-4", ["x402-payto:unsafe"]), false);
  assert.equal(shouldSend({ ...unsafe, key: "x402-payto:changed", severity: "SEV-1" }, "SEV-4", ["x402-payto:unsafe"]), true, "同規則的其他 key 不受影響");
  assert.equal(shouldSend({ ruleId: "fee-withdrawals", key: "fee-withdrawals:0xabc:1", severity: "SEV-3", status: "事件" }, "SEV-4", ["fee-withdrawals"]), false, "規則 id 當前綴 → 整條靜音");
  assert.equal(shouldSend({ ruleId: "fee-withdrawals-x", key: "fee-withdrawals-x:1", severity: "SEV-3", status: "事件" }, "SEV-4", ["fee-withdrawals"]), true, "前綴以冒號為界，不誤傷名字相近的規則");

  // 整輪：MIN_SEVERITY=SEV-1、又（錯誤地）把 monitor-self 列進 MUTE_KEYS，RPC 全掛 → 仍然收到監控自身告警。
  const w = fakeWorld();
  const kv = fakeKv();
  w.http.set(`${API}/`, () => ({ status: 200, body: { payTo: "0x00000000000000000000000000000000000000a1", payToSafety: { safe: false, reason: "known-leaked" } } }));
  const env = { ...env0, RPC_URL: "https://rpc.down", MONITOR_STATE: kv, DISCORD_WEBHOOK_URL: DISCORD("x"), MIN_SEVERITY: "SEV-1", MUTE_KEYS: "x402-payto:unsafe,monitor-self" };
  w.http.set("https://rpc.down", () => ({ status: 503, body: "down" }));
  const logs = [];
  for (let i = 0; i < 4; i++) {
    await assert.rejects(tick({ config: only("owner-transferred", "x402-payto"), env, now: 100 + 300 * i, fetchImpl: w.fetch, log: (l) => logs.push(l), sleep: async () => {} }), /規則讀取失敗/);
  }
  const sent = w.sent.filter((s) => s.url.startsWith("https://discord.com/")).map((s) => JSON.parse(s.init.body).content.split("\n")[0]);
  assert.equal(sent.length, 1, sent.join(" | "));
  assert.match(sent[0], /SEV-3\] 觸發｜監控本身有規則讀取失敗/);
  assert.ok(logs.some((l) => /MUTE_KEYS 忽略 1 個項目/.test(l)));
});

test("M5：KV 沒有檢查點 → SEV-3「監控狀態重置，X 之前的事件未掃描」；不受 MIN_SEVERITY 影響；只發一次", async () => {
  const w = fakeWorld();
  const kv = fakeKv();
  const env = { ...env0, MONITOR_STATE: kv, DISCORD_WEBHOOK_URL: DISCORD("x"), MIN_SEVERITY: "SEV-1" };
  const sent = () => w.sent.filter((s) => s.url.startsWith("https://discord.com/")).map((s) => JSON.parse(s.init.body).content);
  const cfg = only("owner-transferred");
  await tick({ config: cfg, env, now: 100, fetchImpl: w.fetch, log: () => {} });
  const from = w.head - 3 - 300 + 1;
  assert.equal(sent().length, 1);
  assert.match(sent()[0], /SEV-3\] 事件｜監控狀態重置/);
  assert.ok(sent()[0].includes(`事件掃描從區塊 ${from} 重新開始，區塊 ${from} 之前的事件未掃描`), sent()[0]);
  w.head += 150;
  await tick({ config: cfg, env, now: 400, fetchImpl: w.fetch, log: () => {} });
  assert.equal(sent().length, 1, "有檢查點之後不再發");

  // 狀態遺失（state:v1 被刪）：這段期間的事件掃不到，必須再講一次。
  w.head += 5000;
  ownerLog(w, w.head - 2000, 9); // 落在遺失期間、重置後的回看範圍之外
  await kv.delete(STATE_KEY);
  await tick({ config: cfg, env, now: 700, fetchImpl: w.fetch, log: () => {} });
  assert.equal(sent().length, 2);
  assert.match(sent()[1], /監控狀態重置/);
  assert.ok(!sent().some((t) => /合約 owner 變更/.test(t)), "那筆事件確實沒被掃到——所以才需要這則通知");

  // 第一輪 RPC 就失敗：檢查點沒建立，不發「重置」；建立的那一輪才發。
  const w2 = fakeWorld();
  const kv2 = fakeKv();
  w2.rpcHttp = () => ({ status: 503, body: "down" });
  const env2 = { ...env, MONITOR_STATE: kv2 };
  await assert.rejects(tick({ config: cfg, env: env2, now: 100, fetchImpl: w2.fetch, log: () => {}, sleep: noSleep }));
  assert.equal(w2.sent.length, 0);
  w2.rpcHttp = null;
  await tick({ config: cfg, env: env2, now: 400, fetchImpl: w2.fetch, log: () => {}, sleep: noSleep });
  assert.match(JSON.parse(w2.sent[0].init.body).content, /監控狀態重置/);
});

test("M5：基準放在獨立的 KV 鍵——只刪 baselines:v1 會重設基準，檢查點與開啟中的告警不受影響", async () => {
  const w = fakeWorld();
  const kv = fakeKv();
  const A = "0x00000000000000000000000000000000000000a1";
  const B = "0x00000000000000000000000000000000000000b2";
  let payTo = A;
  w.http.set(`${API}/`, () => ({ status: 200, body: { payTo, payToSafety: { safe: true } } }));
  const env = { ...env0, MONITOR_STATE: kv, DISCORD_WEBHOOK_URL: DISCORD("x") };
  const cfg = only("owner-transferred", "x402-payto", "keeper-gas");
  const keeper = "0x00000000000000000000000000000000000000f1";
  w.setCall(addrOf("keeper-gas", "oracle"), "owner()", [], word(BigInt(keeper)));
  w.balances.set(keeper, 10n ** 15n); // gas 過低：一則開啟中的告警
  const heads = () => w.sent.filter((s) => s.url.startsWith("https://discord.com/")).map((s) => JSON.parse(s.init.body).content.split("\n")[0]);
  await tick({ config: cfg, env, now: 100, fetchImpl: w.fetch, log: () => {} });
  assert.deepEqual(JSON.parse(kv.m.get(BASELINES_KEY)), { "x402-payto": A });
  assert.equal(JSON.parse(kv.m.get(STATE_KEY)).baselines, undefined, "基準不存在 state:v1 裡");
  assert.ok(heads().some((h) => /基準已設定/.test(h)));

  payTo = B;
  w.head += 150;
  await tick({ config: cfg, env, now: 400, fetchImpl: w.fetch, log: () => {} });
  assert.ok(heads().some((h) => /SEV-1\] 觸發｜x402 收款地址：收款地址變更/.test(h)));
  const before = JSON.parse(kv.m.get(STATE_KEY));

  // 預期中的變更：只刪基準。
  await kv.delete(BASELINES_KEY);
  w.sent.length = 0;
  w.head += 150;
  await tick({ config: cfg, env, now: 700, fetchImpl: w.fetch, log: () => {} });
  const after = JSON.parse(kv.m.get(STATE_KEY));
  assert.deepEqual(JSON.parse(kv.m.get(BASELINES_KEY)), { "x402-payto": B });
  assert.equal(after.checkpoint, before.checkpoint + 150, "檢查點接著走，沒有重置");
  assert.ok(after.open[`keeper-gas:${keeper}`], "其他開啟中的告警還在");
  assert.ok(heads().some((h) => /恢復｜x402 收款地址：收款地址變更/.test(h)));
  assert.ok(heads().some((h) => /基準已設定/.test(h)));
  assert.ok(!heads().some((h) => /監控狀態重置/.test(h)));
});

test("pending-deploy 規則不會被載入（沒有位址、不出現在 getLogs 過濾條件）", async () => {
  const w = fakeWorld();
  let filter;
  const orig = w.fetch;
  w.fetch = async (url, init) => {
    if (url === RPC) {
      const b = JSON.parse(init.body);
      const g = (Array.isArray(b) ? b : [b]).find((r) => r.method === "eth_getLogs");
      if (g) filter = g.params[0];
    }
    return orig(url, init);
  };
  const cfg = { ...FULL, rules: FULL.rules.filter((r) => r.kind === "event") };
  await runOnce({ config: cfg, env: env0, state: {}, fetchImpl: w.fetch, now: 1 });
  const pendingTopics = FULL.rules.filter((r) => r.status !== "active").flatMap((r) => r.events.map((e) => e.topic0));
  const activeTopics = new Set(FULL.rules.filter((r) => r.status === "active" && r.kind === "event").flatMap((r) => r.events.map((e) => e.topic0)));
  for (const t of pendingTopics) if (!activeTopics.has(t)) assert.ok(!filter.topics[0].includes(t), t);
  assert.ok(filter.address.every((a) => /^0x[0-9a-fA-F]{40}$/.test(a)));
});
