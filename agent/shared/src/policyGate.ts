// Policy gate —— agent 下單前、送出交易之前的「平台級」守門（Privy/Turnkey 式 policy engine）。
//
// 與既有兩道閘的分工：
//   - VC 閘（identity.ts）：這筆動作**有沒有被使用者授權**（誰簽、哪個 session、caps 是否與鏈上一致）
//   - 合約（AgentSessionManager）：session 額度、單筆上限、槓桿上限、到期 —— 最後一道硬防線
//   - policy gate（本檔）：**營運方／持牌機構**自己的風控政策，與使用者授權無關、可比 VC 更嚴：
//       1. 單筆保證金上限            MARGIN_PER_TRADE_EXCEEDED
//       2. 每日累計保證金上限（UTC） DAILY_MARGIN_EXCEEDED
//       3. 允許資產白名單            ASSET_NOT_ALLOWED
//       4. 槓桿上限                  LEVERAGE_EXCEEDED
//       5. 單位時間筆數上限          RATE_LIMITED
//     設定錯誤、狀態檔壞掉、稽核寫不進去 → 一律拒絕（fail-closed）。
//
// ── 每日累計：為什麼用本地狀態檔，而不是鏈上 session.spentMargin ──
//   spentMargin 是「session 生命週期累計」，沒有時間維度，算不出「今天」花了多少。
//   鏈上的 totalMarginBudget 已經是生命週期的硬上限，policy gate 要補的是「時間窗」與
//   「跨進入點（MCP、tg-bot、x402 agent）」這兩個維度，所以選本地狀態檔、UTC 日期切日。
//   預設路徑固定在 agent/.state/（不隨 cwd 變），同一台機器上的三個進入點共用同一份額度。
//
// ── 額度範圍：兩層（複審 Medium-4）──
//   1. **(agent, 鏈上 session.user)**：每位客戶（持牌機構的一個客戶帳戶）一組每日額度與
//      開倉頻率。以 session.user（鏈上讀出，非呼叫端自報）為鍵，而**不是** sessionId——
//      同一位使用者開再多 session，額度也不會倍增；B2B 白標下同一把 agent 金鑰服務多位客戶，
//      客戶之間也不會互吃額度。
//   2. **agent 全域**：同一把 agent 金鑰所有客戶合計的每日額度與開倉頻率上限
//      （POLICY_AGENT_MAX_DAILY_MARGIN / POLICY_AGENT_MAX_ORDERS_PER_WINDOW）。agent 金鑰
//      外洩或失控時，這一層限制總傷害，不論它拿到多少位使用者的授權。
//   平倉只受「每位客戶」那層寬鬆的平倉桶限制，不受全域層限制（平倉降低風險，不應因其他
//   客戶的活動被擋）。
//   誠實邊界：本地檔可被有檔案權限的人刪除重置；它是縱深防禦，不是唯一防線
//   （合約的 session 預算仍在）。同機多 process 以檔案鎖（fileLock.ts）序列化讀改寫；
//   跨主機部署要改成共享儲存（Redis 等）。
//   計數時機：放行當下先「預留」（避免並發雙花額度），送出前失敗就釋放；已廣播的
//   交易即使 revert 也不退回（保守）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { ASSET_IDS } from "./addresses.ts";
import { appendChainedRecord } from "./audit.ts";
import { withFileLockSync, LockTimeoutError } from "./fileLock.ts";

export type PolicyReasonCode =
  | "OK"
  | "CONFIG_INVALID"
  | "STATE_UNREADABLE"
  | "AUDIT_WRITE_FAILED"
  | "ASSET_NOT_ALLOWED"
  | "MARGIN_INVALID"
  | "MARGIN_PER_TRADE_EXCEEDED"
  | "DAILY_MARGIN_EXCEEDED"
  | "LEVERAGE_INVALID"
  | "LEVERAGE_EXCEEDED"
  | "RATE_LIMITED"
  | "AGENT_DAILY_MARGIN_EXCEEDED"
  | "AGENT_RATE_LIMITED"
  | "CLOSE_RATE_LIMITED"
  | "STATE_LOCK_TIMEOUT"
  | "STATE_LOCK_FAILED"
  | "OK_DEGRADED";

