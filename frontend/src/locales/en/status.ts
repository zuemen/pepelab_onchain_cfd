import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/status.ts`。
 */
export const status: Catalog['status'] = {
  market: {
    badge: {
      always: 'Trades 24/7',
      open: 'Market open',
      closed: 'Market closed',
      closedNoStop:
        'Market closed (this testnet deployment has no closed-market order stop; orders fill at the last close)',
      closedActive:
        'Market closed (the closed-market order stop is not active yet; orders fill at the last close)',
      reduceOnly: 'Reduce-only',
      halted: 'Halted',
    },
    short: {
      always: '24/7',
      open: 'Open',
      closed: 'Closed',
      reduceOnly: 'Reduce-only',
      halted: 'Halted',
    },
    hint:
      'Decided by asset class: US stocks and ETFs follow the regular New York session 09:30–16:00 ET (daylight saving included), gold is closed from Friday 17:00 to Sunday 18:00 ET, and crypto trades 24/7. Scheduled hours only; holidays are not included.\n\n"Reduce-only" and "Halted" are the mode the exchange contract currently has for this asset, not a guess.',
    priceAge: 'Last price write',
    priceAgeHint:
      'How long ago the on-chain oracle last wrote this asset’s price, measured against the latest block time (the same clock the contract uses to reject stale prices). It turns red past the contract’s maxPriceAge ({max}); opening and closing are both rejected then.',
    maxAgeHours: '{n} h',
    priceAgeLocalClock: ' (block time unavailable; using this computer’s clock)',
    confirm: {
      title: 'Market closed',
      bodyNoStop:
        '{asset} is closed. This testnet deployment has no closed-market order stop, so this order fills at the last close; the price can gap at the open and your exit may be far from today’s price.',
      bodyActive:
        '{asset} is closed, but the exchange’s closed-market order stop is not active yet, so this order fills at the last close; the price can gap at the open and your exit may be far from today’s price.',
      note: 'This is a reminder only; it does not block the order.',
      proceed: 'Submit anyway',
      cancel: 'Cancel',
    },
  },

  build: {
    network: 'Network',
    version: 'Version',
    builtAt: 'Built',
    localDev: 'local dev',
    unknownChain: 'chainId {id}',
  },
};
