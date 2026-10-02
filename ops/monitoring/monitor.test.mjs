// 監控引擎與通知的測試：用假的 JSON-RPC／HTTP（注入 fetch），不連任何網路。
//   node --test ops/monitoring/monitor.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, selector } from "./keccak.mjs";
import {
  IMPL_SLOT,
  configProblems,
  decodeLog,
  formatUnits,
  isRangeError,
  isTransient,
  makeRpc,
  minSeverityOf,
  reconcile,
  redactUrls,
  runOnce,
  toUnits,
} from "./engine.mjs";
import { channelsOf, escapeDiscord, formatNote, noteId, parseMuteKeys, sendToChannel, shouldSend } from "./notify.mjs";
import { BASELINES_KEY, CHANNEL_STUCK_ROUNDS, MAX_RESEND_PER_TICK, OUTBOX_TTL_SEC, STATE_KEY, tick } from "./tick.mjs";

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
    storage: new Map(), // `${address}|${slot}` → 32-byte hex（eth_getStorageAt）
    blockTimes: new Map(), // 區塊號 → timestamp（eth_getBlockByNumber 用；log 沒帶 blockTimestamp 時才會查）
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
    const data = selector(fnSig) + args.map((a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0")).join("");
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
      case "eth_getBlockByNumber": {
        const bn = Number(BigInt(req.params[0]));
        if (!w.blockTimes.has(bn)) throw new Error("block not found");
        return { number: req.params[0], timestamp: "0x" + w.blockTimes.get(bn).toString(16) };
      }
      case "eth_getStorageAt":
        return w.storage.get(`${req.params[0].toLowerCase()}|${req.params[1].toLowerCase()}`) ?? "0x" + "0".repeat(64);
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

function makeLog(w, { address, sig, topics = [], data = "0x", block = w.head - 5, tx = "0x" + "ab".repeat(32), logIndex = 0, ts }) {
  w.logs.push({
    ...(ts === undefined ? {} : { blockTimestamp: "0x" + ts.toString(16) }),
    address,
    topics: [keccak256(sig), ...topics],
    data,
    blockNumber: "0x" + block.toString(16),
    transactionHash: tx,
    logIndex: "0x" + logIndex.toString(16),
    removed: false,
  });
}

/** Discord 收到的內容（去掉 Markdown 跳脫，方便比對文字）。 */
const dcText = (sent) => JSON.parse(sent.init.body).content.replace(/\\([^0-9A-Za-z\s])/g, "$1");

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
  const sent = () => w.sent.filter((s) => s.url.startsWith("https://discord.com/")).map((s) => dcText(s).split("\n")[0]);
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

test("M6：相對門檻——單筆提領達合約提領前餘額的 20% 即告警（絕對門檻 10,000 比整個池子還大）", async () => {
  const w = fakeWorld();
  const cfg = only("large-margin-withdrawal");
  const r = ruleOf("large-margin-withdrawal");
  const ex = addrOf("large-margin-withdrawal", "PerpetualExchange");
  const user = topicAddr("0x00000000000000000000000000000000000000ee");
  assert.equal(r.amount.relativeBps, "LARGE_WITHDRAWAL_BPS");
  assert.equal(r.amount.balanceOf.token, addrOf("exchange-balance-drop", "token"), "餘額讀的是 MockUSDC");
  // 提領後交易所剩 500；本輪兩筆提領 10 與 150 → 提領前約 660。150/660 = 22.7% ≥ 20%；10/660 = 1.5%。
  w.setCall(r.amount.balanceOf.token, "balanceOf(address)", [ex], word(500n * E18));
  makeLog(w, { address: ex, sig: "MarginWithdrawn(address,uint256)", topics: [user], data: word(10n * E18), block: 990, logIndex: 0, ts: 9_000 });
  makeLog(w, { address: ex, sig: "MarginWithdrawn(address,uint256)", topics: [user], data: word(150n * E18), block: 991, logIndex: 1, ts: 9_002 });
  const r1 = await runOnce({ config: cfg, env: env0, state: { checkpoint: 980 }, fetchImpl: w.fetch, now: 10_000 });
  assert.equal(r1.errors.length, 0, r1.errors.join());
  const ev = r1.notes.filter((n) => n.status === "事件");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].severity, "SEV-2");
  assert.ok(ev[0].lines.some((l) => /金額：150（單筆門檻 10,000；佔合約提領前餘額約 22\.72%（相對門檻 20%））/.test(l)), ev[0].lines.join("\n"));

  // 門檻可覆寫：50% 時不告警。
  const r2 = await runOnce({ config: cfg, env: { ...env0, LARGE_WITHDRAWAL_BPS: "5000" }, state: { checkpoint: 980 }, fetchImpl: w.fetch, now: 10_000 });
  assert.equal(r2.notes.filter((n) => n.status === "事件").length, 0);

  // 餘額讀不到：不讓整個事件掃描失敗，退回只用絕對門檻，訊息註明。
  w.calls.clear();
  makeLog(w, { address: ex, sig: "MarginWithdrawn(address,uint256)", topics: [user], data: word(20_000n * E18), block: 992, logIndex: 2, ts: 9_004 });
  const r3 = await runOnce({ config: cfg, env: env0, state: { checkpoint: 980 }, fetchImpl: w.fetch, now: 10_000 });
  assert.equal(r3.errors.length, 0, r3.errors.join());
  const ev3 = r3.notes.filter((n) => n.status === "事件");
  assert.equal(ev3.length, 1);
  assert.ok(ev3[0].lines.some((l) => /金額：20,000（單筆門檻 10,000；相對門檻未評估（讀不到合約餘額））/.test(l)));
});

