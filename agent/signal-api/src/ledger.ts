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

import { createHash } from "node:crypto";

import { decodeBase64Json } from "./paymentIdentifier.ts";

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
 * x402 v2 結算結果未知的付款（facilitator 逾時、斷線、5xx、回應壞掉、settlement_pending）：
 * 授權已交給 facilitator，但不知道有沒有上鏈，也沒有入主佇列。結算 worker 每輪以
 * unknownReconcile.ts 對帳：只有鏈上逐項核對完全吻合才補分潤，其餘移到 UNKNOWN_MANUAL_KEY。
 */
export const UNKNOWN_SETTLEMENT_KEY = "x402:settlement:unknown";
/**
 * Dedup marker per authorization: `<prefix><payer>:<nonce>` (lowercase). An EIP-3009 nonce can
 * be consumed at most once per payer, so this pair identifies one payment. Without it every
 * resend of the same authorization during a facilitator outage added another row.
 * Kept as long as the idempotency state, so a later resend is still recognised.
 */
export const UNKNOWN_SEEN_PREFIX = "x402:settlement:unknown:seen:";
/**
 * Count of rows that arrived while the list was full. Should stay 0. Those rows are not dropped:
 * they are persisted to UNKNOWN_MANUAL_KEY (reason "overflow"). The settlement worker raises a
 * GitHub Actions ::error:: every round while this is > 0; reset it (DEL) after handling them.
 */
export const UNKNOWN_OVERFLOW_KEY = "x402:settlement:unknown:overflow";
/**
 * Rows the reconciler will not decide on its own, each wrapped as `{ raw, reason, ..., movedAt }`
 * with a short reason code (unknownReconcile.ts). Anything that is not an exact on-chain match
 * ends up here instead of being credited; so do overflow rows. A human decides each one.
 */
export const UNKNOWN_MANUAL_KEY = "x402:settlement:unknown:manual";
/** Default cap on UNKNOWN_SETTLEMENT_KEY; override with X402_UNKNOWN_MAX. */
export const UNKNOWN_MAX_DEFAULT = 1000;
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
  /**
   * x402 v2：client 在 PaymentPayload 帶的 payment-identifier（只是中繼資料，方便對帳）。
   * **不參與去重**：同一個 id 的兩筆不同結算是兩筆錢，各自分潤。
   */
  paymentId?: string;
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
 * One marker per EIP-3009 authorization that has been credited, whichever path credited it:
 * `<prefix><chain>:<token>:<payer>:<nonce>` (lowercase) → the idempotency key it was credited
 * under. The success path keys revenue by the tx hash the facilitator reported, and the
 * reconciler by the tx that emitted AuthorizationUsed; if those ever differ, the two `tx:` keys
 * differ too, but the authorization is the same. Both paths enqueue through an atomic
 * "SET marker NX, then RPUSH" (the reconciler's script also removes its row), so one
 * authorization can enter the settlement queue at most once. Kept as long as settlement state.
 */
export const AUTHZ_MARKER_PREFIX = "x402:settlement:authz:";

export function authorizationMarkerKey(a: { network?: unknown; asset?: unknown; payer?: unknown; nonce?: unknown }): string | null {
  const ok =
    typeof a.network === "string" && /^eip155:[0-9]+$/.test(a.network) &&
    typeof a.asset === "string" && /^0x[0-9a-fA-F]{40}$/.test(a.asset) &&
    typeof a.payer === "string" && /^0x[0-9a-fA-F]{40}$/.test(a.payer) &&
    typeof a.nonce === "string" && /^0x[0-9a-fA-F]{64}$/.test(a.nonce);
  if (!ok) return null;
  return `${AUTHZ_MARKER_PREFIX}${[a.network, a.asset, a.payer, a.nonce].map((v) => String(v).toLowerCase()).join(":")}`;
}

/** KEYS: marker, queue   ARGV: marker value, entry, ttl. 1 = queued, 0 = authorization already credited. */
const ENQUEUE_ONCE_SCRIPT = `-- pepelab:enqueue_once
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', tonumber(ARGV[3])) then
  redis.call('RPUSH', KEYS[2], ARGV[2])
  return 1
end
return 0`;

/**
 * Success-path enqueue for a payment whose authorization is known: queued only if no revenue
 * row was ever queued for the same authorization (see AUTHZ_MARKER_PREFIX).
 */
export async function enqueueSettlementOnce(entry: LedgerEntry, marker: string): Promise<"queued" | "already_credited"> {
  const r = await command<number>([
    "EVAL", ENQUEUE_ONCE_SCRIPT, 2, marker, QUEUE_KEY, entry.idempotencyKey ?? "?", JSON.stringify(entry), SETTLE_STATE_TTL_SEC,
  ]);
  return Number(r) === 1 ? "queued" : "already_credited";
}

export function unknownMaxFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.X402_UNKNOWN_MAX);
  return Number.isInteger(n) && n > 0 ? n : UNKNOWN_MAX_DEFAULT;
}

