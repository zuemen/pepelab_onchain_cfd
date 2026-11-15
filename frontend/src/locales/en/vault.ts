import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/vault.ts`。
 */
export const vault: Catalog['vault'] = {
  connectWallet: 'Connect wallet to use the risk reserve.',
  viewOnEtherscan: 'View on Etherscan ↗',

  title: 'Risk Reserve',
  titleSimple: 'Risk Reserve',
  subtitle: 'Deposit USDC to share in platform fees. The risk reserve absorbs investors\' extreme losses, so share value can fall.',

  simpleYieldActive: 'The risk reserve is currently earning a share of platform fees.',

  stat: {
    totalAssets: 'Total Assets',
    sharePrice: 'Share Price',
    totalSupply: 'Total Supply',
    myValue: 'My pIV Value',
  },

  position: {
    title: 'Your Deposit',
    shares: 'pIV held',
    value: 'USDC value',
  },

  deposit: {
    title: 'Deposit USDC',
    description:
      'Receive pIV shares in proportion to the current reserve size, and share in platform fees.',
    placeholder: 'USDC amount',
    cta: 'Deposit',
    estimate: '≈ {shares} pIV',
    done: 'Deposited {amount} USDC ✓',
  },

  withdraw: {
    title: 'Withdraw Shares',
    description: 'Burn pIV shares to receive proportional USDC from the pool.',
    placeholder: 'pIV shares',
    cta: 'Withdraw',
    estimate: '≈ {amount} USDC',
    max: 'Max ({shares} pIV)',
    done: 'Withdrew {amount} pIV shares ✓',
  },

  /** 活動列表。每一種事件的名稱。 */
  activity: {
    title: 'Recent Activity',
    emptyTitle: 'No activity yet',
    emptyDescription: 'Deposit USDC to start sharing in platform fees. The risk reserve absorbs extreme losses, so share value can fall.',
    readFailedTitle: 'Read failed',
    readFailedDescription: "The risk reserve's on-chain events could not be read — an empty list here does not mean there was no activity. Please refresh later.",
    partial: 'Some block ranges could not be read; the activity below may be incomplete.',
    deposited: 'Deposit',
    withdrawn: 'Withdrawal',
    protocolDeposit: 'Platform fee',
    bailout: 'Cover paid',
    block: '#{block}',
  },

  /** 交易正在跑的時候按鈕上的字。 */
  working: '…',

  /** #36：三句句中夾標記的說明，各自拆成標記前後的片段。 */
  markup: {
    mmActiveLabel: 'Fee sharing active:',
    mmPctRouted: '{pct}% of every investment fee goes to depositors —',
    mmAmount: '{amount} USDC',
    mmRoutedToDate: 'routed to date.',

    howItWorksLabel: 'How it works:',
    howItWorksBody:
      ' Depositors put in USDC and receive pIV shares. Through the fee-sharing program (FeeRouter) the risk reserve receives 10% of all copy investing and performance fees. When an investment is settled automatically, the risk reserve only receives the ',
    howItWorksBodyNoCopy:
      ' Depositors put in USDC and receive pIV shares. Through the fee-sharing program (FeeRouter) the risk reserve receives 10% of platform and performance fees. When an investment is settled automatically, the risk reserve only receives the ',
    liquidationPenaltyLabel: 'automatic settlement penalty',
    howItWorksCodeWrap: ' (',
    howItWorksTail:
      ") plus a reward for whoever carries out the settlement — the investor gets back whatever is left of the amount invested after loss, fees and penalty, so an automatic settlement does not take everything.",

    badDebtBefore:
      "When an investor's loss exceeds the amount invested (an extreme event), the risk reserve pays a 10% cover floor directly to that investor. If losses exceed what the reserve can cover, the shortfall is recorded on-chain as a ",
    badDebtMid: ' event and the reserve has to be topped up via ',
    badDebtAfter: '. Depositors bear this risk in exchange for the yield.',
  },
};