test("M6：交易所餘額較 24 小時高點下降 ≥ 30% → SEV-2；回升後恢復；讀取失敗不算恢復", async () => {
  const w = fakeWorld();
  const cfg = only("exchange-balance-drop");
  const token = addrOf("exchange-balance-drop", "token");
  const ex = addrOf("exchange-balance-drop", "holder");
  const set = (n) => w.setCall(token, "balanceOf(address)", [ex], word(BigInt(n) * E18));
  const state = {};
  set(1000);
  assert.equal((await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 7200 })).notes.length, 0);
  set(750); // -25%：未達
  assert.equal((await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 7500 })).notes.length, 0);
  set(650); // -35%（拆成很多小筆也一樣）
  const r3 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 7800 });
  assert.deepEqual(r3.notes.map((n) => [n.key, n.severity, n.status]), [["exchange-balance-drop:drop", "SEV-2", "觸發"]]);
  assert.match(r3.notes[0].lines[0], /持有 650，24 小時內高點 1,000，下降 35\.00%（門檻 30%）/);
  w.calls.clear();
  const r4 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 8100 });
  assert.match(r4.errors[0], /exchange-balance-drop: balanceOf\(PerpetualExchange\) 讀取失敗/);
  assert.ok(state.open["exchange-balance-drop:drop"]);
  set(900);
  const r5 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 8400 });
  assert.deepEqual(r5.notes.map((n) => n.status), ["恢復"]);
  // 24 小時後舊高點過期：以新的水位為準。
  set(600);
  const r6 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now: 8400 + 25 * 3600 });
  assert.equal(r6.notes.length, 0);
});

test("L1：累計視窗用區塊時間——落後追趕時，幾小時前的提領不算進「最近一小時」", async () => {
  const cfg = only("large-margin-withdrawal");
  const ex = addrOf("large-margin-withdrawal", "PerpetualExchange");
  const user = topicAddr("0x00000000000000000000000000000000000000ee");
  const now = 100_000;
  const logs = (w, ts) => {
    for (let i = 0; i < 6; i++) {
      makeLog(w, { address: ex, sig: "MarginWithdrawn(address,uint256)", topics: [user], data: word(9_000n * E18), block: 990 + i, logIndex: i, ...(ts === null ? {} : { ts: ts + i }) });
    }
  };
  // 6 × 9,000 = 54,000 ≥ 50,000，但都發生在 3 小時前（Worker 停了 3 小時後追趕）。
  const old = fakeWorld();
  logs(old, now - 3 * 3600);
  const r1 = await runOnce({ config: cfg, env: env0, state: { checkpoint: 980 }, fetchImpl: old.fetch, now });
  assert.ok(!r1.notes.some((n) => n.key === "large-margin-withdrawal:window"), "三小時前的提領不在「最近一小時」的即時視窗內");
  // …但它們在發生當時的一小時內累計達門檻：複審 L-a，過去的爆量也要告警，並標明發生時間。
  const past = r1.notes.filter((n) => n.key.startsWith("large-margin-withdrawal:window-past:"));
  assert.equal(past.length, 1, JSON.stringify(r1.notes.map((n) => n.key)));
  assert.equal(past[0].status, "事件");
  assert.equal(past[0].at, now - 3 * 3600 + 5);
  assert.match(past[0].lines[0], /發生時間 1970-01-02T00:46:40Z ～ 1970-01-02T00:46:45Z（區塊時間），60 分鐘內累計 54,000，6 筆/);
  // 同樣的六筆發生在 10 分鐘內 → 累計告警。
  const recent = fakeWorld();
  logs(recent, now - 600);
  const st = { checkpoint: 980 };
  const r2 = await runOnce({ config: cfg, env: env0, state: st, fetchImpl: recent.fetch, now });
  assert.ok(r2.notes.some((n) => n.key === "large-margin-withdrawal:window" && n.status === "觸發"));
  assert.equal(st.windows["large-margin-withdrawal"][0][0], now - 600, "視窗裡存的是區塊時間");
  // log 沒帶 blockTimestamp 的節點：改查 eth_getBlockByNumber。
  const noTs = fakeWorld();
  logs(noTs, null);
  for (let i = 0; i < 6; i++) noTs.blockTimes.set(990 + i, now - 3 * 3600 + i);
  const r3 = await runOnce({ config: cfg, env: env0, state: { checkpoint: 980 }, fetchImpl: noTs.fetch, now });
  assert.equal(r3.errors.length, 0, r3.errors.join());
  assert.ok(!r3.notes.some((n) => n.key === "large-margin-withdrawal:window"));
  assert.ok(r3.notes.some((n) => n.key.startsWith("large-margin-withdrawal:window-past:")));
});

