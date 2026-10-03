import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/history.ts`。
 */
export const history: Catalog['history'] = {
  title: 'Transaction History',
  subtitle: 'On-chain auditability — decoded directly from Base Sepolia via ethers.js',
  loading: 'Loading…',
  scanningLogs: 'Syncing chain logs…',
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
    asset: 'Tokenized assets',
    vault: 'Insurance vault',
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
    swapLegacy: 'Swap (legacy)',
    ammSwap: 'Swap (AMM)',
    mint: 'Mint',
    redeem: 'Redeem',
    vaultDeposit: 'Vault deposit',
    vaultWithdraw: 'Vault withdraw',
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

  legacySwapTooltip: 'Legacy MockSwapRouter swap (the router has been superseded by PepeAMM; kept for reference).',
  storageTooltip:
    'Read from contract storage — permanent, but storage does not record which transaction wrote it. Once the matching transaction is found in the logs, this becomes its hash and a BaseScan link. You can also verify with getPosition() on BaseScan.',
  storageLabel: 'contract storage',

  loadOlder: {
    scanning: 'Scanning older blocks…',
    cta: '↓ Load older (blocks {from}–{to})',
    ctaStart: '↻ Start reading logs (blocks {from}–{to})',
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
      '{count} block-range query failed (event logs — swaps, mint/redeem, margin, vault, fees and stakes — may be incomplete)',
    failedChunkMany:
      '{count} block-range queries failed (event logs — swaps, mint/redeem, margin, vault, fees and stakes — may be incomplete)',
    positionIndexUnreadable:
      'the position index could not be read — positions below may be missing',
    missedPositionOne: '{count} position could not be read',
    missedPositionMany: '{count} positions could not be read',
    refreshToRetry: '{notes}. Refresh to retry.',
  },

  /** 掃描失敗時取代空狀態——失敗絕不能顯示成「沒有資料」。 */
  readFailed: {
    title: 'Read failed',
    description:
      "On-chain events could not be read (or were only partly read) — an empty list here does not mean there was no activity. Press Refresh to retry.",
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
    mint: 'Minted {amount} {asset} for {usdc} USDC (fee {fee} USDC)',
    redeem: 'Redeemed {amount} {asset} for {usdc} USDC (fee {fee} USDC)',
    vaultDeposit: 'Deposited {usdc} USDC for {shares} shares',
    vaultWithdraw: 'Redeemed {shares} shares for {usdc} USDC',
  },
};
