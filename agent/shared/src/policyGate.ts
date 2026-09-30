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
//   spentMargin 是「session 生命週期累計」，沒有時間維度，算不出「今天」花了多少；
//   而且它只看單一 session —— 同一把 agent 金鑰開多個 session 就能各自用滿。鏈上的
//   totalMarginBudget 已經是生命週期的硬上限，policy gate 要補的正是「時間窗」與
//   「跨 session／跨進入點（MCP、tg-bot、x402 agent）」這兩個維度，所以選本地狀態檔，
//   以 agent 地址為鍵、UTC 日期切日。預設路徑固定在 agent/.state/（不隨 cwd 變），
//   同一台機器上的三個進入點共用同一份額度。
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
  | "STATE_LOCK_TIMEOUT";

export interface PolicyConfig {
  /** 單筆保證金上限（USDC，人類單位）。 */
  maxMarginPerTrade: number;
  /** 每個 agent 地址每個 UTC 日的累計開倉保證金上限（USDC）。 */
  maxDailyMargin: number;
  /** 允許交易的資產代號。 */
  allowedAssets: string[];
  /** 槓桿上限（整數倍）。 */
  maxLeverage: number;
  /** 每個時間窗內的最多筆數（開倉與平倉合計）。 */
  maxOrdersPerWindow: number;
  /** 時間窗長度（秒）。 */
  windowSec: number;
}

/**
 * 保守預設：單筆 100、每日 500、槓桿 5x、每小時 10 筆；資產＝協議本身上架的清單
 * （assetIdOf 認得的代號），未知代號在這裡就被擋，不會進到編碼層。
 */
export const DEFAULT_POLICY: PolicyConfig = {
  maxMarginPerTrade: 100,
  maxDailyMargin: 500,
  allowedAssets: Object.keys(ASSET_IDS),
  maxLeverage: 5,
  maxOrdersPerWindow: 10,
  windowSec: 3600,
};

export type PolicyAction = "open" | "close";

export interface PolicyRequest {
  action: PolicyAction;
  sessionId: number;
  agent: string;
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
  /** 時間窗內已放行的筆數時間戳（ms）。 */
  orders: number[];
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
  if (e("POLICY_MAX_LEVERAGE")) cfg.maxLeverage = Number(e("POLICY_MAX_LEVERAGE"));
  if (e("POLICY_MAX_ORDERS_PER_WINDOW")) cfg.maxOrdersPerWindow = Number(e("POLICY_MAX_ORDERS_PER_WINDOW"));
  if (e("POLICY_WINDOW_SEC")) cfg.windowSec = Number(e("POLICY_WINDOW_SEC"));
  if (e("POLICY_ALLOWED_ASSETS"))
    cfg.allowedAssets = e("POLICY_ALLOWED_ASSETS")!.split(",").map((s) => s.trim()).filter(Boolean);

  num("maxMarginPerTrade", cfg.maxMarginPerTrade);
  num("maxDailyMargin", cfg.maxDailyMargin);
  num("maxLeverage", cfg.maxLeverage);
  num("maxOrdersPerWindow", cfg.maxOrdersPerWindow);
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

/** 取某 agent 在 now 時的狀態（跨日歸零、清掉時間窗外的筆數）。不修改輸入。 */
export function currentAgentState(
  state: PolicyState,
  agent: string,
  cfg: PolicyConfig,
  nowMs: number,
): AgentState {
  const prev = state.agents[agent.toLowerCase()];
  const day = utcDay(nowMs);
  const cutoff = nowMs - cfg.windowSec * 1000;
  return {
    day,
    dailyMargin: prev && prev.day === day ? prev.dailyMargin : 0,
    orders: (prev?.orders ?? []).filter((t) => t > cutoff),
  };
}

/** 逐條檢查。順序：資產 → 槓桿 → 單筆 → 每日 → 頻率。 */
export function evaluatePolicy(
  req: PolicyRequest,
  cfg: PolicyConfig,
  state: PolicyState,
  nowMs: number,
): PolicyDecision {
  const s = currentAgentState(state, req.agent, cfg, nowMs);

  if (req.action === "open") {
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
        `今日（UTC ${s.day}）已用 ${s.dailyMargin}，加上本筆 ${m} 超過每日上限 ${cfg.maxDailyMargin}`,
      );
  }

  if (s.orders.length >= cfg.maxOrdersPerWindow) {
    const retry = Math.ceil((s.orders[0] + cfg.windowSec * 1000 - nowMs) / 1000);
    return deny(
      "RATE_LIMITED",
      `${cfg.windowSec}s 內已 ${s.orders.length} 筆，達上限 ${cfg.maxOrdersPerWindow}；約 ${Math.max(retry, 1)}s 後再試`,
    );
  }
  return { allowed: true, reasonCode: "OK", message: "policy gate 通過" };
}

function deny(reasonCode: PolicyReasonCode, message: string): PolicyDecision {
  return { allowed: false, reasonCode, message };
}

