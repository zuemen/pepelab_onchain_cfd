// 金額表示：每個數值同時回傳原始 bigint 與「精確」的十進位字串。
// 不轉成 JS number —— 18 位小數的金額轉 number 會失去精度，對帳時會對不起來。
import { formatUnits } from "viem";

/** 保證金代幣（MockUSDC）小數位；保證金、PnL、名目金額、OI 上限都是這個單位。 */
export const MARGIN_DECIMALS = 18;
/** Oracle 價格小數位（MockOracle / GuardedOracle）。 */
export const PRICE_DECIMALS = 8;
/** 原生幣（ETH）小數位；executionFee 用。 */
export const NATIVE_DECIMALS = 18;

export interface Amount {
  /** 鏈上原始整數。 */
  raw: bigint;
  /** 精確十進位字串（viem formatUnits，不經過浮點數）。 */
  formatted: string;
  decimals: number;
}

export const amount = (raw: bigint, decimals: number): Amount => ({
  raw,
  formatted: formatUnits(raw, decimals),
  decimals,
});

export const margin = (raw: bigint): Amount => amount(raw, MARGIN_DECIMALS);
export const price = (raw: bigint): Amount => amount(raw, PRICE_DECIMALS);

/** unix 秒 → ISO；0 代表「從未設定」回 null。 */
export const isoOrNull = (unixSec: bigint | number): string | null => {
  const n = Number(unixSec);
  return n > 0 ? new Date(n * 1000).toISOString() : null;
};

/** 把含 bigint 的物件轉成可 JSON 序列化（bigint → 十進位字串）。 */
export function toJsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
