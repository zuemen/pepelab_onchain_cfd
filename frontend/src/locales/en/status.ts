import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/status.ts`。
 */
export const status: Catalog['status'] = {
  market: {
    /** Below the market tabs: explains a row of Reduce-only badges, which otherwise looks like the whole site is locked. */
    reduceOnlyHint: 'Sell-only means the market is closed or not taking new purchases: you can still sell what you hold, and buying resumes when the market opens. US stocks and ETFs trade Mon-Fri 09:30-16:00 ET. 🔒 means buying requires passing an eligibility check.',
    badge: {
      always: 'Open 24/7',
      open: 'Market open',
      closed: 'Market closed',
      closedNoStop:
        'Market closed (this site has no closed-market stop; orders fill at the last close)',
      closedActive:
        'Market closed (the closed-market stop is not active yet; orders fill at the last close)',
      reduceOnly: 'Sell-only',
      halted: 'Halted',
    },
    short: {
      always: '24/7',
      open: 'Open',
      closed: 'Closed',
      reduceOnly: 'Sell-only',
      halted: 'Halted',
    },
    hint:
      'Decided by asset class: US stocks and ETFs follow the regular New York session 09:30–16:00 ET (daylight saving included), gold is closed from Friday 17:00 to Sunday 18:00 ET, and crypto is open 24/7. Scheduled hours only; holidays are not included.\n\n"Sell-only" and "Halted" are the setting the on-chain program currently has for this asset, not a guess.',
    priceAge: 'Last price write',
    priceAgeHint:
      'How long ago the on-chain price source last wrote this asset’s price, measured against the latest block time (the same clock the on-chain program uses to reject stale prices). It turns red past the limit ({max}); buying and selling are both rejected by the on-chain program then.',
    maxAgeHours: '{n} h',
    priceAgeLocalClock: ' (block time unavailable; using this computer’s clock)',
    confirm: {
      title: 'Market closed',
      bodyNoStop:
        '{asset} is closed. This site has no closed-market stop, so this order fills at the last close; the price can gap at the open and a later sale may be far from today’s price.',
      bodyActive:
        '{asset} is closed, but the platform’s closed-market stop is not active yet, so this order fills at the last close; the price can gap at the open and a later sale may be far from today’s price.',
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
