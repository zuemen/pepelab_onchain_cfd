import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/portfolio.ts`。
 */
export const portfolio: Catalog['portfolio'] = {
  netWorth: {
    title: 'Net Worth',
    titleTooltip: 'Each part valued at current prices and added up — not an amount you can withdraw all at once. The parts differ in liquidity and risk; hover each heading below for details.',
    liquid: 'Available now',
    liquidTooltip: 'Wallet USDC + free margin in your trading account: usable without closing a position, unstaking or redeeming. Excludes margin locked in positions, stake, the LP vault and tokenized assets.',
    unrealisedPnl: 'Unrealised PnL',
    unrealisedPnlTooltip: 'What your open positions would net if closed now: mark-price PnL after fees and funding, the same figure as the trading terminal. Excludes the 10% performance fee some positions pay on profit; funding as of the last settlement; excludes the bankruptcy bailout. Shows — when any position cannot be read',

    /**
     * 單複數寫成兩條完整的句子。catalog 沒有複數引擎，而把 'balance' / 'balances'
     * 抽成一個可插入的字，等於假設每個語言都用同樣的句構——中文沒有複數變化，
     * 其他語言的複數規則也不只兩種。
     */
    incompleteOne: '{count} balance could not be read — this total is incomplete.',
    incompleteMany: '{count} balances could not be read — this total is incomplete.',

    part: {
      spot: 'Tokenized assets',
      wallet: 'Wallet',
      trading: 'Trading',
      staked: 'Staked',
      lpVault: 'LP Vault',
    },

    risk: {
      spot: 'Valued at the oracle price, not a traded price; while the underlying market is closed the price may sit at its last update. Redeeming pays USDC at the current oracle price, and only while the asset vault holds enough USDC. These are synthetic tokens — they cannot be exchanged for the real stock or commodity.',
      wallet: 'USDC in your Web3 wallet, usable any time. Its value depends on the stablecoin holding its $1 peg.',
      trading: 'Free margin can be withdrawn any time; margin locked in positions comes back only when you close them. Leveraged positions are liquidated when losses reach maintenance margin. Excludes unrealised PnL, which is shown next to net worth.',
      staked: 'USDC staked in TraderStake. After requesting an unstake you wait 1 day to withdraw. When one of your followers exits with a loss of 30% or more, half that loss is slashed from your stake, up to 50% of the stake.',
      stakedNoCopy: 'USDC staked in TraderStake. After requesting an unstake you wait 1 day to withdraw. When the contract\'s slashing rules trigger, up to 50% of the stake can be deducted at once.',
      lpVault: 'The LP vault covers traders\' bankruptcies; each bailout lowers the share value. Shown is the USDC your shares would redeem for at the current share price; if the vault runs short it cannot redeem in full.',
    },

    /** 某一項讀不到時的說明（Unread Balance，見 CONTEXT.md）。 */
    unread: {
      spot: 'Some tokenized-asset balances or prices could not be read',
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
    subtitle: 'Tokenized asset holdings at mark plus margin in open positions — excludes wallet cash, staking, and the LP vault. Not a breakdown of Net Worth.',
    subtitleSpot: 'Tokenized asset holdings at mark (plus margin, if the account still holds trading positions) — excludes wallet cash, staking, and the LP vault. Not a breakdown of Net Worth.',
    noPositions: 'Nothing held yet',
    holdingsOnlyNote: 'The PnL column covers trading positions only — spot holdings have no on-chain cost basis.',

    /**
     * 見 `../zh-TW/portfolio.ts`。
     */
    benchmark: {
      heading: 'Benchmarks',
      names: {
        spx: 'S&P 500',
        bond: 'US Treasury',
        gold: 'Gold',
        btc: 'Bitcoin',
      },
      dayChange: 'Day change',
      chartRange: 'Past month',
      chartPrice: 'Close',
      itemUnavailable: 'Currently unavailable',
      unreachable: "Can't reach the benchmarks API ({url}).",
      unreachableDev:
        "Can't reach the benchmarks API ({url}). Start signal-api first: cd agent/signal-api && npx tsx src/index.ts",
      httpError: 'Benchmarks API returned {status} ({url})',
      httpError404:
        'Benchmarks API returned {status} ({url}) — this deployment may not have the /benchmarks route yet; redeploy signal-api',
    },

    /**
     * See `../zh-TW/portfolio.ts`.
     */
    comparison: {
      heading: 'You vs the Market',
      since: "Since {date} (your oldest position's open date) · {days} days",
      beatSummary: 'Ahead of {beat} of {total} benchmarks',
      beatSummaryNone: 'No benchmark data to compare against yet',
      aheadBy: 'ahead by {pp}pp',
      behindBy: 'behind by {pp}pp',
      youLabel: 'You (deleveraged)',
      youHint:
        'Unrealised PnL ÷ notional — leverage stripped out so this is comparable to the unleveraged benchmarks. The allocation ring above uses margin as its denominator; that difference is intentional.',
      noPositions: 'No positions yet',
    },
  },

  quickAction: {
    trade: 'Trade',
    copyTrader: 'Copy a trader',
    marketplace: 'Browse marketplace',
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

  columnSimple: {
    unrealizedPnl: 'Holding return',
    margin: 'Amount invested',
    value: 'Current value',
  },

  /** 欄位的 tooltip。只有會被誤讀的欄位需要——兩個價格擺在一起且幾乎不相等。 */
  columnHint: {
    entry: 'Price you opened at',
    oracle: 'On-chain price the contract settles against — this is what Unr. PnL uses',
    liveMarket: 'Off-chain feed. Moves before the oracle does, so a gap here is normal',
    unrealizedPnl: 'How much more or less than your margin you would get back by closing now: mark-price PnL after the close fee, borrow fee and accrued funding (contract getPositionValue − margin). Excludes the 10% performance fee some positions pay on profit; funding as of the last settlement; excludes the bankruptcy bailout',
  },

  close: {
    column: 'Actions',
    button: 'Close',
    closing: 'Closing…',
    closed: 'Position closed',
    halted: 'The {asset} market is halted; positions cannot be closed right now.',
    copyManaged: 'This position belongs to an active copy. Unfollow the trader under Copy Positions above to close it.',
    copyManagedShort: 'Copying',
    leftover: 'Left over from an earlier copy; you can close it directly.',
  },

  page: {
    positionsUnread: '{count} position(s) could not be read this time — the table and totals below are incomplete. Refresh to try again.',
    title: 'My Portfolio',
    refresh: 'Refresh',

    /** 見 `../zh-TW/portfolio.ts`。 */
    tab: {
      spot:      'Spot',
      positions: 'Positions',
    },
    connectWallet: 'Connect wallet to view your portfolio.',

    unsupportedNetwork: 'Unsupported Network',
    connectedTo: 'Connected to ',
    connectedToAfter: '.',
    switchTo: 'Please switch to ',
    switchToAfter: ' testnet.',
    unknownChain: 'unknown',
    chainNumber: 'Chain {id}',

    demoTitle: 'Demo mode — no live chain data',
    demoDescription:
      "You're on the presentation walkthrough, which has no wallet connection to read real balances or positions from. Connect a real wallet to see your actual portfolio.",

    emptyTitle: 'Your portfolio is empty',
    emptyDescription:
      'Start by getting test {token}, then copy a trader or open positions yourself.',
    emptyDescriptionNoCopy:
      'Start by getting test {token}, then buy tokenized assets on the Assets page or browse published allocations on the marketplace.',
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
    copyOutdated: 'Strategy updated',
    copyOutdatedHint: 'The trader has published a new strategy version. Your copy is still on the old one and does not adjust by itself.',
    copyRefresh: 'Move to latest',
    copyRefreshing: 'Updating…',
    copyRefreshStep: 'Unfollow the old copy, withdraw the {amount} USDC it returns to your wallet, then copy the latest version with the same amount.',
    stopLossNone: 'Off',
    stopLossOption: 'At -{pct}%',
    stopLossReached: 'Stop-loss reached',
    stopLossHint: 'The stop-loss reminder lives in this browser only and never closes anything by itself; when it fires, press Unfollow.',
    notCopyingAnyone: "You're not copying anyone yet.",
    browseTraders: 'Browse traders →',
    copyColumn: {
      trader: 'Trader',
      copiedAt: 'Copied At',
      initial: 'Initial',
      current: 'Current',
      return: 'Return',
      stopLoss: 'Stop-loss reminder',
      actions: 'Actions',
    },
    unfollow: 'Unfollow',
    unfollowStale: 'Price stale',
    unfollowedOk: 'Unfollowed and all positions closed ✓',

    openPositions: 'Open Positions',
    openCount: '{count} open · manual + copied',
    openCountNoCopy: '{count} open',
    noOpenPositions: 'No open positions.',
    totalOf: 'Total {label}',

    openPositionsSimple: 'My positions',
    openCountSimple: '{count} positions',

    freeMargin: 'Free Margin',
    freeMarginSimple: 'Withdrawable balance',
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

  /** See `../zh-TW/portfolio.ts`. */
  syncNotice: {
    behind: 'A trader published a new strategy version. Entries still on an older one: {count}. ',
    needsYou: 'Needing you ({reasons}), so they will not update on their own: {count}.',
    waitingOnly: 'Auto-sync is on: they update once the cooldown ends and an executor sends the sync.',
    reasonSeparator: '; ',
    reasons: {
      feeAboveCap: 'the execution fee was raised and needs your consent again',
      needsGas: 'the auto-sync gas tank is short',
      manual: 'auto-sync is off',
      snapshot: 'needs updating to the latest version',
    },
    cta: 'Open Portfolio',
    dismiss: 'Got it',
  },

  /** See `../zh-TW/portfolio.ts`. */
  autoSync: {
    column: 'Sync',
    versions: 'Version {current} / latest {latest}',
    versionsLatest: 'Version {current} (latest)',
    on: 'Auto-sync: on',
    off: 'Auto-sync: off',
    syncCount: 'Synced {count}×',
    followerClosed: "You closed one of these positions yourself, so later results no longer count towards the trader's slash scoring.",
    status: {
      upToDate: 'On the latest version',
      upToDateSimpleOff: 'On the latest version. To switch auto-sync on, use Expert Mode',
      consentStale: 'On the latest version, but the exchange raised its execution fee above the rate you agreed to, so no one else can sync for you when the trader publishes next. Review the new fee under Settings and save again to restore it',
      consentStaleSimple: 'On the latest version, but the exchange raised its execution fee above the rate you agreed to, so no one else can sync for you when the trader publishes next. Switch to Expert Mode to review the new fee and accept it',
      manual: 'New version: press “Sync now”, or switch auto-sync on',
      manualSimple: 'New version: switch to Expert Mode to review it before syncing',
      feeAboveCap: 'The exchange raised its execution fee above the rate you agreed to when you switched auto-sync on, so no one else can sync for you yet. Save your settings again to accept the new fee, or press “Sync now”',
      feeAboveCapSimple: 'The exchange raised its execution fee above the rate you agreed to when you switched auto-sync on, so no one else can sync for you yet. Switch to Expert Mode to review the new fee and accept it, or to sync yourself',
      cooldown: 'Cooling down — can sync after {time}',
      needsGas: 'Gas tank short of one executor sync by {eth} ETH',
      waiting: 'Waiting for any executor to send the sync',
      waitingExecutor: 'Waiting for the executor you chose to send the sync',
      unknown: 'Sync status unavailable',
    },
    outdatedHint: 'The trader published a new strategy version. “Sync now” shows you the new version first and, once you confirm, moves these positions to it in place (no need to cancel and start over) — or switch auto-sync on.',
    outdatedHintSimple: 'The trader published a new strategy version. Switch to Expert Mode to review it before syncing.',
    executorChip: 'Executor {addr}',
    executorTip: 'Only this address (and you) can sync for you; everyone else is rejected by the contract. Change or clear it under Settings.',
    executorTipSimple: 'Only this address (and you) can sync for you; everyone else is rejected by the contract. To change or clear it, switch to Expert Mode and open Settings.',
    executorSaved: 'Executor updated ✓',
    executorFailed: 'Auto-sync settings were saved, but setting the executor did not go through. Please try again.',
    confirm: {
      title: 'Sync to version {version}',
      loading: 'Loading the new version…',
      loadFailed: 'Could not load the new version. Please try again later.',
      intro:
        'Review the new version before you send. This transaction is pinned to version {version}: if the trader publishes again before it lands, it reverts as a whole instead of switching to a version you have not seen.',
      colAsset: 'Asset',
      colSide: 'Side',
      colWeight: 'Weight',
      colLeverage: 'Leverage (version → used)',
      long: 'Long',
      short: 'Short',
      capped: 'capped',
      noCap:
        "This row has no leverage cap: positions open at the new version's leverage (limited only by the exchange's per-asset cap). To set a cap, save Settings once first (auto-sync can stay off).",
      leverageRaised: 'The highest leverage this sync uses ({to}×) is above your current highest ({from}×).',
      closeAll:
        'Syncing first closes every position in this row, then opens the new version with the margin those closes release; if any asset cannot open (KYC missing, market closed, open-interest cap) the whole sync is cancelled and your positions stay as they are.',
      execFee: 'Execution fees (from the gas tank)',
      topUp: 'The tank is short, so this transaction attaches {eth} ETH to top it up',
      released: 'Margin expected to be released',
      perfFee: 'Performance fee on profitable positions (10%, to the trader)',
      tradingFee: 'Trading fee to open the new version',
      approx: '≈ {amount} {token}',
      unknown: '—',
      estimateNote: 'Estimated at current prices; the on-chain result is what counts. Closing fees, borrow fees and funding are already in the current value.',
      cancel: 'Cancel',
      cta: 'Confirm sync',
    },
    syncNow: 'Sync now',
    syncing: 'Syncing…',
    synced: 'Synced to the latest version ✓',
    topUpFirst: 'The gas tank cannot cover this sync’s execution fees, so this sync attaches {eth} ETH to top it up.',
    settings: 'Settings',
    enable: 'Switch auto-sync on',
    disable: 'Switch auto-sync off',
    saved: 'Auto-sync settings updated ✓',
    disabledOk: 'Auto-sync switched off ✓',
    tank: {
      title: 'Auto-sync gas tank',
      balance: '{eth} ETH',
      estimate: 'About {count} executor syncs',
      consentBlocked: 'Executor syncs paused until you accept the new execution fee',
      deposit: 'Deposit',
      withdraw: 'Withdraw',
      deposited: 'Deposited {eth} ETH ✓',
      withdrawn: 'Withdrew {eth} ETH ✓',
      note: 'ETH in the tank only pays sync execution fees and tips. It is held in the contract under your own address, and only you can withdraw it.',
    },
    dialog: {
      settingsTitle: 'Auto-sync settings',
      enabled: 'Turn auto-sync on',
      /** Shown while the switch is on: what saving signs. See `../zh-TW/portfolio.ts`. */
      consentLine: 'Saving signs {fee} ETH per asset as the most an executor sync may take from your tank for execution fees (the exchange’s current fee).',
      consentChanged: 'The exchange’s execution fee is now {fee} ETH per asset; you had agreed to {old} ETH. Saving accepts the new fee.',
      consentCurrent: 'You currently agree to at most {fee} ETH per asset in execution fees for each executor sync (the exchange’s current fee).',
      consentLowered: 'The exchange lowered its execution fee to {fee} ETH per asset (you had agreed to {old} ETH). Syncs work without agreeing again; if you save, your cap drops to {fee} ETH as well, and you will need to agree again if the fee goes back up.',
      consentUnknownFee: 'Could not read the exchange’s current execution fee, so the fee you would agree to is unknown. Please try again later. Until then the settings cannot change; switching auto-sync off or only changing the executor still works.',
      gasTitle: 'Auto-sync gas tank',
      amount: 'Amount (ETH)',
      max: 'Max',
      cancel: 'Cancel',
      save: 'Save',
      depositCta: 'Deposit to tank',
      withdrawCta: 'Withdraw to wallet',
      invalidAmount: 'Enter a valid ETH amount.',
      overBalance: 'More than the tank holds.',
      offNote: 'With auto-sync off, the leverage cap here still applies when you press “Sync now” yourself, and the executor you chose stays in effect if you switch it back on. Cooldown and tip only matter while it is on.',
    },
  },

  /**
   * See `../zh-TW/portfolio.ts`.
   */
  analysis: {
    esgScore: 'ESG score (value-weighted)',
    esgMethodology:
      "Each holding's market value is the weight in this average. If any holding is missing ESG data, no score shows at all — half the data isn't enough to fake a normal-looking number.",
    esgIncomplete: 'Not all holdings have ESG data yet.',
    byAsset: 'Contribution by asset',

    cat: {
      crypto: 'Crypto',
      equity: 'Equity',
      commodity: 'Commodity',
      bond: 'Bond',
    },
  },
};
