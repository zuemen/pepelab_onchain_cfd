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
// 策略：熔斷語意（2026-09-29 審查後改寫）。
//
// 原則：**絕不寫入明知不是最佳估計的價格。** 舊版在 10–50% 區間「夾到上限邊緣、
// 分段逼近」，>50% 經多源確認後也用 stepTowards 分段逼近 —— 兩者都會把一個已知
// 錯誤的價格帶著新的時間戳寫上鏈，任何人都能對著這個錯價開倉（價格看起來新鮮，
// 交易所的 maxPriceAge 也擋不住）。所以現在只有「寫完整價格」或「不寫」兩種結果：
//
//   • 鏈上還沒有價格（current ≤ 0）→ seed，沒有可比較的基準，原樣寫入。
//   • 偏離 ≤ breakerDeviation（預設 20%）→ 照常寫入完整價格。
//   • 偏離 > breakerDeviation：
//       – 多源確認通過（≥2 個新鮮的獨立來源、彼此差距 ≤ confirmTolerance、方向一致）
//         → 寫入完整的共識價（各來源中位數）。
//       – 否則拒寫：讓價格變舊，交易所的 maxPriceAge 自然停單（開倉／平倉／清算都
//         revert StalePrice），run.ts 輸出 ::error:: 並讓 job 失敗。這是熔斷，不是故障。
//         股票只有單一來源（Yahoo），所以拆股、財報跳空這類 >20% 的真實變動一律
//         需要人工處置，步驟見 docs/RUNBOOK_KEEPER.md「價格熔斷」。

/** 熔斷門檻：單一來源變動超過這個比例就需要多源確認。可用 KEEPER_BREAKER_DEVIATION 覆寫。 */
export const DEFAULT_BREAKER_DEVIATION = 0.2; // 20%
/** 多源確認：獨立來源彼此的最大差距（(max−min)/min）。可用 KEEPER_CONFIRM_TOLERANCE 覆寫。 */
export const DEFAULT_CONFIRM_TOLERANCE = 0.02; // 2%

/**
 * 解析比例型環境變數（審查 Low）：未設用預設值；設了就必須是有限數、且落在
 * (min, max] 內，否則回 error，由呼叫端 exit 1。`KEEPER_BREAKER_DEVIATION=abc`
 * 變成 NaN 會讓所有比較都是 false —— 熔斷形同關閉，這種設定錯誤必須大聲失敗。
 */
export function parseRatioEnv(
  name: string,
  raw: string | undefined,
  def: number,
  min: number,
  max: number,
): { value: number; error?: undefined } | { value?: undefined; error: string } {
  if (raw === undefined || raw.trim() === "") return { value: def };
  const v = Number(raw.trim());
  if (!Number.isFinite(v) || v <= min || v > max) {
    return { error: `${name}=${JSON.stringify(raw)} 不合法：必須是 (${min}, ${max}] 內的有限數` };
  }
  return { value: v };
}

/** KEEPER_BREAKER_DEVIATION 的合理範圍：(0, 1]。 */
export const BREAKER_RANGE = [0, 1] as const;
/** KEEPER_CONFIRM_TOLERANCE 的合理範圍：(0, 0.1] —— 超過 10% 的「一致」不算確認。 */
export const CONFIRM_TOLERANCE_RANGE = [0, 0.1] as const;

/** 同一輪從某個來源拿到的價格。source 相同視為同一來源（不算獨立）。 */
export interface SourceQuote {
  source: string;
  value: number;
  /** 報價本身的年齡（秒）。多源確認時缺漏＝新鮮度不明，不算一票。 */
  ageSec?: number;
  /** 來源自己標記為過時（例如 Yahoo 的 quoteStale）。 */
  stale?: boolean;
}

/** 多源確認：每一票的報價年齡上限（秒）。 */
export const DEFAULT_CONFIRM_MAX_AGE_SEC = 3600;

export interface LargeMoveConfirmation {
  confirmed: boolean;
  /** 各來源的中位數（兩個來源時為平均）；confirmed=false 時無意義。 */
  consensus: number;
  reason: string;
}

/**
 * 偏離超過熔斷門檻時的多源確認。要全部成立才 confirmed：
 *   0. 每一票必須新鮮：ageSec 存在且 ≤ maxQuoteAgeSec（預設 1 小時），且不是 stale。
 *      休市時的 Yahoo 收盤價、凍結的 relay、沒有時間戳的報價都不算一票 ——
 *      兩個「一致但都是昨天」的價格不能證明今天的大幅變動。
 *   1. 至少兩個不同 source 的合法報價（同名來源只取第一筆）。
 *   2. 彼此差距 (max−min)/min ≤ tolerance。
 *   3. 每個報價相對鏈上 current 的方向一致（全部高於或全部低於）。
 */
