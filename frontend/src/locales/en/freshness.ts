import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/freshness.ts`。
 */
export const freshness: Catalog['freshness'] = {
  unknownAge: 'Age unknown',

  /** 模擬報價沒有鏈上年齡可言，所以給的是「這不是真價格」而不是一個時間。 */
  mockLabel: 'Mock price',

  age: {
    seconds: '{n}s ago',
    minutes: '{n}m ago',
    hours: '{n}h ago',
    days: '{n}d ago',
  },

  notice: {
    unknownWithAsset:
      "⛔ Can't confirm when {asset}'s on-chain index price last updated ({age}). Not sending the order until we know, to avoid paying gas only to be rejected on-chain with StalePrice.",
    unknownNoAsset:
      "⛔ Can't confirm when the on-chain index price last updated ({age}). Not sending the order until we know, to avoid paying gas only to be rejected on-chain with StalePrice.",
    staleWithAsset:
      "⛔ {asset}'s on-chain index price is older than the contract's maxPriceAge (last updated {age}). Opening or closing a position right now would be reverted with StalePrice — please wait for the keeper to update it and try again.",
    staleNoAsset:
      "⛔ The on-chain index price is older than the contract's maxPriceAge (last updated {age}). Opening or closing a position right now would be reverted with StalePrice — please wait for the keeper to update it and try again.",
  },
};
