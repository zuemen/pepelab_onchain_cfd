import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/copy.ts`。
 */
export const copy: Catalog['copy'] = {
  invalidAddress: 'Invalid strategy sharer address.',
  connectWallet: 'Connect your wallet to follow this strategy sharer with copy investing.',
  viewOn: 'View on {explorer} ↗',
  loadFailed: 'Failed to load strategy sharer:',
  breadcrumbMarketplace: 'Strategy Marketplace',

  header: {
    unknownTrader: 'Unknown strategy sharer',
    repChip: '◆ {rep} rep',
    staked: '{amount} {token} performance deposit',
    notRegistered: '⚠ This address is not registered as a strategy sharer.',
  },

  strategy: {
    title: 'Latest Strategy',
    empty: 'No strategy published yet.',
    /** 分配標籤：↑ BTC 50% · 3× */
    chip: '{side} {asset} {weight}% · {leverage}×',
  },

  amount: {
    title: 'Copy investing amount',
    placeholder: '1000',
    unitSuffix: '{token} amount invested',
    disabledHint: 'disabled — no strategy',
    belowMinimum: 'Amount too small: once split by weight, one asset falls under the platform minimum amount invested. This strategy needs at least {amount} USDC.',
  },

  /** #333: before copying, how many simulated credits this copy will lead the platform to retire. The tonnes are the platform's (carbonWording.test.ts). */
  retirementEstimate: {
    title: 'Carbon retirement this copy investment leads to (estimate)',
    value: 'About {tonnes} t of platform-minted carbon credits',
    body: 'Of the {fee} copy investing fee, {carbon} of the platform’s {platform} share goes to the retirement budget, leading the platform to retire about {tonnes} t of platform-minted carbon credits (not issued by any carbon-credit registry). The tonnes belong to the platform, not to you; retirement is paid from the platform’s own revenue and costs you nothing extra.',
    note: 'An estimate: it counts the copy investing fee only; the performance fee on this investment’s later profits goes the same way. Ratios and price are read from the public on-chain programs; the retirement records are on the ESG page.',
  },

  preview: {
    totalDeposit: 'Total deposit:',
    copyFee: '− Copy investing fee (0.3%):',
    tradingFeeBuffer: '− Buy/sell fee reserve:',
    effectiveMargin: 'Amount actually invested:',

    column: {
      asset: 'Asset',
      side: 'Side',
      leverage: 'Multiplier',
      weight: 'Weight',
      margin: 'Amount invested',
      notional: 'Full value',
      estEntry: 'Est. Entry',
    },
    long: 'Expect rise ↑',
    short: 'Expect fall ↓',
  },

  feePreview: {
    title: 'Fee Preview',
    copyFee: 'Copy investing fee (0.3%)',
    netMargin: 'After fee (buy/sell fees still apply)',
    executionFee: 'Execution Fee (ETH)',
    split:
      'The copy investing fee is split 70% → strategy sharer · 20% → platform · 10% → risk reserve. The execution fee pays the automated programs that send records for you.',
  },

  skinInGame: {
    title: 'Strategy sharer’s own money at risk',
    staked: 'Performance deposit',
    reputation: 'Reputation',
    reputationUnit: 'pts',
    totalSlashed: 'Total deducted',
    slashedWarning:
      '⚠ This strategy sharer has had {amount} {token} deducted for causing excessive losses to followers. Proceed with caution.',
    noStakeWarning:
      '⚠ This strategy sharer has no performance deposit right now, so the on-chain program will not accept new copy investing funds. You can follow them once they make a deposit.',
    slashRule:
      "⚠ When you stop following, if this investment's loss from price moves reaches 30% (before fees and other holding costs), this strategy sharer's performance deposit is deducted (50% of the loss, capped at 50% of the deposit). The deducted amount goes into the platform reserve, not to you. If you sell any of its assets yourself, this investment is not scored for deductions.",
  },

  confirm: {
    title: 'Confirm copy investing',
    approveStep: 'Approve {token} to CopyTracker',
    followStep: 'Follow this strategy sharer',
    lead: 'Enter an amount, then confirm twice: first allow the on-chain program to use this USDC, then start copy investing. The investment appears in your portfolio, and you can stop following at any time.',
    notEnoughUsdc: 'Your wallet holds {balance} {token}, which is less than this amount. Lower the amount or claim {token} first. Buying also needs a little ETH for the execution fee.',
    notEnoughUsdcCta: 'Claim tokens',

    staleTitle: 'Price stale — copy investing paused',
    staleExplain:
      "Copy investing buys {count} assets in one on-chain record — if even one asset's price is stale, the whole thing gets rejected, and the {count} execution fees are already spent.",

    kycRequired:
      '🔒 This strategy includes stock / bond assets and requires KYC before you can follow it (approved as soon as you submit, with no manual review).',
    kycSubmit: 'Submit KYC Application',

    approving: 'Approving…',
    approved: 'Approved',
    approveCta: 'Step 1 · Approve',

    following: 'Sending…',
    stalePrice: '⛔ {asset} price is stale',
    followCta: 'Step 2 · Start copy investing',

    noStrategy: '⚠ This strategy sharer has no published strategy yet, so you cannot follow them.',
    footer:
      'The amount you invest will be split across the assets automatically, according to the strategy above.',
    snapshotNote:
      'Copy investing takes the strategy sharer\'s current strategy version. If they publish a new version later, your investment does not change automatically; to move to the new version, stop following and follow again.',
    snapshotNoteSyncable:
      "Copy investing takes the strategy sharer's current strategy version. Without auto-sync, your investment stays put when they publish a new version; press “Sync now” in your portfolio to move to the latest one, or switch auto-sync on at any time.",
    snapshotNoteSyncableSimple:
      "Copy investing takes the strategy sharer's current strategy version. If they publish a new version later, your investment does not change on its own; switch to Expert Mode to review the new version before syncing, or to turn auto-sync on.",
  },

  /** See `../zh-TW/copy.ts`. */
  autoSync: {
    title: 'Auto-sync (optional)',
    toggle: "When the strategy sharer publishes a new version, move my investment to it automatically",
    disclosure:
      "Once on, anyone — your own AI agent, the platform's executor or a third party — can move your investment to the strategy sharer's latest on-chain version when one is published; you can also restrict it to one address you choose (for example your own AI agent). They cannot pick the assets or change the strategy, and they cannot touch the rest of your funds; you can switch auto-sync off and withdraw the gas tank at any time.",
    costs:
      'Each sync sells everything in this investment and buys the new version: you pay a trading fee on both the sale and the purchase, and 10% of any gain goes to the strategy sharer as a performance fee (no high-water mark, so it can be charged again when prices swing). The timing depends on when the sharer publishes and when an executor submits, and may land at a bad price for you. A longer cooldown lowers these costs and risks.',
    selfCustody:
      'Your private key never leaves your wallet: the sync rule lives in the public on-chain program, and an executor only presses the button — it neither needs nor receives your key.',
    unsupported:
      "The copy investing program on this network hasn't been upgraded to a version with auto-sync yet, so it still copies the version of the moment.",
    expertOnly:
      'Auto-sync can only be switched on in Expert Mode, where you review its settings and costs first. Switch to Expert Mode to turn it on when you start copy investing, or later from your portfolio.',
    maxLeverage: 'Multiplier cap',
    maxLeverageHelp:
      "When a new version uses a higher multiplier than this, it buys at this figure instead. Defaults to the highest multiplier in this version, so a strategy sharer raising it later doesn't raise yours.",
    leverageOption: '{lev}×',
    cooldown: 'Cooldown',
    cooldownHelp:
      'Minimum time between two syncs sent by someone else (syncing yourself is never limited). The shorter it is, the more trading fees a strategy sharer publishing version after version can make you pay: 1 h allows up to 24 rounds a day, 24 h allows one. Defaults to 24 h.',
    cooldownOption: '{hours} h',
    tip: 'Executor tip (per sync)',
    tipHelp: 'ETH paid from your gas tank to whoever sends the sync for you; nothing when you sync yourself. Cap: {max} ETH.',
    tipOption: '{eth} ETH',
    tipNone: 'None (only you or your own agent)',
    prefund: 'Gas tank deposit (ETH)',
    prefundHelp:
      'The tank pays each sync’s execution fee ({fee} ETH per asset in the new version) and the tip. It is held in the on-chain program under your own address and can be withdrawn at any time. The {fee} ETH per asset is also the execution-fee cap you sign: if the platform raises its fee later, no one else can sync for you until you review the new fee in Portfolio and accept it.',
    estimate: 'About {count} syncs ({legs} assets, {cost} ETH each)',
    oneTx: 'One send starts copy investing, switches auto-sync on and fills the tank: {total} ETH attached ({open} ETH execution fees + {prefund} ETH tank).',
    twoTx: 'This on-chain program version needs separate sends: start copy investing first, then switch auto-sync on, then fill the tank.',
    snapshotNoteAuto:
      'Auto-sync selected: when the strategy sharer publishes a new version, anyone can move your investment to it (multiplier capped at {lev}×), with no need to follow again. You can switch it off from your portfolio at any time.',
    invalid: {
      leverage: 'The multiplier cap must be 1–5×.',
      tip: 'The tip is above the on-chain program cap.',
      interval: 'The cooldown must be at least 1 hour (the on-chain program minimum).',
      prefund: 'Invalid deposit amount.',
    },
    executor: 'Only let this address sync for me (optional)',
    executorPlaceholder: '0x… (empty = anyone)',
    executorHelp:
      "Enter the hot wallet your own AI agent uses (not your main wallet). From then on, apart from you, only it can sync for you — the platform and everyone else are rejected by the on-chain program; the cooldown, tip and fee cap still apply. Leave empty to let anyone sync for you.",
    executorExtraTx: 'Choosing an executor takes one more send after you start copy investing; during the cooldown that follows (at least 1 hour) no one can sync for you anyway.',
    executorInvalid: {
      address: 'Invalid address.',
      self: 'That is your own address — you can always sync yourself. Enter a separate hot wallet that only holds ETH for fees (for example your own AI agent).',
    },
  },

  tx: {
    enterValidAmount: 'Enter a valid amount',
    approved: '{token} approved ✓',
    following: 'Copy investing started ✓',
    followingAuto: 'Copy investing started with auto-sync on ✓',
    autoSyncStep: 'Copy investing started — now switching auto-sync on…',
    autoSyncFailed: 'Copy investing started, but auto-sync was not switched on; you can switch it on from your portfolio.',
    executorStep: 'Copy investing started — now setting your executor…',
    executorFailed:
      'Copy investing and auto-sync went through, but setting your executor did not: once the cooldown ends anyone can sync for you. You can set it again under Settings in your portfolio.',
  },

  /** #36：KYC 待審核那句夾了 `<b>`，拆成前後片段。 */
  markup: {
    kycPendingBefore: '⏳ Your KYC application ',
    kycPendingBold: 'has been submitted and is under review',
    kycPendingAfter:
      ' — copy investing in strategies with stocks / bonds unlocks once a reviewer approves it; no need to resubmit.',
  },
};
