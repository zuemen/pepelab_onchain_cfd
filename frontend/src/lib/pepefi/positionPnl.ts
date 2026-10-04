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
 * ## 不給數字的三種情況（呼叫端顯示「—」＋原因，絕不補 0）
 *
 * - `unreadable`：`getPositionValue` 或 oracle 讀不到（RPC 逾時、節點錯誤）。以前會補成 0，
 *   畫面出現綠色的 +0.0000——看起來是一個確定的數字。也不再退回 `getUnrealizedPnL`：
 *   那是不扣費用的毛額，同一欄會在兩種口徑之間無聲跳動。
 * - `noPrice`：oracle 價格是 0。合約這時不 revert，`getPositionValue` 回 0（M8 的保守值），
 *   照算會變成「保證金全虧」；`getMarkPrice` 也回 0。
 * - `stale`：oracle 價格超過合約的 maxPriceAge。合約此時拒絕平倉（StalePrice），算出來的
 *   「平倉可拿回」並不能兌現。
 *
 * ## 口徑沒有涵蓋的部分（view 與實際平倉的差異）
 *
 * - 跟單部位獲利時的 10% 績效費（`_closePosition` 才扣）；
 * - 資金費以最後一次結算的累積指數為準（平倉時會先 `_pokeFunding` 再算）；
 * - 穿倉時保險金庫的 bailout floor。
 */

import { withTimeout } from './safeRead';
import { FALLBACK_MAX_PRICE_AGE_SEC } from './priceFreshness';

/** `ok` 才有數字；其餘三種見檔頭。 */
export type PnlStatus = 'ok' | 'unreadable' | 'noPrice' | 'stale';

export interface PositionChainReads {
  /** `getPosition(id).margin`，18 位小數。 */
  margin: bigint;
  /** `getPositionValue(id)`；讀取失敗為 null。 */
  positionValue: bigint | null;
  /** oracle `getPrice(asset)` 的 [價格(8 dp), 更新時間]；讀取失敗為 null。 */
  oracle: readonly [bigint, bigint] | null;
  /** 判斷過期用的現在時間（秒）。 */
  nowSec: number;
  /** 合約的 maxPriceAge（秒）。 */
  maxPriceAgeSec?: number;
}

export interface PositionPnl {
  status: PnlStatus;
  /** 未實現損益（平倉淨額 − 保證金）。status 不是 ok 時為 null。 */
  pnl: bigint | null;
  /** 現在平倉拿回的金額。status 不是 ok 時為 null。 */
  value: bigint | null;
}

export function positionPnl({
  margin,
  positionValue,
  oracle,
  nowSec,
  maxPriceAgeSec = FALLBACK_MAX_PRICE_AGE_SEC,
}: PositionChainReads): PositionPnl {
  const none = (status: PnlStatus): PositionPnl => ({ status, pnl: null, value: null });
  if (oracle === null) return none('unreadable');
  if (oracle[0] <= 0n) return none('noPrice');
  const updatedAt = Number(oracle[1]);
  if (updatedAt > 0 && nowSec - updatedAt > maxPriceAgeSec) return none('stale');
  if (positionValue === null) return none('unreadable');
  return { status: 'ok', pnl: positionValue - margin, value: positionValue };
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
  /** 見 PnlStatus。 */
  status: PnlStatus;
  /** oracle index 價，18 位小數；讀不到或為 0 時 null。 */
  indexPrice: bigint | null;
  /**
   * 合約 mark 價（`getMarkPrice`，含全部 OI 的溢價），18 位小數；status 不是 ok 時 null。
   * 沒讀（withMarkPrice = false）時等於 index。注意部位本身的損益用的是「排除自己名目」
   * 的 mark（`_markPriceExcluding`），markPremiumCapBps > 0 時兩者會不同。
   */
  markPrice: bigint | null;
  /** 見 `positionPnl`：平倉淨額 − 保證金。status 不是 ok 時 null——呼叫端顯示「—」。 */
  pnl: bigint | null;
  /** 現在平倉拿回的金額（`getPositionValue`）。status 不是 ok 時 null。 */
  value: bigint | null;
  /** 應付資金費（正 = 付出）；讀不到為 null。 */
  accruedFunding: bigint | null;
}

