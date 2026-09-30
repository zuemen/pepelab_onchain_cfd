// v2 VC 的 nonce（jti）一次性檢查 —— agent 本地狀態。
//
// 語意（一張授權 VC 本來就要在 session 期間用來下很多筆單，所以不是「每筆交易用一次」）：
//   1. **nonce 綁內容**：某個 nonce 第一次被接受時，記下它對應的 EIP-712 digest。
//      之後同一個 nonce 只接受同一份內容；同 nonce 不同內容 → NONCE_REPLAYED。
//   2. **新的取代舊的**：同一個 (issuer, sessionId) 以 issuedAt 最新的 VC 為準。
//      使用者重新簽發（例如縮短 validUntil）後，舊 VC 再被出示 → VC_SUPERSEDED。
//      這讓「重簽」成為撤銷舊憑證的手段，不必等鏈上 revoke。
//   3. 過期（validUntil 已過）的紀錄自動清掉 —— 它們本來就會在 verify 階段被拒。
//
// 重啟之後的語意：狀態存在檔案（預設 agent/.state/vc-nonces.json，env VC_NONCE_STATE_PATH），
// **重啟後仍然有效**；三個進入點（MCP、tg-bot、x402 agent）在同一台機器共用。
// 若檔案被刪除，記憶歸零：尚未過期的舊 VC 可能再被接受一次（然後重新記錄），
// 影響上限＝該 VC 的 validUntil（v2 預設最多 7 天）與鏈上 session 的額度／撤銷狀態。
// 檔案存在但讀不到或格式不符 → 拒絕（fail-closed，NONCE_STORE_UNREADABLE）。
// 跨主機部署要改成共享儲存。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VerifyResult } from "./identity.ts";

export type NonceReason = "OK" | "LEGACY_NO_NONCE" | "NONCE_REPLAYED" | "VC_SUPERSEDED" | "NONCE_STORE_UNREADABLE";

interface NonceEntry {
  digest: string;
  issuer: string;
  sessionId: number;
  issuedAt: number;
  validUntil: number;
  firstSeenAt: number;
}

interface NonceState {
  version: 1;
  nonces: Record<string, NonceEntry>;
  /** `${issuer}|${sessionId}` → 已接受的最新 issuedAt */
  latest: Record<string, { issuedAt: number; nonce: string }>;
}

export function defaultNonceStatePath(): string {
  if (process.env.VC_NONCE_STATE_PATH?.trim()) return process.env.VC_NONCE_STATE_PATH.trim();
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".state", "vc-nonces.json");
  } catch {
    return path.resolve(".state", "vc-nonces.json");
  }
}

function read(file: string): NonceState {
  if (!fs.existsSync(file)) return { version: 1, nonces: {}, latest: {} };
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  if (s?.version !== 1 || typeof s.nonces !== "object" || typeof s.latest !== "object") {
    throw new Error("vc nonce 狀態檔格式不符");
  }
  return s as NonceState;
}

function write(file: string, s: NonceState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s), "utf8");
  fs.renameSync(tmp, file);
}

/**
 * 對一個**已通過 verifyAuthorizationVC** 的結果做 nonce 一次性檢查並記錄。
 * v1（無 nonce）直接放行並回 LEGACY_NO_NONCE（呼叫端已經有 legacy 警告）。
 */
export function checkAndRecordVcNonce(
  res: VerifyResult,
  opts: { statePath?: string; now?: number } = {},
): { ok: boolean; reasonCode: NonceReason; message: string } {
  if (res.version !== 2 || !res.nonce) {
    return { ok: true, reasonCode: "LEGACY_NO_NONCE", message: "v1 VC 沒有 nonce，未做一次性檢查" };
  }
  const file = opts.statePath ?? defaultNonceStatePath();
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  let s: NonceState;
  try {
    s = read(file);
  } catch {
    return { ok: false, reasonCode: "NONCE_STORE_UNREADABLE", message: "VC nonce 狀態檔無法讀取（fail-closed）" };
  }

  // 清掉過期紀錄
  for (const [n, e] of Object.entries(s.nonces)) if (e.validUntil < nowSec) delete s.nonces[n];

  const nonce = res.nonce.toLowerCase();
  const seen = s.nonces[nonce];
  if (seen && seen.digest !== res.digest) {
    return { ok: false, reasonCode: "NONCE_REPLAYED", message: `nonce ${nonce.slice(0, 10)}… 已被另一份內容使用過` };
  }
  const key = `${String(res.issuer).toLowerCase()}|${res.sessionId}`;
  const latest = s.latest[key];
  if (latest && latest.nonce !== nonce && latest.issuedAt > (res.issuedAt ?? 0)) {
    return {
      ok: false,
      reasonCode: "VC_SUPERSEDED",
      message: `session #${res.sessionId} 已有更新的授權 VC（issuedAt ${latest.issuedAt}），舊 VC 不再接受`,
    };
  }

  if (!seen) {
    s.nonces[nonce] = {
      digest: res.digest!,
      issuer: String(res.issuer),
      sessionId: Number(res.sessionId),
      issuedAt: Number(res.issuedAt),
      validUntil: Number(res.validUntil),
      firstSeenAt: nowSec,
    };
  }
  if (!latest || (res.issuedAt ?? 0) >= latest.issuedAt) {
    s.latest[key] = { issuedAt: Number(res.issuedAt), nonce };
  }
  try {
    write(file, s);
  } catch {
    return { ok: false, reasonCode: "NONCE_STORE_UNREADABLE", message: "VC nonce 狀態檔無法寫入（fail-closed）" };
  }
  return { ok: true, reasonCode: "OK", message: "nonce 檢查通過" };
}