export interface PolicyConfig {
  /** 單筆保證金上限（USDC，人類單位）。 */
  maxMarginPerTrade: number;
  /** 每個 (agent, session.user) 每個 UTC 日的累計開倉保證金上限（USDC）。 */
  maxDailyMargin: number;
  /** agent 全域（所有客戶合計）每個 UTC 日的累計開倉保證金上限（USDC）。 */
  maxAgentDailyMargin: number;
  /** agent 全域（所有客戶合計）每個時間窗內的最多開倉筆數。 */
  maxAgentOrdersPerWindow: number;
  /** 允許交易的資產代號。 */
  allowedAssets: string[];
  /** 槓桿上限（整數倍）。 */
  maxLeverage: number;
  /** 每個時間窗內的最多**開倉**筆數。 */
  maxOrdersPerWindow: number;
  /**
   * 每個時間窗內的最多**平倉**筆數（獨立、寬鬆的桶）。平倉是降低風險的動作，
   * 不計入、也不受開倉的頻率與額度限制；這個桶只防 agent 失控狂刷。
   */
  maxClosesPerWindow: number;
  /** 時間窗長度（秒）。 */
  windowSec: number;
}

/**
 * 保守預設：單筆 100、每位客戶每日 500、槓桿 5x、每位客戶每小時 10 筆開倉（平倉另計，
 * 每小時 60 筆）；agent 全域每日 2000、每小時 40 筆開倉。
 * 資產＝協議本身上架的清單（assetIdOf 認得的代號），未知代號在這裡就被擋。
 */
export const DEFAULT_POLICY: PolicyConfig = {
  maxMarginPerTrade: 100,
  maxDailyMargin: 500,
  maxAgentDailyMargin: 2000,
  maxAgentOrdersPerWindow: 40,
  allowedAssets: Object.keys(ASSET_IDS),
  maxLeverage: 5,
  maxOrdersPerWindow: 10,
  maxClosesPerWindow: 60,
  windowSec: 3600,
};

export type PolicyAction = "open" | "close";

export interface PolicyRequest {
  action: PolicyAction;
  sessionId: number;
  agent: string;
  /** 鏈上 session.user（write.ts 從鏈上讀出，不是呼叫端自報）。額度以它為鍵。 */
  user: string;
  symbol?: string;
  isLong?: boolean;
  marginUsdc?: number;
  leverage?: number;
  positionId?: number;
}

export interface AgentState {
  /** UTC 日期 YYYY-MM-DD。 */
  day: string;
  /** 當日已預留／已用的開倉保證金。 */
  dailyMargin: number;
  /** 時間窗內已放行的**開倉**時間戳（ms）。 */
  orders: number[];
  /** 時間窗內已放行的**平倉**時間戳（ms），獨立的桶。 */
  closes: number[];
}

export interface PolicyState {
  version: 1;
  agents: Record<string, AgentState>;
}

export interface PolicyDecision {
  allowed: boolean;
  reasonCode: PolicyReasonCode;
  message: string;
}

// ── 設定 ─────────────────────────────────────────────────────────────────────
const AGENT_ROOT = (() => {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  } catch {
    return process.cwd();
  }
})();

export function defaultStatePath(): string {
  return process.env.POLICY_STATE_PATH?.trim() || path.join(AGENT_ROOT, ".state", "policy-state.json");
}

export function defaultPolicyAuditPath(): string {
  return process.env.POLICY_AUDIT_PATH?.trim() || path.join(AGENT_ROOT, "audit", "policy-gate.jsonl");
}

