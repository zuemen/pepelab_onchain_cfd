import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/portfolio.ts`。
 */
export const portfolio: Catalog['portfolio'] = {
  netWorth: {
    title: 'Net Worth',
    titleTooltip: 'Each part valued at current prices and added up — not an amount you can withdraw all at once. The parts differ in liquidity and risk; hover each heading below for details.',
    liquid: 'Available now',
    liquidTooltip: 'Wallet USDC + the withdrawable balance in your investment account: usable without selling, reclaiming your deposit or redeeming. Excludes amounts already invested, the performance deposit, risk-reserve deposits and tokenized assets.',
    unrealisedPnl: 'Unrealised gain/loss',
    unrealisedPnlTooltip: 'What your current investments would net if sold now: priced at the on-chain settlement price after fees and funding, the same figure as the advanced investing tools. Excludes the 10% performance fee some investments pay on profit; funding as of the last settlement; excludes risk-reserve cover. Shows — when any investment cannot be read',

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
      trading: 'Investment account',
      staked: 'Performance deposit',
      lpVault: 'Risk reserve deposit',
    },

    risk: {
      spot: 'Valued at the price source, not a traded price; while the underlying market is closed the price may sit at its last update. Redeeming pays USDC at the current price, and only while the asset vault holds enough USDC. These tokens only track the underlying price — they cannot be exchanged for the real stock or commodity.',
      wallet: 'USDC in your Web3 wallet, usable any time. Its value depends on the stablecoin holding its $1 peg.',
      trading: 'The withdrawable balance can be taken out any time; money already invested comes back only when you sell. If losses grow past a set level, the investment is settled automatically. Excludes unrealised gain/loss, which is shown next to net worth.',
      staked: 'Your performance deposit (USDC). After asking for it back you wait 1 day to withdraw. When one of your followers exits with a loss of 30% or more, half that loss is deducted from your deposit, up to 50% of the deposit.',
      stakedNoCopy: 'Your performance deposit (USDC). After asking for it back you wait 1 day to withdraw. When the public deduction rules trigger, up to 50% of the deposit can be deducted at once.',
      lpVault: 'When an investor’s loss exceeds the amount invested, the risk reserve covers it; each cover lowers the share value. Shown is the USDC your shares would return at the current share price; if the reserve runs short it cannot pay out in full.',
    },

    /** 某一項讀不到時的說明（Unread Balance，見 CONTEXT.md）。 */
    unread: {
      spot: 'Some tokenized-asset balances or prices could not be read',
      wallet: 'Wallet balance could not be read',
      trading: 'Investment account could not be read',
      staked: 'Performance deposit could not be read',
      lpVault: 'Risk reserve could not be read',
    },
  },

  /**
   * RWA 資產配置——見 CONTEXT.md 的 RWA／Asset Class 詞條。刻意跟 netWorth
   * 分開：這裡的分母是交易部位的保證金，不是淨資產，兩個數字不會對得起來，
   * 用同一個 title 或同一組詞會讓讀者以為算法一樣。
   */
  allocation: {
    title: 'My allocation',
    subtitle: 'Tokenized asset holdings at current value plus the amount invested in your investment account — excludes wallet cash, the performance deposit and the risk reserve. Not a breakdown of Net Worth.',
    subtitleSpot: 'Tokenized asset holdings at current value (plus the amount invested, if the investment account still holds investments) — excludes wallet cash, the performance deposit and the risk reserve. Not a breakdown of Net Worth.',
    noPositions: 'Nothing held yet',
    holdingsOnlyNote: 'The gain/loss column covers the investment account only — directly held tokenized assets have no on-chain cost basis.',

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
      since: "Since {date} (the buy date of your earliest investment) · {days} days",
      beatSummary: 'Ahead of {beat} of {total} benchmarks',
      beatSummaryNone: 'No benchmark data to compare against yet',
      aheadBy: 'ahead by {pp}pp',
      behindBy: 'behind by {pp}pp',
      youLabel: 'You (by full amount)',
      youHint:
        'Unrealised gain/loss ÷ the full (notional) amount — the same base the benchmarks use, so the comparison is fair. The allocation ring above uses the amount invested as its denominator; that difference is intentional.',
      noPositions: 'No investments yet',
    },
  },

  quickAction: {
    trade: 'Invest',
    copyTrader: 'Copy investing',
    marketplace: 'Browse marketplace',
    history: 'History',
    proTerminal: 'Advanced investing tools',
  },

  /**
   * Open Positions 的欄位名。simple 與 expert 兩張表共用同一份——原本 expert 表在
   * 頁面裡另外寫了一份一模一樣的清單，兩份字得同時改才不會不一致。
   */
  column: {
    asset: 'Asset',
    carbonTier: 'Carbon tier',
    side: 'View',
    entry: 'Buy price',
    oracle: 'On-chain price',
    liveMarket: 'Live Market',
    margin: 'Amount invested',
    leverage: 'Scale',
    copiedFrom: 'Following (strategy sharer)',
    unrealizedPnl: 'Unrealised gain/loss',
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
    entry: 'Price you bought at',
    oracle: 'Price the on-chain program settles against — this is what unrealised gain/loss uses',
    liveMarket: 'Off-chain feed. Moves before the on-chain price does, so a gap here is normal',
    unrealizedPnl: 'How much more or less than the amount invested you would get back by selling now: priced at the on-chain settlement price after the sell fee, borrow fee and accrued funding. Excludes the 10% performance fee some investments pay on profit; funding as of the last settlement; excludes risk-reserve cover',
  },

  close: {
    column: 'Actions',
    button: 'Sell',
    closing: 'Selling…',
    closed: 'Sold',
    halted: 'The {asset} market is paused; this investment cannot be sold right now.',
    copyManaged: 'This investment belongs to a strategy you follow. Press Stop following under Copy investing above to sell it along with the rest.',
    copyManagedShort: 'Following',
    leftover: 'Left over from a strategy sharer you used to follow (copy investing); you can sell it directly.',
  },

  page: {
    positionsUnread: '{count} investment(s) could not be read this time — the table and totals below are incomplete. Refresh to try again.',
    title: 'My Portfolio',
    refresh: 'Refresh',

    /** 見 `../zh-TW/portfolio.ts`。 */
    tab: {
      spot:      'Holdings',
      positions: 'Investment account',
    },
    connectWallet: 'Connect wallet to view your portfolio.',

    unsupportedNetwork: 'Unsupported Network',
    connectedTo: 'Connected to ',
    connectedToAfter: '.',
    switchTo: 'Please switch to ',
    switchToAfter: '.',
    unknownChain: 'unknown',
    chainNumber: 'Chain {id}',

    demoTitle: 'Guest mode — no live chain data',
    demoDescription:
      "You're in guest mode, which has no wallet connection to read real balances or investments from. Connect a real wallet to see your actual portfolio.",

    emptyTitle: 'Your portfolio is empty',
    emptyDescription:
      'Start by claiming {token}, then buy gold, stock and other tokenized assets on the Assets page. For copy investing, pick a strategy sharer in the Strategy Marketplace.',
    emptyDescriptionNoCopy:
      'Start by getting {token}, then buy tokenized assets on the Assets page or browse published allocations on the marketplace.',
    emptyCta: 'Get {token}',

    side: {
      long: 'Rise ↑',
      short: 'Fall ↓',
    },

    activeCopies: 'Copy investing',
    traderFollowedOne: 'strategy sharer followed',
    traderFollowedMany: 'strategy sharers followed',
    totalCopyPnl: 'Copy investing gain/loss',
    noCopyPositions: 'no copy investing yet',

    copyPositions: 'Copy investing',
    copyOutdated: 'Strategy updated',
    copyOutdatedHint: 'The strategy sharer has published a new strategy version. What you follow is still on the old one and does not adjust by itself.',
    copyRefresh: 'Move to latest',
    copyRefreshing: 'Updating…',
    copyRefreshStep: 'Stop following the old version, withdraw the {amount} USDC it returns to your wallet, then follow the latest version with the same amount on the copy investing page.',
    stopLossNone: 'Off',
    stopLossOption: 'At -{pct}%',
    stopLossReached: 'Stop-loss reached',
    stopLossHint: 'The stop-loss reminder lives in this browser only and never sells anything by itself; when it fires, press Stop following.',
    notCopyingAnyone: "You're not following any strategy sharer yet (copy investing).",
    browseTraders: 'Browse strategy sharers →',
    copyColumn: {
      trader: 'Strategy sharer',
      copiedAt: 'Following since',
      initial: 'Initial',
      current: 'Current',
      return: 'Return',
      stopLoss: 'Stop-loss reminder',
      actions: 'Actions',
    },
    unfollow: 'Stop following',
    unfollowStale: 'Price stale',
    unfollowedOk: 'Stopped following and sold the related investments ✓',

    openPositions: 'My investments',
    openCount: '{count} investments · your own + copy investing',
    openCountNoCopy: '{count} investments',
    noOpenPositions: 'No investments yet.',
    totalOf: 'Total {label}',

    openPositionsSimple: 'My investments',
    openCountSimple: '{count} investments',

    freeMargin: 'Withdrawable balance',
    freeMarginSimple: 'Withdrawable balance',
    amountPlaceholder: 'Amount',
    withdraw: 'Withdraw',
    withdrawnOk: 'Withdrew {amount} {token} ✓',
    enterValidAmount: 'Enter a valid amount',

    copyPerformance: 'Copy investing performance',
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
    behind: 'A strategy sharer published a new strategy version. Entries still on an older one: {count}. ',
    needsYou: 'Needing you ({reasons}), so they will not update on their own: {count}.',
    waitingOnly: 'Auto-sync is on: they update once the cooldown ends and an executor sends the sync.',
    reasonSeparator: '; ',
    reasons: {
      feeAboveCap: 'the platform raised the execution fee and it and needs your consent again',
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
    followerClosed: "You sold one of these investments yourself, so later results no longer count towards the strategy sharer's deduction scoring.",
    status: {
      upToDate: 'On the latest version',
      upToDateSimpleOff: 'On the latest version. To switch auto-sync on, use Expert Mode',
      consentStale: 'On the latest version, but the platform raised its execution fee above the rate you agreed to, so no one else can sync for you when the strategy sharer publishes next. Review the new fee under Settings and save again to restore it',
      consentStaleSimple: 'On the latest version, but the platform raised its execution fee above the rate you agreed to, so no one else can sync for you when the strategy sharer publishes next. Switch to Expert Mode to review the new fee and accept it',
      manual: 'New version: press “Sync now”, or switch auto-sync on',
      manualSimple: 'New version: switch to Expert Mode to review it before syncing',
      feeAboveCap: 'The platform raised its execution fee above the rate you agreed to when you switched auto-sync on, so no one else can sync for you yet. Save your settings again to accept the new fee, or press “Sync now”',
      feeAboveCapSimple: 'The platform raised its execution fee above the rate you agreed to when you switched auto-sync on, so no one else can sync for you yet. Switch to Expert Mode to review the new fee and accept it, or to sync yourself',
      cooldown: 'Cooling down — executors can sync after {time}, possibly later. To update now, press “Sync now”',
      cooldownSimple: 'Cooling down — executors can sync after {time}, possibly later. To update now, switch to Expert Mode',
      needsGas: 'Gas tank short of one executor sync by {eth} ETH',
      waiting: 'Waiting for an executor to send the sync, which can take a few hours. To update now, press “Sync now”',
      waitingSimple: 'Waiting for an executor to send the sync, which can take a few hours. To update now, switch to Expert Mode',
      waitingExecutor: 'Waiting for the executor you chose to send the sync. To update now, press “Sync now”',
      waitingExecutorSimple: 'Waiting for the executor you chose to send the sync. To update now, switch to Expert Mode',
      unknown: 'Sync status unavailable',
    },
    outdatedHint: 'The strategy sharer published a new strategy version. “Sync now” shows you the new version first and, once you confirm, moves these investments to it in place (no need to cancel and start over) — or switch auto-sync on.',
    outdatedHintSimple: 'The strategy sharer published a new strategy version. Switch to Expert Mode to review it before syncing.',
    executorChip: 'Executor {addr}',
    executorTip: 'Only this address (and you) can sync for you; everyone else is rejected by the on-chain program. Change or clear it under Settings.',
    executorTipSimple: 'Only this address (and you) can sync for you; everyone else is rejected by the on-chain program. To change or clear it, switch to Expert Mode and open Settings.',
    executorSaved: 'Executor updated ✓',
    executorFailed: 'Auto-sync settings were saved, but setting the executor did not go through. Please try again.',
    confirm: {
      title: 'Sync to version {version}',
      loading: 'Loading the new version…',
      loadFailed: 'Could not load the new version. Please try again later.',
      intro:
        'Review the new version before you send. This submission is pinned to version {version}: if the strategy sharer publishes again before it lands, it reverts as a whole instead of switching to a version you have not seen.',
      colAsset: 'Asset',
      colSide: 'View',
      colWeight: 'Weight',
      colLeverage: 'Scale (version → used)',
      long: 'Rise',
      short: 'Fall',
      capped: 'capped',
      noCap:
        "This row has no scale cap: it buys at the new version's scale (limited only by the platform's per-asset cap). To set a cap, save Settings once first (auto-sync can stay off).",
      leverageRaised: 'The highest scale this sync uses ({to}×) is above your current highest ({from}×).',
      closeAll:
        'Syncing first sells every investment in this row, then buys the new version with the amount those sales return; if any asset cannot be bought (KYC missing, market closed, platform-wide limit) the whole sync is cancelled and your investments stay as they are.',
      execFee: 'Execution fees (from the gas tank)',
      topUp: 'The tank is short, so this sync attaches {eth} ETH to top it up',
      released: 'Amount expected to come back',
      perfFee: 'Performance fee on profitable investments (10%, to the strategy sharer)',
      tradingFee: 'Fee to buy the new version',
      approx: '≈ {amount} {token}',
      unknown: '—',
      estimateNote: 'Estimated at current prices; the on-chain result is what counts. Selling fees, borrow fees and funding are already in the current value.',
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
      note: 'ETH in the tank only pays sync execution fees and tips. It is held in the on-chain program under your own address, and only you can withdraw it.',
    },
    dialog: {
      settingsTitle: 'Auto-sync settings',
      enabled: 'Turn auto-sync on',
      /** Shown while the switch is on: what saving signs. See `../zh-TW/portfolio.ts`. */
      consentLine: 'Saving signs {fee} ETH per asset as the most an executor sync may take from your tank for execution fees (the platform’s current fee).',
      consentChanged: 'The platform’s execution fee is now {fee} ETH per asset; you had agreed to {old} ETH. Saving accepts the new fee.',
      consentCurrent: 'You currently agree to at most {fee} ETH per asset in execution fees for each executor sync (the platform’s current fee).',
      consentLowered: 'The platform lowered its execution fee to {fee} ETH per asset (you had agreed to {old} ETH). Syncs work without agreeing again; if you save, your cap drops to {fee} ETH as well, and you will need to agree again if the fee goes back up.',
      consentUnknownFee: 'Could not read the platform’s current execution fee, so the fee you would agree to is unknown. Please try again later. Until then the settings cannot change; switching auto-sync off or only changing the executor still works.',
      gasTitle: 'Auto-sync gas tank',
      amount: 'Amount (ETH)',
      max: 'Max',
      cancel: 'Cancel',
      save: 'Save',
      depositCta: 'Deposit to tank',
      withdrawCta: 'Withdraw to wallet',
      invalidAmount: 'Enter a valid ETH amount.',
      overBalance: 'More than the tank holds.',
      offNote: 'With auto-sync off, the scale cap here still applies when you press “Sync now” yourself, and the executor you chose stays in effect if you switch it back on. Cooldown and tip only matter while it is on.',
    },
  },

  /**
   * See `../zh-TW/portfolio.ts`.
   */
  analysis: {

    cat: {
      crypto: 'Crypto',
      equity: 'Equity',
      commodity: 'Commodity',
      bond: 'Bond',
    },
  },
};