/** `<payer>:<nonce>` lowercase, or null when the row cannot identify its authorization. */
export function unknownDedupeKey(record: { payer?: unknown; nonce?: unknown }): string | null {
  const payer = typeof record.payer === "string" && /^0x[0-9a-fA-F]{40}$/.test(record.payer) ? record.payer : null;
  const nonce = typeof record.nonce === "string" && /^0x[0-9a-fA-F]{64}$/.test(record.nonce) ? record.nonce : null;
  return payer && nonce ? `${payer.toLowerCase()}:${nonce.toLowerCase()}` : null;
}

export type RecordUnknownResult = "recorded" | "duplicate" | "overflow";

/**
 * Cap check and push in one step (a separate LLEN + RPUSH lets concurrent writers overshoot).
 * When the list is full the row is NOT dropped: it goes to the manual list with reason
 * "overflow" and the overflow counter is bumped; the worker raises ::error:: while it is > 0.
 *   KEYS: unknown list, manual list, overflow counter   ARGV: row, max, manual row
 */
const UNKNOWN_PUSH_SCRIPT = `-- pepelab:unknown_push
if redis.call('LLEN', KEYS[1]) >= tonumber(ARGV[2]) then
  redis.call('RPUSH', KEYS[2], ARGV[3])
  redis.call('INCR', KEYS[3])
  return 0
end
redis.call('RPUSH', KEYS[1], ARGV[1])
return 1`;

/**
 * Move one exact row out of the unknown list into `KEYS[2]`, atomically: the destination
 * write happens only if this call removed the row. A retry after a lost reply therefore never
 * produces a second copy (no duplicate manual rows, no second revenue row).
 *   KEYS: unknown list, destination   ARGV: row, value to push
 */
const UNKNOWN_MOVE_SCRIPT = `-- pepelab:unknown_move
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 1 then
  redis.call('RPUSH', KEYS[2], ARGV[2])
  return 1
end
return 0`;

/**
 * 把一筆「結算結果未知」的 v2 付款推進對帳佇列（UNKNOWN_SETTLEMENT_KEY）。ledger 未設定或
 * 寫入失敗會丟錯，由呼叫端 log——不可以因此改變回給買方的狀態碼。
 *
 * Deduplicated per authorization and capped. A full list does not lose the record: it is
 * persisted to UNKNOWN_MANUAL_KEY (reason "overflow") and counted in UNKNOWN_OVERFLOW_KEY, and
 * the result is "overflow". The dedup marker is dropped only when nothing was persisted
 * (Redis error), so the next resend can still be recorded.
 */
export async function recordUnknownSettlement(
  record: object,
  max: number = unknownMaxFromEnv(),
): Promise<RecordUnknownResult> {
  const dedupe = unknownDedupeKey(record as { payer?: unknown; nonce?: unknown });
  const seenKey = dedupe ? UNKNOWN_SEEN_PREFIX + dedupe : null;
  if (seenKey) {
    const claimed = await command<string | null>(["SET", seenKey, "1", "NX", "EX", SETTLE_STATE_TTL_SEC]);
    if (claimed !== "OK") return "duplicate";
  }
  try {
    const raw = JSON.stringify(record);
    const manualRow = JSON.stringify({ raw, reason: "overflow", movedAt: Math.floor(Date.now() / 1000) });
    const r = await command<number>([
      "EVAL", UNKNOWN_PUSH_SCRIPT, 3, UNKNOWN_SETTLEMENT_KEY, UNKNOWN_MANUAL_KEY, UNKNOWN_OVERFLOW_KEY,
      raw, max, manualRow,
    ]);
    return Number(r) === 1 ? "recorded" : "overflow";
  } catch (err) {
    if (seenKey) await command(["DEL", seenKey]).catch(() => undefined);
    throw err;
  }
}

