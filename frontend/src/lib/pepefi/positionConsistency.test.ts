import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it, expect, describe } from 'vitest';

import { toTerminalPos } from 'src/hooks/useTerminalAccount';

import { totalPnl, toPortfolioRow, readOpenPosition } from './positionPnl';

/**
 * 釘住「同一個部位在交易終端機與投資組合頁顯示同一個未實現損益」。
 *
 * 2026-10-02 截圖：sETH 做多、保證金 800、3×，終端機顯示 −7.46（鏈下參考價重算），
 * 投資組合顯示 +0.00（getUnrealizedPnL），目前價值 797.60 卻是紅字。這裡用同一組
 * 假合約讀數餵兩頁的資料路徑，數字必須一模一樣。
 */

const E18 = 10n ** 18n;
const SETH = `0x${'ab'.repeat(32)}`;

const screenshotChain = (over: Partial<Record<string, () => Promise<unknown>>> = {}) => ({
  exchange: {
    getPosition: async () => ({
      asset: SETH,
      isLong: true,
      isOpen: true,
      entryPrice: 276055n * 10n ** 16n,
      margin: 800n * E18,
      leverage: 3n,
      openedAt: 1_790_000_000n,
      copiedFrom: '0x0000000000000000000000000000000000000000',
    }),
    // 800 − 2,400 × 10 bps：oracle 沒動，只扣平倉手續費。
    getPositionValue: over.getPositionValue ?? (async () => 79760n * 10n ** 16n),
    getUnrealizedPnL: async () => 0n,
    pendingFunding: async () => 0n,
    getMarkPrice: async () => 276055n * 10n ** 16n,
  },
  oracle: { getPrice: async () => [276055000000n, 1_790_000_000n] },
});

describe('terminal and portfolio show the same unrealised PnL for the same position', () => {
  it('both read the position through readOpenPosition and get the contract’s net figure', async () => {
    const read = await readOpenPosition(screenshotChain(), 1n);
    expect(read).not.toBeNull();

    const terminal = toTerminalPos(read!);
    const portfolio = toPortfolioRow(read!);

    expect(terminal.pnl).toBe(-240n * 10n ** 16n);
    expect(portfolio.unrealizedPnL).toBe(terminal.pnl);
    expect(portfolio.currentValue).toBe(terminal.value);

    // 終端機帳戶區的「未實現 PnL」與投資組合淨資產列的「未實現 PnL」是同一個合計。
    expect(totalPnl([terminal])).toBe(portfolio.unrealizedPnL);
  });

  it('the value colour and the PnL sign can no longer disagree (797.60 red next to +0.0000)', async () => {
    const portfolio = toPortfolioRow((await readOpenPosition(screenshotChain(), 1n))!);
    expect(portfolio.currentValue < portfolio.margin).toBe(true);
    expect(portfolio.unrealizedPnL < 0n).toBe(true);
  });

  it('the terminal’s mark column is the contract mark price, not an off-chain reference', async () => {
    const terminal = toTerminalPos((await readOpenPosition(screenshotChain(), 1n))!);
    expect(terminal.cur).toBe(276055n * 10n ** 16n);
  });

  it('a reverting getPositionValue degrades the same way on both pages', async () => {
    const chain = screenshotChain({
      getPositionValue: async () => {
        throw new Error('revert');
      },
    });
    const read = (await readOpenPosition(chain, 1n))!;
    expect(toTerminalPos(read).pnl).toBe(0n);
    expect(toPortfolioRow(read).unrealizedPnL).toBe(0n);
  });

  it('a closed position is not shown on either page', async () => {
    const chain = screenshotChain();
    const closed = {
      ...chain,
      exchange: {
        ...chain.exchange,
        getPosition: async () => ({ ...(await chain.exchange.getPosition()), isOpen: false }),
      },
    };
    expect(await readOpenPosition(closed, 1n)).toBeNull();
  });
});

describe('no page recomputes PnL from an off-chain price', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

  it('the terminal and the portfolio page both load positions with readOpenPosition', () => {
    expect(read('hooks/useTerminalAccount.ts')).toMatch(/readOpenPosition\(/);
    expect(read('pages/pepefi/PortfolioPage.tsx')).toMatch(/readOpenPosition\(/);
  });

  it('neither the terminal view nor the market-activity panel multiplies a price delta by size', () => {
    for (const rel of [
      'sections/terminal/TerminalView.tsx',
      'sections/terminal/book/MarketActivity.tsx',
    ]) {
      expect(read(rel), rel).not.toMatch(/-\s*p\.entryPrice\)\s*\*\s*size/);
    }
  });
});