test("L-a：過去的爆量（複審 l1sim）——跨輪接得起來、即時視窗在響時不重複、未達門檻不響、只發一次", async () => {
  const cfg = only("large-margin-withdrawal");
  const ex = addrOf("large-margin-withdrawal", "PerpetualExchange");
  const user = topicAddr("0x00000000000000000000000000000000000000ee");
  const now = 1_800_000_000;
  const W = (w, block, ts, amt, i) => makeLog(w, { address: ex, sig: "MarginWithdrawn(address,uint256)", topics: [user], data: word(BigInt(amt) * E18), block, logIndex: i, ts });
  // 複審 l1sim L1b：落後 3 小時才掃到 6×9,000（30 分鐘內）→ 告警；L1a（即時）→ 即時視窗告警，不另發過去的。
  const lag = fakeWorld();
  lag.head = 10_000;
  [10800, 10500, 10200, 9900, 9600, 9300].forEach((ago, i) => W(lag, 4000 + i, now - ago, 9000, i));
  const st = { checkpoint: 3990 };
  const r1 = await runOnce({ config: cfg, env: env0, state: st, fetchImpl: lag.fetch, now, sleep: noSleep });
  assert.deepEqual(r1.notes.map((n) => n.key.replace(/:\d+-\d+$/, "")), ["large-margin-withdrawal:window-past"]);
  // 下一輪沒有新提領：不重發。
  lag.head += 150;
  const r2 = await runOnce({ config: cfg, env: env0, state: st, fetchImpl: lag.fetch, now: now + 300, sleep: noSleep });
  assert.equal(r2.notes.length, 0, JSON.stringify(r2.notes));

  const live = fakeWorld();
  live.head = 10_000;
  [1800, 1500, 1200, 900, 600, 300].forEach((ago, i) => W(live, 9990 + i, now - ago, 9000, i));
  const r3 = await runOnce({ config: cfg, env: env0, state: { checkpoint: 9980 }, fetchImpl: live.fetch, now, sleep: noSleep });
  assert.deepEqual(r3.notes.map((n) => n.key), ["large-margin-withdrawal:window"]);

  // 跨輪：落後追趕被分成兩輪，同一段爆量的前三筆在第一輪、後三筆在第二輪才掃到。
  // 區塊時間與區塊號一致（每塊 2 秒）：第一輪結束時的掃描進度落後 now 約 9.5 小時。
  const split = fakeWorld();
  split.head = 20_003;
  const tOf = (b) => now - (20_000 - b) * 2;
  [2980, 2983, 2986].forEach((b, i) => W(split, b, tOf(b), 9000, i));
  [2992, 2995, 2998].forEach((b, i) => W(split, b, tOf(b), 9000, i));
  const st2 = { checkpoint: 990 };
  const env = { ...env0, MAX_SCAN_REQUESTS: "2" };
  const a = await runOnce({ config: cfg, env, state: st2, fetchImpl: split.fetch, now, sleep: noSleep });
  assert.equal(st2.checkpoint, 2990);
  assert.equal(a.notes.filter((n) => n.key.includes("window")).length, 0, "27,000 未達門檻");
  assert.equal(st2.windows["large-margin-withdrawal"].length, 3, "前三筆留著，等下一輪接上");
  const b = await runOnce({ config: cfg, env, state: st2, fetchImpl: split.fetch, now: now + 300, sleep: noSleep });
  const past = b.notes.filter((n) => n.key.startsWith("large-margin-withdrawal:window-past:"));
  assert.equal(past.length, 1, JSON.stringify(b.notes.map((n) => n.key)));
  assert.match(past[0].lines[0], /累計 54,000，6 筆/);
  // 拆單但沒達門檻（6×5,000）→ 不響。
  const small = fakeWorld();
  small.head = 10_000;
  [10800, 10500, 10200, 9900, 9600, 9300].forEach((ago, i) => W(small, 4000 + i, now - ago, 5000, i));
  const r4 = await runOnce({ config: cfg, env: env0, state: { checkpoint: 3990 }, fetchImpl: small.fetch, now, sleep: noSleep });
  assert.equal(r4.notes.length, 0);
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
  assert.deepEqual(first.notes.map((n) => [n.key, n.severity, n.status]), [[`x402-payto:baseline:${A}`, "SEV-2", "事件"]], "首次觀察當基準時要講出來（L-b：至少 SEV-2、不可靜音）");
  assert.equal(first.notes[0].unmutable, true);
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
  assert.equal(JSON.parse(dc.init.body).flags, 4, "Discord 不展開連結預覽");
  // webhook 簽章涵蓋時間戳（L5）：HMAC(secret, `${timestamp}.${body}`)。
  const sig = hk.init.headers["X-Pepelab-Signature"];
  const ts = hk.init.headers["X-Pepelab-Timestamp"];
  const { createHmac } = await import("node:crypto");
  assert.equal(ts, "50");
  assert.equal(JSON.parse(hk.init.body).sentAt, 50);
  assert.equal(sig, `sha256=${createHmac("sha256", "s3cret").update(`50.${hk.init.body}`).digest("hex")}`);
  assert.notEqual(sig, `sha256=${createHmac("sha256", "s3cret").update(hk.init.body).digest("hex")}`, "只簽內文的舊格式可以被無限期重放");
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

test("M2／M-A：monitor-self 與 SEV-1 永遠送；MUTE_KEYS 只認白名單、完全相同的 key", async () => {
  const self = { ruleId: "monitor-self", key: "monitor-self:errors", severity: "SEV-3", status: "觸發" };
  assert.equal(shouldSend(self, "SEV-1"), true);
  assert.equal(shouldSend(self, "SEV-1", ["monitor-self", "monitor-self:errors"]), true);
  assert.equal(shouldSend({ ...self, severity: "SEV-4", origSeverity: "SEV-3", status: "恢復" }, "SEV-1"), true);
  const allowed = FULL.mutableKeys.map((m) => m.key);
  assert.deepEqual(allowed, ["x402-payto:unsafe"]);
  assert.deepEqual(parseMuteKeys(" x402-payto:unsafe , monitor-self:errors,monitor-self, bad key ,fee-withdrawals,x402-payto:changed", allowed), {
    keys: ["x402-payto:unsafe"],
    rejected: ["fee-withdrawals", "x402-payto:changed"],
    ignored: ["monitor-self:errors", "monitor-self", "bad key"],
  });
  const unsafe = { ruleId: "x402-payto", key: "x402-payto:unsafe", severity: "SEV-3", status: "觸發" };
  assert.equal(shouldSend(unsafe, "SEV-4", ["x402-payto:unsafe"]), false);
  assert.equal(shouldSend({ ...unsafe, key: "x402-payto:changed", severity: "SEV-1" }, "SEV-4", ["x402-payto:unsafe"]), true, "同規則的其他 key 不受影響");
  // 複審 N4b／N4c：就算 muteKeys 裡有 SEV-1 的 key（例如繞過白名單直接呼叫），SEV-1 也照送。
  assert.equal(shouldSend({ ruleId: "x402-payto", key: "x402-payto:changed", severity: "SEV-1", status: "觸發" }, "SEV-4", ["x402-payto:changed"]), true);
  assert.equal(shouldSend({ ruleId: "insurance-wiring", key: "insurance-wiring:InsuranceVault.exchange()", severity: "SEV-1", status: "觸發" }, "SEV-4", ["insurance-wiring:InsuranceVault.exchange()"]), true);
  assert.equal(shouldSend({ ruleId: "owner-transferred", key: "owner-transferred:0xabc:1", severity: "SEV-1", status: "事件" }, "SEV-4", ["owner-transferred"]), true);
  assert.equal(shouldSend({ ruleId: "x402-payto", key: "x402-payto:changed", severity: "SEV-4", origSeverity: "SEV-1", status: "恢復" }, "SEV-4", ["x402-payto:changed"]), true, "SEV-1 的恢復也照送");
  assert.equal(shouldSend({ ruleId: "fee-withdrawals", key: "fee-withdrawals:0xabc:1", severity: "SEV-3", status: "事件" }, "SEV-4", ["fee-withdrawals"]), true, "沒有前綴比對");
  assert.equal(shouldSend({ ruleId: "x402-payto", key: "x402-payto:baseline:0xa1", severity: "SEV-2", status: "事件", unmutable: true }, "SEV-4", ["x402-payto:baseline:0xa1"]), true, "基準已設定不可靜音");

  // 整輪：MIN_SEVERITY=SEV-1（不允許）、又把 monitor-self 列進 MUTE_KEYS，RPC 全掛 →
  // 第一輪就收到「監控設定問題」（不可靜音），之後收到監控自身告警。
  const w = fakeWorld();
  const kv = fakeKv();
  w.http.set(`${API}/`, () => ({ status: 200, body: { payTo: "0x00000000000000000000000000000000000000a1", payToSafety: { safe: false, reason: "known-leaked" } } }));
  const env = { ...env0, RPC_URL: "https://rpc.down", MONITOR_STATE: kv, DISCORD_WEBHOOK_URL: DISCORD("x"), MIN_SEVERITY: "SEV-1", MUTE_KEYS: "x402-payto:unsafe,monitor-self", EXPECTED_PAY_TO: "0x00000000000000000000000000000000000000a1" };
  w.http.set("https://rpc.down", () => ({ status: 503, body: "down" }));
  const logs = [];
  for (let i = 0; i < 4; i++) {
    await assert.rejects(tick({ config: only("owner-transferred", "x402-payto"), env, now: 100 + 300 * i, fetchImpl: w.fetch, log: (l) => logs.push(l), sleep: async () => {} }), /規則讀取失敗/);
  }
  const sent = w.sent.filter((s) => s.url.startsWith("https://discord.com/")).map((s) => dcText(s));
  const heads = sent.map((t) => t.split("\n")[0]);
  assert.deepEqual(heads.map((h) => h.replace(/^\S*\[/, "[")), ["[SEV-2] 觸發｜監控設定問題", "[SEV-3] 觸發｜監控本身有規則讀取失敗"], heads.join(" | "));
  assert.match(sent[0], /設定了不可靜音的 key：monitor-self/);
  assert.match(sent[0], /MIN_SEVERITY=SEV-1 不允許/);
  assert.ok(!heads.some((h) => /收款守門/.test(h)), "白名單裡的 x402-payto:unsafe 照樣被靜音");
  assert.ok(logs.some((l) => /設定問題/.test(l)));
});

test("M-A：執行期 MUTE_KEYS 設了不在白名單的 key（複審 m5sim 第 7、8 輪）→ 照送、並發 monitor-self:config", async () => {
  const w = fakeWorld();
  const kv = fakeKv();
  const A = "0x00000000000000000000000000000000000000a1";
  const B = "0x00000000000000000000000000000000000000b2";
  const C = "0x00000000000000000000000000000000000000c3";
  let payTo = A;
  w.http.set(`${API}/`, () => ({ status: 200, body: { payTo, payToSafety: { safe: true } } }));
  const base = { ...env0, MONITOR_STATE: kv, DISCORD_WEBHOOK_URL: DISCORD("x") };
  const cfg = only("x402-payto");
  const heads = () => w.sent.filter((s) => s.url.startsWith("https://discord.com/")).map((s) => dcText(s).split("\n")[0].replace(/^\S*\[/, "["));
  await tick({ config: cfg, env: base, now: 100, fetchImpl: w.fetch, log: () => {} });
  // 第 7 輪：dashboard 設 MUTE_KEYS=x402-payto（CI 看不到），payTo 被改＋基準被刪
  const env = { ...base, MUTE_KEYS: "x402-payto" };
  payTo = B;
  await kv.delete(BASELINES_KEY);
  w.sent.length = 0;
  w.head += 150;
  await tick({ config: cfg, env, now: 400, fetchImpl: w.fetch, log: () => {} });
  assert.deepEqual(heads().sort(), ["[SEV-2] 事件｜x402 收款地址：基準已設定", "[SEV-2] 觸發｜監控設定問題"].sort(), heads().join(" | "));
  // 第 8 輪：只改 payTo（基準在）
  payTo = C;
  w.sent.length = 0;
  w.head += 150;
  await tick({ config: cfg, env, now: 700, fetchImpl: w.fetch, log: () => {} });
  assert.deepEqual(heads(), ["[SEV-1] 觸發｜x402 收款地址：收款地址變更"], "SEV-1 不受 MUTE_KEYS 影響");
  // 第 9 輪：MUTE_KEYS=x402-payto:changed（舊版 CI 放行的子 key）
  w.sent.length = 0;
  w.head += 150;
  await tick({ config: cfg, env: { ...base, MUTE_KEYS: "x402-payto:changed" }, now: 700 + 6 * 3600, fetchImpl: w.fetch, log: () => {} });
  assert.ok(heads().includes("[SEV-1] 持續｜x402 收款地址：收款地址變更"), heads().join(" | "));
});

test("M5：KV 沒有檢查點 → SEV-3「監控狀態重置，X 之前的事件未掃描」；不受 MIN_SEVERITY 影響；只發一次", async () => {
  const w = fakeWorld();
  const kv = fakeKv();
  const env = { ...env0, MONITOR_STATE: kv, DISCORD_WEBHOOK_URL: DISCORD("x"), MIN_SEVERITY: "SEV-2" };
  const sent = () => w.sent.filter((s) => s.url.startsWith("https://discord.com/")).map((s) => dcText(s));
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
  assert.match(dcText(w2.sent[0]), /監控狀態重置/);
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
  const heads = () => w.sent.filter((s) => s.url.startsWith("https://discord.com/")).map((s) => dcText(s).split("\n")[0]);
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
  assert.ok(heads().some((h) => /SEV-2\] 事件｜x402 收款地址：基準已設定/.test(h)), "基準已設定至少 SEV-2（L-b）");
  assert.ok(!heads().some((h) => /恢復｜x402 收款地址：收款地址變更/.test(h)), "同一輪不可以把開著的 SEV-1 當成恢復（L-b）");
  assert.ok(after.open["x402-payto:changed"], "變更告警保持開啟一輪");
  assert.ok(!heads().some((h) => /監控狀態重置/.test(h)));
  // 下一輪才恢復。
  w.sent.length = 0;
  w.head += 150;
  await tick({ config: cfg, env, now: 1000, fetchImpl: w.fetch, log: () => {} });
  assert.ok(heads().some((h) => /恢復｜x402 收款地址：收款地址變更/.test(h)), heads().join(" | "));
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

// ── Low ──────────────────────────────────────────────────────────────────────

test("L2：嚴重度降級後再升級要再通知；恢復通知以期間最高嚴重度判斷", () => {
  const state = {};
  const f = (sev) => [{ ruleId: "keeper-gas", key: "keeper-gas:0x1", severity: sev, title: "gas", lines: ["x"] }];
  const ev = new Set(["keeper-gas"]);
  const step = (sev, now) => reconcile({ config: FULL, env: {}, state, findings: sev ? f(sev) : [], evaluated: ev, now }).map((n) => [n.status, n.severity]);
  assert.deepEqual(step("SEV-2", 0), [["觸發", "SEV-2"]]);
  assert.deepEqual(step("SEV-3", 300), [], "降級不通知");
  assert.equal(state.open["keeper-gas:0x1"].severity, "SEV-3", "但記下目前的嚴重度");
  const up = reconcile({ config: FULL, env: {}, state, findings: f("SEV-2"), evaluated: ev, now: 600 });
  assert.deepEqual(up.map((n) => [n.status, n.severity]), [["持續", "SEV-2"]], "再升回 SEV-2 要通知");
  assert.ok(up[0].lines.includes("嚴重度由 SEV-3 升為 SEV-2"));
  assert.deepEqual(step("SEV-2", 900), [], "同級不重複");
  assert.deepEqual(step("SEV-3", 1200), []);
  const rec = reconcile({ config: FULL, env: {}, state, findings: [], evaluated: ev, now: 1500 });
  assert.equal(rec[0].status, "恢復");
  assert.equal(rec[0].origSeverity, "SEV-2", "恢復時目前是 SEV-3，但期間到過 SEV-2：MIN_SEVERITY=SEV-2 的人也要收到恢復");
  assert.equal(shouldSend(rec[0], "SEV-2"), true);
});

test("L3：部分資產讀不到 → 已算出的過期告警照送、算監控錯誤、不替讀不到的資產發恢復", async () => {
  const w = fakeWorld();
  const cfg = only("oracle-stale");
  const r = ruleOf("oracle-stale");
  const oracle = addrOf("oracle-stale", "oracle");
  let now = 2_000_000;
  const state = {};
  stubOracle(w, { now, ages: { sBTC: 7 * 3600, sAAPL: 80 * 3600 } });
  const r1 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now });
  assert.deepEqual(r1.notes.map((n) => n.key).sort(), ["oracle-stale:sAAPL", "oracle-stale:sBTC"]);

  // 審查 G 的情境：sBTC／sETH 過期 8 小時，其餘 9 檔讀取失敗（多數）。原本整個丟例外，SEV-2 被丟掉。
  now += 300;
  stubOracle(w, { now, ages: { sBTC: 8 * 3600, sETH: 8 * 3600 } });
  for (const sym of r.assets.slice(2)) w.setCall(oracle, "getPrice(bytes32)", [FULL.assets[sym]], { revert: true });
  const r2 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now });
  assert.deepEqual(r2.notes.map((n) => [n.key, n.severity, n.status]), [["oracle-stale:sETH", "SEV-2", "觸發"]], "sETH 的新告警照送（sBTC 已開、未升級）");
  assert.match(r2.errors[0], /oracle-stale: 9／11 檔資產讀不到價格：sAAPL,/);
  assert.ok(state.open["oracle-stale:sAAPL"], "sAAPL 讀不到 ≠ sAAPL 恢復");

  // 少數讀不到（1 檔）也一樣：原本會靜靜略過，並把那一檔開著的告警當成恢復。
  now += 300;
  stubOracle(w, { now, ages: { sBTC: 8 * 3600, sETH: 8 * 3600 } });
  w.setCall(oracle, "getPrice(bytes32)", [FULL.assets.sAAPL], { revert: true });
  const r3 = await runOnce({ config: cfg, env: env0, state, fetchImpl: w.fetch, now });
  assert.ok(!r3.notes.some((n) => n.status === "恢復"));
  assert.match(r3.errors[0], /1／11 檔資產讀不到價格：sAAPL/);
});

test("L5：RPC_URL／HEARTBEAT_URL 必須是 https；錯誤訊息不帶完整 URL", async () => {
  const w = fakeWorld();
  const secretPath = "v2/SuperSecretKey0123456789abcdef";
  await assert.rejects(
    runOnce({ config: only("owner-transferred"), env: { ...env0, RPC_URL: `http://rpc.example/${secretPath}` }, state: {}, fetchImpl: w.fetch, now: 1 }),
    (e) => /RPC_URL 必須是 https/.test(e.message) && !e.message.includes("SuperSecret") && !e.message.includes("rpc.example"),
  );
  await assert.rejects(runOnce({ config: only("owner-transferred"), env: { ...env0, RPC_URL: "not a url" }, state: {}, fetchImpl: w.fetch, now: 1 }), /RPC_URL 必須是 https/);
  const kv = fakeKv();
  await assert.rejects(
    tick({ config: only("owner-transferred"), env: { ...env0, MONITOR_STATE: kv, DISCORD_WEBHOOK_URL: DISCORD("x"), HEARTBEAT_URL: "http://hc.example/ping/abc" }, now: 1, fetchImpl: w.fetch, log: () => {} }),
    (e) => /HEARTBEAT_URL 必須是 https/.test(e.message) && !e.message.includes("hc.example"),
  );
  assert.throws(() => channelsOf({ ALERT_WEBHOOK_URL: "http://plain.example/hook/secret" }), (e) => /ALERT_WEBHOOK_URL 必須是 https/.test(e.message) && !e.message.includes("secret"));

  // URL 遮蔽：路徑與查詢字串（金鑰所在）拿掉，只留協定與主機。
  assert.equal(redactUrls(`fetch https://rpc.example/${secretPath}?k=1 failed`), "fetch https://rpc.example/… failed");
  assert.equal(redactUrls("see https://sepolia.base.org and https://user:pw@h.example/x"), "see https://sepolia.base.org and https://h.example/…");
  // 付費 RPC 的錯誤（內文或例外訊息回顯了完整 URL）→ 告警與 log 裡都不可以出現金鑰。
  const paid = `https://paid.example/${secretPath}`;
  const logs = [];
  const fetchImpl = async (url, init) => {
    if (url === paid) return new Response(`upstream ${paid} unavailable`, { status: 502 });
    return w.fetch(url, init);
  };
  const state = {};
  let last;
  for (let i = 0; i < 2; i++) last = await runOnce({ config: only("owner-transferred"), env: { ...env0, RPC_URL: paid }, state, fetchImpl, now: 1 + i * 300, log: (l) => logs.push(l), sleep: noSleep });
  const all = [...last.errors, ...last.notes.flatMap((n) => n.lines), ...logs].join("\n");
  assert.match(all, /RPC HTTP 502：upstream https:\/\/paid\.example\/… unavailable/);
  assert.ok(!all.includes("SuperSecret"), all);
});

test("L5：通知與心跳的 fetch 有逾時；通道例外訊息遮蔽 URL", async () => {
  const hang = (url, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }))));
  const logs = [];
  const ch = { name: "discord", url: DISCORD("tokenpart"), body: (t) => ({ content: t }) };
  const t0 = Date.now();
  const ok = await sendToChannel({ severity: "SEV-3" }, "x", ch, hang, { log: (l) => logs.push(l), now: 1, timeoutMs: 30 });
  assert.equal(ok, false);
  assert.ok(Date.now() - t0 < 2000, "不會無限期卡住");
  assert.match(logs[0], /notify discord 例外：逾時/);
  const boom = async (url) => {
    throw new Error(`connect ECONNREFUSED ${url}`);
  };
  await sendToChannel({ severity: "SEV-3" }, "x", ch, boom, { log: (l) => logs.push(l), now: 1 });
  assert.ok(!logs.join("\n").includes("tokenpart"), logs.join("\n"));

  // 心跳卡住：tick 仍然結束（fetch 有帶 signal），而且不把 URL 寫進 log。
  const w = fakeWorld();
  const kv = fakeKv();
  let hbSignal = null;
  const fetchImpl = async (url, init) => {
    if (url.startsWith("https://hc.example/")) {
      hbSignal = init.signal;
      throw new Error(`getaddrinfo ENOTFOUND ${url}`);
    }
    return w.fetch(url, init);
  };
  const tlogs = [];
  await tick({ config: only("owner-transferred"), env: { ...env0, MONITOR_STATE: kv, DISCORD_WEBHOOK_URL: DISCORD("x"), HEARTBEAT_URL: "https://hc.example/ping/secret-uuid" }, now: 1, fetchImpl, log: (l) => tlogs.push(l) });
  assert.ok(hbSignal, "心跳的 fetch 帶 AbortSignal（有逾時）");
  assert.ok(tlogs.some((l) => /heartbeat 失敗/.test(l)));
  assert.ok(!tlogs.join("\n").includes("secret-uuid"));
});

