import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/copy.ts`。
 */
export const copy: Catalog['copy'] = {
  invalidAddress: 'Invalid trader address.',
  connectWallet: 'Connect wallet to copy a trader.',
  viewOn: 'View on {explorer} ↗',
  loadFailed: 'Failed to load trader:',
  breadcrumbMarketplace: 'Marketplace',

  header: {
    unknownTrader: 'Unknown Trader',
    repChip: '◆ {rep} rep',
    staked: '{amount} {token} staked',
    notRegistered: '⚠ This address is not registered as a trader.',
  },

  strategy: {
    title: 'Latest Strategy',
    empty: 'No strategy published yet.',
    /** 分配標籤：↑ BTC 50% · 3× */
    chip: '{side} {asset} {weight}% · {leverage}×',
  },

  esg: {
    title: 'Strategy ESG Score',
    champion: 'ESG Champion',
    aware: 'ESG Aware',
    considerGreener: 'Consider greener assets',
    details: 'Details →',
  },

  amount: {
    title: 'Copy Amount',
    placeholder: '1000',
    unitSuffix: '{token} total margin',
    disabledHint: 'disabled — no strategy',
    belowMinimum: 'Amount too small: once split by weight, one leg falls under the exchange minimum margin. This strategy needs at least {amount} USDC.',
  },

  /** #333: before copying, how many simulated credits this copy will lead the platform to retire. The tonnes are the platform's (carbonWording.test.ts). */
  retirementEstimate: {
    title: 'Carbon retirement this copy leads to (estimate)',
    value: 'About {tonnes} t of simulated carbon credits',
    body: 'Of the {fee} copy fee, {carbon} of the platform’s {platform} share goes to the retirement budget, leading the platform to retire about {tonnes} t of simulated carbon credits. The tonnes belong to the platform, not to you; retirement is paid from the platform’s own revenue and costs you nothing extra.',
    note: 'An estimate: it counts the copy fee only; the performance fee on profitable copied positions later goes the same way. Ratios and price are read from the contracts; the retirement records are on the ESG page.',
  },

  preview: {
    totalDeposit: 'Total deposit:',
    copyFee: '− Copy fee (0.3%):',
    tradingFeeBuffer: '− Trading fee buffer:',
    effectiveMargin: 'Effective margin:',

    column: {
      asset: 'Asset',
      side: 'Side',
      leverage: 'Lev',
      weight: 'Weight',
      margin: 'Margin',
      notional: 'Notional',
      estEntry: 'Est. Entry',
    },
    long: 'LONG ↑',
    short: 'SHORT ↓',
  },

  feePreview: {
    title: 'Fee Preview',
    copyFee: 'Copy fee (0.3%)',
    netMargin: 'Net margin deposited',
    executionFee: 'Execution Fee (ETH)',
    split:
      'Copy fee is split 70% → trader · 20% → platform · 10% → insurance vault. Execution fee pays Keeper bots.',
  },

  skinInGame: {
    title: 'Trader Skin-in-the-Game',
    staked: 'Staked',
    reputation: 'Reputation',
    reputationUnit: 'pts',
    totalSlashed: 'Total Slashed',
    slashedWarning:
      '⚠ This trader has had {amount} {token} slashed for causing excessive losses to followers. Proceed with caution.',
    noStakeWarning:
      '⚠ This trader has no stake — they have no skin-in-the-game. You cannot trigger slashing if they cause losses.',
    slashRule:
      "⚠ When you unfollow, if this copy's price loss reaches 30% (before trading fees, borrow fees and funding), this trader's stake is slashed (50% of the loss, capped at 50% of the stake). The slashed amount goes into the platform reserve, not to you. If you close any of the copied positions yourself, this copy is not scored for slashing.",
  },

  confirm: {
    title: 'Confirm Copy',
    approveStep: 'Approve {token} to CopyTracker',
    followStep: 'Follow Trader',

    staleTitle: 'Price stale — copying paused',
    staleExplain:
      "Copying opens {count} positions in one transaction — if even one asset's price is stale, the whole thing gets rejected, and the gas for {count} execution fees is already spent.",

    kycRequired:
      '🔒 This strategy includes stock / bond assets and requires KYC review before you can copy it (approval is required after submitting).',
    kycSubmit: 'Submit KYC Application',

    approving: 'Approving…',
    approved: 'Approved',
    approveCta: 'Step 1 · Approve',

    following: 'Following…',
    stalePrice: '⛔ {asset} price is stale',
    followCta: 'Step 2 · Follow Trader',

    noStrategy: '⚠ Trader has no published strategy. Copy is disabled.',
    footer:
      'Your margin will be automatically split and deposited into positions according to the strategy above.',
    snapshotNote:
      'Copying takes the trader\'s current strategy version. If the trader publishes a new version later, your positions do not follow automatically; to move to the new version, unfollow and copy again.',
    snapshotNoteSyncable:
      "Copying takes the trader's current strategy version. Without auto-sync, your positions stay put when the trader publishes a new version; press “Sync now” in your portfolio to move to the latest one, or switch auto-sync on at any time.",
    snapshotNoteSyncableSimple:
      "Copying takes the trader's current strategy version. If the trader publishes a new version later, your positions do not change on their own; switch to Expert Mode to review the new version before syncing, or to turn auto-sync on.",
  },

  /** See `../zh-TW/copy.ts`. */
  autoSync: {
    title: 'Auto-sync (optional)',
    toggle: "When the trader publishes a new version, move my positions to it automatically",
    disclosure:
      "Once on, anyone — your own agent, the platform's executor or a third party — can move your positions to the trader's latest on-chain version when one is published; you can also restrict it to one address you choose (for example your own agent). They cannot choose the assets, direction or leverage, and they cannot touch the rest of your funds; you can switch auto-sync off and withdraw the gas tank at any time.",
    costs:
      'Every sync first closes all positions of this copy and then opens the new version: you pay the trading fee once on the way out and once on the way in (at 5× and a 0.10% rate, about 1% of your margin per round), and profitable positions settle the 10% performance fee to the trader first (there is no high-water mark, so a price that swings back and forth can be charged more than once). When a sync happens is decided by when the trader publishes and when an executor sends it, which can be a moment when prices are against you. A longer cooldown and a lower leverage cap reduce both the cost and the risk.',
    selfCustody:
      'Your private key never leaves your wallet: the sync rule lives in the contract, and an executor only presses the button — it neither needs nor receives your key.',
    unsupported:
      "The copy contract on this network hasn't been upgraded to a version with auto-sync yet, so copying is still a snapshot.",
    expertOnly:
      'Auto-sync can only be switched on in Expert Mode, where you review its settings and costs first. Switch to Expert Mode to turn it on while copying, or later from your portfolio.',
    maxLeverage: 'Leverage cap',
    maxLeverageHelp:
      "When a new version asks for more leverage than this, positions open at this figure instead. Defaults to the highest leverage in this version, so a trader raising leverage later doesn't raise yours.",
    leverageOption: '{lev}×',
    cooldown: 'Cooldown',
    cooldownHelp:
      'Minimum time between two syncs sent by someone else (syncing yourself is never limited). The shorter it is, the more trading fees a trader publishing version after version can make you pay: 1 h allows up to 24 rounds a day, 24 h allows one. Defaults to 24 h.',
    cooldownOption: '{hours} h',
    tip: 'Executor tip (per sync)',
    tipHelp: 'ETH paid from your gas tank to whoever sends the sync for you; nothing when you sync yourself. Cap: {max} ETH.',
    tipOption: '{eth} ETH',
    tipNone: 'None (only you or your own agent)',
    prefund: 'Gas tank deposit (ETH)',
    prefundHelp:
      'The tank pays each sync’s execution fee ({fee} ETH per asset in the new version) and the tip. It is held in the contract under your own address and can be withdrawn at any time. The {fee} ETH per asset is also the execution-fee cap you sign: if the exchange raises its fee later, no one else can sync for you until you review the new fee in Portfolio and accept it.',
    estimate: 'About {count} syncs ({legs} assets, {cost} ETH each)',
    oneTx: 'One transaction copies, switches auto-sync on and fills the tank: {total} ETH attached ({open} ETH execution fees + {prefund} ETH tank).',
    twoTx: 'This contract version needs separate transactions: copy first, then switch auto-sync on, then fill the tank.',
    snapshotNoteAuto:
      'Auto-sync selected: when the trader publishes a new version, anyone can move your positions to it (leverage capped at {lev}×), with no need to copy again. You can switch it off from your portfolio at any time.',
    invalid: {
      leverage: 'The leverage cap must be 1–5×.',
      tip: 'The tip is above the contract cap.',
      interval: 'The cooldown must be at least 1 hour (the contract minimum).',
      prefund: 'Invalid deposit amount.',
    },
    executor: 'Only let this address sync for me (optional)',
    executorPlaceholder: '0x… (empty = anyone)',
    executorHelp:
      "Enter the hot wallet your own agent uses (not your main wallet). From then on, apart from you, only it can sync for you — the platform and everyone else are rejected by the contract; the cooldown, tip and fee cap still apply. Leave empty to let anyone sync for you.",
    executorExtraTx: 'Choosing an executor takes one more transaction after the copy; during the cooldown after copying (at least 1 hour) no one can sync for you anyway.',
    executorInvalid: {
      address: 'Invalid address.',
      self: 'That is your own address — you can always sync yourself. Enter a separate hot wallet that only holds gas (for example your own agent).',
    },
  },

  tx: {
    enterValidAmount: 'Enter a valid amount',
    approved: '{token} approved ✓',
    following: 'Following trader ✓',
    followingAuto: 'Following trader with auto-sync on ✓',
    autoSyncStep: 'Copied — now switching auto-sync on…',
    autoSyncFailed: 'The copy went through, but auto-sync was not switched on; you can switch it on from your portfolio.',
    executorStep: 'Copied — now setting your executor…',
    executorFailed:
      'The copy and auto-sync went through, but setting your executor did not: once the cooldown ends anyone can sync for you. You can set it again under Settings in your portfolio.',
  },

  /** #36：KYC 待審核那句夾了 `<b>`，拆成前後片段。 */
  markup: {
    kycPendingBefore: '⏳ Your KYC application ',
    kycPendingBold: 'has been submitted and is under review',
    kycPendingAfter:
      ' — copying strategies with stocks / bonds unlocks once a reviewer approves it; no need to resubmit.',
  },
};
