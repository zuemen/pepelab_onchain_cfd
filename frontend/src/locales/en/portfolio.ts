import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/portfolio.ts`。搬移階段逐字複製原文。
 */
export const portfolio: Catalog['portfolio'] = {
  netWorth: {
    title: 'Net Worth',
    unrealisedPnl: 'Unrealised PnL',
    unrealisedPnlTooltip: 'Mark-to-market PnL on positions that are still open',

    /**
     * 單複數寫成兩條完整的句子。catalog 沒有複數引擎，而把 'balance' / 'balances'
     * 抽成一個可插入的字，等於假設每個語言都用同樣的句構——中文沒有複數變化，
     * 其他語言的複數規則也不只兩種。
     */
    incompleteOne: '{count} balance could not be read — this total is incomplete.',
    incompleteMany: '{count} balances could not be read — this total is incomplete.',

    part: {
      wallet: 'Wallet',
      trading: 'Trading',
      staked: 'Staked',
      lpVault: 'LP Vault',
    },

    /** 某一項讀不到時的說明（Unread Balance，見 CONTEXT.md）。 */
    unread: {
      wallet: 'Wallet balance could not be read',
      trading: 'Trading account could not be read',
      staked: 'Stake could not be read',
      lpVault: 'LP vault could not be read',
    },
  },

  quickAction: {
    trade: 'Trade',
    copyTrader: 'Copy a trader',
    history: 'History',
    proTerminal: 'Pro Terminal',
  },

  analysis: {
    allocation: 'Allocation',
    noBreakdown: 'No positions to break down.',
    byAssetClass: 'By asset class',
    noPositions: 'No positions',
    esgScore: 'ESG score (value-weighted)',
    esgIncomplete: 'Not all holdings have ESG data yet.',

    cat: {
      crypto: 'Crypto',
      equity: 'Equity',
      commodity: 'Commodity & ETF',
      bond: 'Bond',
    },
  },
};
