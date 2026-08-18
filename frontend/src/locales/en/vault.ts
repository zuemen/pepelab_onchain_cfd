import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/vault.ts`。搬移階段逐字複製原文。
 */
export const vault: Catalog['vault'] = {
  connectWallet: 'Connect wallet to use the LP Vault.',
  viewOnEtherscan: 'View on Etherscan ↗',

  stat: {
    totalAssets: 'Total Assets',
    sharePrice: 'Share Price',
    totalSupply: 'Total Supply',
    myValue: 'My pIV Value',
  },

  position: {
    title: 'Your Position',
    shares: 'pIV held',
    value: 'mUSDC value',
  },

  deposit: {
    title: 'Deposit mUSDC',
    description:
      'Receive pIV shares proportional to current pool size. Earn yield from protocol fees.',
    placeholder: 'mUSDC amount',
    cta: 'Deposit',
    estimate: '≈ {shares} pIV',
    done: 'Deposited {amount} mUSDC ✓',
  },

  withdraw: {
    title: 'Withdraw Shares',
    description: 'Burn pIV shares to receive proportional mUSDC from the pool.',
    placeholder: 'pIV shares',
    cta: 'Withdraw',
    estimate: '≈ {amount} mUSDC',
    max: 'Max ({shares} pIV)',
    done: 'Withdrew {amount} pIV shares ✓',
  },

  /** 活動列表。每一種事件的名稱。 */
  activity: {
    title: 'Recent Activity',
    emptyTitle: 'No activity yet',
    emptyDescription: 'Deposit mUSDC to start earning yield from protocol fees.',
    deposited: 'LP Deposit',
    withdrawn: 'LP Withdraw',
    protocolDeposit: 'Protocol Fee',
    bailout: 'Bailout Paid',
    block: '#{block}',
  },

  /** 交易正在跑的時候按鈕上的字。 */
  working: '…',
};
