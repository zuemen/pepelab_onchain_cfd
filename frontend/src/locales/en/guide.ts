import type { Catalog } from '../zh-TW';

export const guide: Catalog['guide'] = {
  slogan: 'Trading with trust, intelligence, and sustainability.',
  sloganZh: '',

  more: 'Show details',
  less: 'Hide details',
  hide: 'Hide guide',
  show: 'Show beginner guide',

  pillars: {
    trust: {
      title: 'Trust',
      short: 'Your assets stay in your own wallet, and every record is on-chain for anyone to check.',
      detail:
        'PepeFi never holds your private keys. Positions opened by copying are in your name, and only you can cancel them. Every position and strategy version a trader publishes is recorded on-chain and cannot be deleted later. This is a testnet prototype: margin sits in smart contracts under the contract rules, synthetic assets are not fully collateralized, and risks are disclosed on the Reserves & Solvency page.',
    },
    intelligence: {
      title: 'Intelligence',
      short: 'Let AI trade inside the limits you set, without ever getting your private key, or follow the traders you pick automatically.',
      detail:
        'You give an AI agent a limited session key: size per trade, total budget, maximum leverage and expiry are all on-chain, and you can revoke it at any time. When the AI needs data, it pays a small amount itself through x402, with no account to set up.',
    },
    sustainability: {
      title: 'Sustainability',
      short: 'Carbon is built into the fee: the more carbon-intensive the asset, the higher the fee.',
      detail:
        'Each asset has a sourced carbon-intensity tier that sets its fee, so it is more than a green label. Part of the platform fee buys simulated carbon credits and burns them on the spot, and every retirement can be checked. This is a testnet: the credits are simulated and do not represent real emission cuts.',
    },
  },

  copyFlow: {
    heading: 'How copy trading works, in five steps',
    sub: 'No blockchain knowledge needed. Everything here uses test tokens, not real money.',
    steps: [
      { title: 'Connect a wallet', text: 'Your wallet is your account. No sign-up.', to: '/portfolio' },
      { title: 'Get test tokens', text: 'Claim free USDC on the Exchange page.', to: '/exchange' },
      { title: 'Pick a trader', text: 'Compare on-chain records in the Marketplace.', to: '/marketplace' },
      { title: 'Press copy', text: 'Choose an amount and confirm once in your wallet.', to: '/marketplace' },
      { title: 'Stay in sync', text: 'When they change strategy, your positions follow.', to: '/portfolio' },
    ],
    detail: [
      'Positions opened by copying are in your own name. Only you can cancel them, and the trader cannot touch your funds.',
      'You choose how often to sync and the leverage cap, or turn auto-sync off and sync by hand.',
      'Copying costs a 0.3% copy fee, and profitable copied positions pay a 10% performance fee on close. Traders must stake before publishing, and can be slashed if followers lose too much.',
    ],
  },

  mode: {
    simpleTitle: 'Simple mode: start with these four steps',
    expertTitle: 'Expert mode: you can also do these',
    switchHint: 'Switch between Simple and Expert at the top right.',
    simple: [
      { title: 'Get test tokens', text: 'Claim free USDC to trade with.', to: '/exchange' },
      { title: 'Buy some assets', text: 'Use USDC to buy stocks, bonds, gold and crypto.', to: '/tokens' },
      { title: 'Copy a trader', text: 'Compare on-chain records and pick one.', to: '/marketplace' },
      { title: 'Check your results', text: 'Allocation and P&L are in your portfolio.', to: '/portfolio' },
    ],
    expert: [
      { title: 'Pro terminal', text: 'Go long or short yourself and set leverage.', to: '/terminal' },
      { title: 'AI agent sessions', text: 'Set limits and let an AI trade for you.', to: '/sessions' },
      { title: 'Become a trader', text: 'Stake USDC, publish a strategy, earn a share.', to: '/stake' },
      { title: 'x402 paid signals', text: 'See how an AI pays for its own data.', to: '/x402' },
      { title: 'Insurance vault', text: 'Deposit USDC to share fees and take on risk.', to: '/vault' },
      { title: 'On-chain transparency', text: 'Check reserves, prices and records yourself.', to: '/solvency' },
    ],
  },
};
