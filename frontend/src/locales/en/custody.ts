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
      key: "The contracts are currently managed by a single operator key. It can pause the service (you cannot redeem while paused), change parameters, upgrade the vault's code, and authorise tokens to be burned.",
      price: "Prices are written by the operator's own software, not by a decentralised price source.",
      trust: 'So holding your own assets does not mean you need no trust in the operator at all. These powers are written into the contracts, where anyone can look them up.',
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
      'Self-custody only: the platform has no custodial accounts and never holds your private keys. You can verify every point below against the contracts yourself.',
    facts: {
      margin: 'Margin sits in the exchange contract, recorded under your address, and only you can withdraw it.',
      trading:
        'Only you, or an authorised agent contract acting for you, can open or close your positions; an agent session has a spending cap and you can revoke it at any time.',
      copy: 'Positions opened by copy trading are in your own name. The trader cannot move your margin and only earns the copy fee and profit share the contract sets; only you can stop copying.',
      liquidation: 'There are two exceptions. When margin runs short, anyone can liquidate your position under the rules in the contract; and if the operator switches on auto-deleveraging (ADL), a profitable position can be force-closed with part of its profit taken.',
      spot: 'Tokens you buy sit in your own wallet. The vault is under-collateralised synthetic exposure: if it is short of USDC, redemptions fail.',
      keys: 'The platform does not hold your private keys.',
    },
    operatorHeading: 'What the operator can still do',
    operator: {
      key: 'The contract owner is currently a single key, with no multisig and no timelock. The owner and an emergency pause key (the guardian) can both pause the exchange — no closing positions and no withdrawals while paused — and the vault’s administrator can pause the vault, which stops redemptions.',
      markets: 'The owner can freeze a single market (not even closing is possible while it is frozen), switch on auto-deleveraging, change parameters such as fees and leverage caps, and decide which agent contracts may trade on users’ behalf.',
      vault: 'The vault’s administrator can upgrade the tokenized-asset vault’s code, and can authorise the burning of any holder’s tokens.',
      price: 'Prices are written by a trusted keeper, not a decentralised oracle.',
      trust: 'So self-custody still means trusting the operator with these powers. They are written into the contracts, where anyone can look them up.',
    },
    whyHeading: 'Why there are no custodial accounts',
    why: 'Custody means the operator can move your funds, and all you can do is trust its books. Self-custody keeps every unit of margin and every position visible on-chain — a design choice, not a missing feature.',
    differenceHeading: 'How copy trading here differs from eToro',
    difference: {
      snapshot:
        "Copying takes a snapshot of the trader's current strategy version and opens positions once. If the trader changes strategy later, your positions do not change (Portfolio marks this as \"Strategy updated\").",
      stopLoss:
        'There is no automatic stop-loss. You can set a stop-loss reminder in Portfolio, but it never closes anything — when it triggers, you stop copying yourself.',
      reason:
        'Continuous copying and automatic stop-losses would both need contract changes, or the operator placing orders for you. Both conflict with self-custody, so neither is offered.',
    },
  },
};
