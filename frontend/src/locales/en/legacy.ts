import type { Catalog } from '../zh-TW';

/**
 * See `../zh-TW/legacy.ts`.
 */
export const legacy: Catalog['legacy'] = {
  title: 'Legacy Contract Assets',
  subtitle:
    'The trading contract has been redeployed several times. The retired contracts still hold the margin and open positions you had at the time. This page reads only the retired contract addresses published by the platform, so you can check and recover them.',
  connectPrompt: 'Connect your wallet to look up your assets on the retired contracts.',
  demoWallet: 'Demo mode has no on-chain data. Connect a real wallet.',
  loading: 'Reading retired contracts…',
  refresh: 'Refresh',
  noneOnChain: 'There are no retired trading contracts on {chain}.',
  noneFound: 'You have no margin or open positions on the retired contracts on {chain}. Nothing to do.',
  readFailed: 'Could not read {address}. Please refresh in a moment.',
  unsupported: '{address} lacks the functions needed to look up assets, so this page cannot confirm what you hold there.',
  backToPortfolio: 'Back to Portfolio',

  card: {
    period: 'In use {from} – {until}',
    contract: 'Contract address',
    freeMargin: 'Free Margin',
    contractBalance: 'Contract USDC balance',
    openPositions: 'Open Positions',
    noPositions: 'You have no open positions on this contract.',
  },

  withdraw: {
    button: 'Withdraw {amount} {token}',
    working: 'Withdrawing…',
    done: 'Margin withdrawn from the retired contract',
    partial:
      'The contract balance cannot cover a full withdrawal: up to {amount} can be withdrawn now; the remaining {shortfall} needs the operator.',
  },

  close: {
    button: 'Close',
    working: 'Closing…',
    done: 'Position on the retired contract closed',
    afterClose:
      'After closing, the settled amount returns to your Free Margin on this retired contract. Withdraw again to move it to your wallet.',
  },

  column: {
    id: 'ID',
    asset: 'Asset',
    side: 'Side',
    margin: 'Margin',
    leverage: 'Leverage',
    entryPrice: 'Entry price',
    oracleAge: 'Oracle last updated',
    action: 'Actions',
  },
  side: {
    long: 'Long',
    short: 'Short',
  },

  staleWarning:
    'This retired contract does not check price age: the Oracle price was last updated {age}, and closing will settle at that price.',

  block: {
    checking: 'Pre-checking…',
    notSent: 'Stopped before sending: this transaction would certainly fail.',
    stalePrice:
      'The Oracle price is stale (last updated {age}); the retired contract will reject the close. Try again once the price is updated.',
    stalePriceAbandoned:
      'The Oracle has not updated this asset for a long time (last updated {age}) and appears to have stopped. This needs the operator.',
    oracleInvalid: 'The Oracle returns an invalid price, so the retired contract will reject the close. This needs the operator.',
    feeRouterRevoked:
      'Closing this position pays a performance fee, but the fee contract now accepts only the new trading contract, so the transaction would fail. The operator must change a setting on the retired contract before it can be closed.',
    vaultRevoked:
      "The retired contract's authorisation on the insurance vault has moved to the new contract, so this action would fail. This needs the operator.",
    exchangeUnderfunded: 'The retired contract does not hold enough USDC to pay this amount. This needs the operator.',
    insufficientFreeMargin: 'Your Free Margin has changed. Refresh and try again.',
    notOwner: 'This position does not belong to the connected wallet.',
    alreadyClosed: 'This position is already closed. Please refresh.',
    paused: 'The retired contract is paused. This needs the operator.',
    unsupported: 'This retired contract has no function for this action, so it cannot be handled here. This needs the operator.',
    unknown: 'The pre-check failed ({code}), so the transaction would fail and was not sent. The operator needs to look into it.',
  },

  contact: {
    title: 'Operator help needed',
    body: 'Items marked as needing the operator cannot be recovered on-chain by you. Include the following when you get in touch:',
    email: 'Support email: ',
    url: 'Support page',
    none: 'This platform has not configured a support contact. Reach the operator through the channel you signed up with, and include the following.',
    detailsWallet: 'Wallet address',
    detailsContract: 'Retired contract',
    detailsPositions: 'Position IDs',
    copy: 'Copy',
    copied: 'Copied',
  },

  banner: {
    title: 'You still have assets on a retired trading contract',
    body: '{count} retired contract(s) still hold your margin or open positions. The current pages do not show them.',
    cta: 'Review and recover',
  },
};
