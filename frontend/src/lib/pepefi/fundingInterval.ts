// 資金費率結算週期的顯示（#196）。
//
// 週期的唯一真相是鏈上 `PerpetualExchange.FUNDING_INTERVAL()`（秒）。現行 exchange 是
// 28800 秒＝8 小時，但白標租戶或下一次重部署可以改——標籤寫死「8 小時」就會再次失真。
// 讀不到時顯示「—」，**不**回退成任何寫死的週期：寧可空著，也不給一個可能是錯的數字。
import { interpolate } from 'src/locales/interpolate';

/** 各語系的時間單位字串，`{n}` 是數量（例：`'{n} 小時'`、`'{n}h'`）。 */
export interface IntervalUnits {
  d: string;
  h: string;
  m: string;
  s: string;
}

export const UNKNOWN_INTERVAL = '—';

const UNITS: ReadonlyArray<[keyof IntervalUnits, number]> = [
  ['d', 86_400],
  ['h', 3_600],
  ['m', 60],
  ['s', 1],
];

/**
 * 把秒數格式化成「能整除的最大單位」：28800 → 8 小時、300 → 5 分鐘、90 → 90 秒。
 * 不做「1 小時 30 分」這種複合格式——標籤要短，而且整除才不會四捨五入出一個假週期。
 * null／0／負數／非有限值一律回傳「—」。
 */
export function formatFundingInterval(
  seconds: bigint | number | null | undefined,
  units: IntervalUnits
): string {
  if (seconds === null || seconds === undefined) return UNKNOWN_INTERVAL;
  const n = typeof seconds === 'bigint' ? Number(seconds) : seconds;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return UNKNOWN_INTERVAL;
  for (const [unit, size] of UNITS) {
    if (n % size === 0) return interpolate(units[unit], { n: n / size });
  }
  return UNKNOWN_INTERVAL; // 不會走到：size=1 一定整除
}

/**
 * 從 useFundingData 的結果取出週期。FUNDING_INTERVAL 是 exchange 全域常數，每個標的
 * 帶的是同一個值，取第一個讀到的即可；全部讀不到回傳 null。
 */
export function fundingIntervalOf(
  data: Record<string, { interval: bigint | null }>
): bigint | null {
  for (const info of Object.values(data)) {
    if (info.interval !== null) return info.interval;
  }
  return null;
}
