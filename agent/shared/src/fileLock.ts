// 跨 process 檔案鎖（審查 Medium-5）。
//
// policy 狀態、VC nonce 狀態、hash-chained 稽核檔都是「讀 → 改 → 寫」。同一台機器上
// MCP server、tg-bot、x402 agent 是不同 process，只有 process 內的 promise 鎖時，兩個
// process 會讀到同一份舊狀態、各自寫回 → 額度少算（雙花每日上限）、稽核 hash chain 分岔。
//
// 做法：`<檔名>.lock` 以 O_CREAT|O_EXCL（fs "wx"）建立，內容是 {pid, token, at}。
//   - 取得失敗（EEXIST）→ 短暫等待重試，直到 timeoutMs。
//   - 過期鎖回收：持有者 pid 已不存在，或鎖檔超過 staleMs 未釋放（臨界區只做幾個小檔的
//     I/O，毫秒級；10 秒必然是當掉的持有者）→ 先 rename 成暫存名（原子，只有一個回收者
//     會成功），確認搬走的確實是剛才判定過期的那一把（token 相同）才刪；否則搬回。
//   - 釋放時只刪「自己的」鎖（token 相同）。
// 臨界區都是同步 I/O，所以提供同步版本；等待用 Atomics.wait 睡眠，不空轉 CPU。
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export class LockTimeoutError extends Error {
  constructor(target: string) {
    super(`取得檔案鎖逾時：${target}.lock`);
    this.name = "LockTimeoutError";
  }
}

const SLEEP = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms: number) {
  Atomics.wait(SLEEP, 0, 0, ms);
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

function readLock(file: string): { pid: number; token: string; at: number } | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function tryReclaim(lockPath: string, staleMs: number): void {
  const cur = readLock(lockPath);
  let stale = false;
  if (!cur) {
    // 內容讀不到（剛建立還沒寫完，或損毀）：以 mtime 判斷
    try {
      stale = Date.now() - fs.statSync(lockPath).mtimeMs > staleMs;
    } catch {
      return; // 已經不存在
    }
  } else {
    stale = !pidAlive(cur.pid) || Date.now() - cur.at > staleMs;
  }
  if (!stale) return;
  const aside = `${lockPath}.reclaim.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(lockPath, aside);
  } catch {
    return; // 別人先回收了
  }
  const moved = readLock(aside);
  if (cur && moved && moved.token !== cur.token) {
    // 搬走的是別人剛建立的新鎖 → 搬回（若原位置已被占用就只能放棄它，對方會逾時重試）
    try {
      fs.linkSync(aside, lockPath);
    } catch {
      /* ignore */
    }
  }
  try {
    fs.unlinkSync(aside);
  } catch {
    /* ignore */
  }
}

export interface LockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

/** 在 `<target>.lock` 的保護下同步執行 fn。取不到鎖丟 LockTimeoutError。 */
export function withFileLockSync<T>(target: string, fn: () => T, opts: LockOptions = {}): T {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const staleMs = opts.staleMs ?? 10_000;
  const retryMs = opts.retryMs ?? 5;
  const lockPath = `${target}.lock`;
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, at: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // 目錄不存在 → 建好再試
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        continue;
      }
      if (code !== "EEXIST") throw e;
      tryReclaim(lockPath, staleMs);
      if (Date.now() > deadline) throw new LockTimeoutError(target);
      sleepMs(retryMs + Math.floor(Math.random() * retryMs));
    }
  }
  try {
    return fn();
  } finally {
    const cur = readLock(lockPath);
    if (cur?.token === token) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
    }
  }
}
