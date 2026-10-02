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
// 讀取方法只有 eth_blockNumber／eth_getLogs／eth_call／eth_getBalance／eth_getBlockByNumber／
// eth_getStorageAt（讀 EIP-1967 實作 slot）。

import { MAX_ALERT_DELAY_ROUNDS, MIN_SEVERITY_ALLOWED, PARAM_SPECS, SEVERITIES, envSecret, envSetting, envSettingProblems, resolveParams } from "./params.mjs";

export { MAX_ALERT_DELAY_ROUNDS, MIN_SEVERITY_ALLOWED, SEVERITIES };
const sevRank = (s) => {
  const i = SEVERITIES.indexOf(s);
  return i < 0 ? SEVERITIES.length : i;
};
/** 兩個嚴重度取較嚴重的。 */
export const worse = (a, b) => (sevRank(a) <= sevRank(b) ? a : b);

// ── 參數 ─────────────────────────────────────────────────────────────────────
// 型別、上下限與組合限制的單一來源是 params.mjs（CI 與執行期共用，複審 M-1）。

/**
 * 參數值（字串）：Worker 環境變數優先，否則 monitors.json 的預設值；**照 PARAM_SPECS 夾值**。
 * 只認 PARAM_SPECS 裡的名字——新增參數必須先在表裡定義上下限。
 */
export function param(config, env, name) {
  if (!PARAM_SPECS[name]) throw new Error(`未定義的參數 ${name}（不在 params.mjs 的 PARAM_SPECS）`);
  return String(resolveParams(config, env).values[name]);
}
/** 數值參數（已夾值）。 */
export const numParam = (config, env, name) => Number(param(config, env, name));
/** 執行期的有效 MIN_SEVERITY（SEV-1 或不合法時用 SEV-2）。 */
export function minSeverityOf(config, env) {
  return param(config, env, "MIN_SEVERITY");
}
/**
 * 執行期設定問題（不經 CI 的覆寫值）：回傳文字陣列。tick 把它們變成一則 monitor-self:config 告警
 * ——設定被調成「等於關掉告警」或格式不對時，值班的人要知道，而且 Worker 照常以夾住後的值運作。
 */
export function configProblems(config, env) {
  const rpc = rpcUrlOf(config, env);
  return [...resolveParams(config, env).problems, ...envSettingProblems(env), ...(rpc.problem ? [rpc.problem] : [])];
}
const isHttpsUrl = (v) => {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};
/**
 * RPC 端點：Worker secret RPC_URL（可含 API key），沒設或格式不對時用 network.publicRpc。格式不對時
 * 不丟錯（丟錯等於整輪停擺、SEV-1 送不出去），改用公開 RPC 並回報（不顯示值：URL 可能含金鑰）。
 */
export function rpcUrlOf(config, env) {
  const v = envSecret(env, "RPC_URL");
  if (!v) return { url: config.network.publicRpc };
  if (isHttpsUrl(v)) return { url: v };
  return { url: config.network.publicRpc, problem: "RPC_URL 不是 https:// 開頭的合法 URL（值不顯示），改用公開 RPC" };
}
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
/**
 * 把文字裡的 URL 縮成「協定＋主機」。錯誤訊息會進告警與 log；含金鑰的 RPC URL、心跳 URL、webhook
 * 的秘密都在路徑或查詢字串裡，不可以跟著錯誤訊息流出去（審查 L5）。
 */
