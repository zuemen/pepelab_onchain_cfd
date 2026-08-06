// Keeper 的純函式核心：資料驗證、更新判斷、偏離上限分段逼近。
// 這裡不做任何 I/O，也不 import ethers —— 這樣它才能被單元測試覆蓋。
//
// 為什麼存在：2026-07-27 stooq 開始回 HTML 404，而當時的 bash 守衛只檢查
// 空字串 / "N/D" / "0"，HTML 通過守衛、被 awk 強制轉成 0、再被下限夾擠成前價的
// 55%，每 15 分鐘複利一次。把這段邏輯搬進可測試的函式，是不讓同類錯誤再發生的
// 唯一辦法。

/** 只接受純數值字面量：任何 HTML、錯誤訊息、空值、零與負數一律拒絕。 */
const NUMERIC = /^[0-9]+(\.[0-9]+)?$/;

export interface ParsedFeed {
  value: number | null;
  reason: string;
}

export function parseFeedValue(raw: unknown): ParsedFeed {
  if (raw === null || raw === undefined) return { value: null, reason: "empty" };
  const s = String(raw).trim();
  if (s === "" || s === "N/D") return { value: null, reason: "empty" };
  if (!NUMERIC.test(s)) {
    return { value: null, reason: `non-numeric: ${s.slice(0, 40)}` };
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    return { value: null, reason: `non-positive: ${s}` };
  }
  return { value: n, reason: "ok" };
}

/** USD → 8 位小數整數（MockOracle / GuardedOracle 的慣例）。 */
export function toPrice8(usd: number): bigint {
  return BigInt(Math.round(usd * 1e8));
}

export interface UpdatePlan {
  write: boolean;
  reason: string;
}

/**
 * 是否該送出這筆更新。偏離門檻省 gas，heartbeat 保證合約端的
 * `maxPriceAge` 檢查不會因為價格沒動就過期。
 */
export function planUpdate(a: {
  target: number;
  current: number;
  lastUpdatedSec: number;
  nowSec: number;
  deviationThreshold: number;
  heartbeatSec: number;
}): UpdatePlan {
  if (a.current <= 0) return { write: true, reason: "seed (no on-chain price)" };

  const dev = Math.abs(a.target - a.current) / a.current;
  if (dev >= a.deviationThreshold) {
    return { write: true, reason: `deviation ${(dev * 100).toFixed(3)}%` };
  }

  const age = a.nowSec - a.lastUpdatedSec;
  if (age >= a.heartbeatSec) {
    return { write: true, reason: `heartbeat ${age}s` };
  }

  return {
    write: false,
    reason: `within band (dev ${(dev * 100).toFixed(3)}%, age ${age}s)`,
  };
}

// ── MockOracle 的偏離上限（稽核 A-5）─────────────────────────────────────────
//
// 為什麼存在：GuardedOracle 有 `maxDeviationBps` 保護，但 PerpetualExchange 讀的是
// **沒有任何保護的 MockOracle**，而舊 keeper 只要偏離 ≥0.1% 就照寫全額目標價。
// Yahoo 在拆股日／期貨換月／來源換 ticker 時會回一個「數值合法但離譜」的價格
// （parseFeedValue 擋不住——它只擋 HTML 與非數值），下一輪交易所就會依此清算所有
// 部位。core.ts 開頭那段註解宣稱要防的正是這類事故，但當時只擋住了「HTML 混進來」。
//
// 策略（與 stepTowards 同精神，但作用在 MockOracle）：
//   • 偏離 ≤ maxDeviation        → 原樣寫入。
//   • maxDeviation < 偏離 ≤ rejectDeviation → 夾到上限邊緣，分段逼近，下一輪繼續。
//     真實的大行情會在數輪內追上；假價格則不會，而且人有時間看到警告。
//   • 偏離 > rejectDeviation     → 完全不寫並大聲報錯。這種幅度多半是來源壞了
//     （換 ticker、拆股、幣別跑掉），寧可讓價格變舊（交易所有 maxPriceAge 會擋交易）
//     也不要寫一個會清算所有人的數字。
//   • 鏈上還沒有價格（current ≤ 0）→ seed，沒有可比較的基準，原樣寫入。

/** 每輪允許的最大偏離（比例）。可用 KEEPER_MAX_DEVIATION 覆寫。 */
export const DEFAULT_MAX_DEVIATION = 0.1; // 10%
/** 超過這個幅度視為來源壞掉，完全拒寫。可用 KEEPER_REJECT_DEVIATION 覆寫。 */
export const DEFAULT_REJECT_DEVIATION = 0.5; // 50%