export interface ReadOptions {
  /** 每個 view 的逾時。 */
  ms?: number;
  /** 投資組合用不到 mark 價，傳 false 省一次 RPC。 */
  withMarkPrice?: boolean;
  /** 合約的 maxPriceAge（秒），讀不到就用後備值。 */
  maxPriceAgeSec?: number;
  /** 測試用。 */
  nowSec?: number;
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
 * 每個 view 各自隔離：其中一個 revert 不會讓整列消失，只會讓那一列變成「—」。
 */
export async function readOpenPosition(
  // ethers 的 Contract 型別上沒有具名方法（ABI 是執行期才知道的），所以參數只要求有
  // exchange / oracle 兩個物件，內部再當成 PositionReadContracts 用。
  contractSet: { exchange: object; oracle: object },
  id: bigint,
  opts: ReadOptions = {}
): Promise<OpenPositionRead | null> {
  const r = await readPosition(contractSet, id, opts);
  return r.kind === 'open' ? r.row : null;
}

/**
 * 同 readOpenPosition，但分得出「已平倉」與「getPosition 本身讀不到」（審查 L5）。
 * 讀不到的部位不能悄悄從列表與合計裡消失：呼叫端要把合計標成不完整、顯示讀取失敗。
 */
export type PositionReadResult =
  | { kind: 'open'; row: OpenPositionRead }
  | { kind: 'closed' }
  | { kind: 'failed'; id: bigint };

export async function readPosition(
  contractSet: { exchange: object; oracle: object },
  id: bigint,
  opts: ReadOptions = {}
): Promise<PositionReadResult> {
  const ms = opts.ms ?? 8000;
  const contracts = contractSet as unknown as PositionReadContracts;
  const raw = await settle<RawPosition>(() => contracts.exchange.getPosition(id), ms);
  if (!raw) return { kind: 'failed', id };
  if (!raw.isOpen) return { kind: 'closed' };

  const ex = contracts.exchange;
  const wantMark = opts.withMarkPrice !== false && !!ex.getMarkPrice;
  const [positionValue, price, funding, mark] = await Promise.all([
    settle<bigint>(() => ex.getPositionValue(id), ms),
    settle<[bigint, bigint]>(() => contracts.oracle.getPrice(raw.asset), ms),
    settle<bigint>(() => ex.pendingFunding(id), ms),
    wantMark ? settle<bigint>(() => ex.getMarkPrice!(raw.asset), ms) : Promise.resolve(null),
  ]);

  const { status, pnl, value } = positionPnl({
    margin: raw.margin,
    positionValue,
    oracle: price ? [price[0], price[1]] : null,
    nowSec: opts.nowSec ?? Math.floor(Date.now() / 1000),
    maxPriceAgeSec: opts.maxPriceAgeSec,
  });

  // oracle 存 8 位小數，補到 18 位跟其他數值對齊。
  const indexPrice = price && price[0] > 0n ? price[0] * 10n ** 10n : null;
  let markPrice: bigint | null = null;
  if (status === 'ok') {
    if (!wantMark) markPrice = indexPrice;
    else if (mark !== null && mark > 0n) markPrice = mark;
  }

  return {
    kind: 'open',
    row: {
      id,
      asset: raw.asset,
      isLong: raw.isLong,
      entryPrice: raw.entryPrice,
      margin: raw.margin,
      leverage: raw.leverage,
      openedAt: raw.openedAt ?? 0n,
      copiedFrom: raw.copiedFrom ?? '0x0000000000000000000000000000000000000000',
      status,
      indexPrice,
      markPrice,
      pnl,
      value,
      accruedFunding: funding,
    },
  };
}

/** 合約的 maxPriceAge；讀不到用後備值（Base Sepolia 實際部署的 6 小時）。 */
export async function readMaxPriceAge(exchange: object | null | undefined, ms = 8000): Promise<number> {
  const ex = exchange as { maxPriceAge?: () => Promise<unknown> } | null | undefined;
  if (!ex?.maxPriceAge) return FALLBACK_MAX_PRICE_AGE_SEC;
  const v = await settle<bigint>(() => ex.maxPriceAge!(), ms);
  return v !== null && v > 0n ? Number(v) : FALLBACK_MAX_PRICE_AGE_SEC;
}

/**
 * 一組部位的未實現損益合計（終端機帳戶區、投資組合淨資產列共用）。
 * 任何一列沒有數字就回 null：少算一個部位的合計不是「比較保守的數字」，是錯的。
 */
export const totalPnl = (rows: readonly { pnl: bigint | null }[]): bigint | null =>
  rows.some((r) => r.pnl === null) ? null : rows.reduce((s, r) => s + (r.pnl as bigint), 0n);

/** 一組部位的平倉價值合計；同 totalPnl，任何一列沒有數字就回 null。 */
export const totalValue = (rows: readonly { value: bigint | null }[]): bigint | null =>
  rows.some((r) => r.value === null) ? null : rows.reduce((s, r) => s + (r.value as bigint), 0n);

// ── 兩頁各自要的形狀 ──────────────────────────────────────────────────────
// 終端機的 toTerminalPos 在 hooks/useTerminalAccount.ts；投資組合的放這裡，讓測試
// 能把同一份讀數餵給兩邊、比對兩頁顯示的數字。

/** 投資組合「部位」頁籤的一列。 */
export interface PortfolioPositionRow {
  id: bigint;
  asset: string;
  isLong: boolean;
  entryPrice: bigint; // 18-dec
  currentPrice: bigint | null; // 18-dec，oracle index（「預言機」欄）
  margin: bigint; // 18-dec
  leverage: bigint;
  openedAt: bigint; // unix seconds
  status: PnlStatus;
  unrealizedPnL: bigint | null; // signed 18-dec，見 positionPnl；status 不是 ok 時 null
  currentValue: bigint | null; // 18-dec ≥ 0，getPositionValue；status 不是 ok 時 null
  copiedFrom: string; // address(0) for self-opened
  accruedFunding: bigint | null; // signed 18-dec
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
  status: r.status,
  unrealizedPnL: r.pnl,
  currentValue: r.value,
  copiedFrom: r.copiedFrom,
  accruedFunding: r.accruedFunding,
});

/** 有數字的列（給只吃 bigint 的圖表／分析元件用；讀不到的列不畫，而不是畫成 0）。 */
export type PricedPortfolioRow = PortfolioPositionRow & {
  unrealizedPnL: bigint;
  currentValue: bigint;
  currentPrice: bigint;
};
export const isPriced = (r: PortfolioPositionRow): r is PricedPortfolioRow =>
  r.status === 'ok' && r.unrealizedPnL !== null && r.currentValue !== null && r.currentPrice !== null;