export const redactUrls = (text) =>
  String(text ?? "").replace(/\b(https?:\/\/)([^\s/"'<>?#]+)([^\s"'<>]*)/gi, (_m, scheme, host, rest) =>
    rest && rest !== "/" ? `${scheme}${host.replace(/^[^@]*@/, "")}/…` : `${scheme}${host.replace(/^[^@]*@/, "")}${rest}`,
  );
/** 設定的 URL 必須是 https（明文 http 會把金鑰與告警內容送過不加密的連線）。丟錯時不帶 URL 本身。 */
export function assertHttps(name, value) {
  let u = null;
  try {
    u = new URL(String(value));
  } catch {
    /* 不是合法 URL */
  }
  if (!u || u.protocol !== "https:") throw new Error(`${name} 必須是 https:// 開頭的合法 URL`);
  return u;
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
 * 其他節點常見的是 -32005「query returned more than 10000 results」（-32005 本身不算：有些節點的
 * 限流也用這個碼，那要退避重試而不是縮小範圍）。
 */
export function isRangeError(e) {
  // -32602「block range extends beyond current head block」：負載平衡後面的節點落後，不是範圍太大。
  // 縮小範圍沒有用（也浪費請求），要當成暫時性錯誤退避重試（複審 Info）。
  if (isBeyondHead(e)) return false;
  if (e?.status === 413 || e?.code === -32614) return true;
  return /limited to a|block range|range (?:is )?too (?:large|wide)|exceeds? .*range|more than \d[\d,]* results|response size|too many results/i.test(
    String(e?.message ?? ""),
  );
}

/** 節點的 head 比我們要的 toBlock 舊（負載平衡後面有落後的節點）。 */
export const isBeyondHead = (e) => /beyond (?:the )?current head|extends beyond|header not found|unknown block/i.test(String(e?.message ?? ""));

/**
 * 暫時性失敗：限流、5xx、逾時、連線錯誤。退避後重送通常就過，不值得吵醒人（審查 M3：公開 RPC
 * 每秒 25 個請求，超過回 HTTP 429 或逐筆的 -32007）。範圍被拒不在此列——那要縮小範圍，不是重送。
 */
export function isTransient(e) {
  if (isBeyondHead(e)) return true;
  if (isRangeError(e)) return false;
  if (e?.transient) return true;
  if (e?.status === 429 || (e?.status >= 500 && e?.status <= 599)) return true;
  if (e?.code === -32007) return true;
  return /rate.?limit|limit reached|too many requests|request rate|timed? ?out|temporarily unavailable/i.test(String(e?.message ?? e?.error ?? ""));
}

/** EIP-1967 implementation slot：keccak256("eip1967.proxy.implementation") − 1。 */
export const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    return await fetchImpl(url, ctl ? { ...init, signal: ctl.signal } : init);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 重試前的等待（毫秒）：第一次 400、第二次 1200。 */
const BACKOFF_MS = [400, 1200];

/**
 * RPC 用戶端。batch() 一次送多個請求（省 Worker 的 subrequest 配額）；節點不支援
 * batch（回非陣列）時退回逐筆。每個結果是 {result} 或 {error}，單筆失敗不影響其他筆。
 *
 *   • 暫時性失敗退避重試，每個請求最多 retries 次、整輪合計最多 retryBudget 次（subrequest 有限：
 *     RPC 整個掛掉時不能讓每個請求都重試到底）。
 *   • 節流：一秒內送出的呼叫數（batch 內逐筆計）不超過 callsPerSec，超過就先等。公開 RPC 的上限
 *     是每秒 25 個，batch 裡超過的那幾筆會各自回 -32007——那幾筆也會被重送。
 */
export function makeRpc(url, fetchImpl, { timeoutMs = 15_000, retries = 2, retryBudget = 6, callsPerSec = 20, sleep = realSleep, clock = Date.now } = {}) {
  let nextId = 1;
  const stats = { requests: 0, retries: 0 };
  let budget = retryBudget;
  const stamps = []; // 最近送出的每個呼叫的時間（毫秒）
  const pace = async (n) => {
    const now = clock();
    while (stamps.length && now - stamps[0] >= 1000) stamps.shift();
    const over = Math.min(stamps.length, stamps.length + n - callsPerSec);
    if (over > 0) {
      await sleep(Math.max(0, stamps[over - 1] + 1000 - now) + 10);
      stamps.splice(0, over);
    }
    const t = clock();
    for (let i = 0; i < n; i++) stamps.push(t);
  };
  const postOnce = async (body) => {
    let res;
    try {
      res = await fetchWithTimeout(
        fetchImpl,
        url,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        timeoutMs,
      );
    } catch (e) {
      const aborted = e?.name === "AbortError" || /abort/i.test(String(e?.message ?? ""));
      throw Object.assign(new RpcError(aborted ? `RPC 逾時（${timeoutMs / 1000} 秒）` : `RPC 連線失敗：${clip(redactUrls(e?.message ?? e), 80)}`), { transient: true });
    }
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
      throw new RpcError(`RPC HTTP ${res.status}${text.trim() ? `：${clip(redactUrls(text), 200)}` : ""}`, { status: res.status, code });
    }
    try {
      return await res.json();
    } catch {
      throw Object.assign(new RpcError("RPC 回應不是 JSON"), { transient: true });
    }
  };
  /** 可以再試一次嗎（同時扣整輪額度）。 */
  const mayRetry = (attempt) => {
    if (attempt >= retries || budget <= 0) return false;
    budget--;
    stats.retries++;
    return true;
  };
  const post = async (body) => {
    for (let attempt = 0; ; attempt++) {
      await pace(Array.isArray(body) ? body.length : 1);
      stats.requests++;
      try {
        return await postOnce(body);
      } catch (e) {
        if (!isTransient(e) || !mayRetry(attempt)) throw e;
        await sleep(BACKOFF_MS[attempt] ?? 1200);
      }
    }
  };
  const one = async (method, params) => {
    for (let attempt = 0; ; attempt++) {
      const j = await post({ jsonrpc: "2.0", id: nextId++, method, params });
      if (!j?.error) return j?.result;
      const err = new RpcError(`RPC ${method}: ${clip(redactUrls(j.error.message ?? "error"), 160)}`, { code: j.error.code });
      if (!isTransient(err) || !mayRetry(attempt)) throw err;
      await sleep(BACKOFF_MS[attempt] ?? 1200);
    }
  };
  const batch = async (reqs) => {
    if (reqs.length === 0) return [];
    const out = new Array(reqs.length).fill(null);
    let todo = reqs.map((_, i) => i);
    for (let attempt = 0; todo.length; attempt++) {
      const body = todo.map((i) => ({ jsonrpc: "2.0", id: nextId++, method: reqs[i].method, params: reqs[i].params }));
      const j = await post(body);
      if (!Array.isArray(j)) {
        // 節點不支援 batch：逐筆（各自有重試）。
        for (const i of todo) {
          try {
            out[i] = { result: await one(reqs[i].method, reqs[i].params) };
          } catch (e) {
            out[i] = { error: e.message, code: e.code };
          }
        }
        break;
      }
      const byId = new Map(j.map((x) => [x.id, x]));
      const again = [];
      todo.forEach((i, k) => {
        const x = byId.get(body[k].id);
        if (!x) out[i] = { error: "RPC 回應缺少此筆" };
        else if (x.error) {
          out[i] = { error: clip(redactUrls(x.error.message ?? "error"), 160), code: x.error.code };
          if (isTransient({ code: x.error.code, message: x.error.message })) again.push(i);
        } else out[i] = { result: x.result };
      });
      // batch 裡被限流的那幾筆單獨重送（其餘已經有結果）。
      if (!again.length || !mayRetry(attempt)) break;
      await sleep(BACKOFF_MS[attempt] ?? 1200);
      todo = again;
    }
    return out;
  };
  return { call: one, batch, stats };
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
  const balances = new Map(); // 相對門檻用的合約餘額（一輪內只讀一次）
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
    out.findings.push(...(await logFindings({ config, env, state, now, logs, index, explorer, rpc, balances })));
    out.nextCheckpoint = to;
    out.scanned += to - cursor + 1;
    cursor = to + 1;
  }
  // 範圍一路減半、額度用完仍沒有任何一段成功：這是失敗，不是「還在追」。
  if (!out.error && rangeError && out.scanned === 0) out.error = rangeError;
  out.lagBlocks = latest - (cursor - 1);
  return out;
}

/**
 * 把一段 eth_getLogs 的結果轉成 findings（並記入累計視窗）。
 *
 * 金額規則有兩個門檻，任一成立就告警：
 *   • 絕對門檻（amount.threshold）。
 *   • 相對門檻（amount.relativeBps，審查 M6）：單筆 ≥ 合約「提領前」餘額的某個比例。絕對門檻是
 *     佔位值，實測比合約的全部餘額還高（exchange 只有 500 MockUSDC、門檻 10,000），等於永遠不響。
 *     提領前餘額 ≈ 當下 balanceOf ＋ 本段同一合約的提領合計。餘額讀不到時只用絕對門檻。
 * 累計視窗用**區塊時間**（log 的 blockTimestamp，沒有就查區塊）：落後追趕時，幾小時前的提領
 * 不該被算進「最近一小時」（審查 L1）。
 */
async function logFindings({ config, env, state, now, logs, index, explorer, rpc, balances }) {
  const entries = [];
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
      let raw;
      if (rule.amount) {
        const f = fields.find((x) => x.name === rule.amount.param);
        if (!f || f.raw === undefined) continue;
        raw = f.raw;
      }
      const at = log.blockTimestamp !== undefined && log.blockTimestamp !== null ? Number(BigInt(log.blockTimestamp)) : undefined;
      entries.push({ rule, contract, log, lines, raw, key: `${rule.id}:${where}`, at, fields, ev });
    }
  }
  const amounts = entries.filter((e) => e.rule.amount);
  const times = await blockTimes(amounts.filter((e) => e.rule.amount.windowThreshold), rpc, now);
  await readBalances(amounts.filter((e) => e.rule.amount.balanceOf && e.rule.amount.relativeBps), rpc, balances);
  const sums = new Map(); // `${rule.id}|${addr}` → 本段的提領合計
  for (const e of amounts) {
    const k = `${e.rule.id}|${lc(e.contract.address)}`;
    sums.set(k, (sums.get(k) ?? 0n) + e.raw);
  }

  const findings = [];
  for (const e of entries) {
    const a = e.rule.amount;
    if (a) {
      const dec = a.decimals;
      const single = toUnits(param(config, env, a.threshold), dec);
      recordWindow(state, e.rule, e.raw, times.get(e.log.blockNumber) ?? now);
      let hit = e.raw >= single;
      let rel = "";
      if (a.relativeBps && a.balanceOf) {
        const bps = BigInt(Math.floor(numParam(config, env, a.relativeBps)));
        const bal = balances.get(`${lc(a.balanceOf.token)}|${lc(e.contract.address)}`);
        if (bal === undefined || bal === null) rel = "；相對門檻未評估（讀不到合約餘額）";
        else {
          const before = bal + (sums.get(`${e.rule.id}|${lc(e.contract.address)}`) ?? 0n);
          const pct = before > 0n ? (e.raw * 10000n) / before : 0n;
          rel = `；佔合約提領前餘額約 ${(Number(pct) / 100).toFixed(2)}%（相對門檻 ${Number(bps) / 100}%）`;
          if (before > 0n && e.raw * 10000n >= bps * before) hit = true;
        }
      }
      e.lines.splice(2, 0, `金額：${formatUnits(e.raw, dec)}（單筆門檻 ${formatUnits(single, dec)}${rel}）`);
      if (!hit) continue;
    }
    const at = e.at ?? times.get(e.log.blockNumber);
    let severity = e.rule.severity;
    // EIP-1967 Upgraded：與 proxy-implementation（每輪讀實作 slot）互補而不重複（複審 L-c）。
    // 同一次升級先被 slot 檢查以 SEV-1 通報過，這則只補 tx 細節（SEV-3）；反之記下來，讓 slot 檢查降級。
    if (e.ev.sig === "Upgraded(address)") {
      const impl = lc(e.fields.find((f) => f.type === "address")?.value ?? "");
      const proxy = lc(e.contract.address);
      state.upgrades ??= {};
      const rec = state.upgrades[proxy];
      if (rec && rec.impl === impl && rec.by === "slot") {
        severity = "SEV-3";
        e.lines.push("同一次升級已由 proxy-implementation（實作 slot 檢查）以 SEV-1 通報；這則補上交易細節");
      } else state.upgrades[proxy] = { impl, by: "event", at: at ?? now };
    }
    findings.push({ ...finding(e.rule, e.key, severity, e.rule.title, e.lines), once: true, ...(at ? { at } : {}) });
  }
  return findings;
}