test("L5：Discord 內容跳脫 Markdown（不能做出遮罩連結、粗體、程式碼區塊），URL 保持可點", () => {
  const evil = "reason: **urgent** [click here](https://evil.example/x) `code` ~~x~~ ||spoiler|| @everyone\n# 標題\n> 引用\n- 清單";
  const out = escapeDiscord(evil);
  assert.ok(!/(^|[^\\])\[click here\]\(/.test(out), out);
  assert.ok(out.includes("\\*\\*urgent\\*\\*"));
  assert.ok(out.includes("\\[click here\\]"));
  assert.ok(out.includes("\\`code\\`"));
  assert.ok(out.includes("\\~\\~x\\~\\~") && out.includes("\\|\\|spoiler\\|\\|"));
  assert.ok(out.includes("\n\\# 標題\n\\> 引用\n\\- 清單"));
  const url = "https://github.com/zuemen/pepelab_onchain_cfd/blob/master/docs/INCIDENT_RESPONSE.md#1-嚴重度分級";
  assert.ok(escapeDiscord(`處置：${url}`).includes(url), "URL 裡的 _ 不跳脫，連結不會壞");
  assert.ok(escapeDiscord("tx：https://sepolia.basescan.org/tx/0xabc").endsWith("https://sepolia.basescan.org/tx/0xabc"));
});

test("L6：多通道各自重送——Telegram 送到、Discord 失敗 → 只對 Discord 重送，不重複打擾 Telegram", async () => {
  const w = fakeWorld();
  const kv = fakeKv();
  const env = { ...env0, MONITOR_STATE: kv, TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: "-1", DISCORD_WEBHOOK_URL: DISCORD("x") };
  const cfg = only("owner-transferred");
  let discordUp = false;
  const orig = w.fetch;
  w.fetch = async (url, init) => {
    if (url.startsWith("https://discord.com/") && !discordUp) {
      w.sent.push({ url, init, failed: true });
      return new Response("nope", { status: 500 });
    }
    return orig(url, init);
  };
  const to = (prefix) => w.sent.filter((x) => x.url.startsWith(prefix) && !x.failed);
  const tgHeads = () => to("https://api.telegram.org/").map((x) => JSON.parse(x.init.body).text.split("\n")[0]);
  ownerLog(w, w.head - 5, 1);
  await assert.rejects(tick({ config: cfg, env, now: 100, fetchImpl: w.fetch, log: () => {} }), /2 則告警未送達（discord×2；已留在 outbox 重送）/);
  assert.equal(to("https://api.telegram.org/").length, 2, "Telegram 兩則都送到（owner 事件＋狀態重置）");
  assert.deepEqual(JSON.parse(kv.m.get(STATE_KEY)).outbox.map((o) => o.channels), [["discord"], ["discord"]]);

  // 第二輪 Discord 仍然失敗：Telegram 不會再收到那兩則。
  w.head += 150;
  await assert.rejects(tick({ config: cfg, env, now: 400, fetchImpl: w.fetch, log: () => {} }), /未送達/);
  assert.equal(to("https://api.telegram.org/").length, 2, "已送達的通道不重複送");
  assert.equal(JSON.parse(kv.m.get(STATE_KEY)).channelStuck.discord, CHANNEL_STUCK_ROUNDS);

  // 第三輪：連續兩輪送不出去 → 透過 Telegram 告知「discord 送不出去」。
  w.head += 150;
  await assert.rejects(tick({ config: cfg, env, now: 700, fetchImpl: w.fetch, log: () => {} }), /未送達/);
  assert.match(tgHeads().at(-1), /SEV-3\] 觸發｜告警通道 discord 送不出去/);

  // Discord 恢復：積欠的全部補送到 Discord，Telegram 收到恢復。
  discordUp = true;
  w.head += 150;
  await tick({ config: cfg, env, now: 1000, fetchImpl: w.fetch, log: () => {} });
  const dc = to("https://discord.com/").map(dcText).map((t) => t.split("\n")[0]);
  assert.ok(dc.some((h) => /合約 owner 變更/.test(h)) && dc.some((h) => /監控狀態重置/.test(h)) && dc.some((h) => /告警通道 discord 送不出去/.test(h)), dc.join(" | "));
  assert.equal(JSON.parse(kv.m.get(STATE_KEY)).outbox.length, 0);
  w.head += 150;
  await tick({ config: cfg, env, now: 1300, fetchImpl: w.fetch, log: () => {} });
  assert.match(tgHeads().at(-1), /恢復｜告警通道 discord 送不出去/);
});

