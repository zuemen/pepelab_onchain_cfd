import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/history.ts`。搬移階段逐字複製原文。
 */
export const history: Catalog['history'] = {
  title: 'Transaction History',
  subtitle: 'On-chain auditability — decoded directly from Base Sepolia via ethers.js',
  loading: 'Loading…',
  refresh: '↺ Refresh',

  proofNote: {
    intro:
      'All activity is read directly from the Base Sepolia blockchain — no backend and no server-side database, just the immutable ledger.',
    positionsComplete: 'Positions are complete',
    positionsCompleteRest:
      '— every one you have ever opened is read from contract storage, however long ago. Swaps, margin moves, fees and stakes exist only as event logs, which the RPC serves in a limited block window, so those build up from what this browser has already seen.',
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
    position: 'Positions',
    margin: 'Margin',
    social: 'Social',
    fee: 'Fees',
    price: 'Oracle',
    stake: 'Stake',
    /** 篩選中且有結果時：Swap (12) */
    countedLabel: '{label} ({count})',
  },

  noWallet: 'Connect your wallet to see your activity.',

  empty: {
    title: 'No activity yet',
    windowOnly: 'No events found in the last {blocks} blocks.',
    windowFiltered: 'No events found in the last {blocks} blocks for filter "{filter}".',
  },

  column: {
    time: 'Time',
    type: 'Type',
    user: 'User',
    details: 'Details',
    block: 'Block',
    tx: 'Tx',
  },

  eventType: {
    swap: 'Swap',
    opened: 'Opened',
    closed: 'Closed',
    deposit: 'Deposit',
    withdraw: 'Withdraw',
    follow: 'Follow',
    unfollow: 'Unfollow',
    copyFee: 'Copy Fee',
    priceUpdated: 'Price ↺',
    stake: 'Stake',
    slash: 'Slash',
  },

  storageTooltip:
    'Read from contract storage — permanent, but not tied to a single transaction. Verify with getPosition() on BaseScan.',
  storageLabel: 'storage',

  loadOlder: {
    scanning: 'Scanning older blocks…',
    cta: '↓ Load older (blocks {from}–{to})',
  },

  footer: {
    eventOne: '{count} event displayed',
    eventMany: '{count} events displayed',
    positionsFull: 'Positions read in full from contract storage',
    scannedBackTo: '· logs scanned back to block #{block}',
    cacheNote:
      '· Log rows are cached in this browser only; clearing site data resets them, but the chain keeps everything.',
  },

  /** 掃描不完整時的說明——缺口不該被誤讀成「沒有資料」。 */
  scanIssue: {
    failedChunkOne:
      '{count} block-range query failed (swaps, margin, fees and stakes may be incomplete)',
    failedChunkMany:
      '{count} block-range queries failed (swaps, margin, fees and stakes may be incomplete)',
    positionIndexUnreadable:
      'the position index could not be read — positions below may be missing',
    missedPositionOne: '{count} position could not be read',
    missedPositionMany: '{count} positions could not be read',
    refreshToRetry: '{notes}. Refresh to retry.',
  },

  fetchFailed: 'Failed to fetch events',
  fetchOlderFailed: 'Failed to fetch older events',

  /** 每一種事件明細的敘述。 */
  detail: {
    marginLabel: 'Margin:',
    pnlLabel: 'PnL:',
    receivedSuffix: ' | Received: {amount}',
    following: 'Following',
    unfollowed: 'Unfollowed',
    earned: 'Earned:',
    feeSuffix: ' (fee: {fee})',
    staked: 'Staked',
    slashed: 'Slashed',
    /** 開倉明細行首的方向色塊。 */
    sideLong: 'LONG',
    sideShort: 'SHORT',
  },
};
