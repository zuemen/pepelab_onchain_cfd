// 授權 VC 的一次性／取代檢查 —— agent 本地狀態。
//
// 語意（一張授權 VC 本來就要在 session 期間用來下很多筆單，所以不是「每筆交易用一次」）：
//   1. **nonce 綁內容**（v2）：某個 nonce 第一次被接受時，記下它對應的 EIP-712 digest。
//      之後同一個 nonce 只接受同一份內容；同 nonce 不同內容 → NONCE_REPLAYED。
//   2. **新的取代舊的**（v1、v2 都參與）：同一個 (issuer, sessionId) 以 issuedAt 最新的
//      VC 為準。使用者重新簽發後，舊 VC 再被出示 → VC_SUPERSEDED。重簽＝撤銷舊憑證，
//      不必等鏈上 revoke。v1 也寫進 latest（以 digest 為識別），所以新的 v1 同樣能取代舊的。
//   3. **不降級**：某個 (issuer, sessionId) 一旦接受過 v2，之後一律拒收 v1
//      （LEGACY_AFTER_V2）——否則攻擊者可以拿出使用者更早簽的 v1 繞過 v2 的 validUntil。
//   4. 清理：nonce 紀錄在其 validUntil 之後清掉；latest 紀錄在 keepUntil 之後清掉，
//      keepUntil = max(validUntil, session expiry)——session 到期後該 session 的任何 VC
//      都會在 verify 階段被拒，保留它已無意義；在那之前保留，才能維持第 2、3 條。
//
// 重啟之後的語意：狀態存在檔案（預設 agent/.state/vc-nonces.json，env VC_NONCE_STATE_PATH），
// **重啟後仍然有效**；三個進入點（MCP、tg-bot、x402 agent）在同一台機器共用。
// 若檔案被刪除，記憶歸零：尚未過期的舊 VC 可能再被接受一次（然後重新記錄），
// 影響上限＝該 VC 的 validUntil（預設見 DEFAULT_VC_VALIDITY_SEC，不超過 session 到期）與鏈上 session
// 的額度／撤銷狀態。檔案存在但讀不到或格式不符 → 拒絕（fail-closed，NONCE_STORE_UNREADABLE）。
// 同機多 process 以檔案鎖（fileLock.ts）序列化讀改寫；跨主機部署要改成共享儲存。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VerifyResult } from "./identity.ts";
import { withFileLockSync } from "./fileLock.ts";

export type NonceReason =
  | "OK"
  | "NONCE_REPLAYED"
  | "VC_SUPERSEDED"
  | "LEGACY_AFTER_V2"
  | "NONCE_STORE_UNREADABLE"
  | "NONCE_STORE_LOCK_FAILED";

interface NonceEntry {
  digest: string;
  issuer: string;
  sessionId: number;
  issuedAt: number;
  validUntil: number;
  firstSeenAt: number;
}

interface LatestEntry {
  issuedAt: number;
  /** v2＝nonce，v1＝digest */
  id: string;
  version: 1 | 2;
  /** 此 (issuer, sessionId) 是否曾接受過 v2（一旦 true 就拒收 v1）。 */
  v2Seen: boolean;
  keepUntil: number;
}

interface NonceState {
  version: 2;
  nonces: Record<string, NonceEntry>;
  /** `${issuer}|${sessionId}` → 已接受的最新 VC */
  latest: Record<string, LatestEntry>;
}

export function defaultNonceStatePath(): string {
  if (process.env.VC_NONCE_STATE_PATH?.trim()) return process.env.VC_NONCE_STATE_PATH.trim();
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".state", "vc-nonces.json");
  } catch {
    return path.resolve(".state", "vc-nonces.json");
  }
}

const isNum = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown) => typeof v === "string" && v.length > 0;

function read(file: string): NonceState {
  if (!fs.existsSync(file)) return { version: 2, nonces: {}, latest: {} };
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  if (s?.version !== 2 || !s.nonces || typeof s.nonces !== "object" || !s.latest || typeof s.latest !== "object") {
    throw new Error("vc nonce 狀態檔格式不符");
  }
  for (const e of Object.values(s.nonces) as NonceEntry[]) {
    if (!isStr(e?.digest) || !isNum(e.issuedAt) || !isNum(e.validUntil)) throw new Error("nonce 紀錄格式不符");
  }
  for (const e of Object.values(s.latest) as LatestEntry[]) {
    if (!isStr(e?.id) || !isNum(e.issuedAt) || !isNum(e.keepUntil) || typeof e.v2Seen !== "boolean" || (e.version !== 1 && e.version !== 2))
      throw new Error("latest 紀錄格式不符");
  }
  return s as NonceState;
}