/** 區塊時間（秒）：blockNumber(hex) → timestamp。優先用 log 自帶的 blockTimestamp；沒有就批次查區塊；查不到退回 now。 */
async function blockTimes(entries, rpc, now) {
  const out = new Map();
  const missing = new Set();
  for (const e of entries) {
    if (e.log.blockTimestamp !== undefined && e.log.blockTimestamp !== null) out.set(e.log.blockNumber, Number(BigInt(e.log.blockTimestamp)));
    else missing.add(e.log.blockNumber);
  }
  const need = [...missing].filter((b) => !out.has(b));
  if (need.length) {
    let res = [];
    try {
      res = await rpc.batch(need.map((b) => ({ method: "eth_getBlockByNumber", params: [b, false] })));
    } catch {
      /* 查不到區塊時間：用 now（最多把舊提領多算進視窗，不會漏） */
    }
    need.forEach((b, i) => out.set(b, res[i]?.result?.timestamp ? Number(BigInt(res[i].result.timestamp)) : now));
  }
  return out;
}

/** 讀「代幣在合約裡的餘額」，結果放進 balances（`${token}|${holder}` → BigInt，讀不到是 null）。 */
async function readBalances(entries, rpc, balances) {
  const want = new Map();
  for (const e of entries) {
    const k = `${lc(e.rule.amount.balanceOf.token)}|${lc(e.contract.address)}`;
    if (!balances.has(k)) want.set(k, { token: e.rule.amount.balanceOf.token, selector: e.rule.amount.balanceOf.selector, holder: e.contract.address });
  }
  if (!want.size) return;
  const list = [...want];
  let res = [];
  try {
    res = await rpc.batch(list.map(([, w]) => ethCall(w.token, w.selector + encodeArg("address", w.holder))));
  } catch {
    /* 整批失敗：全部當作讀不到 */
  }
  list.forEach(([k], i) => {
    const w = res[i]?.error || !res[i] ? [] : words(res[i].result);
    balances.set(k, w.length ? w[0] : null);
  });
}

