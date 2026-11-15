import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/freshness.ts`。
 */
export const freshness: Catalog['freshness'] = {
  unknownAge: 'Update time unknown',

  /** Short price-source tag shown next to a price. 'none' = neither source readable; the UI shows '—'. */
  priceSource: {
    coingecko: 'CoinGecko',
    oracle: 'On-chain price source',
    none: 'No price',
  },

  age: {
    seconds: '{n}s ago',
    minutes: '{n}m ago',
    hours: '{n}h ago',
    days: '{n}d ago',
  },

  notice: {
    unknownWithAsset:
      "⛔ Can't confirm when {asset}'s on-chain price last updated ({age}). Nothing is sent until we know, so you don't pay a network fee only to be rejected on-chain (StalePrice).",
    unknownNoAsset:
      "⛔ Can't confirm when the on-chain price last updated ({age}). Nothing is sent until we know, so you don't pay a network fee only to be rejected on-chain (StalePrice).",
    staleWithAsset:
      "⛔ {asset}'s on-chain price hasn't been updated for too long (last updated {age}). Buying or selling right now would be rejected on-chain (StalePrice) — please wait for the price to update and try again.",
    staleNoAsset:
      "⛔ The on-chain price hasn't been updated for too long (last updated {age}). Buying or selling right now would be rejected on-chain (StalePrice) — please wait for the price to update and try again.",
  },
};