export async function unknownLength(): Promise<number> {
  return (await command<number | null>(["LLEN", UNKNOWN_SETTLEMENT_KEY])) ?? 0;
}

/**
 * Rotate: take the head row and put it at the tail in one atomic LMOVE, returning it. The row
 * stays in the list; walking N rows this way visits N different rows and leaves every row it
 * did not resolve behind the ones it has not looked at yet, so a stuck row never blocks others.
 */
export async function rotateUnknown(): Promise<string | null> {
  return command<string | null>(["LMOVE", UNKNOWN_SETTLEMENT_KEY, UNKNOWN_SETTLEMENT_KEY, "LEFT", "RIGHT"]);
}

/** Remove one exact row (closed: expired unused, or already credited elsewhere). */
export async function removeUnknownSettlement(raw: string): Promise<void> {
  await command(["LREM", UNKNOWN_SETTLEMENT_KEY, 1, raw]);
}

/** Hand a row to a human, atomically (see UNKNOWN_MOVE_SCRIPT). `reason` is a short code. */
export async function moveUnknownToManual(raw: string, reason: string, extra: object = {}): Promise<boolean> {
  const value = JSON.stringify({ raw, reason, ...extra, movedAt: Math.floor(Date.now() / 1000) });
  const r = await command<number>(["EVAL", UNKNOWN_MOVE_SCRIPT, 2, UNKNOWN_SETTLEMENT_KEY, UNKNOWN_MANUAL_KEY, raw, value]);
  return Number(r) === 1;
}

/**
 * KEYS: unknown list, queue, authorization marker   ARGV: row, entry, marker value, ttl.
 * 2 = the authorization was already credited (nothing changed), 1 = credited, 0 = row gone.
 */
const UNKNOWN_CREDIT_SCRIPT = `-- pepelab:unknown_credit
if redis.call('EXISTS', KEYS[3]) == 1 then
  return 2
end
if redis.call('LREM', KEYS[1], 1, ARGV[1]) == 1 then
  redis.call('SET', KEYS[3], ARGV[3], 'EX', tonumber(ARGV[4]))
  redis.call('RPUSH', KEYS[2], ARGV[2])
  return 1
end
return 0`;

/**
 * Credit a reconciled row, atomically: unless the authorization marker already exists, remove
 * the row, set the marker and enqueue `entry` into the main queue.
 */
export async function creditUnknownSettlement(
  raw: string,
  entry: LedgerEntry,
  marker: string,
): Promise<"credited" | "already_credited" | "gone"> {
  const r = Number(await command<number>([
    "EVAL", UNKNOWN_CREDIT_SCRIPT, 3, UNKNOWN_SETTLEMENT_KEY, QUEUE_KEY, marker,
    raw, JSON.stringify(entry), entry.idempotencyKey ?? "?", SETTLE_STATE_TTL_SEC,
  ]));
  return r === 1 ? "credited" : r === 2 ? "already_credited" : "gone";
}

/** Per-row consecutive error counter, keyed by a hash of the exact row. */
export const UNKNOWN_ERRORS_PREFIX = "x402:settlement:unknown:errors:";
export const unknownRowErrorsKey = (raw: string): string =>
  UNKNOWN_ERRORS_PREFIX + createHash("sha256").update(raw).digest("hex").slice(0, 32);

export async function bumpUnknownRowErrors(raw: string): Promise<number> {
  const k = unknownRowErrorsKey(raw);
  const n = Number(await command<number>(["INCR", k]));
  await command(["EXPIRE", k, 7 * 24 * 60 * 60]);
  return n;
}

