/**
 * LP Vault（保險金庫）。
 */
export const vault = {
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

  /** #36：三句句中夾標記的說明，各自拆成標記前後的片段。 */
  markup: {
    mmActiveLabel: 'Market-making yield active:',
    mmPctRouted: "{pct}% of every trade's fee is routed to LPs —",
    mmAmount: '{amount} mUSDC',
    mmRoutedToDate: 'routed to date.',

    howItWorksLabel: 'How it works:',
    howItWorksBody:
      ' LPs deposit mUSDC and receive pIV shares. The vault earns 10% of all copy-trading and performance fees via the FeeRouter. On liquidation the vault only receives the ',
    liquidationPenaltyLabel: 'liquidation penalty',
    howItWorksCodeWrap: ' (',
    howItWorksTail:
      ") plus the liquidator's reward — the position owner is refunded whatever margin is left after loss, fees and penalty, so liquidation is no longer a 100% forfeit.",

    badDebtBefore:
      "When a trader's loss exceeds their margin (extreme event), the vault pays a 10% bailout floor directly to the trader. If losses exceed what the vault can cover, the shortfall is emitted as a ",
    badDebtMid: ' event and the vault has to be topped up via ',
    badDebtAfter: '. LPs bear this risk in exchange for the yield.',
  },
};
