import type { AssetMeta } from './assetMeta';

import { t } from 'src/locales';

/**
 * 合成資產的顯示名稱。代號（sETH）是鏈上識別碼，照原樣顯示；名稱走 catalog 的
 * `tokens.assetName`，所以 zh-TW 建置顯示「合成以太幣」而不是 `assetMeta.ts` 裡的英文
 * 原名「Synthetic Ethereum」。catalog 沒有的標的才退回 meta.name。
 */
export function assetDisplayName(meta: Pick<AssetMeta, 'symbol' | 'name'> | undefined): string {
  if (!meta) return '';
  const names = t.tokens.assetName as Record<string, string | undefined>;
  return names[meta.symbol] ?? meta.name;
}

/**
 * K 線右上角的追蹤標的。行情 API（signal-api symbols.ts）回的是資料來源的識別字串：
 * 股票是交易所代號（AAPL），加密貨幣是「ETH Spot」。代號與產品名稱不譯，只把
 * 「Spot」這個說明字換成 catalog 的用字。
 */
export function underlyingLabel(underlying: string): string {
  const spot = /^([A-Z0-9.=-]+) Spot$/.exec(underlying.trim());
  return spot ? t.terminal.chart.underlyingSpot.replace('{ticker}', spot[1]) : underlying;
}