function write(file: string, s: NonceState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s), "utf8");
  fs.renameSync(tmp, file);
}

export interface NonceCheck {
  ok: boolean;
  reasonCode: NonceReason;
  message: string;
}

/**
 * 對一個**已通過 verifyAuthorizationVC** 的結果做一次性／取代／不降級檢查並記錄。
 * v1 與 v2 都要經過這裡（v1 沒有 nonce，只參與取代與不降級）。
 */
export function checkAndRecordVcNonce(
  res: VerifyResult,
  opts: { statePath?: string; now?: number; lockTimeoutMs?: number } = {},
): NonceCheck {
  const file = opts.statePath ?? defaultNonceStatePath();
  // 鎖的任何錯誤（逾時、Windows EPERM 重試到逾時、其他 I/O）統一回 NONCE_STORE_LOCK_FAILED；
  // 由呼叫端決定：開倉拒絕、平倉降級（見 write.ts）。
  try {
    return withFileLockSync(file, () => checkLocked(res, file, opts.now), { timeoutMs: opts.lockTimeoutMs });
  } catch {
    return { ok: false, reasonCode: "NONCE_STORE_LOCK_FAILED", message: "VC nonce 狀態檔鎖取得失敗" };
  }
}

function checkLocked(res: VerifyResult, file: string, now?: number): NonceCheck {
  const nowSec = Math.floor((now ?? Date.now()) / 1000);
  let s: NonceState;
  try {
    s = read(file);
  } catch {
    return { ok: false, reasonCode: "NONCE_STORE_UNREADABLE", message: "VC nonce 狀態檔無法讀取或格式不符（fail-closed）" };
  }

  // 清理
  for (const [k, e] of Object.entries(s.nonces)) if (e.validUntil < nowSec) delete s.nonces[k];
  for (const [k, e] of Object.entries(s.latest)) if (e.keepUntil < nowSec) delete s.latest[k];

  const v2 = res.version === 2 && !!res.nonce;
  const id = v2 ? res.nonce!.toLowerCase() : String(res.digest);
  const issuedAt = Number(res.issuedAt ?? 0);
  const key = `${String(res.issuer).toLowerCase()}|${res.sessionId}`;
  const latest = s.latest[key];

  if (v2) {
    const seen = s.nonces[id];
    if (seen && seen.digest !== res.digest) {
      return { ok: false, reasonCode: "NONCE_REPLAYED", message: `nonce ${id.slice(0, 10)}… 已被另一份內容使用過` };
    }
  } else if (latest?.v2Seen) {
    return {
      ok: false,
      reasonCode: "LEGACY_AFTER_V2",
      message: `session #${res.sessionId} 已接受過 v2 授權 VC，不再接受舊格式 v1`,
    };
  }

  if (latest && latest.id !== id && latest.issuedAt > issuedAt) {
    return {
      ok: false,
      reasonCode: "VC_SUPERSEDED",
      message: `session #${res.sessionId} 已有更新的授權 VC（issuedAt ${latest.issuedAt}），舊 VC 不再接受`,
    };
  }

  const validUntil = Number(res.validUntil ?? res.caps?.expiry ?? 0);
  if (v2 && !s.nonces[id]) {
    s.nonces[id] = {
      digest: String(res.digest),
      issuer: String(res.issuer),
      sessionId: Number(res.sessionId),
      issuedAt,
      validUntil,
      firstSeenAt: nowSec,
    };
  }
  const keepUntil = Math.max(validUntil, Number(res.caps?.expiry ?? 0), latest?.keepUntil ?? 0);
  if (!latest || issuedAt >= latest.issuedAt) {
    s.latest[key] = { issuedAt, id, version: v2 ? 2 : 1, v2Seen: v2 || !!latest?.v2Seen, keepUntil };
  } else {
    s.latest[key] = { ...latest, v2Seen: latest.v2Seen || v2, keepUntil };
  }
  try {
    write(file, s);
  } catch {
    return { ok: false, reasonCode: "NONCE_STORE_UNREADABLE", message: "VC nonce 狀態檔無法寫入（fail-closed）" };
  }
  return { ok: true, reasonCode: "OK", message: "VC 一次性／取代檢查通過" };
}