/** 累計視窗：同一規則在 windowSec 內的金額加總（KV 狀態，只存 [區塊時間（秒）, 金額字串]）。 */
function recordWindow(state, rule, amount, at) {
  if (!rule.amount?.windowThreshold) return;
  state.windows ??= {};
  const arr = (state.windows[rule.id] ??= []);
  arr.push([at, amount.toString()]);
}
/** 累計視窗的紀錄最多保留幾筆（KV 大小固定）。 */
export const WINDOW_MAX_ENTRIES = 500;
const iso = (t) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

/**
 * 累計提領視窗（以區塊時間計）。兩種告警：
 *   • 即時視窗：最近 windowSec 內（相對於 now）的合計 ≥ 門檻 → 狀態型告警（觸發／持續／恢復）。
 *   • 過去的爆量（複審 L-a）：落後追趕時才掃到的提領，發生時間早於「最近 windowSec」，即時視窗看不到它們；
 *     L1 改用區塊時間後，「停機期間被拆單抽走」反而完全不響。所以對本輪新記入的每一筆，看「以它結尾的
 *     windowSec 滑動視窗」——合計 ≥ 門檻、且視窗裡有即時視窗之外的提領，就發一則一次性告警，
 *     訊息標明發生時間。即時視窗已經在響時不重複發。
 * freshFrom：本輪掃描前各規則的紀錄筆數（之後的是本輪新記入的）。scanTime：掃描進度的區塊時間
 * （落後時比 now 早），紀錄保留到「scanTime − windowSec」，讓跨輪的爆量也接得起來。
 */
export function windowFindings({ config, env, state, now, freshFrom = {}, scanTime = now }) {
  const out = [];
  for (const rule of config.rules.filter((r) => r.kind === "event" && isActive(r) && r.amount?.windowThreshold)) {
    const windowSec = numParam(config, env, rule.amount.windowSec);
    const all = state.windows?.[rule.id] ?? [];
    const fresh = all.slice(freshFrom[rule.id] ?? 0);
    const keepAfter = Math.min(now, scanTime) - windowSec;
    let kept = all.filter(([t]) => t > keepAfter || now - t < windowSec);
    if (kept.length > WINDOW_MAX_ENTRIES) kept = kept.slice(kept.length - WINDOW_MAX_ENTRIES);
    if (state.windows) state.windows[rule.id] = kept;
    const dec = rule.amount.decimals;
    const limit = toUnits(param(config, env, rule.amount.windowThreshold), dec);
    const contractsLine = `合約：${rule.contracts.map((c) => `${c.ref} ${c.address}`).join("、")}`;

    const live = kept.filter(([t]) => now - t < windowSec);
    const sum = live.reduce((s, [, a]) => s + BigInt(a), 0n);
    if (sum >= limit) {
      out.push(
        finding(rule, `${rule.id}:window`, rule.severity, `${rule.title}（累計）`, [
          `${Math.round(windowSec / 60)} 分鐘內累計 ${formatUnits(sum, dec)}，${live.length} 筆（門檻 ${formatUnits(limit, dec)}）`,
          contractsLine,
        ]),
      );
      continue;
    }
    let best = null;
    // 用保留前的全部紀錄：本輪新記入的提領可能早於保留界線（一輪就追完數小時的積欠）。
    const sorted = [...all].sort((x, y) => x[0] - y[0]);
    // 「落後追趕才掃到」＝本輪新記入、但發生時間已經在即時視窗之外的提領（複審 L-1）。正常運作時
    // 每輪掃到的都是最近幾分鐘的提領，不會有這種紀錄，所以不評估過去的爆量——原本的條件是「視窗裡
    // 有任何一筆在即時視窗之外」，穩定的提領流量每小時會多出幾則內容不實的「過去發生」SEV-2。
    const lateScanned = new Set(fresh.filter(([t]) => now - t >= windowSec));
    if (!lateScanned.size) continue;
    for (const [end] of fresh) {
      const inWin = sorted.filter(([t]) => t > end - windowSec && t <= end);
      if (!inWin.some((x) => lateScanned.has(x))) continue; // 視窗裡沒有「落後才掃到」的提領：即時視窗當時就看得到
      const s = inWin.reduce((acc, [, a]) => acc + BigInt(a), 0n);
      if (s >= limit && (!best || s > best.sum)) best = { start: inWin[0][0], end, sum: s, n: inWin.length };
    }
    if (best) {
      out.push({
        ...finding(rule, `${rule.id}:window-past:${best.start}-${best.end}`, rule.severity, `${rule.title}（累計，過去發生）`, [
          `發生時間 ${iso(best.start)} ～ ${iso(best.end)}（區塊時間），${Math.round(windowSec / 60)} 分鐘內累計 ${formatUnits(best.sum, dec)}，${best.n} 筆（門檻 ${formatUnits(limit, dec)}）`,
          `監控落後追趕時才掃到（約 ${Math.round((now - best.end) / 60)} 分鐘前）：這段期間的提領沒有即時告警`,
          contractsLine,
        ]),
        once: true,
        at: best.end,
      });
    }
  }
  return out;
}

