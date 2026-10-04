import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

import { toTerminalPos } from 'src/hooks/useTerminalAccount';

import { isPriced, totalPnl, readPosition, toPortfolioRow, readOpenPosition } from './positionPnl';

/**
 * 釘住「同一個部位在交易終端機與投資組合頁顯示同一個未實現損益」。
 *
 * 2026-10-02 截圖：sETH 做多、保證金 800、3×，終端機顯示 −7.46（鏈下參考價重算），
 * 投資組合顯示 +0.00（getUnrealizedPnL），目前價值 797.60 卻是紅字。這裡用同一組
 * 假合約讀數餵兩頁的資料路徑，數字必須一模一樣；讀不到或價格不可用時兩頁都不給數字。
 */

const E18 = 10n ** 18n;
const SETH = `0x${'ab'.repeat(32)}`;
const NOW = 1_790_000_000;
const never = () => new Promise<never>(() => {});
const boom = async (): Promise<never> => {
  throw new Error('revert');
};

const screenshotChain = (over: Partial<Record<string, () => Promise<unknown>>> = {}) => ({
  exchange: {
    getPosition:
      over.getPosition ??
      (async () => ({
        asset: SETH,
        isLong: true,
        isOpen: true,
        entryPrice: 276055n * 10n ** 16n,
        margin: 800n * E18,
        leverage: 3n,
        openedAt: 1_789_990_000n,
        copiedFrom: '0x0000000000000000000000000000000000000000',
      })),
    // 800 − 2,400 × 10 bps：oracle 沒動，只扣平倉手續費。
    getPositionValue: over.getPositionValue ?? (async () => 79760n * 10n ** 16n),
    pendingFunding: over.pendingFunding ?? (async () => 0n),
    getMarkPrice: over.getMarkPrice ?? (async () => 276055n * 10n ** 16n),
  },
  oracle: { getPrice: over.getPrice ?? (async () => [276055000000n, BigInt(NOW - 60)]) },
});

const read = (chain: ReturnType<typeof screenshotChain>, ms?: number) =>
  readOpenPosition(chain, 1n, { nowSec: NOW, ms });

describe('terminal and portfolio show the same unrealised PnL for the same position', () => {
  it('both read the position through readOpenPosition and get the contract’s net figure', async () => {
    const r = await read(screenshotChain());
    expect(r).not.toBeNull();

    const terminal = toTerminalPos(r!);
    const portfolio = toPortfolioRow(r!);

    expect(terminal.status).toBe('ok');
    expect(terminal.pnl).toBe(-240n * 10n ** 16n);
    expect(portfolio.unrealizedPnL).toBe(terminal.pnl);
    expect(portfolio.currentValue).toBe(terminal.value);

    // 終端機帳戶區的「未實現 PnL」與投資組合淨資產列的「未實現 PnL」是同一個合計。
    expect(totalPnl([terminal])).toBe(portfolio.unrealizedPnL);
  });

  it('the value colour and the PnL sign can no longer disagree (797.60 red next to +0.0000)', async () => {
    const portfolio = toPortfolioRow((await read(screenshotChain()))!);
    expect(portfolio.currentValue! < portfolio.margin).toBe(true);
    expect(portfolio.unrealizedPnL! < 0n).toBe(true);
  });

  it('the terminal’s mark column is the contract mark price, not an off-chain reference', async () => {
    const terminal = toTerminalPos((await read(screenshotChain()))!);
    expect(terminal.cur).toBe(276055n * 10n ** 16n);
  });

  // 審查 L5：getPosition 讀不到不能和「已平倉」走同一條路、悄悄從列表消失。
  it('a position whose getPosition fails is reported as failed, not as closed', async () => {
    const chain = screenshotChain({ getPosition: boom });
    expect(await readPosition(chain, 7n, { nowSec: NOW })).toEqual({ kind: 'failed', id: 7n });
    const closed = screenshotChain({
      getPosition: async () => ({ asset: SETH, isOpen: false }),
    });
    expect(await readPosition(closed, 7n, { nowSec: NOW })).toEqual({ kind: 'closed' });
  });

  it('a closed position is not shown on either page', async () => {
    const chain = screenshotChain();
    const closed = screenshotChain({
      getPosition: async () => ({ ...((await chain.exchange.getPosition()) as object), isOpen: false }),
    });
    expect(await read(closed)).toBeNull();
  });
});

