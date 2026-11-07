import type { Catalog } from '../zh-TW';

/**
 * #149 / ADR-007: the Simple Mode Allocation marketplace and Adopt flow.
 * Unleveraged spot product — no trading-desk words (adoptVocabulary.test.ts).
 */
export const adopt: Catalog['adopt'] = {
  title: 'Allocations',
  subtitle:
    "Pick a published portfolio, enter an amount, and we buy the same mix for you. The tokens go straight to your wallet. It's a one-time purchase: later changes by the publisher won't affect you. Publishers marked Simulated are programs, not real people.",

  connectWallet: 'Connect a wallet to browse Allocations.',
  notDeployed: 'Spot tokens are not enabled on this network yet, so Allocations cannot be adopted here.',
  notConnected: 'This connection cannot read on-chain data right now. Reconnect your wallet and try again.',
  mockWallet: 'The mock wallet cannot read on-chain data. Connect a real wallet to browse and adopt Allocations.',
  loadFailed: 'Could not load Allocations:',
  refreshAria: 'Refresh Allocations',
  listSeparator: ', ',

  empty: {
    title: 'No adoptable Allocations on this chain yet',
    description: 'Connected to {chain}. Allocations appear here once an Allocation Publisher shares one.',
    unknownChain: 'Unknown network (chainId {chainId})',
  },
  hiddenNote: '{count} more published Allocation(s) include assets that cannot be bought as spot tokens, so they are not listed.',

  snapshotNote:
    "Adopting buys the publisher's weights as they are right now, once. If the publisher changes their Allocation later, your holdings do not change with it.",

  card: {
    noName: 'Unnamed Allocation Publisher',
    assetCount: '{count} assets',
    adopt: 'Adopt',
    details: "See this publisher's record",
  },

  dialog: {
    title: 'Adopt the Allocation from “{name}”',
    amountLabel: 'Amount (USDC)',
    balance: 'Wallet balance: {amount} USDC',
    colAsset: 'Asset',
    colWeight: 'Weight',
    colAmount: 'Amount',
    colStatus: 'Status',
    badAmount: 'Enter a valid amount.',
    tooSmall: 'That amount is too small to give every asset a share.',
    insufficientBalance: 'Not enough USDC in your wallet.',
    vaultPaused: 'The vault is paused, so buying is unavailable right now.',
    mintingHalted: 'Minting is paused in the vault, so buying is unavailable right now. Redemption is unaffected.',
    txCount: 'Your wallet will ask you to confirm {total} transactions: 1 USDC approval and {legs} buys.',
    confirm: 'Confirm and adopt',
    running: 'Adopting…',
    cancel: 'Cancel',
    close: 'Close',
    viewTx: 'View transaction',
  },

  status: {
    waiting: 'Waiting',
    buying: 'Buying…',
    bought: 'Bought',
    failed: 'Failed',
    unavailable: 'Unavailable right now',
    notStarted: 'Not sent',
  },

  outcome: {
    complete: 'Adopted — all {count} assets are now in your wallet.',
    partial:
      'Only partly done: bought {bought}; {failed} failed and nothing after it was sent. The tokens you bought are in your wallet — redeem them on the assets page or buy the rest yourself.',
    failed: 'Adoption failed. Nothing was bought.',
    blocked: '{symbols} cannot be bought right now. Nothing was sent, so you did not end up with only part of the Allocation.',
  },
};