export function confirmLargeMove(a: {
  current: number;
  quotes: SourceQuote[];
  tolerance?: number;
  maxQuoteAgeSec?: number;
}): LargeMoveConfirmation {
  const tol = a.tolerance ?? DEFAULT_CONFIRM_TOLERANCE;
  const maxAge = a.maxQuoteAgeSec ?? DEFAULT_CONFIRM_MAX_AGE_SEC;
  const seen = new Set<string>();
  const qs: SourceQuote[] = [];
  const dropped: string[] = [];
  for (const q of a.quotes) {
    if (!Number.isFinite(q.value) || q.value <= 0 || seen.has(q.source)) continue;
    if (q.stale || typeof q.ageSec !== "number" || !Number.isFinite(q.ageSec) || q.ageSec > maxAge) {
      dropped.push(`${q.source}(${q.stale ? "stale" : q.ageSec === undefined ? "無時間戳" : `${q.ageSec}s`})`);
      continue;
    }
    seen.add(q.source);
    qs.push(q);
  }
  const list = qs.map((q) => `${q.source}=$${q.value}`).join(", ") || "無";
  if (qs.length < 2) {
    const why = dropped.length ? `；不新鮮而不計：${dropped.join(", ")}` : "";
    return {
      confirmed: false,
      consensus: 0,
      reason: `只有 ${qs.length} 個新鮮的獨立來源（${list}${why}），至少需要 2 個`,
    };
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
  /** 偏離超過熔斷門檻、經多源確認後寫入共識價。 */
  confirmed: boolean;
  /** |target−current|/current；current≤0 時為 0。 */
  deviation: number;
  reason: string;
}

export function guardDeviation(a: {
  target: number;
  current: number;
  breakerDeviation?: number;
  /** 同一輪的獨立來源報價（含 target 本身的來源）；只在偏離 > breakerDeviation 時使用。 */
  quotes?: SourceQuote[];
  confirmTolerance?: number;
}): DeviationGuard {
  const breaker = a.breakerDeviation ?? DEFAULT_BREAKER_DEVIATION;
  const no = (deviation: number, reason: string): DeviationGuard =>
    ({ value: 0, write: false, confirmed: false, deviation, reason });

  if (!Number.isFinite(a.target) || a.target <= 0) return no(0, "target 非法");
  if (!Number.isFinite(a.current) || a.current <= 0) {
    return { value: a.target, write: true, confirmed: false, deviation: 0, reason: "seed（鏈上無前價，無可比基準）" };
  }

  const deviation = Math.abs(a.target - a.current) / a.current;
  if (deviation <= breaker) {
    return { value: a.target, write: true, confirmed: false, deviation, reason: "在熔斷門檻內" };
  }

  const head =
    `偏離 ${(deviation * 100).toFixed(1)}% 超過熔斷門檻 ${(breaker * 100).toFixed(0)}%` +
    `（$${a.current} → $${a.target}）`;
  const c = confirmLargeMove({ current: a.current, quotes: a.quotes ?? [], tolerance: a.confirmTolerance });
  if (c.confirmed && (c.consensus > a.current) === (a.target > a.current)) {
    return {
      value: c.consensus,
      write: true,
      confirmed: true,
      deviation,
      reason: `${head}，${c.reason}，寫入共識價 $${c.consensus}`,
    };
  }
  return no(
    deviation,
    `${head}—— 熔斷：拒絕寫入，價格將變舊、交易所以 maxPriceAge 停單。多源確認未通過：` +
      (c.confirmed ? "共識方向與目標相反" : c.reason) +
      `。若行情屬實（拆股／財報跳空），依 docs/RUNBOOK_KEEPER.md「價格熔斷」人工處置`,
  );
}

export type MirrorPlan =
  | { action: "write"; value: bigint }
  | { action: "skip"; reason: string }
  | { action: "reject"; reason: string };

/**
 * GuardedOracle 鏡射：只寫完整目標價。鏈上 maxDeviationBps 不接受完整價格時
 * **不改寫部分步進**（那同樣是明知錯誤的價格），回 reject 由呼叫端記為 failed。
 */
export function planMirror(current8: bigint, target8: bigint, maxDeviationBps: bigint): MirrorPlan {
  if (current8 === target8) return { action: "skip", reason: "已是目標值" };
  if (!deviationAccepted(current8, target8, maxDeviationBps)) {
    return {
      action: "reject",
      reason:
        `完整價格 ${target8} 超出 GuardedOracle 上限 ${maxDeviationBps} bps（鏈上 ${current8}）；` +
        `不寫部分步進，需人工處置（見 RUNBOOK_KEEPER.md「價格熔斷」）`,
    };
  }
  return { action: "write", value: target8 };
}

/** run.ts 一輪結束後的計數。 */
export interface RunCounters {
  total: number;
  available: number;
  skipped: number;
  rejected: number;
  wrote: number;
  failed: number;
}

/**
 * 一輪結束後是否讓 job 失敗，以及對應的 ::error:: 訊息。熔斷拒寫（rejected）一定
 * 讓 job 失敗：那是需要人看的事件，不是可以安靜略過的雜訊。
 */
export function runVerdict(c: RunCounters, maxDegradedRatio: number): { exitCode: 0 | 1; errors: string[] } {
  const errors: string[] = [];
  if (c.available > 0 && c.wrote === 0 && c.failed > 0) {
    errors.push(`Keeper 寫入 0 筆（${c.failed} 筆失敗）。檢查簽章者權限與錢包餘額。`);
  }
  if (c.skipped === c.total) errors.push("所有價格來源都無效 —— 來源可能已下線。");
  const degraded = c.skipped + c.rejected;
  const ratio = c.total > 0 ? degraded / c.total : 0;
  if (ratio > maxDegradedRatio) {
    errors.push(
      `${degraded}/${c.total} 個資產無法更新（skipped=${c.skipped} rejected=${c.rejected}，` +
        `${(ratio * 100).toFixed(0)}% > ${(maxDegradedRatio * 100).toFixed(0)}% 門檻）—— 價格來源或熔斷出了問題。`,
    );
  }
  if (c.rejected > 0) errors.push(`${c.rejected} 個資產觸發價格熔斷被拒寫，請依 RUNBOOK_KEEPER.md 人工確認。`);
  if (c.failed > 0) errors.push(`寫入 ${c.wrote} 筆，${c.failed} 筆失敗。`);
  return { exitCode: errors.length ? 1 : 0, errors };
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

// stepTowards（分段逼近 GuardedOracle）已於 2026-09-29 移除：它會把明知不是最佳
// 估計的部分價格寫上鏈。GuardedOracle 拒絕完整價格時改由 planMirror 回 reject，
// 見 docs/RUNBOOK_KEEPER.md「價格熔斷」。