test("L6／L-e：依發生時間送（舊的觸發先於新的）、舊的每輪重送有上限、過期丟棄、通道移除後不再等", async () => {
  const w = fakeWorld();
  const kv = fakeKv();
  const cfg = only("owner-transferred");
  const item = (i, firstAt) => ({ note: { ruleId: "owner-transferred", key: `k${i}`, severity: "SEV-1", status: "事件", title: "t", lines: [] }, text: `old-${i}`, channels: ["discord"], firstAt });
  const now = 1_000_000;
  const outbox = [item(0, now - OUTBOX_TTL_SEC - 10), ...Array.from({ length: 30 }, (_, i) => item(i + 1, now - 600))];
  kv.m.set(STATE_KEY, JSON.stringify({ checkpoint: w.head - 3, outbox }));
  ownerLog(w, w.head + 100, 5);
  w.head += 150;
  const envBoth = { ...env0, MONITOR_STATE: kv, TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: "-1", DISCORD_WEBHOOK_URL: DISCORD("x") };
  const order = [];
  const orig = w.fetch;
  w.fetch = async (url, init) => {
    if (url.startsWith("https://discord.com/")) order.push("dc:" + JSON.parse(init.body).content.split("\n")[0].slice(0, 12));
    if (url.startsWith("https://api.telegram.org/")) order.push("tg");
    return orig(url, init);
  };
  await assert.rejects(tick({ config: cfg, env: envBoth, now, fetchImpl: w.fetch, log: () => {} }), /未送達.*另丟棄 1 則/);
  const lastOld = order.map((o) => o.startsWith("dc:old-")).lastIndexOf(true);
  assert.equal(lastOld, MAX_RESEND_PER_TICK - 1, `舊通知（發生得早）先送：${order.join(",")}`);
  assert.equal(order[MAX_RESEND_PER_TICK], "tg", "新告警排在舊的之後");
  assert.ok(order[MAX_RESEND_PER_TICK + 1].startsWith("dc:") && !order[MAX_RESEND_PER_TICK + 1].includes("old-"));
  assert.equal(order.filter((o) => o.startsWith("dc:old-")).length, MAX_RESEND_PER_TICK);
  const st = JSON.parse(kv.m.get(STATE_KEY));
  assert.equal(st.outbox.length, 30 - MAX_RESEND_PER_TICK);
  assert.ok(!st.outbox.some((o) => o.text === "old-0"), "超過 24 小時的丟棄");

  // 把 Discord 從設定移除：只等 Discord 的舊通知不再留著。
  const { DISCORD_WEBHOOK_URL: _removed, ...envTg } = envBoth;
  w.head += 150;
  await tick({ config: cfg, env: envTg, now: now + 300, fetchImpl: w.fetch, log: () => {} });
  assert.equal(JSON.parse(kv.m.get(STATE_KEY)).outbox.length, 0);
});

