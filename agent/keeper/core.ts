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
//   • 偏離 > rejectDeviation     → 預設完全不寫並大聲報錯。這種幅度多半是來源壞了
//     （換 ticker、拆股、幣別跑掉），寧可讓價格變舊（交易所有 maxPriceAge 會擋交易）
//     也不要寫一個會清算所有人的數字。
//     例外（偏離死鎖的解法）：同一輪至少兩個**獨立**來源彼此差距 ≤ confirmTolerance
//     （預設 2%）、且相對鏈上價格方向一致，才以 stepTowards 的步幅分段逼近。
//     否則真實的大行情（或鏈上價格本身就是錯的）會讓資產永遠卡在拒寫：拒寫不更新
//     → 偏離永遠 > 50% → 永遠拒寫，與舊 GuardedOracle 的死鎖同形。
//   • 鏈上還沒有價格（current ≤ 0）→ seed，沒有可比較的基準，原樣寫入。

/** 每輪允許的最大偏離（比例）。可用 KEEPER_MAX_DEVIATION 覆寫。 */
export const DEFAULT_MAX_DEVIATION = 0.1; // 10%
/** 超過這個幅度視為來源壞掉，完全拒寫。可用 KEEPER_REJECT_DEVIATION 覆寫。 */
export const DEFAULT_REJECT_DEVIATION = 0.5; // 50%
/** 多源確認：獨立來源彼此的最大差距（(max−min)/min）。可用 KEEPER_CONFIRM_TOLERANCE 覆寫。 */
export const DEFAULT_CONFIRM_TOLERANCE = 0.02; // 2%

/** 同一輪從某個來源拿到的價格。source 相同視為同一來源（不算獨立）。 */
export interface SourceQuote {
  source: string;
  value: number;
}

export interface LargeMoveConfirmation {
  confirmed: boolean;
  /** 各來源的中位數（兩個來源時為平均）；confirmed=false 時無意義。 */
  consensus: number;
  reason: string;
}

/**
 * 偏離超過拒寫門檻時的多源確認。要全部成立才 confirmed：
 *   1. 至少兩個不同 source 的合法報價（同名來源只取第一筆）。
 *   2. 彼此差距 (max−min)/min ≤ tolerance。
 *   3. 每個報價相對鏈上 current 的方向一致（全部高於或全部低於）。
 */
export function confirmLargeMove(a: {
  current: number;
  quotes: SourceQuote[];
  tolerance?: number;
}): LargeMoveConfirmation {
  const tol = a.tolerance ?? DEFAULT_CONFIRM_TOLERANCE;
  const seen = new Set<string>();
  const qs: SourceQuote[] = [];
  for (const q of a.quotes) {
    if (!Number.isFinite(q.value) || q.value <= 0 || seen.has(q.source)) continue;
    seen.add(q.source);
    qs.push(q);
  }
  const list = qs.map((q) => `${q.source}=$${q.value}`).join(", ") || "無";
  if (qs.length < 2) {
    return { confirmed: false, consensus: 0, reason: `只有 ${qs.length} 個獨立來源（${list}），至少需要 2 個` };
  }
  const vals = qs.map((q) => q.value).sort((x, y) => x - y);
  const spread = (vals[vals.length - 1] - vals[0]) / vals[0];
  if (spread > tol) {
    return {
      confirmed: false,
      consensus: 0,
      reason: `來源彼此差距 ${(spread * 100).toFixed(2)}% > ${(tol * 100).toFixed(1)}%（${list}）`,
    };
  }
  const up = vals.every((v) => v > a.current);
  const down = vals.every((v) => v < a.current);
  if (!up && !down) {
    return { confirmed: false, consensus: 0, reason: `來源方向不一致（鏈上 $${a.current}；${list}）` };
  }
  const mid = Math.floor(vals.length / 2);
  const consensus = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  return {
    confirmed: true,
    consensus,
    reason: `${qs.length} 個獨立來源一致（${list}，差距 ${(spread * 100).toFixed(2)}%，方向${up ? "向上" : "向下"}）`,
  };
}

export interface DeviationGuard {
  /** 這一輪實際該寫進 MockOracle 的價格（USD）；write=false 時無意義。 */
  value: number;
  write: boolean;
  /** 是否被夾到上限邊緣（未寫入全額目標）。 */
  clamped: boolean;
  /** 偏離超過拒寫門檻、但經多源確認而分段逼近。 */
  confirmed?: boolean;
  /** |target−current|/current；current≤0 時為 0。 */
  deviation: number;
  reason: string;
}

export function guardDeviation(a: {
  target: number;
  current: number;
  maxDeviation?: number;
  rejectDeviation?: number;
  /** 同一輪的獨立來源報價（含 target 本身的來源）；只在偏離 > rejectDeviation 時使用。 */
  quotes?: SourceQuote[];
  confirmTolerance?: number;
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
    const head =
      `偏離 ${(deviation * 100).toFixed(1)}% 超過拒寫門檻 ${(rejectDev * 100).toFixed(0)}%` +
      `（$${a.current} → $${a.target}）`;
    const c = confirmLargeMove({
      current: a.current,
      quotes: a.quotes ?? [],
      tolerance: a.confirmTolerance,
    });
    const targetUp = a.target > a.current;
    if (c.confirmed && (c.consensus > a.current) === targetUp) {
      // 用既有 stepTowards 的步幅（含 50 bps 安全緩衝），朝多源共識價走一步。
      const stepped8 = stepTowards(
        toPrice8(a.current),
        toPrice8(c.consensus),
        BigInt(Math.round(maxDev * 10_000)),
      );
      const stepped = Number(stepped8) / 1e8;
      return {
        value: stepped,
        write: true,
        clamped: true,
        confirmed: true,
        deviation,
        reason: `${head}，但${c.reason}，以 stepTowards 步幅逼近到 $${stepped.toFixed(2)}（下一輪繼續）`,
      };
    }
    return {
      value: 0,
      write: false,
      clamped: false,
      deviation,
      reason:
        `${head}—— 來源可能已壞（拆股/換約/幣別），拒絕寫入；多源確認未通過：` +
        (c.confirmed ? "共識方向與目標相反" : c.reason) +
        `。若行情屬實，需第二個獨立來源（≤${((a.confirmTolerance ?? DEFAULT_CONFIRM_TOLERANCE) * 100).toFixed(0)}%）或人工處置`,
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
