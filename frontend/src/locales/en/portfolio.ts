import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/portfolio.ts`。
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

  /**
   * RWA 資產配置——見 CONTEXT.md 的 RWA／Asset Class 詞條。刻意跟 netWorth
   * 分開：這裡的分母是交易部位的保證金，不是淨資產，兩個數字不會對得起來，
   * 用同一個 title 或同一組詞會讓讀者以為算法一樣。
   */
  allocation: {
    title: 'RWA Allocation',
    subtitle: 'Based on margin in open positions — excludes wallet cash, staking, and the LP vault. Not a breakdown of Net Worth.',
    noPositions: 'No positions yet',

    /**
     * 見 `../zh-TW/portfolio.ts`。
     */
    benchmark: {
      heading: 'Benchmarks',
      names: {
        spx: 'S&P 500',
        gold: 'Gold',
        btc: 'Bitcoin',
      },
      itemUnavailable: 'Currently unavailable',
      unreachable: "Can't reach the benchmarks API ({url}).",
      unreachableDev:
        "Can't reach the benchmarks API ({url}). Start signal-api first: cd agent/signal-api && npx tsx src/index.ts",
      httpError: 'Benchmarks API returned {status} ({url})',
      httpError404:
        'Benchmarks API returned {status} ({url}) — this deployment may not have the /benchmarks route yet; redeploy signal-api',
    },
  },

  quickAction: {
    trade: 'Trade',
    copyTrader: 'Copy a trader',
    history: 'History',
    proTerminal: 'Pro Terminal',
  },

  /**
   * Open Positions 的欄位名。simple 與 expert 兩張表共用同一份——原本 expert 表在
   * 頁面裡另外寫了一份一模一樣的清單，兩份字得同時改才不會不一致。
   */
  column: {
    asset: 'Asset',
    esg: 'ESG',
    side: 'Side',
    entry: 'Entry',
    oracle: 'Oracle',
    liveMarket: 'Live Market',
    margin: 'Margin',
    leverage: 'Lev',
    copiedFrom: 'Copied From',
    unrealizedPnl: 'Unr. PnL',
    accruedFunding: 'Accrued Funding',
    value: 'Value',
  },

  /** 欄位的 tooltip。只有會被誤讀的欄位需要——兩個價格擺在一起且幾乎不相等。 */
  columnHint: {
    entry: 'Price you opened at',
    oracle: 'On-chain price the contract settles against — this is what Unr. PnL uses',
    liveMarket: 'Off-chain feed. Moves before the oracle does, so a gap here is normal',
    unrealizedPnl: 'Unrealised, from the Oracle price',
  },

  page: {
    title: 'My Portfolio',
    refresh: 'Refresh',
    connectWallet: 'Connect wallet to view your portfolio.',

    unsupportedNetwork: 'Unsupported Network',
    unknownChain: 'unknown',
    chainNumber: 'Chain {id}',

    demoTitle: 'Demo mode — no live chain data',
    demoDescription:
      "You're on the presentation walkthrough, which has no wallet connection to read real balances or positions from. Connect a real wallet to see your actual portfolio.",

    emptyTitle: 'Your portfolio is empty',
    emptyDescription:
      'Start by getting test {token}, then copy a trader or open positions yourself.',
    emptyCta: 'Get {token}',

    side: {
      long: 'LONG ↑',
      short: 'SHORT ↓',
    },

    activeCopies: 'Active Copies',
    traderFollowedOne: 'trader followed',
    traderFollowedMany: 'traders followed',
    totalCopyPnl: 'Total Copy PnL',
    noCopyPositions: 'no copy positions',

    copyPositions: 'Copy Positions',
    notCopyingAnyone: "You're not copying anyone yet.",
    browseTraders: 'Browse traders →',
    copyColumn: {
      trader: 'Trader',
      copiedAt: 'Copied At',
      initial: 'Initial',
      current: 'Current',
      return: 'Return',
      actions: 'Actions',
    },
    unfollow: 'Unfollow',
    unfollowStale: 'Price stale',
    unfollowedOk: 'Unfollowed and all positions closed ✓',

    openPositions: 'Open Positions',
    openCount: '{count} open · manual + copied',
    noOpenPositions: 'No open positions.',
    total: 'Total',

    freeMargin: 'Free Margin',
    amountPlaceholder: 'Amount',
    withdraw: 'Withdraw',
    withdrawnOk: 'Withdrew {amount} {token} ✓',
    enterValidAmount: 'Enter a valid amount',

    copyPerformance: 'Copy Performance',
    chart: {
      deposited: 'Deposited',
      now: 'Now',
      initial: 'Initial',
      portfolioValue: 'Portfolio Value',
    },
    autoRefresh: 'Auto-refreshes every 30 s · Two-point view (initial vs current)',
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
      commodity: 'Commodity',
      bond: 'Bond',
    },
  },
};
