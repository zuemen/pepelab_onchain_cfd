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
      short: 'You keep your private key, your margin is recorded under your address and can only be withdrawn to you, and every trade is on-chain for anyone to check.',
      detail:
        'PepeFi never holds your private keys, and the contracts have no function that lets the platform directly withdraw user funds. Positions opened by copying are in your name, and every position and strategy version a trader publishes is recorded on-chain and cannot be deleted later. This is a testnet prototype: the operator can still change parameters, authorize contracts, pause and upgrade, using a single key that is visible on-chain, which can indirectly affect your funds, so you still have to trust the operator; a timelock handover script is ready but has not been run. Synthetic assets are not fully collateralized, and risks are disclosed on the Reserves & Solvency page.',
    },
    intelligence: {
      title: 'Intelligence',
      short: 'Let AI trade inside the limits you set, without ever getting your main wallet key, or follow the traders you pick automatically.',
      detail:
        'You give an AI agent a limited session key: size per trade, total budget, maximum leverage and expiry are all on-chain, and you can revoke it at any time. When the AI needs data, it pays a small amount itself through x402, with no account to set up.',
    },
    sustainability: {
      title: 'Sustainability',
      short: 'Carbon is built into the fee: the more carbon-intensive the asset, the higher the fee.',
      detail:
        'Each asset has a carbon tier that sets its buy fee and leverage cap, so it is more than a green label. Tiers are currently attested by the team. 5% of copy and performance fees regularly buys simulated carbon credits, which are burned, and every retirement can be checked. This is a testnet: the credits are simulated and do not represent real emission cuts.',
    },
  },

  marketplace: {
    traders: 'Copy a trader',
    allocations: 'Ready-made allocations',
    simNote: 'Testnet demo: most traders and allocation publishers listed here are simulated accounts run by a program, not real people, and their results are not real investment returns.',
  },

  twin: {
    heading: 'Are these tokenized securities? Not today. Digital twins are the next step',
    short: 'Today the tokens and perpetuals are synthetic exposure on a testnet and only track prices. The route to real securities is a digital twin built with licensed partners: an off-chain custodian holds the official record, and the on-chain token is its twin.',
    roadmap: [
      { title: 'Now: synthetic track (testnet)', text: 'Shows the product and technology: spot tokens, perpetuals, copy trading and AI authorization.' },
      { title: 'Next: licensed partner pilot', text: 'A licensed institution issues twin tokens, with no leverage, for credentialed wallets only.' },
      { title: 'Later: align with regulatory specs', text: 'Add closed-market price bands, standardized reporting data and on-chain handling of corporate actions.' },
    ],
    notice: 'PepeFi is not a venue under the SEC exemption and has no regulatory approval. This table only compares gaps and is not a compliance statement. The digital twin column is a plan and has not been built.',
    columns: ['Item', 'Now (synthetic track)', 'Next (digital twin, planned)', 'SEC exemption condition'],
    rows: [
      { item: 'What the token is', now: 'A synthetic token that only tracks price', twin: 'An on-chain representation of the same security held by a custodian', sec: 'Must represent the same security; synthetic exposure is out of scope' },
      { item: 'Holder rights', now: 'No shareholder, creditor or beneficiary rights', twin: 'Provided by the issuer or custodian; mapping dividends and votes on-chain is unresolved', sec: 'Must carry the same rights as traditional shares' },
      { item: 'Leverage', now: 'Perpetuals up to 5x, by asset', twin: 'None', sec: 'No financing or extension of credit' },
      { item: 'Who can trade', now: 'Any connected wallet; testnet KYC passes on submission', twin: 'A verifiable-credential allowlist binding wallets to legal entities', sec: 'Public chain, but permissioned access' },
      { item: 'Closed markets', now: 'The keeper switches equities to reduce-only', twin: 'Add closed-market price bands and a pre-open pause', sec: 'Trading halts when the listing exchange halts the stock' },
    ],
    source: 'Source: US SEC Release No. 34-106402 (File No. 4-927, 2026-09-17). This is the team\'s summary; the regulator\'s interpretation governs.',
  },

  copyFlow: {
    heading: 'How copy trading works, in five steps',
    sub: 'No blockchain knowledge needed. Everything here uses test tokens, not real money.',
    steps: [
      { title: 'Connect a wallet', text: 'Your wallet is your account. No sign-up.', to: '/portfolio' },
      { title: 'Get test tokens', text: 'Claim free USDC on the Exchange page.', to: '/exchange' },
      { title: 'Pick a trader', text: 'Compare on-chain records in the Marketplace.', to: '/marketplace' },
      { title: 'Press copy', text: 'Choose an amount and confirm once in your wallet.', to: '/marketplace' },
      { title: 'Optional sync', text: 'To follow their updates, turn on auto-sync (off by default).', to: '/portfolio' },
    ],
    detail: [
      'Positions opened by copying are in your own name. Only you can cancel them, and the trader cannot touch your funds.',
      'Auto-sync is off by default and is turned on in Expert mode. You set the cooldown and leverage cap, and can turn it off later.',
      'Copying costs a 0.3% copy fee, and profitable copied positions pay a 10% performance fee on close. Traders must stake before publishing. If followers lose too much the stake can be slashed, but that money does not go to followers.',
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
