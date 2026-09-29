// tg-bot 的存取控制純邏輯（無 I/O，可離線測試）。
//
// 2026-09-29（P0）：
//   - 只驗 chat id 不夠：群組裡任何成員（或被拉進白名單群組的人）都能下單。現在
//     chat id 與發訊者 from.id **都**必須在白名單內。
//   - 下單前二次確認：解析出的指令先回一個 6 位數確認碼，同一個人在同一個 chat、
//     60 秒內回 `/confirm <碼>` 才真的送鏈。打錯字、被人轉貼訊息都不會直接開倉。
//   - 每人頻率限制：固定視窗計數，超過就拒絕（不送鏈）。
import { randomInt } from "node:crypto";

/** 解析逗號分隔的整數 id 清單（Telegram id 可為負數＝群組）。格式錯回 error。 */
export function parseIdList(raw: string | undefined): { ids: Set<string> } | { error: string } {
  const ids = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const bad = ids.filter((s) => !/^-?\d+$/.test(s));
  if (bad.length) return { error: `含非法 id：${bad.join(", ")}（必須是整數）` };
  if (!ids.length) return { error: "解析後為空" };
  return { ids: new Set(ids) };
}

/** chat 與發訊者都必須在白名單內；缺 from（頻道貼文等）一律拒絕。 */
export function isAuthorized(
  chatId: string,
  fromId: string | undefined,
  allowedChats: Set<string>,
  allowedUsers: Set<string>,
): boolean {
  if (!allowedChats.has(chatId)) return false;
  if (!fromId) return false;
  return allowedUsers.has(fromId);
}

export interface PendingOrder<T> {
  code: string;
  order: T;
  expiresAt: number;
}

/**
 * 二次確認碼。以 `${chatId}:${userId}` 為鍵，每人同時只有一筆待確認；新指令覆蓋舊的。
 * 確認碼一次性：成功或失敗比對後都不能重用（失敗會清掉，避免暴力猜碼）。
 */
export class ConfirmationStore<T> {
  private pending = new Map<string, PendingOrder<T>>();
  constructor(private ttlMs = 60_000, private now: () => number = () => Date.now()) {}

  private key(chatId: string, userId: string) {
    return `${chatId}:${userId}`;
  }

  create(chatId: string, userId: string, order: T): PendingOrder<T> {
    this.prune();
    const p: PendingOrder<T> = {
      code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      order,
      expiresAt: this.now() + this.ttlMs,
    };
    this.pending.set(this.key(chatId, userId), p);
    return p;
  }

  consume(
    chatId: string,
    userId: string,
    code: string,
  ): { ok: true; order: T } | { ok: false; reason: "none" | "expired" | "mismatch" } {
    const k = this.key(chatId, userId);
    const p = this.pending.get(k);
    if (!p) return { ok: false, reason: "none" };
    this.pending.delete(k); // 一次性
    if (this.now() > p.expiresAt) return { ok: false, reason: "expired" };
    if (code.trim() !== p.code) return { ok: false, reason: "mismatch" };
    return { ok: true, order: p.order };
  }

  private prune() {
    const t = this.now();
    for (const [k, p] of this.pending) if (t > p.expiresAt) this.pending.delete(k);
  }
}

/** 每人固定視窗頻率限制。 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = () => Date.now(),
  ) {}

  /** 記一次並回傳是否允許；不允許時帶剩餘秒數。 */
  hit(userId: string): { allowed: boolean; retryAfterSec: number } {
    const t = this.now();
    const e = this.hits.get(userId);
    if (!e || t >= e.resetAt) {
      this.hits.set(userId, { count: 1, resetAt: t + this.windowMs });
      if (this.hits.size > 10_000) {
        for (const [k, v] of this.hits) if (t >= v.resetAt) this.hits.delete(k);
      }
      return { allowed: 1 <= this.max, retryAfterSec: 0 };
    }
    if (e.count >= this.max) {
      return { allowed: false, retryAfterSec: Math.ceil((e.resetAt - t) / 1000) };
    }
    e.count += 1;
    return { allowed: true, retryAfterSec: 0 };
  }
}
