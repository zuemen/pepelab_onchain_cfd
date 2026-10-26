// 狀態檔：掃到哪一個區塊、正在追蹤哪些 record、各自為什麼還沒同步、下次什麼時候再試。
//
// 冪等與可中斷續跑：
//   - 游標（lastBlock）只在「那一段 getLogs 完整成功、事件也處理完」之後才往前推，
//     中途被殺掉，下次從上一個完整的區塊繼續；同一段事件處理兩次沒有副作用（事件只把
//     record 標成「該檢查了」，真正要不要送交易每次都重新讀鏈上狀態決定）。
//   - 重送 resyncFor 也是安全的：合約在已是最新版時 revert AlreadySynced（防重放），
//     執行者最多浪費一次模擬，不會讓部位被調兩次。
//   - 寫檔用「寫暫存檔 → rename」，不會留下半份 JSON；檔案權限 0600、目錄 0700（只有執行者本人的帳號
//     讀得到）。狀態檔不放任何秘密：寫進 lastReason 的錯誤文字都先遮蔽過（engine.ts），但仍不該讓
//     其他帳號讀到跟隨者清單與執行紀錄。
//   - 同一份狀態檔同時只允許一個行程（pid 鎖），避免兩個執行者用同一把金鑰搶 nonce。
//
// 狀態檔綁定 chainId＋CopyTracker＋registry＋服務範圍（public 或 personal 的地址清單）：
// 換了任何一項就是另一份狀態，避免拿 A 鏈的游標去掃 B 鏈。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RevertCategory } from "./errors.ts";

export type RecordStatus =
  /** 已知有新版、等著檢查或送出。 */
  | "pending"
  /** 已是鏈上最新版。 */
  | "synced"
  /** 合約拒絕（冷卻、KYC、休市、油箱不足……），排了重試時間。 */
  | "blocked"
  /** 自動同步關閉或跟單已結束；等下一次 AutoSyncSet 才會再看。 */
  | "dropped"
  /** 送出了交易但等確認逾時，下一輪重新讀鏈上狀態判斷。 */
  | "unconfirmed"
  /**
   * personal 模式：本執行者不能代為同步（自動同步關閉，或跟隨者指定了別的執行者）。不送交易，
   * 只在交易者發布新版時通知本人。
   */
  | "manual";

export interface WatchEntry {
  follower: string;
  recordIdx: number;
  trader: string;
  autoSync: boolean;
  /** 跟隨者設定的執行者小費（wei，十進位字串）。 */
  tipWei: string;
  /** record 目前跟到的版本。 */
  syncedVersion: number | null;
  /** 最近一次讀到的交易者最新版本。 */
  latestVersion: number | null;
  status: RecordStatus;
  /** 鏈上時間（秒）；0 表示下一輪就檢查。 */
  nextCheckAt: number;
  category?: RevertCategory;
  lastReason?: string;
  /** 同一類原因連續被擋幾次（決定退避間隔）。 */
  attempts: number;
  /** 最近一次通知的簽章（狀態＋原因），相同就不重複通知。 */
  lastNotified?: string;
  /** 已發過「交易者發布了新版」通知的最新版本（personal 模式；同一版只通知一次）。 */
  notifiedVersion?: number;
  lastTx?: string;
  updatedAt: number;
}

export interface CopySyncState {
  version: 1;
  chainId: number;
  copyTracker: string;
  registry: string;
  /** "public"、"personal:<排序後小寫地址,以逗號連接>"，或只通知模式的 "notify:personal:<…>"。 */
  scope: string;
  /** 已完整掃描並處理到的區塊（含）。-1 表示還沒開始。 */
  lastBlock: number;
  /** 最近一次全面重掃的鏈上時間（秒）。 */
  lastRescanAt: number;
  records: Record<string, WatchEntry>;
  /**
   * 掃到了、但還沒處理完的工作：事件只要一進來就先寫進這裡，游標才往前推。
   * 行程在「游標已推進、跟隨者還沒讀完」之間被殺掉時，下一輪從這裡接著做，不會漏。
   */
  queue?: { followers: string[]; traders: string[] };
}

export const recordKey = (follower: string, recordIdx: number | bigint) => `${follower.toLowerCase()}:${String(recordIdx)}`;

export function scopeOf(mode: "public" | "personal", followers: readonly string[], notifyOnly = false): string {
  if (mode === "public") return "public";
  const personal = `personal:${[...new Set(followers.map((f) => f.toLowerCase()))].sort().join(",")}`;
  // 只通知模式（--notify-only）用自己的一份狀態：它的「已通知到第幾版」不能壓掉真正執行者的通知去重，
  // 執行者也不該接手一份從沒送過交易的狀態。
  return notifyOnly ? `notify:${personal}` : personal;
}

export function emptyState(b: { chainId: number; copyTracker: string; registry: string; scope: string }): CopySyncState {
  return {
    version: 1,
    chainId: b.chainId,
    copyTracker: b.copyTracker.toLowerCase(),
    registry: b.registry.toLowerCase(),
    scope: b.scope,
    lastBlock: -1,
    lastRescanAt: 0,
    records: {},
    queue: { followers: [], traders: [] },
  };
}