// ── 複審修正（M-A、L-b、L-c、L-e、L-f、Info）──────────────────────────────────

test("L-c：實作 slot ≠ deployed.json → SEV-1；先由 Upgraded 事件通報過 → SEV-3（不重複叫人）；事件晚到 → 事件降為 SEV-3", async () => {
  const cfg = only("proxy-implementation", "vault-upgraded");
  const rule = ruleOf("proxy-implementation");
  const proxy = rule.contracts[0].address;
  assert.match(rule.contracts[0].impl, /^0x[0-9a-f]{40}$/, "--write 產生預期實作");
  const NEW = "0x00000000000000000000000000000000000000d4";
  const setImpl = (w, a) => w.storage.set(`${proxy.toLowerCase()}|${IMPL_SLOT}`, "0x" + a.slice(2).padStart(64, "0"));

  // 沒變：不響。
  const w0 = fakeWorld();
  setImpl(w0, rule.contracts[0].impl);
  const r0 = await runOnce({ config: cfg, env: env0, state: { checkpoint: 990 }, fetchImpl: w0.fetch, now: 100 });
  assert.equal(r0.errors.length, 0, r0.errors.join());
  assert.equal(r0.notes.length, 0);

  // slot 先看到（事件還在確認數之內）→ SEV-1；下一輪事件進來 → 事件降為 SEV-3。
  const w = fakeWorld();
  setImpl(w, NEW);
  const st = { checkpoint: 990 };
  const r1 = await runOnce({ config: cfg, env: env0, state: st, fetchImpl: w.fetch, now: 100 });
  assert.deepEqual(r1.notes.map((n) => [n.key, n.severity, n.status]), [[`proxy-implementation:${proxy.toLowerCase()}`, "SEV-1", "觸發"]]);
  makeLog(w, { address: proxy, sig: "Upgraded(address)", topics: [topicAddr(NEW)], block: w.head + 2 });
  w.head += 150;
  const r2 = await runOnce({ config: cfg, env: env0, state: st, fetchImpl: w.fetch, now: 400 });
  const ev = r2.notes.find((n) => n.ruleId === "vault-upgraded");
  assert.equal(ev.severity, "SEV-3");
  assert.ok(ev.lines.some((l) => /已由 proxy-implementation/.test(l)));
  assert.ok(!r2.notes.some((n) => n.ruleId === "proxy-implementation"), "slot 的告警持續開著，沒到提醒時間不重送");

  // 事件先到（同一輪：事件掃描在狀態規則之前）→ 事件 SEV-1、slot 只發 SEV-3「deployed.json 過期」。
  const w2 = fakeWorld();
  setImpl(w2, NEW);
  makeLog(w2, { address: proxy, sig: "Upgraded(address)", topics: [topicAddr(NEW)] });
  const r3 = await runOnce({ config: cfg, env: env0, state: { checkpoint: 990 }, fetchImpl: w2.fetch, now: 100 });
  const sev = Object.fromEntries(r3.notes.map((n) => [n.ruleId, n.severity]));
  assert.deepEqual(sev, { "vault-upgraded": "SEV-1", "proxy-implementation": "SEV-3" });
  assert.match(r3.notes.find((n) => n.ruleId === "proxy-implementation").title, /deployed\.json 過期/);

  // slot 讀不到：不算恢復。
  const w3 = fakeWorld();
  setImpl(w3, NEW);
  const st3 = { checkpoint: 990 };
  await runOnce({ config: cfg, env: env0, state: st3, fetchImpl: w3.fetch, now: 100 });
  w3.itemError = (r) => (r.method === "eth_getStorageAt" ? { code: -32000, message: "boom" } : null);
  const r4 = await runOnce({ config: cfg, env: env0, state: st3, fetchImpl: w3.fetch, now: 400, sleep: noSleep });
  assert.match(r4.errors.join(), /實作 slot 讀取失敗/);
  assert.ok(!r4.notes.some((n) => n.status === "恢復"));
});

