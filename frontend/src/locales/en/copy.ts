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
    /** 分配標籤：↑ sBTC 50% · 3× */
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
      'Copy fee is split 70% → trader · 20% → platform · 10% → slash pool. Execution fee pays Keeper bots.',
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
      "⚠ If your loss exceeds 30%, this trader's stake will be slashed (50% of loss, capped at 50% of stake) and transferred to you as compensation.",
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
  },

  tx: {
    enterValidAmount: 'Enter a valid amount',
    approved: '{token} approved ✓',
    following: 'Following trader ✓',
  },

  /** #36：KYC 待審核那句夾了 `<b>`，拆成前後片段。 */
  markup: {
    kycPendingBefore: '⏳ Your KYC application ',
    kycPendingBold: 'has been submitted and is under review',
    kycPendingAfter:
      ' — copying strategies with stocks / bonds unlocks once a reviewer approves it; no need to resubmit.',
  },
};