/** 預設狀態檔位置：agent/.state/copy-sync/（agent/.gitignore 已忽略 .state/）。 */
export function defaultStatePath(chainId: number, copyTracker: string, scope: string): string {
  const agentRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const tag = scope === "public" ? "public" : `${scope.startsWith("notify:") ? "notify" : "personal"}-${shortHash(scope)}`;
  return join(agentRoot, ".state", "copy-sync", `${chainId}-${copyTracker.toLowerCase()}-${tag}.json`);
}

function shortHash(s: string): string {
  // FNV-1a 32-bit：只用來讓不同地址清單落在不同檔名，不需要密碼學強度。
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** 驗證讀回來的狀態；格式不對就丟錯（不猜、不自動覆寫——可能是別的程式的檔案）。 */
export function parseState(text: string): CopySyncState {
  const j = JSON.parse(text) as unknown;
  if (!isObj(j) || j.version !== 1) throw new Error("狀態檔版本不符（預期 version 1）");
  for (const k of ["chainId", "lastBlock", "lastRescanAt"] as const) {
    if (typeof j[k] !== "number" || !Number.isFinite(j[k])) throw new Error(`狀態檔欄位 ${k} 不合法`);
  }
  for (const k of ["copyTracker", "registry", "scope"] as const) {
    if (typeof j[k] !== "string") throw new Error(`狀態檔欄位 ${k} 不合法`);
  }
  if (!isObj(j.records)) throw new Error("狀態檔欄位 records 不合法");
  for (const [k, v] of Object.entries(j.records)) {
    if (!isObj(v) || typeof v.follower !== "string" || typeof v.recordIdx !== "number" || typeof v.status !== "string") {
      throw new Error(`狀態檔 record ${k} 不合法`);
    }
  }
  return j as unknown as CopySyncState;
}

/** 狀態檔綁定的對象是否與這次執行相同；不同時回傳說明。 */
export function bindingMismatch(
  s: CopySyncState,
  b: { chainId: number; copyTracker: string; registry: string; scope: string },
): string | null {
  if (s.chainId !== b.chainId) return `狀態檔屬於 chainId ${s.chainId}，這次是 ${b.chainId}`;
  if (s.copyTracker !== b.copyTracker.toLowerCase()) return `狀態檔屬於 CopyTracker ${s.copyTracker}，這次是 ${b.copyTracker}`;
  if (s.registry !== b.registry.toLowerCase()) return `狀態檔屬於 StrategyRegistry ${s.registry}，這次是 ${b.registry}`;
  if (s.scope !== b.scope) return `狀態檔的服務範圍是 ${s.scope}，這次是 ${b.scope}`;
  return null;
}

export function loadState(path: string): CopySyncState | null {
  if (!existsSync(path)) return null;
  return parseState(readFileSync(path, "utf8"));
}

/** 原子寫入：先寫同目錄的暫存檔（0600）再 rename，舊檔若是 0644 也會被換成 0600 的新檔。 */
export function saveState(path: string, s: CopySyncState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  // umask 可能把 mode 再收窄，但不會放寬；明確 chmod 一次，避免暫存檔殘留舊權限（例如被別的行程先建立）。
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** 已經結束追蹤（dropped）超過這麼久的 record 從狀態檔移除，避免公開模式的檔案無限長大。 */
export const DROPPED_TTL_SEC = 30 * 24 * 3600;

export function pruneState(s: CopySyncState, nowSec: number): number {
  let n = 0;
  for (const [k, e] of Object.entries(s.records)) {
    if (e.status === "dropped" && nowSec - e.updatedAt > DROPPED_TTL_SEC) {
      delete s.records[k];
      n += 1;
    }
  }
  return n;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 行程層級的鎖：`<狀態檔>.lock` 存 pid。持有者還活著就拒絕；已不存在就接手。
 * 回傳釋放函式（只刪自己的鎖）。
 */
export function acquireProcessLock(statePath: string, pid: number = process.pid): () => void {
  const lockPath = `${statePath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const token = `${pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid, token }), { flag: "wx", mode: 0o600 });
      return () => {
        try {
          const cur = JSON.parse(readFileSync(lockPath, "utf8")) as { token?: string };
          if (cur.token === token) rmSync(lockPath, { force: true });
        } catch {
          /* 已不存在 */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let holder: number | null = null;
      try {
        holder = Number((JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown }).pid);
      } catch {
        holder = null;
      }
      if (holder !== null && pidAlive(holder)) {
        throw new Error(`另一個 copy-sync 行程（pid ${holder}）正在使用同一份狀態檔：${statePath}`);
      }
      rmSync(lockPath, { force: true }); // 持有者已不存在：接手
    }
  }
  throw new Error(`取不到狀態檔鎖：${lockPath}`);
}
