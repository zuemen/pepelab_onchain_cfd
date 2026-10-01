// 鏈上監控引擎：讀 monitors.json 的規則，對 Base Sepolia 做唯讀檢查，產出告警。
//
// 純邏輯 + 注入的 fetch：worker.mjs 負責 KV 與排程，monitor.test.mjs 用假 RPC 測這裡。
// 這個模組**不持有任何金鑰、不送交易**；它只做 eth_blockNumber／eth_getLogs／eth_call／
// eth_getBalance 與兩個公開 HTTP GET。
//
// 三種規則：
//   event — 以 eth_getLogs 掃「上次檢查點之後」的區塊；每筆符合的 log 是一則一次性告警。
//   state — 以 eth_call 讀狀態；條件成立時「開啟」告警，持續時依 REMIND_SEC 提醒，解除時發「恢復」。
//   http  — signal-api 的健康檢查與 x402 收款地址。
//
// 所有位址、topic0、selector、資產 ID 都是 monitors.json 裡預先算好、由
// scripts/check-monitoring.mjs 對照 frontend/src/contracts/** 驗證過的；這裡不做雜湊。

export const SEVERITIES = ["SEV-1", "SEV-2", "SEV-3", "SEV-4"];
const sevRank = (s) => {
  const i = SEVERITIES.indexOf(s);
  return i < 0 ? SEVERITIES.length : i;
};
/** 兩個嚴重度取較嚴重的。 */
export const worse = (a, b) => (sevRank(a) <= sevRank(b) ? a : b);

// ── 參數 ─────────────────────────────────────────────────────────────────────

