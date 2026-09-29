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

/** 原子地把 `src` 最前面一筆搬到 processing 尾端，回傳原始字串（空了回 null）。 */
export async function claimNext(src: string): Promise<string | null> {
  return command<string | null>(["LMOVE", src, PROCESSING_KEY, "LEFT", "RIGHT"]);
}

/** 處理完成：從 processing 移除這一筆（以原始字串比對）。 */
export async function ackProcessing(raw: string): Promise<void> {
  await command(["LREM", PROCESSING_KEY, 1, raw]);
}

/** 先寫入目的地、再從 processing 移除（崩潰最多造成重複，由冪等鍵吸收）。 */
export async function moveProcessingTo(raw: string, dest: string, value: string = raw): Promise<void> {
  await command(["RPUSH", dest, value]);
  await ackProcessing(raw);
}

/**
 * worker 啟動時呼叫：把 processing 的遺留項目（上一輪崩潰留下的）原序搬回 main 最前面。
 * 回傳搬回的筆數。
 */
export async function recoverProcessing(max = 10_000): Promise<number> {
  let n = 0;
  while (n < max) {
    const moved = await command<string | null>(["LMOVE", PROCESSING_KEY, QUEUE_KEY, "RIGHT", "LEFT"]);
    if (moved === null || moved === undefined) break;
    n += 1;
  }
  return n;
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
