import type { Catalog } from '../zh-TW';

export const guide: Catalog['guide'] = {
  slogan: 'Investing with trust, intelligence, and sustainability.',
  sloganZh: '',

  more: 'Show details',
  less: 'Hide details',
  hide: 'Hide guide',
  show: 'Show beginner guide',

  pillars: {
    trust: {
      title: 'Trust',
      short: 'You keep your private key, the money you invest is recorded under your address and can only be withdrawn to you, and every record is on-chain for anyone to check.',
      detail:
        'PepeFi never holds your private keys, and the on-chain programs have no function that lets the platform directly withdraw user funds. Assets bought through copy investing are in your name, and every investment and strategy version a strategy sharer publishes is recorded on-chain and cannot be deleted later. Today the operator can still change parameters, authorize programs, pause and upgrade, using a single key that is visible on-chain, which can indirectly affect your funds, so you still have to trust the operator; a timelock handover script is ready but has not been run. Synthetic assets are not fully collateralized, and risks are disclosed on the Reserves & Solvency page.',
    },
    intelligence: {
      title: 'Intelligence',
      short: 'Let AI buy and sell inside the limits you set, without ever getting your main wallet key, or automatically follow the strategy sharers you pick.',
      detail:
        'You give an AI agent an AI agent allowance: amount per order, total budget and expiry are all on-chain, and you can revoke it at any time. When the AI needs data, it pays a small amount itself through x402, with no account to set up.',
    },
    sustainability: {
      title: 'Sustainability',
      short: 'Carbon is built into the fee: the more carbon-intensive the asset, the higher the fee.',
      detail:
        'Each asset has a carbon tier that sets its buy fee, so it is more than a green label. Tiers are currently attested by the team. 5% of copy investing and performance fees regularly buys platform-minted carbon credits, which are burned, and every retirement can be checked. These credits are not issued by any carbon-credit registry and do not represent real emission cuts.',
    },
  },

  marketplace: {
    traders: 'Follow a strategy sharer',
    allocations: 'Ready-made allocations',
    simNote: 'Most strategy sharers and allocation publishers listed here are simulated accounts run by a program, not real people, and their results are not real investment returns.',
  },

  twin: {
    heading: 'Are these tokenized securities? Not today. Digital twins are the next step',
    short: 'Today the tokens and advanced features are synthetic exposure and only track prices. The route to real securities is a digital twin built with licensed partners: an off-chain custodian holds the official record, and the on-chain token is its twin.',
    roadmap: [
      { title: 'Now: synthetic track', text: 'Tokenized assets, advanced features (off by default) and AI agent allowances.' },
      { title: 'Next: licensed partner pilot', text: 'A licensed institution issues twin tokens, with no borrowing to invest, for credentialed wallets only.' },
      { title: 'Later: align with regulatory specs', text: 'Add closed-market price bands, standardized reporting data and on-chain handling of corporate actions.' },
    ],
    notice: 'This platform is not a venue under the SEC exemption and has no regulatory approval. This table only compares gaps and is not a compliance statement. The digital twin column is a plan and has not been built.',
    columns: ['Item', 'Now (synthetic track)', 'Next (digital twin, planned)', 'SEC exemption condition'],
    rows: [
      { item: 'What the token is', now: 'A synthetic token that only tracks price', twin: 'An on-chain representation of the same security held by a custodian', sec: 'Must represent the same security; synthetic exposure is out of scope' },
      { item: 'Holder rights', now: 'No shareholder, creditor or beneficiary rights', twin: 'Provided by the issuer or custodian; mapping dividends and votes on-chain is unresolved', sec: 'Must carry the same rights as traditional shares' },
      { item: 'Borrowing to invest', now: 'Off by default; up to 5x by asset when advanced features are on', twin: 'None', sec: 'No financing or extension of credit' },
      { item: 'Who can invest', now: 'Any connected wallet; KYC passes on submission', twin: 'A verifiable-credential allowlist binding wallets to legal entities', sec: 'Public chain, but permissioned access' },
      { item: 'Closed markets', now: 'While markets are closed, equity holdings can only be reduced, not added to', twin: 'Add closed-market price bands and a pre-open pause', sec: 'Trading halts when the listing exchange halts the stock' },
    ],
    source: 'Source: US SEC Release No. 34-106402 (File No. 4-927, 2026-09-17). This is the team\'s summary; the regulator\'s interpretation governs.',
  },

  copyFlow: {
    heading: 'How copy investing works, in five steps',
    sub: 'No blockchain knowledge needed. Just follow the steps.',
    steps: [
      { title: 'Connect a wallet', text: 'Your wallet is your account. No sign-up.', to: '/portfolio' },
      { title: 'Get USDC', text: 'Claim free USDC on the Exchange page.', to: '/exchange' },
      { title: 'Pick a strategy sharer', text: 'Compare on-chain records in the Strategy Marketplace.', to: '/marketplace' },
      { title: 'Press copy invest', text: 'Choose an amount and confirm once in your wallet.', to: '/marketplace' },
      { title: 'Optional sync', text: 'To follow their updates, turn on auto-sync (off by default).', to: '/portfolio' },
    ],
    detail: [
      'Assets bought through copy investing are in your own name. Only you can stop following, and the strategy sharer cannot touch your funds.',
      'Auto-sync is off by default and is turned on in Expert mode. You set the cooldown, and can turn it off later.',
      'Copy investing costs a 0.3% copy investing fee, and investments that followed a strategy pay a 10% performance fee when sold at a profit. Strategy sharers must place a performance deposit before publishing. If followers lose too much the deposit can be penalised, but that money does not go to followers.',
    ],
  },

  mode: {
    simpleTitle: 'Simple mode: start with these four steps',
    expertTitle: 'Expert mode: you can also do these',
    switchHint: 'Switch between Simple and Expert at the top right.',
    simple: [
      { title: 'Get USDC', text: 'Claim free USDC to invest with.', to: '/exchange' },
      { title: 'Buy some assets', text: 'Use USDC to buy stocks, bonds, gold and crypto.', to: '/tokens' },
      { title: 'Follow a strategy sharer', text: 'Compare on-chain records and pick one for copy investing.', to: '/marketplace' },
      { title: 'Check your results', text: 'Allocation and P&L are in your portfolio.', to: '/portfolio' },
    ],
    expert: [
      { title: 'Advanced investing tools', text: 'Decide yourself whether a price will rise or fall, and set the amount invested.', to: '/terminal' },
      { title: 'AI agent allowances', text: 'Set limits and let an AI buy and sell for you.', to: '/sessions' },
      { title: 'Become a strategy sharer', text: 'Place a performance deposit, publish a strategy, earn a share.', to: '/stake' },
      { title: 'x402 paid signals', text: 'See how an AI pays for its own data.', to: '/x402' },
      { title: 'Risk reserve', text: 'Deposit USDC to share fees and take on risk.', to: '/vault' },
      { title: 'On-chain transparency', text: 'Check reserves, prices and records yourself.', to: '/solvency' },
    ],
  },
};
