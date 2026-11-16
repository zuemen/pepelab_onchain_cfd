import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/custody.ts`。
 */
export const custody: Catalog['custody'] = {
  heading: 'Where Your Assets Are',

  simple: {
    intro:
      'There is no platform-held account here, and the platform never holds your private keys: your assets stay in your own wallet. You can check every point below on-chain yourself.',
    facts: {
      wallet: 'The tokens you buy sit in your own wallet. Moving them out or redeeming them is your call.',
      redeem: 'Only you can start a redemption, and the USDC goes straight back to your wallet. The vault does not hold one-for-one reserves: if it is short of USDC, a redemption cannot go through until it is topped up.',
      adopt: 'When you adopt an allocation someone published, the tokens are bought into your own wallet too; the publisher never touches your money.',
      keys: 'The platform does not hold your private keys, and there is no account that keeps your assets for you.',
    },
    operatorHeading: 'What the operator can still do',
    operator: {
      key: "The on-chain programs are currently managed by a single operator key. It can pause the service (you cannot redeem while paused), change parameters, upgrade the vault's code, and authorise tokens to be burned.",
      price: "Prices are written by the operator's own software, not by a decentralised price source.",
      trust: 'So holding your own assets does not mean you need no trust in the operator at all. These powers are written into the public on-chain programs, where anyone can look them up.',
    },
    whyHeading: 'Why there is no platform-held account',
    why: 'A platform-held account means the operator can move your money, and all you can do is trust its books. Holding your own assets keeps every movement of your money visible on-chain — a design choice, not a missing feature.',
    differenceHeading: 'How this differs from a typical investing app',
    difference: {
      snapshot: "Adopting an allocation buys the publisher's mix as it stands right now, once. If they change it later, your holdings stay as they are.",
      noAutoSell: 'Nothing is sold for you automatically: whether and when to redeem is always your decision.',
    },
  },

  expert: {
    intro:
      'Self-custody only: the platform has no custodial accounts and never holds your private keys. You can verify every point below on-chain yourself.',
    facts: {
      margin: 'The amount you invest sits in a public on-chain program, recorded under your address, and only you can withdraw it.',
      trading:
        'Only you, or an AI agent you have authorised, can buy or sell for you; an AI agent allowance has a spending cap and you can revoke it at any time.',
      copy: 'Holdings bought through copy investing are in your own name. The strategy sharer cannot move the amount you invested and only earns the follower fee and profit share set by the public automated rules; only you can stop following.',
      liquidation: 'There are two exceptions. When the amount invested can no longer cover a loss, anyone can have the investment settled automatically under the public rules; and if the operator switches on its automatic risk-reduction mechanism (ADL), a profitable investment can be settled automatically with part of its profit taken.',
      spot: 'Tokens you buy sit in your own wallet. The tokens only track prices, and the vault is not fully backed: if it is short of USDC, redemptions fail.',
      keys: 'The platform does not hold your private keys.',
    },
    operatorHeading: 'What the operator can still do',
    operator: {
      key: 'The administrator of the on-chain programs is currently a single key, with no multi-person signing and no delay before changes take effect. The administrator and an emergency pause key can both pause the service — no selling and no withdrawals while paused — and the vault’s administrator can pause the vault, which stops redemptions.',
      markets: 'The administrator can freeze a single asset (not even selling is possible while it is frozen), switch on the automatic risk-reduction mechanism, change parameters such as fees and limits, and decide which agent programs may buy and sell on users’ behalf.',
      vault: 'The vault’s administrator can upgrade the tokenized-asset vault’s code, and can authorise the burning of any holder’s tokens.',
      price: 'Prices are written by a program the operator trusts, not by a decentralised price source.',
      trust: 'So self-custody still means trusting the operator with these powers. They are written into the public on-chain programs, where anyone can look them up.',
    },
    whyHeading: 'Why there are no custodial accounts',
    why: 'Custody means the operator can move your funds, and all you can do is trust its books. Self-custody keeps every amount invested and every holding visible on-chain — a design choice, not a missing feature.',
    differenceHeading: 'How copy investing here differs from eToro',
    difference: {
      snapshot:
        "By default, copy investing takes a snapshot of the strategy sharer's current strategy version and buys once. If the strategy sharer publishes a new version later, your holdings do not change on their own (Portfolio marks this as \"Strategy updated\").",
      autoSync:
        "You can also switch on auto-sync on-chain (this network's copy investing rules must be upgraded first, and the copy investing page tells you whether it is available). Once it is on, anyone can — and can only — bring your holdings in line with the strategy sharer's latest on-chain version. They cannot pick the asset or the amount; the operator never signs for you, and you can switch it off at any time.",
      stopLoss:
        'There is no automatic stop-loss. You can set a stop-loss reminder in Portfolio, but it never sells anything — when it triggers, you stop following yourself.',
      reason:
        'Automatic stop-losses are still not offered: someone would have to sell for you when the price gets there, and when to sell is a judgement call, not a rule the on-chain program can verify — it would mean the operator or some program placing orders for you, which conflicts with self-custody. Auto-sync is different: what your holdings become is fixed by the strategy sharer\'s latest on-chain version, and whoever presses sync has no choice to make.',
    },
  },
};