/** 參數值：Worker 環境變數優先（wrangler.toml [vars]），否則 monitors.json 的預設值。 */
export function param(config, env, name) {
  const def = config.params?.[name];
  if (!def) throw new Error(`未定義的參數 ${name}`);
  const v = env?.[name];
  return v === undefined || v === null || String(v).trim() === "" ? String(def.default) : String(v).trim();
}
const numParam = (config, env, name) => {
  const n = Number(param(config, env, name));
  if (!Number.isFinite(n) || n < 0) throw new Error(`參數 ${name} 不是非負數`);
  return n;
};
/** 十進位字串（可含小數）→ 以 decimals 為單位的 BigInt。 */
export function toUnits(text, decimals) {
  const m = String(text).trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) throw new Error(`不是合法金額：${text}`);
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}
export function formatUnits(v, decimals, maxFrac = 2) {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const int = a / base;
  let frac = (a % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int.toLocaleString("en-US")}${frac ? "." + frac : ""}`;
}

// ── ABI 編解碼（只支援本專案用到的靜態型別）──────────────────────────────────

const strip0x = (h) => (h.startsWith("0x") ? h.slice(2) : h);
export function encodeArg(type, value) {
  if (type === "bytes32") {
    const h = strip0x(value).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`bytes32 格式錯誤：${value}`);
    return h;
  }
  if (type === "address") {
    const h = strip0x(value).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(h)) throw new Error(`address 格式錯誤：${value}`);
    return h.padStart(64, "0");
  }
  if (/^uint\d*$/.test(type)) return BigInt(value).toString(16).padStart(64, "0");
  throw new Error(`不支援的參數型別 ${type}`);
}
export function words(hex) {
  const h = strip0x(hex ?? "");
  const out = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(BigInt("0x" + h.slice(i, i + 64)));
  return out;
}
const wordToAddress = (w) => "0x" + w.toString(16).padStart(64, "0").slice(24);
const wordToHex32 = (w) => "0x" + w.toString(16).padStart(64, "0");
const toSigned = (w, bits = 256) => (w >= 1n << BigInt(bits - 1) ? w - (1n << BigInt(bits)) : w);

/** 依 inputs 把一筆 log 解成 [{name, type, value}]（字串值，給訊息用）。 */
export function decodeLog(inputs, log, labels = {}) {
  const topics = log.topics ?? [];
  const data = words(log.data);
  let t = 1;
  let d = 0;
  const out = [];
  for (const inp of inputs ?? []) {
    const dynamic = /\[\]$|^bytes$|^string$/.test(inp.type);
    let raw;
    if (inp.indexed) {
      raw = topics[t++] ? BigInt(topics[t - 1]) : null;
      if (dynamic) {
        out.push({ name: inp.name, type: inp.type, value: "(indexed 動態型別，僅雜湊)" });
        continue;
      }
    } else {
      raw = data[d++] ?? null;
      if (dynamic) {
        out.push({ name: inp.name, type: inp.type, value: "(動態型別略)" });
        continue;
      }
    }
    if (raw === null) {
      out.push({ name: inp.name, type: inp.type, value: "(缺)" });
      continue;
    }
    let value;
    if (inp.type === "address") value = wordToAddress(raw);
    else if (inp.type === "bool") value = raw === 0n ? "false" : "true";
    else if (inp.type === "bytes32") {
      const h = wordToHex32(raw);
      value = labels[h] ? `${labels[h]}（${h.slice(0, 10)}…）` : h;
    } else if (/^int\d*$/.test(inp.type)) value = toSigned(raw, Number(inp.type.slice(3) || 256)).toString();
    else value = raw.toString();
    out.push({ name: inp.name, type: inp.type, value, raw });
  }
  return out;
}

// ── JSON-RPC ─────────────────────────────────────────────────────────────────

/** RPC 失敗：status 是 HTTP 狀態（若有），code 是 JSON-RPC 錯誤碼（若有）。 */
export class RpcError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "RpcError";
    this.status = status;
    this.code = code;
  }
}
/** 壓成一行並截斷（給錯誤訊息用）。 */
const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
/**
 * 節點拒絕這個 eth_getLogs 範圍（區塊數或結果數超過上限）。縮小範圍重試就會過，
 * 所以不算「RPC 壞了」。實測（2026-10-01，https://sepolia.base.org）：超過 1,000 塊回
 * HTTP 413 `{"code":-32614,"message":"eth_getLogs is limited to a 1,000 range"}`。
 * 其他節點常見的是 -32005「query returned more than 10000 results」。
 */
export function isRangeError(e) {
  if (e?.status === 413 || e?.code === -32614 || e?.code === -32005) return true;
  return /limited to a|block range|range (?:is )?too (?:large|wide)|exceeds? .*range|more than \d[\d,]* results|response size|too many results/i.test(
    String(e?.message ?? ""),
  );
}

async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    return await fetchImpl(url, ctl ? { ...init, signal: ctl.signal } : init);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * RPC 用戶端。batch() 一次送多個請求（省 Worker 的 subrequest 配額）；節點不支援
 * batch（回非陣列）時退回逐筆。每個結果是 {result} 或 {error}，單筆失敗不影響其他筆。
 */
export function makeRpc(url, fetchImpl, { timeoutMs = 15_000 } = {}) {
  let nextId = 1;
  const post = async (body) => {
    const res = await fetchWithTimeout(
      fetchImpl,
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      timeoutMs,
    );
    if (!res.ok) {
      // 帶上回應內文：公開 RPC 的 413 內文才說得出「eth_getLogs is limited to a 1,000 range」，
      // 只記 HTTP 狀態的話，值班的人看不出是範圍、額度還是節點故障。
      let text = "";
      try {
        text = await res.text();
      } catch {
        /* 內文讀不到就只報狀態 */
      }
      let code;
      try {
        code = JSON.parse(text)?.error?.code;
      } catch {
        /* 不是 JSON */
      }
      throw new RpcError(`RPC HTTP ${res.status}${text.trim() ? `：${clip(text, 200)}` : ""}`, { status: res.status, code });
    }
    return res.json();
  };
  const one = async (method, params) => {
    const j = await post({ jsonrpc: "2.0", id: nextId++, method, params });
    if (j?.error) throw new RpcError(`RPC ${method}: ${clip(j.error.message ?? "error", 160)}`, { code: j.error.code });
    return j?.result;
  };
  const batch = async (reqs) => {
    if (reqs.length === 0) return [];
    const body = reqs.map((r) => ({ jsonrpc: "2.0", id: nextId++, method: r.method, params: r.params }));
    const j = await post(body);
    if (!Array.isArray(j)) {
      const out = [];
      for (const r of reqs) {
        try {
          out.push({ result: await one(r.method, r.params) });
        } catch (e) {
          out.push({ error: e.message });
        }
      }
      return out;
    }
    const byId = new Map(j.map((x) => [x.id, x]));
    return body.map((b) => {
      const x = byId.get(b.id);
      if (!x) return { error: "RPC 回應缺少此筆" };
      if (x.error) return { error: clip(x.error.message ?? "error", 160), code: x.error.code };
      return { result: x.result };
    });
  };
  return { call: one, batch };
}

// ── 規則輔助 ─────────────────────────────────────────────────────────────────

const isActive = (r) => r.status === "active";
const lc = (a) => String(a ?? "").toLowerCase();
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

function contractOf(rule, alias) {
  const c = rule.contracts.find((x) => x.as === alias);
  if (!c || !c.address) throw new Error(`規則 ${rule.id} 缺少合約 ${alias}`);
  return c;
}
function selectorOf(rule, alias, fn) {
  const c = rule.calls?.find((x) => x.on === alias && x.fn === fn);
  if (!c?.selector) throw new Error(`規則 ${rule.id} 缺少呼叫 ${alias}.${fn}`);
  return c.selector;
}
const ethCall = (to, data) => ({ method: "eth_call", params: [{ to, data }, "latest"] });
function callReq(rule, alias, fn, args = []) {
  const c = contractOf(rule, alias);
  const types = (fn.match(/\((.*)\)$/)?.[1] ?? "").split(",").filter(Boolean);
  const data = selectorOf(rule, alias, fn) + types.map((t, i) => encodeArg(t, args[i])).join("");
  return ethCall(c.address, data);
}
function assetId(config, symbol) {
  const id = config.assets?.[symbol];
  if (!id) throw new Error(`monitors.json 沒有資產 ${symbol} 的 ID`);
  return id;
}
const finding = (rule, key, severity, title, lines) => ({ ruleId: rule.id, key, severity, title, lines });
/**
 * 部分失敗：有些讀取成功、有些失敗。已經算出的 findings 照樣送（不因為別的讀取失敗而丟掉），
 * 但這條規則不算「成功評估」——不會替本輪沒看到的告警發恢復。
 */
const partial = (message, findings) => Object.assign(new Error(message), { findings });

// ── event 規則 ───────────────────────────────────────────────────────────────

/**
 * 掃描「上次檢查點之後」的區塊。回傳
 *   { findings, nextCheckpoint, lagBlocks, scanned, requests, range, initialFrom, error }。
 *
 * 一輪內分多段追趕：每段最多 MAX_BLOCK_RANGE 塊、最多 MAX_SCAN_REQUESTS 個 eth_getLogs
 * （Cloudflare 免費方案每次執行只有 50 個 subrequest，要留給狀態規則與通知）。節點拒絕範圍
 * （HTTP 413／-32614／結果數過多）時把範圍減半重試——寫死一個「剛好等於上限」的範圍，上限
 * 一變就會永久卡死（審查 H1：預設 2000 > 公開 RPC 的 1000，落後 33 分鐘後檢查點永不前進）。
 *
 * 檢查點逐段前進：某一段失敗時，之前成功的段落已經算數（findings 保留、檢查點停在最後一個
 * 成功的區塊），error 帶回失敗原因，下一輪從那裡接著掃（不漏、不重複）。
 */
export async function scanEvents({ config, env, rpc, state, now }) {
  const rules = config.rules.filter((r) => r.kind === "event" && isActive(r));
  const index = new Map(); // `${addr}|${topic0}` → [{rule, event, contract}]
  for (const rule of rules) {
    for (const c of rule.contracts) {
      if (!c.address) continue;
      for (const ev of rule.events) {
        const k = `${lc(c.address)}|${lc(ev.topic0)}`;
        if (!index.has(k)) index.set(k, []);
        index.get(k).push({ rule, ev, contract: c });
      }
    }
  }
  const addresses = [...new Set([...index.keys()].map((k) => k.split("|")[0]))];
  const topics = [...new Set([...index.keys()].map((k) => k.split("|")[1]))];

  const head = Number(BigInt(await rpc.call("eth_blockNumber", [])));
  const latest = head - numParam(config, env, "CONFIRMATIONS");
  const checkpoint = state.checkpoint;
  const fresh = checkpoint === undefined || checkpoint === null;
  const from = fresh ? Math.max(0, latest - numParam(config, env, "INITIAL_LOOKBACK_BLOCKS") + 1) : checkpoint + 1;
  const out = {
    findings: [],
    nextCheckpoint: checkpoint,
    lagBlocks: 0,
    scanned: 0,
    requests: 0,
    range: Math.max(1, Math.floor(numParam(config, env, "MAX_BLOCK_RANGE"))),
    initialFrom: fresh ? from : undefined,
    error: null,
  };
  if (from > latest) return out;

  const maxRequests = Math.max(1, Math.floor(numParam(config, env, "MAX_SCAN_REQUESTS")));
  const explorer = config.network.explorer.replace(/\/$/, "");
  let cursor = from;
  let rangeError = null;
  while (cursor <= latest && out.requests < maxRequests) {
    const to = Math.min(latest, cursor + out.range - 1);
    out.requests++;
    let logs;
    try {
      logs = addresses.length
        ? await rpc.call("eth_getLogs", [
            { fromBlock: "0x" + cursor.toString(16), toBlock: "0x" + to.toString(16), address: addresses, topics: [topics] },
          ])
        : [];
      if (!Array.isArray(logs)) throw new Error("eth_getLogs 回應不是陣列");
    } catch (e) {
      if (isRangeError(e) && out.range > 1) {
        out.range = Math.max(1, Math.floor(out.range / 2));
        rangeError = e;
        continue;
      }
      out.error = e;
      break;
    }
    rangeError = null;
    out.findings.push(...logFindings({ config, env, state, now, logs, index, explorer }));
    out.nextCheckpoint = to;
    out.scanned += to - cursor + 1;
    cursor = to + 1;
  }
  // 範圍一路減半、額度用完仍沒有任何一段成功：這是失敗，不是「還在追」。
  if (!out.error && rangeError && out.scanned === 0) out.error = rangeError;
  out.lagBlocks = latest - (cursor - 1);
  return out;
}

/** 把一段 eth_getLogs 的結果轉成 findings（並記入累計視窗）。 */
function logFindings({ config, env, state, now, logs, index, explorer }) {
  const findings = [];
  for (const log of logs) {
    if (log.removed) continue;
    const hits = index.get(`${lc(log.address)}|${lc(log.topics?.[0])}`) ?? [];
    for (const { rule, ev, contract } of hits) {
      const fields = decodeLog(ev.inputs, log, { ...config.roleNames, ...config.assetLabels });
      const where = `${log.transactionHash}:${Number(BigInt(log.logIndex ?? "0x0"))}`;
      const lines = [
        `合約：${contract.ref} ${contract.address}`,
        `事件：${ev.sig.split("(")[0]}(${fields.map((f) => `${f.name}=${f.value}`).join(", ")})`,
        `區塊：${Number(BigInt(log.blockNumber))}`,
        `tx：${explorer}/tx/${log.transactionHash}`,
      ];
      if (rule.amount) {
        const f = fields.find((x) => x.name === rule.amount.param);
        if (!f || f.raw === undefined) continue;
        const dec = rule.amount.decimals;
        const single = toUnits(param(config, env, rule.amount.threshold), dec);
        recordWindow(state, rule, f.raw, now);
        lines.splice(2, 0, `金額：${formatUnits(f.raw, dec)}（單筆門檻 ${formatUnits(single, dec)}）`);
        if (f.raw < single) continue;
      }
      findings.push({ ...finding(rule, `${rule.id}:${where}`, rule.severity, rule.title, lines), once: true });
    }
  }
  return findings;
}

/** 累計視窗：同一規則在 windowSec 內的金額加總（KV 狀態，只存 [秒, 金額字串]）。 */
function recordWindow(state, rule, amount, now) {
  if (!rule.amount?.windowThreshold) return;
  state.windows ??= {};
  const arr = (state.windows[rule.id] ??= []);
  arr.push([now, amount.toString()]);
}
export function windowFindings({ config, env, state, now }) {
  const out = [];
  for (const rule of config.rules.filter((r) => r.kind === "event" && isActive(r) && r.amount?.windowThreshold)) {
    const windowSec = numParam(config, env, rule.amount.windowSec);
    const arr = (state.windows?.[rule.id] ?? []).filter(([t]) => now - t < windowSec);
    if (state.windows) state.windows[rule.id] = arr;
    const sum = arr.reduce((s, [, a]) => s + BigInt(a), 0n);
    const dec = rule.amount.decimals;
    const limit = toUnits(param(config, env, rule.amount.windowThreshold), dec);
    if (sum >= limit) {
      out.push(
        finding(rule, `${rule.id}:window`, rule.severity, `${rule.title}（累計）`, [
          `${Math.round(windowSec / 60)} 分鐘內累計 ${formatUnits(sum, dec)}，${arr.length} 筆（門檻 ${formatUnits(limit, dec)}）`,
          `合約：${rule.contracts.map((c) => `${c.ref} ${c.address}`).join("、")}`,
        ]),
      );
    }
  }
  return out;
}

// ── state 規則 ───────────────────────────────────────────────────────────────

const checks = {
  /** 價格新鮮度：crypto 以交易所 maxPriceAge 為硬上限、ORACLE_STALE_WARN_SEC 預警；其他資產放寬（休市）。 */
  async oracleStaleness({ rule, config, env, rpc, now }) {
    const reqs = [callReq(rule, "exchange", "maxPriceAge()")];
    for (const s of rule.assets) reqs.push(callReq(rule, "oracle", "getPrice(bytes32)", [assetId(config, s)]));
    const res = await rpc.batch(reqs);
    if (res[0].error) throw new Error(`maxPriceAge 讀取失敗：${res[0].error}`);
    const maxAge = Number(words(res[0].result)[0]);
    const warn = numParam(config, env, "ORACLE_STALE_WARN_SEC");
    const nonCrypto = numParam(config, env, "NONCRYPTO_STALE_SEC");
    const out = [];
    const unreadable = [];
    rule.assets.forEach((sym, i) => {
      const r = res[i + 1];
      const w = r.error ? [] : words(r.result);
      if (w.length < 2) return unreadable.push(sym);
      const age = now - Number(w[1]);
      const crypto = (rule.cryptoAssets ?? []).includes(sym);
      const h = (s) => `${(s / 3600).toFixed(1)}h`;
      let sev = null;
      let why = "";
      if (crypto && age >= maxAge) [sev, why] = ["SEV-2", `超過交易所 maxPriceAge ${h(maxAge)}，開平倉與清算會 revert`];
      else if (crypto && age >= warn) [sev, why] = ["SEV-3", `超過預警門檻 ${h(warn)}（硬上限 ${h(maxAge)}）`];
      else if (!crypto && age >= nonCrypto) [sev, why] = ["SEV-3", `超過非加密資產門檻 ${h(nonCrypto)}（已排除一般休市）`];
      if (sev) {
        out.push(finding(rule, `${rule.id}:${sym}`, sev, `${rule.title}：${sym}`, [
          `${sym} 價格 ${h(age)} 未更新；${why}`,
          `oracle：${contractOf(rule, "oracle").address}`,
        ]));
      }
    });
    if (unreadable.length * 2 > rule.assets.length) throw new Error(`多數資產讀不到價格：${unreadable.join(",")}`);
    return out;
  },

  /** 價格偏離：主 oracle 與參考來源（Chainlink/Pyth 聚合）相差超過門檻。參考來源不支援或過期的資產略過。 */
  async oracleDeviation({ rule, config, env, rpc, now }) {
    const reqs = [];
    for (const s of rule.assets) {
      reqs.push(callReq(rule, "primary", "getPrice(bytes32)", [assetId(config, s)]));
      reqs.push(callReq(rule, "reference", "getPrice(bytes32)", [assetId(config, s)]));
    }
    const res = await rpc.batch(reqs);
    const warnBps = BigInt(numParam(config, env, "ORACLE_DEVIATION_BPS"));
    const critBps = BigInt(numParam(config, env, "ORACLE_DEVIATION_CRIT_BPS"));
    const refMaxAge = numParam(config, env, "REFERENCE_MAX_AGE_SEC");
    const out = [];
    let compared = 0;
    let primaryErrors = 0;
    rule.assets.forEach((sym, i) => {
      const p = res[2 * i];
      const r = res[2 * i + 1];
      if (p.error) return void primaryErrors++;
      if (r.error) return; // 參考來源沒有這個資產的 feed：不是事故
      const [pp] = words(p.result);
      const [rp, rAt] = words(r.result);
      if (!rp || rp === 0n || now - Number(rAt) > refMaxAge) return;
      compared++;
      const diff = pp > rp ? pp - rp : rp - pp;
      const bps = (diff * 10000n) / rp;
      if (bps >= warnBps) {
        const sev = bps >= critBps ? "SEV-1" : "SEV-2";
        out.push(finding(rule, `${rule.id}:${sym}`, sev, `${rule.title}：${sym}`, [
          `${sym} 主 oracle ${formatUnits(pp, 8)} vs 參考 ${formatUnits(rp, 8)}，偏離 ${(Number(bps) / 100).toFixed(2)}%（門檻 ${Number(warnBps) / 100}%／嚴重 ${Number(critBps) / 100}%）`,
          `主：${contractOf(rule, "primary").address}　參考：${contractOf(rule, "reference").address}`,
        ]));
      }
    });
    if (primaryErrors * 2 > rule.assets.length) throw new Error("多數資產讀不到主 oracle 價格");
    return out;
  },

  /** GuardedOracle 是否被 guardian 暫停。 */
  async guardedOraclePaused({ rule, rpc }) {
    const [r] = await rpc.batch([callReq(rule, "oracle", "paused()")]);
    if (r.error) throw new Error(`paused() 讀取失敗：${r.error}`);
    if (words(r.result)[0] === 0n) return [];
    return [finding(rule, `${rule.id}`, rule.severity, rule.title, [
      `GuardedOracle ${contractOf(rule, "oracle").address} 處於暫停（不再接受價格更新；讀取在 maxPriceAge 內仍可用）`,
    ])];
  },

  /** 保險金：低於絕對下限，或較 24 小時內高點下跌超過門檻。高點存在 KV。 */
  async insuranceFund({ rule, config, env, rpc, state, now }) {
    const [r] = await rpc.batch([callReq(rule, "vault", "totalAssets()")]);
    if (r.error) throw new Error(`totalAssets() 讀取失敗：${r.error}`);
    const assets = words(r.result)[0];
    const dec = rule.decimals;
    const min = toUnits(param(config, env, "INSURANCE_MIN_USDC"), dec);
    const dropBps = BigInt(numParam(config, env, "INSURANCE_DROP_BPS"));
    // 每小時一個桶、只存該小時的最大值，保留 24 個桶：KV 大小固定，高點不漏。
    state.samples ??= {};
    const hour = Math.floor(now / 3600);
    const buckets = Object.fromEntries(
      Object.entries(state.samples[rule.id] ?? {}).filter(([h]) => hour - Number(h) < 24),
    );
    const prev = buckets[hour] !== undefined ? BigInt(buckets[hour]) : -1n;
    if (assets > prev) buckets[hour] = assets.toString();
    state.samples[rule.id] = buckets;
    const peak = Object.values(buckets).reduce((m, a) => (BigInt(a) > m ? BigInt(a) : m), 0n);
    const out = [];
    const addr = contractOf(rule, "vault").address;
    if (assets < min) {
      out.push(finding(rule, `${rule.id}:min`, "SEV-2", `${rule.title}：低於下限`, [
        `保險金 ${formatUnits(assets, dec)}，低於下限 ${formatUnits(min, dec)}`,
        `InsuranceVault：${addr}`,
      ]));
    }
    if (peak > 0n && (peak - assets) * 10000n >= peak * dropBps && assets < peak) {
      out.push(finding(rule, `${rule.id}:drop`, "SEV-2", `${rule.title}：24 小時內大幅下降`, [
        `保險金 ${formatUnits(assets, dec)}，24 小時內高點 ${formatUnits(peak, dec)}，下降 ${(Number(((peak - assets) * 10000n) / peak) / 100).toFixed(2)}%（門檻 ${Number(dropBps) / 100}%）`,
        `InsuranceVault：${addr}`,
      ]));
    }
    return out;
  },

  /** 代幣化金庫：儲備率對 minReserveRatioBps、mint 自動停止、暫停、定價缺口。 */
  async vaultReserve({ rule, config, env, rpc }) {
    const [st, min, paused] = await rpc.batch([
      callReq(rule, "vault", "reserveStatus()"),
      callReq(rule, "vault", "minReserveRatioBps()"),
      callReq(rule, "vault", "paused()"),
    ]);
    if (st.error) throw new Error(`reserveStatus() 讀取失敗：${st.error}`);
    if (min.error) throw new Error(`minReserveRatioBps() 讀取失敗：${min.error}`);
    const [reserve, liability, ratioBps, unpriced, stale, halted] = words(st.result);
    const minBps = words(min.result)[0];
    const margin = BigInt(numParam(config, env, "RESERVE_WARN_MARGIN_BPS"));
    const addr = contractOf(rule, "vault").address;
    const ratioText = liability === 0n ? "無流通（∞）" : `${(Number(ratioBps) / 100).toFixed(2)}%`;
    const dec = rule.decimals;
    const ctx = `儲備 ${formatUnits(reserve, dec)}／負債 ${formatUnits(liability, dec)}，儲備率 ${ratioText}，下限 ${(Number(minBps) / 100).toFixed(2)}%`;
    const out = [];
    if (liability > 0n && ratioBps < minBps) {
      out.push(finding(rule, `${rule.id}:below-min`, "SEV-2", `${rule.title}：低於下限`, [ctx, `AssetVaultV2：${addr}`]));
    } else if (liability > 0n && ratioBps < minBps + margin) {
      out.push(finding(rule, `${rule.id}:near-min`, "SEV-3", `${rule.title}：接近下限`, [ctx, `AssetVaultV2：${addr}`]));
    }
    if (halted !== 0n) out.push(finding(rule, `${rule.id}:halted`, "SEV-2", `${rule.title}：mint 已自動停止`, [ctx, `AssetVaultV2：${addr}`]));
    if (stale !== 0n) {
      out.push(finding(rule, `${rule.id}:unpriced`, "SEV-3", `${rule.title}：${unpriced} 個資產無法定價`, [
        `儲備率不可信（有資產讀不到價格）`, ctx, `AssetVaultV2：${addr}`,
      ]));
    }
    if (!paused.error && words(paused.result)[0] !== 0n) {
      out.push(finding(rule, `${rule.id}:paused`, "SEV-3", `${rule.title}：金庫暫停中`, [`mint 與 redeem 均停止`, `AssetVaultV2：${addr}`]));
    }
    return out;
  },

  /**
   * 接線：getter 讀到的位址必須等於預期值（addresses.ts 的位址、零位址、或部署時的鏈上快照）。
   * 為什麼用輪詢：已部署的 InsuranceVault／FeeRouter 的 setter **不發事件**（事件是 master 原始碼
   * 後來才加的），事件規則永遠不會響（審查 H2）。預期值由 check-monitoring.mjs 產生並對照鏈上快照。
   */
  async wiring({ rule, rpc }) {
    const calls = rule.calls ?? [];
    const res = await rpc.batch(calls.map((c) => callReq(rule, c.on, c.fn)));
    const out = [];
    const failed = [];
    calls.forEach((c, i) => {
      const k = contractOf(rule, c.on);
      const name = `${k.ref}.${c.fn}`;
      const w = res[i].error ? [] : words(res[i].result);
      if (!w.length || !c.expected) return failed.push(`${name}：${res[i].error ?? (c.expected ? "空回應" : "缺少 expected")}`);
      const actual = wordToAddress(w[0]);
      if (lc(actual) === lc(c.expected)) return;
      const why = c.expect?.ref ? `前端設定的 ${c.expect.ref}` : c.expect?.zero ? "零位址" : "部署時的鏈上快照";
      out.push(finding(rule, `${rule.id}:${name}`, rule.severity, `${rule.title}：${name}`, [
        `${name} 現在是 ${actual}，預期 ${c.expected}（${why}）`,
        `合約：${k.ref} ${k.address}`,
        "部署版的 setter 不發事件，這是每輪讀 getter 比對出來的；請立即確認是否為預期變更",
      ]));
    });
    if (failed.length) throw partial(`接線讀取失敗：${failed.join("；")}`, out);
    return out;
  },

  /** keeper 錢包 gas 餘額。keeper = MockOracle.owner()（不手抄位址），另可用 EXTRA_GAS_WALLETS 補。 */
  async gasBalance({ rule, config, env, rpc }) {
    const [own] = await rpc.batch([callReq(rule, "oracle", "owner()")]);
    if (own.error) throw new Error(`owner() 讀取失敗：${own.error}`);
    const wallets = [{ label: "keeper（MockOracle.owner）", address: wordToAddress(words(own.result)[0]) }];
    for (const a of String(env?.EXTRA_GAS_WALLETS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`EXTRA_GAS_WALLETS 含不合法位址：${a}`);
      wallets.push({ label: "額外錢包", address: a });
    }
    const res = await rpc.batch(wallets.map((w) => ({ method: "eth_getBalance", params: [w.address, "latest"] })));
    const warn = toUnits(param(config, env, "GAS_MIN_ETH"), 18);
    const crit = toUnits(param(config, env, "GAS_CRIT_ETH"), 18);
    const out = [];
    wallets.forEach((w, i) => {
      if (res[i].error) throw new Error(`eth_getBalance 失敗：${res[i].error}`);
      const bal = BigInt(res[i].result);
      if (bal < warn) {
        out.push(finding(rule, `${rule.id}:${lc(w.address)}`, bal < crit ? "SEV-2" : "SEV-3", `${rule.title}：${w.label}`, [
          `${w.label} ${w.address} 餘額 ${formatUnits(bal, 18, 4)} ETH（預警 ${formatUnits(warn, 18, 4)}／嚴重 ${formatUnits(crit, 18, 4)}）`,
          `餘額耗盡時 keeper 無法寫價，價格會在 maxPriceAge 後過期`,
        ]));
      }
    });
    return out;
  },
};

// ── http 規則 ────────────────────────────────────────────────────────────────

const httpChecks = {
  /** GET /healthz 應回 200 "ok"；連續失敗 HTTP_FAILS_BEFORE_ALERT 次才告警（避免單次抖動）。 */
  async httpHealth({ rule, config, env, fetchImpl, state }) {
    const base = param(config, env, "SIGNAL_API_URL").replace(/\/$/, "");
    const url = `${base}${rule.path}`;
    let ok = false;
    let why = "";
    try {
      const res = await fetchWithTimeout(fetchImpl, url, { method: "GET" }, 10_000);
      const body = (await res.text()).trim();
      ok = res.status === 200 && body === (rule.expectBody ?? "ok");
      if (!ok) why = `HTTP ${res.status}，內容 ${JSON.stringify(body.slice(0, 40))}`;
    } catch (e) {
      why = `連線失敗：${String(e.message ?? e).slice(0, 80)}`;
    }
    state.httpFails ??= {};
    state.httpFails[rule.id] = ok ? 0 : (state.httpFails[rule.id] ?? 0) + 1;
    const need = numParam(config, env, "HTTP_FAILS_BEFORE_ALERT");
    if (ok || state.httpFails[rule.id] < need) return [];
    return [finding(rule, rule.id, rule.severity, rule.title, [`${url} ${why}（連續 ${state.httpFails[rule.id]} 次）`])];
  },

  /** GET / 的 payTo 與 payToSafety：收款地址變更或守門判定不安全。 */
  async x402PayTo({ rule, config, env, fetchImpl, state }) {
    const base = param(config, env, "SIGNAL_API_URL").replace(/\/$/, "");
    const res = await fetchWithTimeout(fetchImpl, `${base}/`, { method: "GET" }, 10_000);
    if (!res.ok) throw new Error(`GET / 回 HTTP ${res.status}`);
    const j = await res.json();
    const payTo = String(j?.payTo ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error("GET / 沒有合法的 payTo");
    const out = [];
    const expected = String(env?.EXPECTED_PAY_TO ?? "").trim();
    state.baselines ??= {};
    const baseline = expected || state.baselines[rule.id];
    if (!expected && !state.baselines[rule.id]) state.baselines[rule.id] = payTo; // 首次觀察即基準
    if (baseline && lc(baseline) !== lc(payTo)) {
      out.push(finding(rule, `${rule.id}:changed`, "SEV-1", `${rule.title}：收款地址變更`, [
        `signal-api 的 payTo 由 ${baseline} 變成 ${payTo}`,
        expected ? "基準來自 EXPECTED_PAY_TO" : "基準來自首次觀察（建議設定 EXPECTED_PAY_TO）",
        "若為預期變更：更新 EXPECTED_PAY_TO（或清除 KV 基準）",
      ]));
    }
    if (j?.payToSafety && j.payToSafety.safe === false) {
      out.push(finding(rule, `${rule.id}:unsafe`, "SEV-3", `${rule.title}：收款守門判定不安全`, [
        `payToSafety.safe=false（${String(j.payToSafety.reason ?? "").slice(0, 120)}）；付費端點會回 503`,
      ]));
    }
    return out;
  },
};

// ── 告警狀態機 ───────────────────────────────────────────────────────────────

/**
 * 把本輪 findings 與 KV 裡的開啟中告警比對，產出要送的通知。
 *   once（event）      → 每筆都送一次。
 *   condition 新出現   → 「觸發」
 *   condition 持續     → 嚴重度升級或超過 REMIND_SEC 才「持續」提醒
 *   condition 消失     → 只有在該規則本輪「成功評估」時才「恢復」（RPC 失敗不等於恢復）
 */
export function reconcile({ config, env, state, findings, evaluated, now }) {
  const remind = numParam(config, env, "REMIND_SEC");
  state.open ??= {};
  const notes = [];
  const seen = new Set();
  for (const f of findings) {
    if (f.once) {
      notes.push({ ...f, status: "事件" });
      continue;
    }
    seen.add(f.key);
    const prev = state.open[f.key];
    if (!prev) {
      state.open[f.key] = { ruleId: f.ruleId, severity: f.severity, since: now, lastNotified: now, title: f.title };
      notes.push({ ...f, status: "觸發" });
    } else if (sevRank(f.severity) < sevRank(prev.severity) || now - prev.lastNotified >= remind) {
      const since = prev.since;
      state.open[f.key] = { ...prev, severity: worse(f.severity, prev.severity), lastNotified: now };
      notes.push({ ...f, status: "持續", lines: [...f.lines, `自 ${new Date(since * 1000).toISOString()} 起`] });
    }
  }
  for (const [key, prev] of Object.entries(state.open)) {
    if (seen.has(key) || !evaluated.has(prev.ruleId)) continue;
    delete state.open[key];
    notes.push({ ruleId: prev.ruleId, key, severity: "SEV-4", origSeverity: prev.severity, status: "恢復", title: prev.title, lines: [
      `持續 ${Math.round((now - prev.since) / 60)} 分鐘後恢復（原嚴重度 ${prev.severity}）`,
    ] });
  }
  return notes;
}

// ── 一輪 ─────────────────────────────────────────────────────────────────────

/**
 * 執行一輪監控。state 會被就地更新（呼叫端負責存回 KV）。
 * 回傳 { notes, errors, summary }：errors 是規則或掃描本身失敗的訊息（監控自己壞了）。
 */
export async function runOnce({ config, env = {}, state, fetchImpl, now = Math.floor(Date.now() / 1000), log = () => {} }) {
  const rpcUrl = String(env.RPC_URL ?? "").trim() || config.network.publicRpc;
  const rpc = makeRpc(rpcUrl, fetchImpl);
  const findings = [];
  const evaluated = new Set();
  const errors = [];
  const fail = (id, e) => {
    const msg = `${id}: ${String(e?.message ?? e).slice(0, 200)}`;
    errors.push(msg);
    log(`ERROR ${msg}`);
  };

  // event
  try {
    const r = await scanEvents({ config, env, rpc, state, now });
    findings.push(...r.findings);
    state.checkpoint = r.nextCheckpoint;
    log(`events: 掃描 ${r.scanned} 個區塊（${r.requests} 個請求、每段 ${r.range} 塊），${r.findings.length} 則，落後 ${r.lagBlocks} 塊`);
    if (r.error) fail("event-scan", r.error);
    else for (const rule of config.rules.filter((x) => x.kind === "event" && isActive(x))) evaluated.add(rule.id);
    if (r.lagBlocks > numParam(config, env, "LAG_ALERT_BLOCKS")) {
      findings.push({ ruleId: "monitor-self", key: "monitor-self:lag", severity: "SEV-3", title: "監控落後", lines: [
        `事件掃描落後 ${r.lagBlocks} 個區塊（每輪最多 ${param(config, env, "MAX_SCAN_REQUESTS")} 個請求 × ${r.range} 塊），告警會延遲`,
      ] });
    }
  } catch (e) {
    fail("event-scan", e);
  }
  findings.push(...windowFindings({ config, env, state, now }));

  // state + http
  for (const rule of config.rules.filter((x) => (x.kind === "state" || x.kind === "http") && isActive(x))) {
    const fn = rule.kind === "state" ? checks[rule.check] : httpChecks[rule.check];
    if (!fn) {
      fail(rule.id, new Error(`未知的檢查 ${rule.check}`));
      continue;
    }
    try {
      findings.push(...(await fn({ rule, config, env, rpc, fetchImpl, state, now })));
      evaluated.add(rule.id);
    } catch (e) {
      if (Array.isArray(e?.findings)) findings.push(...e.findings); // 部分失敗：已算出的照送
      fail(rule.id, e);
    }
  }

  // 監控自身：有規則讀不到時開一則（恢復時自動關閉）。
  evaluated.add("monitor-self");
  if (errors.length) {
    findings.push({ ruleId: "monitor-self", key: "monitor-self:errors", severity: "SEV-3", title: "監控本身有規則讀取失敗", lines: errors.slice(0, 8) });
  }
  const notes = reconcile({ config, env, state, findings, evaluated, now });
  state.lastRunAt = now;
  return { notes, errors, summary: { findings: findings.length, notes: notes.length, errors: errors.length } };
}

export const _internal = { checks, httpChecks, short };
