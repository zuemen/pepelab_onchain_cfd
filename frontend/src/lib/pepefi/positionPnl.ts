/**
 * 未平倉部位的未實現損益——終端機、投資組合、市場動態三處共用這一個定義。
 *
 * ## 為什麼要統一
 *
 * 2026-10 截圖時同一個 sETH 部位，終端機顯示 −7.46、投資組合顯示 +0.00、「目前價值」
 * 797.60 卻是紅字。三個數字各有來源：
 *
 * - 終端機：用鏈下參考價（CoinGecko／Coinbase）自己重算 (現價 − 進場價) × 數量。
 *   參考價不是合約的結算價，合約從來不用它算任何東西。
 * - 投資組合：`getUnrealizedPnL`，合約的 mark 價毛損益，不含任何費用。oracle 沒動
 *   的時候就是 0。
 * - 目前價值：`getPositionValue`，合約 `_closePosition` 的同一套算式。
 *
 * ## 定義
 *
 * 未實現損益 ＝ `getPositionValue(id)` − 保證金。
 *
 * `getPositionValue` 是「現在平倉實際拿回多少」：保證金 ＋ mark 價損益（含獲利上限）
 * − 平倉手續費 − 借貸費 − 應付資金費。減掉保證金，就是現在平倉會比投入多拿或少拿
 * 多少——mark 價、資金費率、手續費都在裡面，而且每一項都是合約自己的數字，前端不
 * 重算任何費率。所以剛開倉、價格還沒動的部位，未實現損益是 −平倉手續費（例如名目
 * 2,400 × 10 bps = −2.40），而不是 0。
 *
 * `getPositionValue` 讀不到時退回 `getUnrealizedPnL`（只差在沒扣費用），兩個都讀不到
 * 才是 null——呼叫端顯示「—」，不要補 0：0 看起來像一個確定的數字。
 */

import { withTimeout } from './safeRead';

export interface PositionChainReads {
  /** `getPosition(id).margin`，18 位小數。 */
  margin: bigint;
  /** `getPositionValue(id)`；讀取失敗為 null。 */
  positionValue: bigint | null;
  /** `getUnrealizedPnL(id)`；讀取失敗為 null。只在 positionValue 讀不到時使用。 */
  markPnl: bigint | null;
}

export interface PositionPnl {
  /** 未實現損益（平倉淨額 − 保證金）。null = 兩個 view 都讀不到。 */
  pnl: bigint | null;
  /** 現在平倉拿回的金額。null = 讀不到。 */
  value: bigint | null;
}

export function positionPnl({ margin, positionValue, markPnl }: PositionChainReads): PositionPnl {
  if (positionValue !== null) return { pnl: positionValue - margin, value: positionValue };
  if (markPnl !== null) {
    const v = margin + markPnl;
    return { pnl: markPnl, value: v > 0n ? v : 0n };
  }
  return { pnl: null, value: null };
}

// ── 讀取 ──────────────────────────────────────────────────────────────────

/** `PerpetualExchange.getPosition()` 用得到的欄位。 */
interface RawPosition {
  asset: string;
  isLong: boolean;
  isOpen: boolean;
  entryPrice: bigint;
  margin: bigint;
  leverage: bigint;
  openedAt?: bigint;
  copiedFrom?: string;
}

/** 只描述這裡會呼叫的 view，讓測試能塞一個假的合約物件。 */
export interface PositionReadContracts {
  exchange: {
    getPosition(id: bigint): Promise<unknown>;
    getPositionValue(id: bigint): Promise<unknown>;
    getUnrealizedPnL(id: bigint): Promise<unknown>;
    pendingFunding(id: bigint): Promise<unknown>;
    getMarkPrice?(asset: string): Promise<unknown>;
  };
  oracle: { getPrice(asset: string): Promise<unknown> };
}

export interface OpenPositionRead {
  id: bigint;
  asset: string;
  isLong: boolean;
  entryPrice: bigint;
  margin: bigint;
  leverage: bigint;
  openedAt: bigint;
  copiedFrom: string;
  /** oracle index 價，18 位小數；讀不到為 0。 */
  indexPrice: bigint;
  /** 合約 mark 價（`getMarkPrice`，含 OI 溢價），18 位小數；舊 ABI 沒有就等於 index。 */
  markPrice: bigint;
  /** 見 `positionPnl`：平倉淨額 − 保證金。兩個 view 都讀不到時為 0（與 safeRead 的退回值一致）。 */
  pnl: bigint;
  /** 現在平倉拿回的金額（`getPositionValue`）。 */
  value: bigint;
  /** 應付資金費（正 = 付出）。 */
  accruedFunding: bigint;
}