export interface DeviationGuard {
  /** 這一輪實際該寫進 MockOracle 的價格（USD）；write=false 時無意義。 */
  value: number;
  write: boolean;
  /** 是否被夾到上限邊緣（未寫入全額目標）。 */
  clamped: boolean;
  /** |target−current|/current；current≤0 時為 0。 */
  deviation: number;
  reason: string;
}

export function guardDeviation(a: {
  target: number;
  current: number;
  maxDeviation?: number;
  rejectDeviation?: number;
}): DeviationGuard {
  const maxDev = a.maxDeviation ?? DEFAULT_MAX_DEVIATION;
  const rejectDev = a.rejectDeviation ?? DEFAULT_REJECT_DEVIATION;

  if (!Number.isFinite(a.target) || a.target <= 0) {
    return { value: 0, write: false, clamped: false, deviation: 0, reason: "target 非法" };
  }
  if (!Number.isFinite(a.current) || a.current <= 0) {
    return { value: a.target, write: true, clamped: false, deviation: 0, reason: "seed（鏈上無前價，無可比基準）" };
  }

  const deviation = Math.abs(a.target - a.current) / a.current;
  if (deviation <= maxDev) {
    return { value: a.target, write: true, clamped: false, deviation, reason: "在偏離上限內" };
  }
  if (deviation > rejectDev) {
    return {
      value: 0,
      write: false,
      clamped: false,
      deviation,
      reason:
        `偏離 ${(deviation * 100).toFixed(1)}% 超過拒寫門檻 ${(rejectDev * 100).toFixed(0)}%` +
        `（$${a.current} → $${a.target}）—— 來源可能已壞（拆股/換約/幣別），拒絕寫入`,
    };
  }
  const stepped =
    a.target > a.current ? a.current * (1 + maxDev) : a.current * (1 - maxDev);
  return {
    value: stepped,
    write: true,
    clamped: true,
    deviation,
    reason:
      `偏離 ${(deviation * 100).toFixed(1)}% 超過上限 ${(maxDev * 100).toFixed(0)}%` +
      `，夾到 $${stepped.toFixed(2)} 分段逼近（下一輪繼續）`,
  };
}

/**
 * GuardedOracle.updatePrice 會用 `(hi-lo)*10000 > bps*lo` 判斷是否超出上限。
 * 注意分母是「兩者中較小的那個」，所以上下方向的容許幅度並不對稱：
 *   向上：new <= current * (1 + bps/10000)
 *   向下：new >= current * 10000 / (10000 + bps)
 * 這個函式必須與合約完全同義，否則 keeper 會送出注定被拒絕的交易。
 */
export function deviationAccepted(
  current8: bigint,
  next8: bigint,
  maxDeviationBps: bigint,
): boolean {
  if (maxDeviationBps === 0n || current8 === 0n) return true;
  const hi = next8 > current8 ? next8 : current8;
  const lo = next8 > current8 ? current8 : next8;
  return (hi - lo) * 10_000n <= maxDeviationBps * lo;
}

/**
 * 回傳「這一輪該寫進 GuardedOracle 的價格」。
 *
 * 目標在上限內就直接寫目標；超出上限則走到上限邊緣，下一輪再往前走一段。
 * 這是死鎖的解法：先前的 keeper 每次都寫全額目標價，一旦落後超過 cap 就
 * 每次都被 `DeviationTooLarge` 打回，於是永遠追不上（線上 sBTC 卡了 9.5 天、
 * sMSFT 卡了 4.9 天，最後只能由 admin 把 cap 設成 0 手動修正）。
 *
 * safetyBps 是留給「讀取與送出之間價格又動了」的緩衝，預設 50 bps。
 */
export function stepTowards(
  current8: bigint,
  target8: bigint,
  maxDeviationBps: bigint,
  safetyBps = 50n,
): bigint {
  if (maxDeviationBps === 0n || current8 === 0n) return target8;

  const bps =
    maxDeviationBps > safetyBps ? maxDeviationBps - safetyBps : maxDeviationBps;

  if (target8 > current8) {
    const max = current8 + (current8 * bps) / 10_000n;
    return target8 <= max ? target8 : max;
  }
  // 向下：整數除法會往下取整，取整後可能剛好跌破上限，故 +1n 保守修正。
  const min = (current8 * 10_000n) / (10_000n + bps) + 1n;
  return target8 >= min ? target8 : min;
}
