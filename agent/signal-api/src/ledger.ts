// x402 結算帳本：Upstash Redis（REST API，無需長連線，serverless 友善）。
//
// 優先序 1（x402 硬化）：把「記帳」跟「上鏈結算」拆開。付費端點只在這裡把
// (trader, feeUsd, timestamp, idempotencyKey) 推進佇列，立刻回應；上鏈結算改由
// settlement-worker.ts 這個獨立 worker 定期處理，見該檔案開頭的說明。
//
// 為什麼是 Upstash 而不是自己 host 一個 Redis：這個專案跑在 Vercel serverless，
// 沒有常駐 process 可以持有 TCP 連線；Upstash 的 REST API 每次呼叫都是一個獨立的
// HTTPS 請求，跟 serverless 的執行模型天然吻合，不需要連線池。
//
// 通用指令端點：POST {url} body=["CMD", arg1, arg2, ...]（Upstash REST API 文件）。
//
// 2026-09-29（P0）：可靠佇列 + 冪等。
//   舊版 worker 用 LPOP「先彈出再處理」—— 彈出後、上鏈前 process 死掉，這筆就從
//   Redis 消失；`tx.wait()` 逾時又會被當失敗重試，同一筆分潤可能上鏈兩次。
//   現在：
//     - LMOVE main→processing（原子），處理完成才 LREM；worker 啟動時先把 processing
//       的遺留項目搬回 main（崩潰可回收）。
//     - 每筆帶冪等鍵；上鏈前 `SET settle:<key> … NX` 佔位，已完成的鍵再出現就跳過。
//     - 「先加後刪」：搬移時一律先寫入目的地、再從來源刪除——中途崩潰最多造成重複，
//       重複由冪等鍵吸收；絕不會造成遺失。

function credentials(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

// 主佇列（待結算）、處理中、失敗佇列（重試中）、死信佇列（需要人工介入）。
export const QUEUE_KEY = "x402:settlement:queue";
export const PROCESSING_KEY = "x402:settlement:processing";
export const RETRY_KEY = "x402:settlement:retry";
/** 已簽出、尚未確認（UNKNOWN）的項目：每輪最先對帳；還有未確認的就不送新交易。 */
export const UNCONFIRMED_KEY = "x402:settlement:unconfirmed";
export const DEAD_KEY = "x402:settlement:dead";
/**
 * 舊格式項目（沒有冪等鍵）以內容雜湊作鍵時，同一個雜湊第二次出現：可能是同一筆的重複，
 * 也可能是「同 trader、同金額、同一秒、同端點」的另一筆真實付款——無法分辨。
 * 不結算、不丟棄，放進這裡交人工核對，並累計衝突筆數。
 */
export const LEGACY_REVIEW_KEY = "x402:settlement:legacy_review";
export const LEGACY_COLLISIONS_KEY = "x402:settlement:legacy_collisions";
/** 冪等狀態：`settle:<idempotencyKey>` → SettleState JSON。 */
export const SETTLE_STATE_PREFIX = "settle:";
/** 冪等狀態保留 90 天：這段期間內同一鍵再出現都會被認出來。 */
export const SETTLE_STATE_TTL_SEC = 90 * 24 * 60 * 60;

export interface LedgerEntry {
  trader: string;
  feeUsd: number;
  /** unix 秒 */
  at: number;
  /** 來自哪個付費端點，純粹方便事後排查，不影響結算邏輯。 */
  source: "signals" | "oracle";
  /**
   * 冪等鍵。優先 `tx:<x402 結算 tx hash>`（X-PAYMENT-RESPONSE.transaction），
   * 沒有就 `auth:<payer>:<EIP-3009 nonce>`。舊資料沒有這欄 → worker 以內容雜湊補上。
   */
  idempotencyKey?: string;
}

export interface RetryEntry {
  entry: LedgerEntry;
  attempts: number;
  lastError: string;
}

export type SettleStatus = "PENDING" | "UNKNOWN" | "DONE" | "FAILED" | "STUCK";

export interface SettleState {
  status: SettleStatus;
  /** 佔位時間（ms）。 */
  claimedAt: number;
  /** 已簽出的 routeExternalRevenue tx hash（送出前就記下）。 */
  txHash?: string;
  /** 簽出／送出的時間（ms），對帳逾時用。 */
  sentAt?: number;
  /** 已簽交易的 nonce（STUCK 時人工用同 nonce 替換／取消）。 */
  nonce?: number;
  /** 已簽的 raw tx（可 `cast publish` 重播；已簽交易不是秘密）。 */
  rawTx?: string;
  note?: string;
}

export function isLedgerEnabled(): boolean {
  return credentials() !== null;
}

async function command<T = unknown>(cmd: (string | number)[]): Promise<T> {
  const creds = credentials();
  if (!creds) {
    throw new Error("ledger disabled：未設定 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");
  }
  const res = await fetch(creds.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(cmd),
  });
  const body = (await res.json()) as { result?: T; error?: string };
  if (!res.ok || body.error) {
    throw new Error(`Upstash ${cmd[0]} 失敗：${body.error ?? res.statusText}`);
  }
  return body.result as T;
}

