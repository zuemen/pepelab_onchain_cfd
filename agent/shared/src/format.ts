import { ethers } from "ethers";

/** 18-dec USDC bigint → 人類可讀數字（保留 2 位）。 */
export function fmtUsdc18(v: bigint): number {
  return Number(ethers.formatUnits(v, 18));
}

/** 8-dec oracle 價格 bigint → USD 數字。 */
export function fmtPrice8(v: bigint): number {
  return Number(ethers.formatUnits(v, 8));
}

/** funding rate（bps，int256）→ 百分比數字。1 bps = 0.01%。 */
export function bpsToPercent(bps: bigint): number {
  return Number(bps) / 100;
}

/** unix 秒 → ISO 字串；0 視為未設定。 */
export function fmtTime(unixSec: bigint | number): string | null {
  const n = Number(unixSec);
  return n > 0 ? new Date(n * 1000).toISOString() : null;
}

/** 把 bigint 安全轉成 JSON 可序列化的字串（避免 JSON.stringify 丟錯）。 */
export function jsonSafe<T>(obj: T): T {
  return JSON.parse(
    JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  );
}