function num(name: string, raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} 必須是正數（實得 ${String(raw)}）`);
  return n;
}

/**
 * 讀設定：DEFAULT_POLICY ← POLICY_GATE_CONFIG_PATH（JSON，部分欄位即可）← 個別 env。
 * 任何欄位不合法都丟錯（呼叫端轉成 CONFIG_INVALID 拒絕，不會默默退回預設）。
 */
export function loadPolicyConfig(env: NodeJS.ProcessEnv = process.env): PolicyConfig {
  let cfg: PolicyConfig = { ...DEFAULT_POLICY, allowedAssets: [...DEFAULT_POLICY.allowedAssets] };
  const file = env.POLICY_GATE_CONFIG_PATH?.trim();
  if (file) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PolicyConfig>;
    cfg = { ...cfg, ...parsed };
  }
  const e = (k: string) => env[k]?.trim() || undefined;
  if (e("POLICY_MAX_MARGIN_PER_TRADE")) cfg.maxMarginPerTrade = Number(e("POLICY_MAX_MARGIN_PER_TRADE"));
  if (e("POLICY_MAX_DAILY_MARGIN")) cfg.maxDailyMargin = Number(e("POLICY_MAX_DAILY_MARGIN"));
  if (e("POLICY_AGENT_MAX_DAILY_MARGIN")) cfg.maxAgentDailyMargin = Number(e("POLICY_AGENT_MAX_DAILY_MARGIN"));
  if (e("POLICY_AGENT_MAX_ORDERS_PER_WINDOW"))
    cfg.maxAgentOrdersPerWindow = Number(e("POLICY_AGENT_MAX_ORDERS_PER_WINDOW"));
  if (e("POLICY_MAX_LEVERAGE")) cfg.maxLeverage = Number(e("POLICY_MAX_LEVERAGE"));
  if (e("POLICY_MAX_ORDERS_PER_WINDOW")) cfg.maxOrdersPerWindow = Number(e("POLICY_MAX_ORDERS_PER_WINDOW"));
  if (e("POLICY_MAX_CLOSES_PER_WINDOW")) cfg.maxClosesPerWindow = Number(e("POLICY_MAX_CLOSES_PER_WINDOW"));
  if (e("POLICY_WINDOW_SEC")) cfg.windowSec = Number(e("POLICY_WINDOW_SEC"));
  if (e("POLICY_ALLOWED_ASSETS"))
    cfg.allowedAssets = e("POLICY_ALLOWED_ASSETS")!.split(",").map((s) => s.trim()).filter(Boolean);

  num("maxMarginPerTrade", cfg.maxMarginPerTrade);
  num("maxDailyMargin", cfg.maxDailyMargin);
  num("maxAgentDailyMargin", cfg.maxAgentDailyMargin);
  num("maxAgentOrdersPerWindow", cfg.maxAgentOrdersPerWindow);
  num("maxLeverage", cfg.maxLeverage);
  num("maxOrdersPerWindow", cfg.maxOrdersPerWindow);
  num("maxClosesPerWindow", cfg.maxClosesPerWindow);
  num("windowSec", cfg.windowSec);
  if (!Array.isArray(cfg.allowedAssets) || cfg.allowedAssets.length === 0)
    throw new Error("allowedAssets 不可為空");
  const unknown = cfg.allowedAssets.filter((s) => !(s in ASSET_IDS));
  if (unknown.length) throw new Error(`allowedAssets 含協議未上架的代號：${unknown.join(", ")}`);
  return cfg;
}

// ── 純邏輯（可離線逐條測試）───────────────────────────────────────────────────
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** 每位客戶的狀態鍵：`<agent>|<session.user>`（皆小寫；理由見檔頭「額度範圍」）。 */
export function policyStateKey(req: Pick<PolicyRequest, "agent" | "user">): string {
  return `${req.agent.toLowerCase()}|${req.user.toLowerCase()}`;
}

/** agent 全域層的狀態鍵：`<agent>|*`。 */
export function agentGlobalKey(agent: string): string {
  return `${agent.toLowerCase()}|*`;
}

/** 取某個鍵在 now 時的狀態（跨日歸零、清掉時間窗外的筆數）。不修改輸入。 */
export function currentAgentState(
  state: PolicyState,
  key: string,
  cfg: PolicyConfig,
  nowMs: number,
): AgentState {
  const prev = state.agents[key];
  const day = utcDay(nowMs);
  const cutoff = nowMs - cfg.windowSec * 1000;
  return {
    day,
    dailyMargin: prev && prev.day === day ? prev.dailyMargin : 0,
    orders: (prev?.orders ?? []).filter((t) => t > cutoff),
    closes: (prev?.closes ?? []).filter((t) => t > cutoff),
  };
}

/**
 * 逐條檢查。開倉：資產 → 槓桿 → 單筆 → 每日 → 開倉頻率。
 * 平倉：只看平倉自己的寬鬆頻率桶（不計入、不受開倉頻率與額度限制）。
 */
export function evaluatePolicy(
  req: PolicyRequest,
  cfg: PolicyConfig,
  state: PolicyState,
  nowMs: number,
): PolicyDecision {
  if (typeof req.user !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(req.user)) {
    return deny("CONFIG_INVALID", "缺少鏈上 session.user，無法套用每位客戶的額度（fail-closed）");
  }
  const s = currentAgentState(state, policyStateKey(req), cfg, nowMs);
  const g = currentAgentState(state, agentGlobalKey(req.agent), cfg, nowMs);

  if (req.action === "close") {
    if (s.closes.length >= cfg.maxClosesPerWindow) {
      const retry = Math.ceil((s.closes[0] + cfg.windowSec * 1000 - nowMs) / 1000);
      return deny(
        "CLOSE_RATE_LIMITED",
        `${cfg.windowSec}s 內已平倉 ${s.closes.length} 筆，達平倉上限 ${cfg.maxClosesPerWindow}；約 ${Math.max(retry, 1)}s 後再試`,
      );
    }
    return { allowed: true, reasonCode: "OK", message: "policy gate 通過（平倉）" };
  }

  {
    if (!req.symbol || !cfg.allowedAssets.includes(req.symbol))
      return deny("ASSET_NOT_ALLOWED", `資產 ${req.symbol ?? "(缺)"} 不在允許清單（${cfg.allowedAssets.join(", ")}）`);
    const lev = req.leverage;
    if (lev === undefined || !Number.isFinite(lev) || lev <= 0 || !Number.isInteger(lev))
      return deny("LEVERAGE_INVALID", `槓桿 ${String(lev)} 不合法`);
    if (lev > cfg.maxLeverage)
      return deny("LEVERAGE_EXCEEDED", `槓桿 ${lev}x 超過政策上限 ${cfg.maxLeverage}x`);
    const m = req.marginUsdc;
    if (m === undefined || !Number.isFinite(m) || m <= 0)
      return deny("MARGIN_INVALID", `保證金 ${String(m)} 不合法`);
    if (m > cfg.maxMarginPerTrade)
      return deny("MARGIN_PER_TRADE_EXCEEDED", `單筆保證金 ${m} 超過政策上限 ${cfg.maxMarginPerTrade}`);
    if (s.dailyMargin + m > cfg.maxDailyMargin)
      return deny(
        "DAILY_MARGIN_EXCEEDED",
        `今日（UTC ${s.day}）此客戶已用 ${s.dailyMargin}，加上本筆 ${m} 超過每日上限 ${cfg.maxDailyMargin}`,
      );
    if (g.dailyMargin + m > cfg.maxAgentDailyMargin)
      return deny(
        "AGENT_DAILY_MARGIN_EXCEEDED",
        `今日（UTC ${g.day}）此 agent 所有客戶合計已用 ${g.dailyMargin}，加上本筆 ${m} 超過 agent 全域每日上限 ${cfg.maxAgentDailyMargin}`,
      );
  }

  if (s.orders.length >= cfg.maxOrdersPerWindow) {
    const retry = Math.ceil((s.orders[0] + cfg.windowSec * 1000 - nowMs) / 1000);
    return deny(
      "RATE_LIMITED",
      `${cfg.windowSec}s 內此客戶已開倉 ${s.orders.length} 筆，達上限 ${cfg.maxOrdersPerWindow}；約 ${Math.max(retry, 1)}s 後再試`,
    );
  }
  if (g.orders.length >= cfg.maxAgentOrdersPerWindow) {
    const retry = Math.ceil((g.orders[0] + cfg.windowSec * 1000 - nowMs) / 1000);
    return deny(
      "AGENT_RATE_LIMITED",
      `${cfg.windowSec}s 內此 agent 已開倉 ${g.orders.length} 筆，達 agent 全域上限 ${cfg.maxAgentOrdersPerWindow}；約 ${Math.max(retry, 1)}s 後再試`,
    );
  }
  return { allowed: true, reasonCode: "OK", message: "policy gate 通過" };
}

function deny(reasonCode: PolicyReasonCode, message: string): PolicyDecision {
  return { allowed: false, reasonCode, message };
}

/**
 * 清理（複審 Low-7）：刪掉「不是今天（UTC）而且所有時間戳都已超出時間窗」的紀錄——
 * 它們對每日額度（跨日歸零）與頻率（窗外）都不再有影響，留著只會讓狀態檔無限長大。
 * 跨日但仍有窗內時間戳的紀錄保留（例如 00:05 時，23:30 的開倉仍計入頻率）。
 */
export function pruneState(state: PolicyState, cfg: PolicyConfig, nowMs: number): PolicyState {
  const today = utcDay(nowMs);
  const cutoff = nowMs - cfg.windowSec * 1000;
  const agents: Record<string, AgentState> = {};
  for (const [k, e] of Object.entries(state.agents)) {
    const recent = [...(e.orders ?? []), ...(e.closes ?? [])].some((t) => t > cutoff);
    if (e.day === today || recent) agents[k] = e;
  }
  return { version: 1, agents };
}

/** 放行後把本筆記進狀態（回新物件，不修改輸入）。順便清理過期紀錄。 */
export function applyReservation(
  state: PolicyState,
  req: PolicyRequest,
  cfg: PolicyConfig,
  nowMs: number,
): PolicyState {
  const open = req.action === "open";
  const bump = (key: string): AgentState => {
    const s = currentAgentState(state, key, cfg, nowMs);
    return {
      day: s.day,
      dailyMargin: s.dailyMargin + (open ? req.marginUsdc ?? 0 : 0),
      orders: open ? [...s.orders, nowMs] : s.orders,
      closes: open ? s.closes : [...s.closes, nowMs],
    };
  };
  const agents = { ...pruneState(state, cfg, nowMs).agents, [policyStateKey(req)]: bump(policyStateKey(req)) };
  // 全域層只記開倉（平倉不受全域層限制）。
  if (open) agents[agentGlobalKey(req.agent)] = bump(agentGlobalKey(req.agent));
  return { version: 1, agents };
}

/** 釋放一筆預留（送出前就失敗時）。 */
export function releaseReservation(
  state: PolicyState,
  req: PolicyRequest,
  reservedAt: number,
): PolicyState {
  // 只移除「一筆」同時間戳的紀錄：兩個 process 同一毫秒預留時，時間戳會重複。
  const removeOne = (xs: number[] = []) => {
    const i = xs.indexOf(reservedAt);
    return i < 0 ? xs : [...xs.slice(0, i), ...xs.slice(i + 1)];
  };
  const open = req.action === "open";
  const undo = (prev: AgentState): AgentState => ({
    day: prev.day,
    dailyMargin:
      open && prev.day === utcDay(reservedAt)
        ? Math.max(0, prev.dailyMargin - (req.marginUsdc ?? 0))
        : prev.dailyMargin,
    orders: open ? removeOne(prev.orders) : prev.orders ?? [],
    closes: open ? prev.closes ?? [] : removeOne(prev.closes),
  });
  const agents = { ...state.agents };
  const keys = open ? [policyStateKey(req), agentGlobalKey(req.agent)] : [policyStateKey(req)];
  for (const k of keys) if (agents[k]) agents[k] = undo(agents[k]);
  return { version: 1, agents };
}

// ── 狀態檔 I/O ───────────────────────────────────────────────────────────────
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isTsArray = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every((t) => typeof t === "number" && Number.isFinite(t) && t >= 0);

/**
 * 讀狀態檔並**逐筆驗型別**（審查 Low-8）。任何一筆不合法 → 丟錯，呼叫端轉成
 * STATE_UNREADABLE（開倉 fail-closed；平倉降級放行）。不做「修補後繼續」：一份被
 * 改壞的額度紀錄（例如 dailyMargin 變成負數或字串）若被默默接受，等於把每日上限重置。
 */
export function readPolicyState(file: string): PolicyState {
  if (!fs.existsSync(file)) return { version: 1, agents: {} };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    parsed?.version !== 1 ||
    typeof parsed.agents !== "object" ||
    parsed.agents === null ||
    Array.isArray(parsed.agents)
  )
    throw new Error("policy 狀態檔格式不符");
  for (const [key, e] of Object.entries(parsed.agents as Record<string, any>)) {
    const ok =
      e !== null &&
      typeof e === "object" &&
      typeof e.day === "string" &&
      DAY_RE.test(e.day) &&
      typeof e.dailyMargin === "number" &&
      Number.isFinite(e.dailyMargin) &&
      e.dailyMargin >= 0 &&
      isTsArray(e.orders) &&
      (e.closes === undefined || isTsArray(e.closes));
    if (!ok) throw new Error(`policy 狀態檔紀錄 ${key} 格式不符`);
  }
  return parsed as PolicyState;
}

function writePolicyState(file: string, state: PolicyState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state), "utf8");
  fs.renameSync(tmp, file);
}

// 同一 process 內序列化讀改寫（MCP 可能並發呼叫）；跨 process 由 withFileLockSync 保護。
let lock: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}

// ── 稽核 ─────────────────────────────────────────────────────────────────────
export type GuardStage = "config" | "vc" | "policy" | "risk" | "precheck" | "signing" | "submit";

export interface PolicyAuditRecord {
  kind: "agent-write-attempt";
  ts: string;
  action: PolicyAction;
  guardStage: GuardStage;
  reasonCode: string;
  allowed: boolean;
  sessionId: number;
  /** agent（session key）地址；**絕不**含私鑰。 */
  agent: string | null;
  request: {
    /** 鏈上 session.user（額度以它為鍵）。 */
    user?: string;
    symbol?: string;
    isLong?: boolean;
    marginUsdc?: number;
    leverage?: number;
    positionId?: number;
  };
  /** 人類可讀說明（已過 redact 的簡短字串）。 */
  message?: string;
  /** 平倉降級放行時，哪些基礎設施出了問題（STATE_UNREADABLE、AUDIT_WRITE_FAILED…）。 */
  degraded?: string[];
  txHash?: string | null;
  prevHash?: string | null;
  hash?: string;
}

/**
 * 寫一筆寫入嘗試的稽核：hash-chained JSONL（沿用 audit.ts 的鏈）＋ stderr 一行結構化 JSON
 * （MCP 走 stdio，stdout 是協定通道，所以只能寫 stderr）。寫檔失敗會丟錯。
 */
export function auditWriteAttempt(
  rec: Omit<PolicyAuditRecord, "kind" | "ts" | "prevHash" | "hash">,
  file: string = defaultPolicyAuditPath(),
  nowMs: number = Date.now(),
): PolicyAuditRecord {
  const full: PolicyAuditRecord = {
    kind: "agent-write-attempt",
    ts: new Date(nowMs).toISOString(),
    ...rec,
    agent: rec.agent ? ethers.getAddress(rec.agent) : null,
  };
  const chained = appendChainedRecord(file, full);
  console.error(`[policy-audit] ${JSON.stringify(chained)}`);
  return chained;
}

// ── 對外入口 ─────────────────────────────────────────────────────────────────
export interface GateResult extends PolicyDecision {
  /** 送出前就失敗時呼叫，把預留的額度與筆數還回去。放行時才有。 */
  release: () => Promise<void>;
  /** 平倉在降級模式放行時，列出哪些基礎設施出了問題（開倉永遠不會降級放行）。 */
  degraded?: string[];
}

/**
 * 強制 policy gate：讀設定與狀態 → 逐條檢查 → 寫稽核 → 放行則預留額度。
 * write.ts 在送出交易前**無條件**呼叫。
 *
 * 失敗語意（審查 Medium-4）：
 *   - **開倉**：設定壞、狀態檔壞／鎖逾時、稽核寫不進去 → 一律拒絕（fail-closed）。
 *   - **平倉**：是降低風險的動作，不能因為 agent 本地的基礎設施壞掉而把使用者鎖在
 *     部位裡。上述情況一律**放行**（reasonCode=OK_DEGRADED），在 stderr 印 `::error::`，
 *     並在稽核紀錄的 `degraded` 欄位標出原因（稽核本身寫不進去時，`::error::` 行帶完整
 *     紀錄內容作為唯一留痕）。平倉只受自己寬鬆的頻率桶限制。
 */
export async function enforcePolicyGate(
  req: PolicyRequest,
  opts: {
    statePath?: string;
    auditPath?: string;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
    lockTimeoutMs?: number;
  } = {},
): Promise<GateResult> {
  const statePath = opts.statePath ?? defaultStatePath();
  const auditPath = opts.auditPath ?? defaultPolicyAuditPath();
  const now = opts.now ?? Date.now;
  const noop = async () => {};
  const isClose = req.action === "close";
  const reqFields = {
    user: req.user,
    symbol: req.symbol,
    isLong: req.isLong,
    marginUsdc: req.marginUsdc,
    leverage: req.leverage,
    positionId: req.positionId,
  };
  const recordOf = (d: PolicyDecision, t: number, degraded: string[]) => ({
    action: req.action,
    guardStage: "policy" as const,
    reasonCode: d.reasonCode,
    allowed: d.allowed,
    sessionId: req.sessionId,
    agent: req.agent,
    request: reqFields,
    message: d.message,
    ...(degraded.length ? { degraded } : {}),
  });
  const degradedClose = (degraded: string[], t: number): GateResult => {
    const d: PolicyDecision = {
      allowed: true,
      reasonCode: "OK_DEGRADED",
      message: `平倉在降級模式放行（${degraded.join(", ")}）`,
    };
    const rec = recordOf(d, t, degraded);
    try {
      auditWriteAttempt(rec, auditPath, t);
    } catch {
      degraded.push("AUDIT_WRITE_FAILED");
      rec.degraded = degraded;
    }
    console.error(`::error::[policy-gate] ${d.message}；紀錄：${JSON.stringify(rec)}`);
    return { ...d, degraded, release: noop };
  };

  // process 內：promise 串行；process 間：statePath 的檔案鎖（fileLock.ts）。
  // 鎖的任何錯誤（逾時、Windows 的 EPERM 重試到逾時、其他 I/O 錯誤）統一處理：
  // 開倉拒絕（fail-closed）；平倉降級放行。
  return serialized((): GateResult => {
    try {
      return withFileLockSync(statePath, () => gateLocked(), { timeoutMs: opts.lockTimeoutMs });
    } catch (err) {
      const code = err instanceof LockTimeoutError ? "STATE_LOCK_TIMEOUT" : "STATE_LOCK_FAILED";
      if (isClose) return degradedClose([code], now());
      return { ...deny(code, "取得 policy 狀態檔鎖失敗（fail-closed）"), release: noop };
    }
  });

  function gateLocked(): GateResult {
    const t = now();
    const degraded: string[] = [];

    let cfg: PolicyConfig | null = null;
    let state: PolicyState | null = null;
    try {
      cfg = loadPolicyConfig(opts.env ?? process.env);
    } catch (err) {
      if (!isClose) {
        return finish(deny("CONFIG_INVALID", `policy 設定不合法：${(err as Error).message}`));
      }
      degraded.push("CONFIG_INVALID");
      cfg = DEFAULT_POLICY; // 平倉只用得到平倉頻率桶：退回預設值
    }
    try {
      state = readPolicyState(statePath);
    } catch {
      if (!isClose) return finish(deny("STATE_UNREADABLE", "policy 狀態檔無法讀取或格式不符（fail-closed）"));
      degraded.push("STATE_UNREADABLE");
    }
    if (!state) return degradedClose(degraded, t);

    const decision = evaluatePolicy(req, cfg, state, t);
    const final: PolicyDecision =
      decision.allowed && degraded.length
        ? { allowed: true, reasonCode: "OK_DEGRADED", message: `${decision.message}（降級：${degraded.join(", ")}）` }
        : decision;

    // 稽核寫不進去：開倉不放行（沒有紀錄就沒有交易）；平倉放行但 ::error::。
    try {
      auditWriteAttempt(recordOf(final, t, degraded), auditPath, t);
    } catch {
      if (!isClose) return { ...deny("AUDIT_WRITE_FAILED", "稽核紀錄寫入失敗（fail-closed）"), release: noop };
      if (!final.allowed) return { ...final, release: noop };
      degraded.push("AUDIT_WRITE_FAILED");
      console.error(`::error::[policy-gate] 平倉稽核寫入失敗，仍放行；紀錄：${JSON.stringify(recordOf(final, t, degraded))}`);
    }
    if (!final.allowed) return { ...final, release: noop };

    try {
      writePolicyState(statePath, applyReservation(state, req, cfg, t));
    } catch {
      if (!isClose) return { ...deny("STATE_UNREADABLE", "policy 狀態檔無法寫入（fail-closed）"), release: noop };
      degraded.push("STATE_WRITE_FAILED");
      console.error("::error::[policy-gate] 平倉的頻率桶無法寫入 policy 狀態檔，仍放行");
    }
    if (degraded.length) {
      console.error(`::error::[policy-gate] 平倉在降級模式放行（${degraded.join(", ")}）`);
    }
    const release = () =>
      serialized(() => {
        try {
          withFileLockSync(statePath, () =>
            writePolicyState(statePath, releaseReservation(readPolicyState(statePath), req, t)),
          );
        } catch {
          /* 釋放失敗＝多算一筆，保守方向，可接受 */
        }
      });
    return degraded.length
      ? { ...final, reasonCode: "OK_DEGRADED", degraded, release }
      : { ...final, release };

    /** 開倉拒絕：寫稽核（寫不進去也照樣拒絕）。 */
    function finish(d: PolicyDecision): GateResult {
      try {
        auditWriteAttempt(recordOf(d, t, []), auditPath, t);
      } catch {
        return { ...deny("AUDIT_WRITE_FAILED", "稽核紀錄寫入失敗（fail-closed）"), release: noop };
      }
      return { ...d, release: noop };
    }
  }
}