/**
 * 把一筆待分潤的費用推進主佇列。**不等待任何鏈上交易**：付費端點的回應只等這一次
 * HTTPS 往返（同區域通常 <100ms）。
 */
export async function enqueueSettlement(entry: LedgerEntry): Promise<void> {
  await command(["RPUSH", QUEUE_KEY, JSON.stringify(entry)]);
}

/**
 * 從 x402 的 header 推導冪等鍵。
 *   1. X-PAYMENT-RESPONSE（base64 JSON）的 `transaction` —— facilitator 送出的 EIP-3009
 *      結算 tx hash，每筆付款唯一。
 *   2. 退而求其次：X-PAYMENT 的 `payload.authorization.{from, nonce}` —— EIP-3009 的
 *      nonce 對同一付款人唯一（合約層強制）。
 * 都解不出來回 undefined（worker 會以內容雜湊補上，並在 log 標示為 legacy）。
 */
export function deriveIdempotencyKey(
  paymentResponseHeader: string | null | undefined,
  paymentHeader?: string | null,
): string | undefined {
  const decode = (h: string): Record<string, any> | null => {
    try {
      return JSON.parse(Buffer.from(h, "base64").toString("utf8")) as Record<string, any>;
    } catch {
      return null;
    }
  };
  if (paymentResponseHeader) {
    const tx = decode(paymentResponseHeader)?.transaction;
    if (typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx)) return `tx:${tx.toLowerCase()}`;
  }
  if (paymentHeader) {
    const auth = decode(paymentHeader)?.payload?.authorization;
    const from = auth?.from;
    const nonce = auth?.nonce;
    if (typeof from === "string" && /^0x[0-9a-fA-F]{40}$/.test(from) && typeof nonce === "string" && nonce) {
      return `auth:${from.toLowerCase()}:${nonce.toLowerCase()}`;
    }
  }
  return undefined;
}

// ── 可靠佇列 ─────────────────────────────────────────────────────────────────

/**
 * 每個來源各自一條 processing 清單（2026-09-29 結構修正）：回收時才知道項目從哪裡來。
 * 舊的單一清單 PROCESSING_KEY 只在回收時讀取，視為「來源不明」。
 */
export const PROCESSING_KEYS = {
  main: "x402:settlement:processing:main",
  retry: "x402:settlement:processing:retry",
  unconfirmed: "x402:settlement:processing:unconfirmed",
} as const;

/** 來源佇列 → 它的 processing 清單。未知來源 → 舊的單一清單（來源不明）。 */
export function processingFor(src: string | undefined): string {
  if (src === QUEUE_KEY) return PROCESSING_KEYS.main;
  if (src === RETRY_KEY) return PROCESSING_KEYS.retry;
  if (src === UNCONFIRMED_KEY) return PROCESSING_KEYS.unconfirmed;
  return PROCESSING_KEY;
}

/** 原子地把 `src` 最前面一筆搬到該來源的 processing 尾端，回傳原始字串（空了回 null）。 */
export async function claimNext(src: string): Promise<string | null> {
  return command<string | null>(["LMOVE", src, processingFor(src), "LEFT", "RIGHT"]);
}

/** 處理完成：從 processing 清單移除這一筆（以原始字串比對）。 */
export async function ackProcessing(raw: string, proc: string = PROCESSING_KEY): Promise<void> {
  await command(["LREM", proc, 1, raw]);
}

/** 先寫入目的地、再從 processing 移除（崩潰最多造成重複，由冪等鍵吸收）。 */
export async function moveProcessingTo(
  raw: string,
  dest: string,
  value: string = raw,
  proc: string = PROCESSING_KEY,
): Promise<void> {
  await command(["RPUSH", dest, value]);
  await ackProcessing(raw, proc);
}

/** 只讀：processing 清單最前面一筆（回收用；搬走後才會看到下一筆）。 */
export async function peekHead(key: string): Promise<string | null> {
  const r = await command<string[] | null>(["LRANGE", key, 0, 0]);
  return r && r.length ? r[0]! : null;
}

export async function queueDepth(key: string): Promise<number> {
  return command<number>(["LLEN", key]);
}

// ── 冪等狀態 ─────────────────────────────────────────────────────────────────

export async function getSettleState(key: string): Promise<SettleState | null> {
  const raw = await command<string | null>(["GET", SETTLE_STATE_PREFIX + key]);
  return raw ? (JSON.parse(raw) as SettleState) : null;
}

/** `SET … NX`：只有沒人佔過才寫入。回傳是否佔位成功。 */
export async function claimSettleKey(key: string, state: SettleState): Promise<boolean> {
  const r = await command<string | null>([
    "SET",
    SETTLE_STATE_PREFIX + key,
    JSON.stringify(state),
    "NX",
    "EX",
    SETTLE_STATE_TTL_SEC,
  ]);
  return r === "OK";
}