describe('when there is no trustworthy figure, neither page shows one', () => {
  // H2：以前兩個 view 都讀不到時補成 0n，終端機顯示綠色的 +0.0000。
  it('a reverting getPositionValue: no figure on either page, and the totals are unknown', async () => {
    const r = (await read(screenshotChain({ getPositionValue: boom })))!;
    const terminal = toTerminalPos(r);
    const portfolio = toPortfolioRow(r);

    expect(terminal.status).toBe('unreadable');
    expect(terminal.pnl).toBeNull();
    expect(terminal.value).toBeNull();
    expect(portfolio.unrealizedPnL).toBeNull();
    expect(portfolio.currentValue).toBeNull();
    expect(isPriced(portfolio)).toBe(false);
    expect(totalPnl([terminal])).toBeNull();
  });

  it('a node that never answers (timeout) is the same as a failed read, never 0', async () => {
    const r = (await read(screenshotChain({ getPositionValue: never, getPrice: never }), 20))!;
    expect(r.status).toBe('unreadable');
    expect(toTerminalPos(r).pnl).toBeNull();
    expect(toPortfolioRow(r).unrealizedPnL).toBeNull();
  });

  // M1：價格為 0 時合約不 revert：getPositionValue 回 0、getMarkPrice 回 0。
  it('a zero oracle price shows "no valid price", not a total loss and not a $0 mark', async () => {
    const r = (await read(
      screenshotChain({
        getPrice: async () => [0n, BigInt(NOW)],
        getPositionValue: async () => 0n,
        getMarkPrice: async () => 0n,
      })
    ))!;
    const terminal = toTerminalPos(r);
    const portfolio = toPortfolioRow(r);
    expect(terminal.status).toBe('noPrice');
    expect(terminal.pnl).toBeNull();
    expect(terminal.cur).toBeNull();
    expect(portfolio.unrealizedPnL).toBeNull();
    expect(portfolio.currentValue).toBeNull();
    expect(portfolio.currentPrice).toBeNull();
  });

  it('a price older than the contract’s maxPriceAge is "stale" on both pages', async () => {
    const r = (await readOpenPosition(
      screenshotChain({ getPrice: async () => [276055000000n, BigInt(NOW - 30_000)] }),
      1n,
      { nowSec: NOW, maxPriceAgeSec: 21_600 }
    ))!;
    expect(r.status).toBe('stale');
    expect(toTerminalPos(r).pnl).toBeNull();
    expect(toPortfolioRow(r).unrealizedPnL).toBeNull();
  });

  it('the portfolio does not pay for getMarkPrice it never shows', async () => {
    let calls = 0;
    const chain = screenshotChain({
      getMarkPrice: async () => {
        calls += 1;
        return 1n;
      },
    });
    const r = (await readOpenPosition(chain, 1n, { nowSec: NOW, withMarkPrice: false }))!;
    expect(calls).toBe(0);
    expect(r.markPrice).toBe(r.indexPrice);
  });
});

describe('no page recomputes PnL from an off-chain price', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const src = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

  it('the terminal and the portfolio page both load positions with readOpenPosition', () => {
    expect(src('hooks/useTerminalAccount.ts')).toMatch(/readPosition\(/);
    expect(src('pages/pepefi/PortfolioPage.tsx')).toMatch(/readPosition\(/);
  });

  it('neither the terminal view nor the market-activity panel multiplies a price delta by size', () => {
    for (const rel of ['sections/terminal/TerminalView.tsx', 'sections/terminal/book/MarketActivity.tsx']) {
      expect(src(rel), rel).not.toMatch(/-\s*p\.entryPrice\)\s*\*\s*size/);
    }
  });
});
