import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/history.ts`。
 */
export const history: Catalog['history'] = {
  title: 'Activity History',
  subtitle: 'Everything you did on the platform, read directly from Base Sepolia. Follow the links to check it yourself.',
  loading: 'Loading…',
  scanningLogs: 'Syncing chain logs…',
  refresh: '↺ Refresh',

  proofNote: {
    intro:
      'All activity is read directly from the Base Sepolia blockchain — no backend and no server-side database, just the immutable ledger.',
    positionsComplete: 'Investments are complete',
    positionsCompleteRest:
      '— every one you have ever bought is read from the on-chain program’s storage, however long ago. Swaps, changes to the amount invested, fees and performance deposits exist only as event logs, which the RPC serves in a limited block window, so those build up from what this browser has already seen.',
    clickToVerify: 'Click',
    clickToVerifyRest: 'to verify a row on BaseScan.',
  },

  tab: {
    mine: 'My Activity',
    mineDisconnected: 'My Activity (connect wallet)',
    all: 'All Activity',
  },

  filter: {
    all: 'All',
    swap: 'Swap',
    asset: 'Tokenized assets',
    vault: 'Risk reserve',
    position: 'Investments',
    margin: 'Amount invested',
    social: 'Social',
    fee: 'Fees',
    price: 'Price source',
    stake: 'Performance deposit',
    /** 篩選中且有結果時：Swap (12) */
    countedLabel: '{label} ({count})',
  },

  noWallet: 'Connect your wallet to see your activity.',

  empty: {
    title: 'No activity yet',
    windowOnly: 'No activity in roughly the last 30 minutes ({blocks} blocks). Load older blocks below to see earlier activity.',
    windowFiltered: 'No activity for filter "{filter}" in roughly the last 30 minutes ({blocks} blocks). Load older blocks below to see earlier activity.',
  },

  column: {
    time: 'Time',
    type: 'Type',
    user: 'User',
    details: 'Details',
    block: 'Block',
    tx: 'On-chain record',
  },

  eventType: {
    swap: 'Swap',
    swapLegacy: 'Swap (legacy)',
    ammSwap: 'Swap (AMM)',
    mint: 'Mint',
    redeem: 'Redeem',
    vaultDeposit: 'Risk reserve deposit',
    vaultWithdraw: 'Risk reserve withdrawal',
    opened: 'Opened',
    closed: 'Closed',
    deposit: 'Deposit',
    withdraw: 'Withdraw',
    follow: 'Follow',
    unfollow: 'Stop following',
    copyFee: 'Copy investing fee',
    priceUpdated: 'Price ↺',
    stake: 'Performance deposit',
    slash: 'Deduction',
  },

  legacySwapTooltip: 'Legacy MockSwapRouter swap (the router has been superseded by PepeAMM; kept for reference).',
  storageTooltip:
    'Read from the on-chain program’s storage — permanent, but storage does not record which on-chain record wrote it. Once the matching record is found in the logs, this becomes its ID and a BaseScan link. You can also check it yourself on BaseScan.',
  storageLabel: 'on-chain program storage',

  loadOlder: {
    scanning: 'Scanning older blocks…',
    cta: '↓ Load older (blocks {from}–{to})',
    ctaStart: '↻ Start reading logs (blocks {from}–{to})',
  },

  footer: {
    eventOne: '{count} event displayed',
    eventMany: '{count} events displayed',
    positionsFull: 'Investments read in full from on-chain program storage',
    scannedBackTo: '· logs scanned back to block #{block}',
    cacheNote:
      '· Log rows are cached in this browser only; clearing site data resets them, but the chain keeps everything.',
  },

  /** 掃描不完整時的說明——缺口不該被誤讀成「沒有資料」。 */
  scanIssue: {
    failedChunkOne:
      '{count} block-range query failed (event logs — swaps, mint/redeem, amounts invested, risk reserve, fees and performance deposits — may be incomplete)',
    failedChunkMany:
      '{count} block-range queries failed (event logs — swaps, mint/redeem, amounts invested, risk reserve, fees and performance deposits — may be incomplete)',
    positionIndexUnreadable:
      'the investment index could not be read — investments below may be missing',
    missedPositionOne: '{count} investment could not be read',
    missedPositionMany: '{count} investments could not be read',
    refreshToRetry: '{notes}. Refresh to retry.',
  },

  /** 掃描失敗時取代空狀態——失敗絕不能顯示成「沒有資料」。 */
  readFailed: {
    title: 'Read failed',
    description:
      "On-chain events could not be read (or were only partly read) — an empty list here does not mean there was no activity. Press Refresh to retry.",
  },
  fetchFailed: 'Failed to fetch events',
  timeoutRetry: 'Read failed (node timed out) — press Refresh to retry.',
  fetchOlderFailed: 'Failed to fetch older events',

  /** 每一種事件明細的敘述。 */
  detail: {
    marginLabel: 'Amount invested:',
    pnlLabel: 'Gain/loss:',
    receivedSuffix: ' | Received: {amount}',
    following: 'Following',
    unfollowed: 'Stopped following',
    earned: 'Earned:',
    feeSuffix: ' (fee: {fee})',
    staked: 'Performance deposit',
    slashed: 'Deducted',
    /** 開倉明細行首的方向色塊。 */
    sideLong: 'Rise',
    sideShort: 'Fall',
    mint: 'Minted {amount} {asset} for {usdc} USDC (fee {fee} USDC)',
    redeem: 'Redeemed {amount} {asset} for {usdc} USDC (fee {fee} USDC)',
    vaultDeposit: 'Deposited {usdc} USDC for {shares} shares',
    vaultWithdraw: 'Redeemed {shares} shares for {usdc} USDC',
  },
};