test("L-d：PepeIncentives 的獎勵池跌幅與 esgRegistry 接線（部署版 setter 不發事件）", async () => {
  const cfg = only("pepe-incentives-balance-drop", "pepe-incentives-wiring");
  const token = addrOf("pepe-incentives-balance-drop", "token");
  const holder = addrOf("pepe-incentives-balance-drop", "holder");
  const w = fakeWorld();
  const set = (n) => w.setCall(token, "balanceOf(address)", [holder], word(BigInt(n) * E18));
  w.setCall(holder, "esgRegistry()", [], word(0));
  const st = {};
  set(1_000_000);
  const r1 = await runOnce({ config: cfg, env: env0, state: st, fetchImpl: w.fetch, now: 7200 });
  assert.equal(r1.errors.length, 0, r1.errors.join());
  assert.equal(r1.notes.length, 0);
  set(100_000); // owner withdraw 把池子提走
  w.setCall(holder, "esgRegistry()", [], word(0xbeef));
  const r2 = await runOnce({ config: cfg, env: env0, state: st, fetchImpl: w.fetch, now: 7500 });
  assert.deepEqual(r2.notes.map((n) => [n.ruleId, n.severity]).sort(), [["pepe-incentives-balance-drop", "SEV-2"], ["pepe-incentives-wiring", "SEV-2"]]);
});