// ── state 規則 ───────────────────────────────────────────────────────────────

/**
 * 24 小時高點：每小時一個桶、只存該小時的最大值，保留 24 個桶（KV 大小固定，高點不漏）。
 * 記入這一輪的值後回傳高點。
 */
function peak24h(state, id, value, now) {
  state.samples ??= {};
  const hour = Math.floor(now / 3600);
  const buckets = Object.fromEntries(Object.entries(state.samples[id] ?? {}).filter(([h]) => hour - Number(h) < 24));
  const prev = buckets[hour] !== undefined ? BigInt(buckets[hour]) : -1n;
  if (value > prev) buckets[hour] = value.toString();
  state.samples[id] = buckets;
  return Object.values(buckets).reduce((m, a) => (BigInt(a) > m ? BigInt(a) : m), 0n);
}

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
    // 有資產讀不到：已算出的告警照送（partial），但整條規則不算成功評估——否則「讀不到的那一檔」
    // 原本開著的過期告警會被當成恢復（審查 L3：原本多數讀不到時直接丟例外，連已算出的 SEV-2 也丟了）。
    if (unreadable.length) throw partial(`${unreadable.length}／${rule.assets.length} 檔資產讀不到價格：${unreadable.join(",")}`, out);
    return out;
  },

  /**
   * 價格偏離：主 oracle 與參考來源（Chainlink/Pyth 聚合）相差超過門檻。參考來源不支援或過期的資產略過；
   * 但**一檔都比不到**時要講出來（SEV-3），否則規則空轉、看起來卻像「沒有偏離」（審查 M1：
   * 2026-10-01 實測 AggregatorOracle 對全部資產 revert NoLiveSource）。
   */
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
    let refUnreadable = 0;
    let refStale = 0;
    rule.assets.forEach((sym, i) => {
      const p = res[2 * i];
      const r = res[2 * i + 1];
      if (p.error) return void primaryErrors++;
      if (r.error) return void refUnreadable++; // 參考來源沒有這個資產的 feed：單獨一檔不是事故
      const [pp] = words(p.result);
      const [rp, rAt] = words(r.result);
      if (!rp || rp === 0n) return void refUnreadable++;
      if (now - Number(rAt) > refMaxAge) return void refStale++;
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
    if (compared === 0 && primaryErrors < rule.assets.length) {
      out.push(finding(rule, `${rule.id}:no-reference`, "SEV-3", `${rule.title}：沒有可用的參考價`, [
        `偏離檢查沒有可用的參考價：${rule.assets.length} 檔資產裡參考來源讀不到 ${refUnreadable} 檔、參考價過期 ${refStale} 檔、主 oracle 讀不到 ${primaryErrors} 檔`,
        "這條規則目前沒有在比對任何價格——「沒有偏離告警」不代表價格正確",
        `參考來源：${contractOf(rule, "reference").address}`,
      ]));
    }
    // 主 oracle 有讀不到的：已算出的偏離照送，但不算成功評估（不替沒讀到的那幾檔發恢復）。
    if (primaryErrors) throw partial(`${primaryErrors}／${rule.assets.length} 檔資產讀不到主 oracle 價格`, out);
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
    const peak = peak24h(state, rule.id, assets, now);
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

  /**
   * 合約持有的代幣餘額較 24 小時高點下降超過門檻（審查 M6）。單筆提領的絕對門檻是佔位值；
   * 這條看的是「池子被抽走多少比例」，拆單也躲不掉。門檻參數名在 rule.dropBps。
   */
  async balanceDrop({ rule, config, env, rpc, state, now }) {
    const holder = contractOf(rule, "holder");
    const [r] = await rpc.batch([callReq(rule, "token", "balanceOf(address)", [holder.address])]);
    const w = r.error ? [] : words(r.result);
    if (!w.length) throw new Error(`balanceOf(${holder.ref}) 讀取失敗：${r.error ?? "空回應"}`);
    const bal = w[0];
    const dec = rule.decimals;
    const dropBps = BigInt(Math.floor(numParam(config, env, rule.dropBps)));
    const peak = peak24h(state, rule.id, bal, now);
    if (!(peak > 0n && bal < peak && (peak - bal) * 10000n >= peak * dropBps)) return [];
    return [finding(rule, `${rule.id}:drop`, rule.severity, rule.title, [
      `${holder.ref} 持有 ${formatUnits(bal, dec)}，24 小時內高點 ${formatUnits(peak, dec)}，下降 ${(Number(((peak - bal) * 10000n) / peak) / 100).toFixed(2)}%（門檻 ${Number(dropBps) / 100}%）`,
      `${holder.ref}：${holder.address}`,
      "可能是正常的大量提領，也可能是資金被抽走：對照 MarginWithdrawn 與 owner／接線告警",
    ])];
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
      out.push({ ...finding(rule, `${rule.id}:${name}`, rule.severity, `${rule.title}：${name}`, [
        `${name} 現在是 ${actual}，預期 ${c.expected}（${why}）`,
        `合約：${k.ref} ${k.address}`,
        "部署版的 setter 不發事件，這是每輪讀 getter 比對出來的；請立即確認是否為預期變更",
      ]), fingerprint: lc(actual) });
    });
    if (failed.length) throw partial(`接線讀取失敗：${failed.join("；")}`, out);
    return out;
  },

  /**
   * EIP-1967 proxy 的實作位址（複審 L-c）。CI 對照的部署版 bytecode（deployed.json）是某個實作的；
   * 實作被換掉之後，CI 的「事件在部署版裡」「函式在部署版裡」全部變成對舊版的判斷，而且 CI 不連網、
   * 永遠是綠的。這裡每輪讀實作 slot 與 deployed.json 的值比對：
   *   • 先於 Upgraded 事件看到（或事件被漏掃）→ SEV-1「實作被升級」。
   *   • 同一個新實作已由 vault-upgraded（Upgraded 事件）以 SEV-1 通報 → 只發 SEV-3「deployed.json 過期」，不重複叫人。
   * 兩者互補：事件帶交易細節、也抓得到「升級又在一輪內換回來」；slot 檢查抓得到事件掃描的空窗
   * （KV 重置、落後），並且一直開著，直到 deployed.json 重抓、Worker 重新部署為止。
   */
  async implementation({ rule, rpc, state, now }) {
    const proxies = rule.contracts.filter((c) => c.as === "proxy");
    const res = await rpc.batch(proxies.map((c) => ({ method: "eth_getStorageAt", params: [c.address, IMPL_SLOT, "latest"] })));
    const out = [];
    const failed = [];
    proxies.forEach((c, i) => {
      const w = res[i]?.error ? [] : words(res[i]?.result);
      if (!w.length || !c.impl) return failed.push(`${c.ref}：${res[i]?.error ?? (c.impl ? "空回應" : "缺少 impl（執行 check-monitoring --write）")}`);
      const actual = lc(wordToAddress(w[0]));
      if (actual === lc(c.impl)) return;
      state.upgrades ??= {};
      const proxy = lc(c.address);
      const rec = state.upgrades[proxy];
      const byEvent = !!rec && rec.impl === actual && rec.by === "event";
      if (!rec || rec.impl !== actual) state.upgrades[proxy] = { impl: actual, by: "slot", at: now };
      const lines = [
        `${c.ref} ${c.address} 的 EIP-1967 實作現在是 ${actual}；CI 依據的部署版（deployed.json）是 ${c.impl}`,
        byEvent
          ? "這次升級已由 vault-upgraded（Upgraded 事件）以 SEV-1 通報；這則提醒 CI 依據的 bytecode 已過期"
          : "未經排程的升級等同合約被換掉：立即確認是否為預期變更（對照 Timelock 排程與部署紀錄）",
        "預期變更時：node scripts/check-monitoring.mjs --refresh-deployed → --write → PR → 重新部署 Worker；在那之前「事件／函式在部署版裡」的 CI 檢查是對舊版做的",
      ];
      out.push({ ...finding(rule, `${rule.id}:${proxy}`, byEvent ? "SEV-3" : rule.severity, byEvent ? `${rule.title}：deployed.json 過期（${c.ref}）` : `${rule.title}：${c.ref}`, lines), fingerprint: actual });
    });
    if (failed.length) throw partial(`實作 slot 讀取失敗：${failed.join("；")}`, out);
    return out;
  },

  /** keeper 錢包 gas 餘額。keeper = MockOracle.owner()（不手抄位址），另可用 EXTRA_GAS_WALLETS 補。 */
  async gasBalance({ rule, config, env, rpc }) {
    const [own] = await rpc.batch([callReq(rule, "oracle", "owner()")]);
    if (own.error) throw new Error(`owner() 讀取失敗：${own.error}`);
    const wallets = [{ label: "keeper（MockOracle.owner）", address: wordToAddress(words(own.result)[0]) }];
    // 不合法的項目略過（configProblems 會講出來），不讓一個打錯的位址讓 keeper 的 gas 也不檢查。
    for (const a of envSetting(env, "EXTRA_GAS_WALLETS").value) wallets.push({ label: "額外錢包", address: a });
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
      const aborted = e?.name === "AbortError" || /abort/i.test(String(e?.message ?? ""));
      why = aborted ? "逾時" : `連線失敗：${redactUrls(e?.message ?? e).slice(0, 80)}`;
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
    state.httpFails ??= {};
    let j;
    let payTo;
    try {
      const res = await fetchWithTimeout(fetchImpl, `${base}/`, { method: "GET" }, 10_000);
      if (!res.ok) throw new Error(`GET / 回 HTTP ${res.status}`);
      j = await res.json();
      payTo = String(j?.payTo ?? "");
      if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) throw new Error("GET / 沒有合法的 payTo");
    } catch (e) {
      // 單次逾時／5xx 不直接告警（Vercel 冷啟動、短暫抖動）：連續 HTTP_FAILS_BEFORE_ALERT 次才算監控錯誤。
      // 失敗期間這條規則不算「成功評估」，已開啟的告警不會被當成恢復。
      const n = (state.httpFails[rule.id] = (state.httpFails[rule.id] ?? 0) + 1);
      const aborted = e?.name === "AbortError" || /abort/i.test(String(e?.message ?? ""));
      const err = new Error(`${aborted ? "GET / 逾時" : redactUrls(e?.message ?? e).slice(0, 120)}（連續 ${n} 次）`);
      if (n < numParam(config, env, "HTTP_FAILS_BEFORE_ALERT")) err.soft = true;
      throw err;
    }
    state.httpFails[rule.id] = 0;
    const out = [];
    const expected = envSetting(env, "EXPECTED_PAY_TO").value;
    state.baselines ??= {};
    const baseline = expected || state.baselines[rule.id];
    let reset = false;
    if (!expected && !state.baselines[rule.id]) {
      // 首次觀察即基準。講出來：KV 被清掉之後，「被改過的 payTo」會靜靜變成新的基準。
      // 比照 monitor-self：不可被 MUTE_KEYS／MIN_SEVERITY 擋掉，至少 SEV-2（複審 L-b：原本 SEV-3，
      // MIN_SEVERITY=SEV-2 或靜音 x402-payto 時，「payTo 被改＋基準被刪」完全沒有通知）。
      state.baselines[rule.id] = payTo;
      reset = true;
      out.push({ ...finding(rule, `${rule.id}:baseline:${lc(payTo)}`, "SEV-2", `${rule.title}：基準已設定`, [
        `KV 沒有收款地址的基準（首次部署，或基準被清除）：以目前觀察到的 payTo ${payTo} 當作基準`,
        "請確認這是預期的收款地址。沒有設定 EXPECTED_PAY_TO 時，「payTo 被改＋KV 基準被刪」只會留下這一則通知——部署時請務必設定 EXPECTED_PAY_TO",
      ]), once: true, unmutable: true });
    }
    // 基準在這一輪才（重新）建立，而原本有開著的「收款地址變更」：同一輪不可以把它當成恢復——
    // 基準是用「被改之後的值」建的，條件消失只是因為比對對象換了（複審 L-b）。保持開啟到下一輪，
    // 讓值班的人先看到上面那則「基準已設定」。
    const openChanged = state.open?.[`${rule.id}:changed`];
    if (reset && openChanged) {
      out.push({ ...finding(rule, `${rule.id}:changed`, "SEV-1", `${rule.title}：收款地址變更`, [
        `基準在變更告警開著的時候被清除，並以目前的 payTo ${payTo} 重建；先前的變更告警保持開啟一輪`,
        "請人工確認 payTo 是預期的地址；若不是，這是收款地址被換掉後又清掉基準",
      ]), fingerprint: lc(payTo) });
    } else if (baseline && lc(baseline) !== lc(payTo)) {
      out.push({ ...finding(rule, `${rule.id}:changed`, "SEV-1", `${rule.title}：收款地址變更`, [
        `signal-api 的 payTo 由 ${baseline} 變成 ${payTo}`,
        expected ? "基準來自 EXPECTED_PAY_TO" : "基準來自首次觀察（建議設定 EXPECTED_PAY_TO）",
        "若為預期變更：更新 EXPECTED_PAY_TO，或只刪 KV 鍵 baselines:v1（見 README「清除基準」）",
      ]), fingerprint: lc(payTo) });
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
 * 把本輪 findings 與 KV 裡的開啟中告警比對，產出要送的通知。每則通知帶 at（這則通知描述的事發生的
 * 時間：事件是區塊時間，狀態變化是本輪）與 firstAt（首次發生：事件同 at，狀態型是開啟的時間）。
 *   once（event）      → 每筆都送一次。
 *   condition 新出現   → 「觸發」
 *   condition 持續     → 嚴重度比「目前」升級，或超過 REMIND_SEC，才「持續」提醒。降級不通知，但會記下
 *                        目前的嚴重度——之後再升回去要再通知一次（審查 L2：原本記的是歷來最嚴重，
 *                        SEV-2 → SEV-3 → SEV-2 的第二次升級不會響）
 *   condition 消失     → 只有在該規則本輪「成功評估」時才「恢復」（RPC 失敗不等於恢復）
 */
export function reconcile({ config, env, state, findings, evaluated, now }) {
  const remind = numParam(config, env, "REMIND_SEC");
  state.open ??= {};
  const notes = [];
  const seen = new Set();
  for (const f of findings) {
    if (f.once) {
      notes.push({ ...f, status: "事件", at: f.at ?? now, firstAt: f.at ?? now });
      continue;
    }
    seen.add(f.key);
    const prev = state.open[f.key];
    const fp = f.fingerprint === undefined ? {} : { fp: f.fingerprint };
    if (!prev) {
      state.open[f.key] = { ruleId: f.ruleId, severity: f.severity, since: now, lastNotified: now, title: f.title, ...fp };
      notes.push({ ...f, status: "觸發", at: now, firstAt: now });
    } else {
      const peak = worse(f.severity, prev.peak ?? prev.severity); // 歷來最嚴重：恢復通知用它過 MIN_SEVERITY
      const escalated = sevRank(f.severity) < sevRank(prev.severity);
      // 觀察值變了（複審 L-2）：告警開著時 payTo／接線／實作又被換成「另一個」值，要立刻再通知，
      // 不等 REMIND_SEC——開著的 SEV-1 不可以變成「之後的變更都不會響」的掩護。
      const changed = f.fingerprint !== undefined && prev.fp !== undefined && f.fingerprint !== prev.fp;
      if (escalated || changed || now - prev.lastNotified >= remind) {
        state.open[f.key] = { ...prev, severity: f.severity, peak, lastNotified: now, ...fp };
        const lines = [...f.lines];
        if (changed) lines.push(f.changeNote ?? `觀察值在告警開著時再次變更：${prev.fp} → ${f.fingerprint}`);
        if (escalated) lines.push(`嚴重度由 ${prev.severity} 升為 ${f.severity}`);
        lines.push(`自 ${new Date(prev.since * 1000).toISOString()} 起`);
        notes.push({ ...f, status: "持續", lines, at: now, firstAt: prev.since, ...(changed ? { title: `${f.title}（值再次變更）` } : {}) });
      } else state.open[f.key] = { ...prev, severity: f.severity, peak, ...fp };
    }
  }
  for (const [key, prev] of Object.entries(state.open)) {
    if (seen.has(key) || !evaluated.has(prev.ruleId)) continue;
    delete state.open[key];
    const orig = prev.peak ?? prev.severity;
    notes.push({ ruleId: prev.ruleId, key, severity: "SEV-4", origSeverity: orig, status: "恢復", title: prev.title, at: now, firstAt: prev.since, lines: [
      `持續 ${Math.round((now - prev.since) / 60)} 分鐘後恢復（期間最高嚴重度 ${orig}）`,
    ] });
  }
  return notes;
}

// ── 一輪 ─────────────────────────────────────────────────────────────────────

/**
 * 執行一輪監控。state 會被就地更新（呼叫端負責存回 KV）。
 * 回傳 { notes, errors, summary }：errors 是規則或掃描本身失敗的訊息（監控自己壞了）。
 */
export async function runOnce({ config, env = {}, state, fetchImpl, now = Math.floor(Date.now() / 1000), log = () => {}, sleep, selfFindings = [] }) {
  const rpcUrl = rpcUrlOf(config, env).url;
  assertHttps("network.publicRpc", config.network.publicRpc);
  assertHttps("SIGNAL_API_URL", param(config, env, "SIGNAL_API_URL"));
  const rpc = makeRpc(rpcUrl, fetchImpl, sleep ? { sleep } : {});
  const findings = [];
  const evaluated = new Set();
  const errors = [];
  let initialFrom; // KV 沒有檢查點、這一輪才建立：事件掃描的起點（呼叫端據此發「狀態重置」）
  const fail = (id, e) => {
    const msg = `${id}: ${redactUrls(e?.message ?? e).slice(0, 200)}`;
    errors.push(msg);
    log(`ERROR ${msg}`);
  };

  // event
  const freshFrom = Object.fromEntries(Object.entries(state.windows ?? {}).map(([k, v]) => [k, v.length]));
  let scanTime = now;
  try {
    const r = await scanEvents({ config, env, rpc, state, now });
    scanTime = now - r.lagBlocks * (config.network?.blockTimeSec ?? 2);
    findings.push(...r.findings);
    state.checkpoint = r.nextCheckpoint;
    if (r.initialFrom !== undefined && r.nextCheckpoint !== undefined && r.nextCheckpoint !== null) initialFrom = r.initialFrom;
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
  findings.push(...windowFindings({ config, env, state, now, freshFrom, scanTime }));

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
      // 軟失敗（HTTP 單次逾時等）：不算監控錯誤，但也不算成功評估（不發恢復）。
      if (e?.soft) log(`SOFT ${rule.id}: ${redactUrls(e.message).slice(0, 160)}`);
      else fail(rule.id, e);
    }
  }

  // 監控自身：有規則讀不到「連續」SELF_ERRORS_BEFORE_ALERT 輪才開一則（恢復時自動關閉）。
  // 單輪失敗多半是公開 RPC 的限流抖動；每次都告警會變成 觸發／恢復 交替的噪音（審查 M3：
  // RPC 隔輪 429 時一小時 11 則）。呼叫端（tick）仍會讓該次 cron 記為失敗、不打心跳。
  evaluated.add("monitor-self");
  state.selfErrorStreak = errors.length ? (state.selfErrorStreak ?? 0) + 1 : 0;
  if (errors.length && state.selfErrorStreak >= numParam(config, env, "SELF_ERRORS_BEFORE_ALERT")) {
    findings.push({ ruleId: "monitor-self", key: "monitor-self:errors", severity: "SEV-3", title: "監控本身有規則讀取失敗", lines: [
      ...errors.slice(0, 8),
      `連續 ${state.selfErrorStreak} 輪失敗；讀不到的規則在這段期間沒有被監控，也不會發恢復`,
    ] });
  }
  findings.push(...selfFindings); // 呼叫端（tick）觀察到的監控自身問題，例如某個告警通道一直送不出去
  const notes = reconcile({ config, env, state, findings, evaluated, now });
  state.lastRunAt = now;
  return { notes, errors, summary: { findings: findings.length, notes: notes.length, errors: errors.length, rpcRequests: rpc.stats.requests, rpcRetries: rpc.stats.retries, initialFrom } };
}

export const _internal = { checks, httpChecks, short };
