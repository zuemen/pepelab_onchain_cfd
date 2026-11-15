import type { Catalog } from '../zh-TW';

/**
 * See `../zh-TW/legacy.ts`.
 */
export const legacy: Catalog['legacy'] = {
  title: 'Assets on Retired On-chain Programs',
  subtitle:
    'The on-chain investing program has been redeployed several times. The retired programs still hold the amounts invested and the investments you had not yet sold at the time. This page reads only the retired program addresses published by the platform, so you can check and recover them.',
  connectPrompt: 'Connect your wallet to look up your assets on the retired on-chain programs.',
  demoWallet: 'Guest mode has no on-chain data. Connect a wallet.',
  loading: 'Reading retired on-chain programs…',
  refresh: 'Refresh',
  noneOnChain: 'There are no retired on-chain programs on {chain}.',
  noneFound: 'You have no invested amounts or unsold investments on the retired on-chain programs on {chain}. Nothing to do.',
  readFailed: 'Could not read {address}. Please refresh in a moment.',
  unsupported: '{address} lacks the functions needed to look up assets, so this page cannot confirm what you hold there.',
  backToPortfolio: 'Back to Portfolio',

  card: {
    period: 'In use {from} – {until}',
    contract: 'On-chain program address',
    freeMargin: 'Withdrawable amount',
    contractBalance: 'Program USDC balance',
    openPositions: 'Investments not yet sold',
    noPositions: 'You have no unsold investments on this retired program.',
    truncated:
      'You have more than {max} investment records on this retired program; only the latest {max} were checked. There may be more investments not listed here. Please contact support to confirm.',
  },

  withdraw: {
    button: 'Withdraw {amount} {token}',
    working: 'Withdrawing…',
    done: 'Amount withdrawn from the retired on-chain program',
    partial:
      'The program balance cannot cover a full withdrawal: up to {amount} can be withdrawn now; the remaining {shortfall} needs the operator.',
  },

  close: {
    button: 'Sell',
    working: 'Selling…',
    done: 'Investment on the retired program sold',
    afterClose:
      'After selling, the settled amount returns to your withdrawable amount on this retired program. Withdraw again to move it to your wallet.',
  },

  column: {
    id: 'ID',
    asset: 'Asset',
    side: 'Direction',
    margin: 'Amount invested',
    leverage: 'Amplification',
    entryPrice: 'Buy price',
    oracleAge: 'Price source last updated',
    action: 'Actions',
  },
  side: {
    long: 'Price up',
    short: 'Price down',
  },

  staleWarning:
    'This retired program does not check price age: the price source was last updated {age}, and selling will settle at that price.',

  block: {
    notSent: 'Stopped before sending: this action would certainly fail.',
    stalePrice:
      'The price source is stale (last updated {age}); the retired program will reject the sale. Try again once the price is updated.',
    stalePriceAbandoned:
      'The price source has not updated this asset for a long time (last updated {age}) and appears to have stopped. This needs the operator.',
    oracleInvalid: 'The price source returns an invalid price, so the retired program will reject the sale. This needs the operator.',
    feeRouterRevoked:
      'Selling this investment pays a performance fee, but the fee program now accepts only the new program, so it would fail. The operator must change a setting on the retired program before it can be sold.',
    vaultRevoked:
      "The retired program's authorisation on the risk reserve has moved to the new program, so this action would fail. This needs the operator.",
    exchangeUnderfunded: 'The retired program does not hold enough USDC to pay this amount. This needs the operator.',
    insufficientFreeMargin: 'Your withdrawable amount has changed. Refresh and try again.',
    notOwner: 'This investment does not belong to the connected wallet.',
    alreadyClosed: 'This investment is already sold. Please refresh.',
    paused: 'The retired program is paused. This needs the operator.',
    unsupported: 'This retired program has no function for this action, so it cannot be handled here. This needs the operator.',
    unknown: 'The pre-check failed ({code}), so it would fail and was not sent. The operator needs to look into it.',
  },

  contact: {
    title: 'Operator help needed',
    body: 'Items marked as needing the operator cannot be recovered on-chain by you. Include the following when you get in touch:',
    email: 'Support email: ',
    url: 'Support page',
    none: 'This platform has not configured a support contact. Reach the operator through the channel you signed up with, and include the following.',
    detailsWallet: 'Wallet address',
    detailsContract: 'Retired on-chain program',
    detailsPositions: 'Investment IDs',
    copy: 'Copy',
    copied: 'Copied',
  },

  banner: {
    title: 'You still have assets on a retired on-chain program',
    body: '{count} retired on-chain program(s) still hold your invested amounts or unsold investments. The current pages do not show them.',
    cta: 'Review and recover',
    readFailedHint: 'Retired program data could not be read right now. Please check again later.',
    readFailedLink: 'Assets on Retired On-chain Programs',
  },
};