const settle = async <T>(p: () => Promise<unknown>, ms: number): Promise<T | null> => {
  try {
    return (await withTimeout(p(), ms)) as T;
  } catch {
    return null;
  }
};

/**
 * 讀一個部位，已平倉回 null。終端機（useTerminalAccount）與投資組合頁都走這裡，
 * 所以同一個部位在兩頁的未實現損益、價值一定是同一組合約讀數算出來的。
 * 每個 view 各自隔離：其中一個 revert 不會讓整列消失。
 */
export async function readOpenPosition(
  // ethers 的 Contract 型別上沒有具名方法（ABI 是執行期才知道的），所以參數只要求有
  // exchange / oracle 兩個物件，內部再當成 PositionReadContracts 用。
  contractSet: { exchange: object; oracle: object },
  id: bigint,
  ms = 8000
): Promise<OpenPositionRead | null> {
  const contracts = contractSet as unknown as PositionReadContracts;
  const raw = await settle<RawPosition>(() => contracts.exchange.getPosition(id), ms);
  if (!raw || !raw.isOpen) return null;

  const ex = contracts.exchange;
  const [positionValue, markPnl, price, funding, mark] = await Promise.all([
    settle<bigint>(() => ex.getPositionValue(id), ms),
    settle<bigint>(() => ex.getUnrealizedPnL(id), ms),
    settle<[bigint, bigint]>(() => contracts.oracle.getPrice(raw.asset), ms),
    settle<bigint>(() => ex.pendingFunding(id), ms),
    ex.getMarkPrice ? settle<bigint>(() => ex.getMarkPrice!(raw.asset), ms) : Promise.resolve(null),
  ]);

  // oracle 存 8 位小數，補到 18 位跟其他數值對齊。
  const indexPrice = price ? price[0] * 10n ** 10n : 0n;
  const { pnl, value } = positionPnl({ margin: raw.margin, positionValue, markPnl });

  return {
    id,
    asset: raw.asset,
    isLong: raw.isLong,
    entryPrice: raw.entryPrice,
    margin: raw.margin,
    leverage: raw.leverage,
    openedAt: raw.openedAt ?? 0n,
    copiedFrom: raw.copiedFrom ?? '0x0000000000000000000000000000000000000000',
    indexPrice,
    markPrice: mark && mark > 0n ? mark : indexPrice,
    pnl: pnl ?? 0n,
    value: value ?? 0n,
    accruedFunding: funding ?? 0n,
  };
}

/** 一組部位的未實現損益合計（終端機帳戶區、投資組合淨資產列共用）。 */
export const totalPnl = (rows: readonly { pnl: bigint }[]): bigint =>
  rows.reduce((s, r) => s + r.pnl, 0n);

// ── 兩頁各自要的形狀 ──────────────────────────────────────────────────────
// 終端機的 toTerminalPos 在 hooks/useTerminalAccount.ts；投資組合的放這裡，讓測試
// 能把同一份讀數餵給兩邊、比對兩頁顯示的數字。

/** 投資組合「部位」頁籤的一列。 */
export interface PortfolioPositionRow {
  id: bigint;
  asset: string;
  isLong: boolean;
  entryPrice: bigint; // 18-dec
  currentPrice: bigint; // 18-dec，oracle index（「預言機」欄）
  margin: bigint; // 18-dec
  leverage: bigint;
  openedAt: bigint; // unix seconds
  unrealizedPnL: bigint; // signed 18-dec，見 positionPnl
  currentValue: bigint; // 18-dec ≥ 0，getPositionValue
  copiedFrom: string; // address(0) for self-opened
  accruedFunding: bigint; // signed 18-dec
}

export const toPortfolioRow = (r: OpenPositionRead): PortfolioPositionRow => ({
  id: r.id,
  asset: r.asset,
  isLong: r.isLong,
  entryPrice: r.entryPrice,
  currentPrice: r.indexPrice,
  margin: r.margin,
  leverage: r.leverage,
  openedAt: r.openedAt,
  unrealizedPnL: r.pnl,
  currentValue: r.value,
  copiedFrom: r.copiedFrom,
  accruedFunding: r.accruedFunding,
});