export async function setSettleState(key: string, state: SettleState): Promise<void> {
  await command(["SET", SETTLE_STATE_PREFIX + key, JSON.stringify(state), "EX", SETTLE_STATE_TTL_SEC]);
}

/** 確定**沒有**送出任何交易時才可呼叫：釋放佔位，讓下次重試可以再佔。 */
export async function releaseSettleKey(key: string): Promise<void> {
  await command(["DEL", SETTLE_STATE_PREFIX + key]);
}

/** 舊格式雜湊衝突：累計並回傳目前總數。 */
export async function incrLegacyCollisions(): Promise<number> {
  return command<number>(["INCR", LEGACY_COLLISIONS_KEY]);
}

// ── worker 租約鎖（第二道防線；第一道是 workflow 的 concurrency group）──────────

export const WORKER_LOCK_KEY = "x402:settlement:lock";
/** 1500 秒 = 25 分鐘，大於 job timeout（20 分鐘）。 */
export const WORKER_LOCK_TTL_SEC = 1500;

/** `SET lock <token> NX EX ttl`。回傳是否取得。 */
export async function acquireWorkerLock(token: string, ttlSec = WORKER_LOCK_TTL_SEC): Promise<boolean> {
  const r = await command<string | null>(["SET", WORKER_LOCK_KEY, token, "NX", "EX", ttlSec]);
  return r === "OK";
}

/** 原子的「值等於 token 才刪」（Lua，Upstash REST 支援 EVAL）。 */
export const RELEASE_LOCK_SCRIPT =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

/** 只有鎖的值等於自己的 token 才刪（EVAL 原子比對，不會刪到別人剛取得的鎖）。 */
export async function releaseWorkerLock(token: string): Promise<boolean> {
  const r = await command<number>(["EVAL", RELEASE_LOCK_SCRIPT, 1, WORKER_LOCK_KEY, token]);
  return Number(r) === 1;
}

// ── 全域停機旗標（STUCK 之後交人工）────────────────────────────────────────────

/**
 * 任何一筆轉 STUCK 就設這個旗標（**不設 TTL**）：之後每一輪都拒跑，直到人工確認原交易的
 * 最終狀態並手動 DEL。值是 JSON：{ reason, txHash, nonce, key, at }。
 */
export const HALT_KEY = "x402:settlement:halt";

export interface HaltInfo {
  reason: string;
  key: string;
  txHash?: string;
  nonce?: number;
  at: string;
}

/** 設定停機旗標（已存在就保留第一個原因）。 */
export async function setHalt(info: HaltInfo): Promise<void> {
  await command(["SET", HALT_KEY, JSON.stringify(info), "NX"]);
}

export async function getHalt(): Promise<HaltInfo | null> {
  const v = await command<string | null>(["GET", HALT_KEY]);
  // 只有 null / undefined 代表沒有旗標；空字串（人工誤設）也當成「有旗標」。
  if (v === null || v === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(v);
    // 只有非 null 物件才是正常格式；"null"、"0"、"false"、數字、字串都視為「有旗標」。
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { reason: v, key: "?", at: "?" };
    }
    return parsed as HaltInfo;
  } catch {
    return { reason: v || "(empty halt flag)", key: "?", at: "?" };
  }
}

/** 只讀：讀一個字串鍵（--dry-run 用）。 */
export async function readString(key: string): Promise<string | null> {
  return command<string | null>(["GET", key]);
}

/** 只讀：看佇列前 n 筆（--dry-run 用）。 */
export async function peekQueue(key: string, n: number): Promise<string[]> {
  return (await command<string[] | null>(["LRANGE", key, 0, Math.max(0, n - 1)])) ?? [];
}

// ── 持續狀態計時（blocked / trader 檢查 no-data）────────────────────────────────

export const BLOCKED_SINCE_KEY = "x402:settlement:blocked_since";
export const NODATA_SINCE_KEY = "x402:settlement:nodata_since";
/** nonce 查詢（RPC）連續失敗的起點——與「nonce 不一致」分開計時，處理方向不同。 */
export const NONCE_RPC_SINCE_KEY = "x402:settlement:nonce_rpc_since";
/** 計時紀錄的 TTL：每次看到都刷新；超過這麼久沒再看到就自然消失，不會殘留過時的起點。 */
export const CONDITION_TTL_SEC = 2 * 60 * 60;

/**
 * 記錄某個狀態「第一次看到」的時間並刷新 TTL，回傳第一次的時間（ms）。
 * 狀態中斷超過 CONDITION_TTL_SEC 沒再出現 → 紀錄過期，下次從頭計時。
 */
export async function markCondition(key: string, nowMs: number): Promise<number> {
  const cur = await command<string | null>(["GET", key]);
  const first = cur && Number.isFinite(Number(cur)) ? Number(cur) : nowMs;
  await command(["SET", key, String(first), "EX", CONDITION_TTL_SEC]);
  return first;
}

export async function clearCondition(key: string): Promise<void> {
  await command(["DEL", key]);
}