test("L-e：訊息帶發生時間、webhook payload 帶去重 id 與首次發生時間（重送時 id 不變）", async () => {
  const note = { ruleId: "owner-transferred", key: "owner-transferred:0xab:1", severity: "SEV-1", status: "事件", title: "合約 owner 變更", lines: ["x"], at: 1_800_000_000, firstAt: 1_800_000_000 };
  assert.match(formatNote(note), /時間：2027-01-15T08:00:00Z/);
  assert.match(formatNote({ ...note, status: "持續", at: 1_800_003_600 }), /時間：2027-01-15T09:00:00Z（首次 2027-01-15T08:00:00Z）/);
  const id1 = await noteId(note, "d");
  assert.equal(id1, await noteId(note, "d"));
  assert.notEqual(id1, await noteId({ ...note, status: "恢復" }, "d"));
  const got = [];
  const ch = { name: "webhook", url: "https://hooks.example/a", body: null, secret: "" };
  const f = async (url, init) => (got.push(JSON.parse(init.body)), new Response("ok"));
  await sendToChannel(note, "t", ch, f, { now: 1_800_000_100, deploymentId: "d" });
  await sendToChannel(note, "t", ch, f, { now: 1_800_000_400, deploymentId: "d" });
  assert.equal(got[0].id, id1);
  assert.equal(got[1].id, id1, "重送（at-least-once）時 id 相同，接收端可去重");
  assert.equal(got[0].occurredAt, 1_800_000_000);
  assert.equal(got[0].firstAt, 1_800_000_000);
  assert.notEqual(got[0].sentAt, got[1].sentAt);
});

test("L-f：等於關掉告警的覆寫值——執行期夾住並講出來；MIN_SEVERITY 不可只剩 SEV-1", () => {
  const cfg = FULL;
  assert.deepEqual(configProblems(cfg, {}), [], "預設值沒有問題");
  const bad = configProblems(cfg, { LAG_ALERT_BLOCKS: "1000000", LARGE_WITHDRAWAL_BPS: "10000", SELF_ERRORS_BEFORE_ALERT: "12", HTTP_FAILS_BEFORE_ALERT: "6", MIN_SEVERITY: "SEV-1" });
  assert.ok(bad.some((m) => /LAG_ALERT_BLOCKS=1000000 超過安全上限 1800/.test(m)), bad.join("\n"));
  assert.ok(bad.some((m) => /LARGE_WITHDRAWAL_BPS=10000 超過安全上限 5000/.test(m)));
  assert.ok(bad.some((m) => /SELF_ERRORS_BEFORE_ALERT=12 超過安全上限 6/.test(m)));
  assert.ok(bad.some((m) => /超過 6 輪（約 30 分鐘）；SELF_ERRORS_BEFORE_ALERT 以 1 執行/.test(m)), bad.join("\n"));
  assert.ok(bad.some((m) => /MIN_SEVERITY=SEV-1 不允許/.test(m)));
  assert.equal(minSeverityOf(cfg, { MIN_SEVERITY: "SEV-1" }), "SEV-2");
  assert.equal(minSeverityOf(cfg, { MIN_SEVERITY: "SEV-3" }), "SEV-3");
});

test("L-f：LAG_ALERT_BLOCKS 被設成 1,000,000 → 仍以 1,800 告警", async () => {
  const w = fakeWorld();
  w.head = 100_000;
  const r = await runOnce({ config: only("owner-transferred"), env: { ...env0, LAG_ALERT_BLOCKS: "1000000" }, state: { checkpoint: 1 }, fetchImpl: w.fetch, now: 1 });
  assert.ok(r.notes.some((n) => n.key === "monitor-self:lag"));
});

test("Info：-32602「block range extends beyond current head」不是範圍錯誤，是要重試的暫時性錯誤", () => {
  const e = { code: -32602, message: "block range extends beyond current head block" };
  assert.equal(isRangeError(e), false);
  assert.equal(isTransient(e), true);
  assert.equal(isRangeError({ status: 413, code: -32614, message: "eth_getLogs is limited to a 1,000 range" }), true);
});