/** 放行後把本筆記進狀態（回新物件，不修改輸入）。 */
export function applyReservation(
  state: PolicyState,
  req: PolicyRequest,
  cfg: PolicyConfig,
  nowMs: number,
): PolicyState {
  const s = currentAgentState(state, req.agent, cfg, nowMs);
  const next: AgentState = {
    day: s.day,
    dailyMargin: s.dailyMargin + (req.action === "open" ? req.marginUsdc ?? 0 : 0),
    orders: [...s.orders, nowMs],
  };
  return { version: 1, agents: { ...state.agents, [req.agent.toLowerCase()]: next } };
}

/** 釋放一筆預留（送出前就失敗時）。 */
export function releaseReservation(
  state: PolicyState,
  req: PolicyRequest,
  reservedAt: number,
): PolicyState {
  const key = req.agent.toLowerCase();
  const prev = state.agents[key];
  if (!prev) return state;
  const next: AgentState = {
    day: prev.day,
    dailyMargin:
      req.action === "open" && prev.day === utcDay(reservedAt)
        ? Math.max(0, prev.dailyMargin - (req.marginUsdc ?? 0))
        : prev.dailyMargin,
    orders: prev.orders.filter((t) => t !== reservedAt),
  };
  return { version: 1, agents: { ...state.agents, [key]: next } };
}

// ── 狀態檔 I/O ───────────────────────────────────────────────────────────────
export function readPolicyState(file: string): PolicyState {
  if (!fs.existsSync(file)) return { version: 1, agents: {} };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (parsed?.version !== 1 || typeof parsed.agents !== "object" || parsed.agents === null)
    throw new Error("policy 狀態檔格式不符");
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
    symbol?: string;
    isLong?: boolean;
    marginUsdc?: number;
    leverage?: number;
    positionId?: number;
  };
  /** 人類可讀說明（已過 redact 的簡短字串）。 */
  message?: string;
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
}

/**
 * 強制 policy gate：讀設定與狀態 → 逐條檢查 → 寫稽核 → 放行則預留額度。
 * 任何內部錯誤都轉成拒絕（fail-closed）。write.ts 在送出交易前**無條件**呼叫。
 */
export async function enforcePolicyGate(
  req: PolicyRequest,
  opts: { statePath?: string; auditPath?: string; now?: () => number; env?: NodeJS.ProcessEnv } = {},
): Promise<GateResult> {
  const statePath = opts.statePath ?? defaultStatePath();
  const auditPath = opts.auditPath ?? defaultPolicyAuditPath();
  const now = opts.now ?? Date.now;
  const noop = async () => {};

  // process 內：promise 串行；process 間：statePath 的檔案鎖（fileLock.ts）。
  return serialized((): GateResult => {
    try {
      return withFileLockSync(statePath, () => gateLocked());
    } catch (err) {
      if (err instanceof LockTimeoutError) {
        return { ...deny("STATE_LOCK_TIMEOUT", "取得 policy 狀態檔鎖逾時（fail-closed）"), release: noop };
      }
      throw err;
    }
  });

  function gateLocked(): GateResult {
    const t = now();
    const reqFields = {
      symbol: req.symbol,
      isLong: req.isLong,
      marginUsdc: req.marginUsdc,
      leverage: req.leverage,
      positionId: req.positionId,
    };
    const record = (d: PolicyDecision, stage: GuardStage) =>
      auditWriteAttempt(
        {
          action: req.action,
          guardStage: stage,
          reasonCode: d.reasonCode,
          allowed: d.allowed,
          sessionId: req.sessionId,
          agent: req.agent,
          request: reqFields,
          message: d.message,
        },
        auditPath,
        t,
      );

    let decision: PolicyDecision = deny("CONFIG_INVALID", "policy 未完成評估（fail-closed）");
    let cfg: PolicyConfig | null = null;
    let state: PolicyState | null = null;
    try {
      cfg = loadPolicyConfig(opts.env ?? process.env);
    } catch (err) {
      decision = deny("CONFIG_INVALID", `policy 設定不合法：${(err as Error).message}`);
    }
    if (cfg) {
      try {
        state = readPolicyState(statePath);
      } catch {
        decision = deny("STATE_UNREADABLE", "policy 狀態檔無法讀取或格式不符（fail-closed）");
      }
    }
    if (cfg && state) decision = evaluatePolicy(req, cfg, state, t);

    // 稽核寫不進去 → 不放行（沒有紀錄就沒有交易）。
    try {
      record(decision, "policy");
    } catch {
      return { ...deny("AUDIT_WRITE_FAILED", "稽核紀錄寫入失敗（fail-closed）"), release: noop };
    }
    if (!decision.allowed || !cfg || !state) return { ...decision, release: noop };

    try {
      writePolicyState(statePath, applyReservation(state, req, cfg, t));
    } catch {
      return { ...deny("STATE_UNREADABLE", "policy 狀態檔無法寫入（fail-closed）"), release: noop };
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
    return { ...decision, release };
  }
}