export async function clearUnknownRowErrors(raw: string): Promise<void> {
  await command(["DEL", unknownRowErrorsKey(raw)]);
}

/** Totals the worker alerts on. */
export async function unknownHealth(): Promise<{ remaining: number; manualTotal: number; overflowTotal: number }> {
  const [remaining, manualTotal, overflow] = await Promise.all([
    command<number | null>(["LLEN", UNKNOWN_SETTLEMENT_KEY]),
    command<number | null>(["LLEN", UNKNOWN_MANUAL_KEY]),
    command<string | null>(["GET", UNKNOWN_OVERFLOW_KEY]),
  ]);
  return { remaining: remaining ?? 0, manualTotal: manualTotal ?? 0, overflowTotal: Number(overflow ?? 0) || 0 };
}

/** True when any of `keys` has a settlement state (`settle:<key>`). */
export async function hasSettleState(keys: string[]): Promise<boolean> {
  for (const k of keys) {
    if ((await command<string | null>(["GET", SETTLE_STATE_PREFIX + k])) !== null) return true;
  }
  return false;
}

/**
 * Every idempotency key sitting in a settlement queue or processing list, read once. The
 * reconciler takes this snapshot once per round instead of re-reading every list per row.
 * Understands all three row shapes: a LedgerEntry, a retry/dead wrapper `{ entry, ... }`, and
 * an unparseable dead row `{ raw, ... }` whose raw may still parse.
 */
export async function idempotencyKeysInQueues(): Promise<Set<string>> {
  const out = new Set<string>();
  const lists = [QUEUE_KEY, RETRY_KEY, UNCONFIRMED_KEY, DEAD_KEY, PROCESSING_KEY, ...Object.values(PROCESSING_KEYS)];
  const take = (o: unknown) => {
    const k = (o as { idempotencyKey?: unknown } | null)?.idempotencyKey;
    if (typeof k === "string") out.add(k);
  };
  for (const l of lists) {
    const rows = (await command<string[] | null>(["LRANGE", l, 0, -1])) ?? [];
    for (const raw of rows) {
      try {
        const o = JSON.parse(raw) as { entry?: unknown; raw?: unknown } | null;
        take(o);
        if (o && typeof o.entry === "object") take(o.entry);
        if (o && typeof o.raw === "string") take(JSON.parse(o.raw));
      } catch {
        /* unparseable rows are handled by the worker, not here */
      }
    }
  }
  return out;
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

/**
 * x402 **v2** 的冪等鍵（docs/ADR-010-x402-v2-migration.md）。v1 維持上面的 deriveIdempotencyKey。
 *   1. `tx:<結算 tx hash>` —— PAYMENT-RESPONSE.transaction（與 v1 相同）。每筆結算唯一，
 *      而且結算成功時一定存在，所以永遠優先。
 *   2. `auth:<付款人>:<EIP-3009 nonce>` —— 只在沒有 tx hash 時才用（與 v1 相同）。
 *
 * client 帶的 payment-identifier **不參與**：它在簽章範圍外、由 client（或任何轉送者）自選，
 * 拿它當鍵只會把兩筆不同的錢合併成一筆分潤。它只以 LedgerEntry.paymentId 存成中繼資料。
 *
 * @param paymentResponseHeader 回應的 PAYMENT-RESPONSE（base64 JSON）。
 * @param paymentPayload        已解碼的 PAYMENT-SIGNATURE（PaymentPayload）。
 */
export function deriveIdempotencyKeyV2(
  paymentResponseHeader: string | null | undefined,
  paymentPayload: unknown,
): string | undefined {
  const isAddr = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
  const settle = decodeBase64Json(paymentResponseHeader);
  const auth = (paymentPayload as { payload?: { authorization?: { from?: unknown; nonce?: unknown } } } | null)
    ?.payload?.authorization;

  const tx = settle?.transaction;
  if (typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx)) return `tx:${tx.toLowerCase()}`;

  if (isAddr(auth?.from) && typeof auth?.nonce === "string" && auth.nonce) {
    return `auth:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;
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
