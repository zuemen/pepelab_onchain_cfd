/**
 * 鏈上價格的新鮮度：價齡怎麼說，以及擋單時要對使用者說的那句話。
 *
 * 帶標的名稱與不帶標的名稱是**兩個完整的句子**，不是一句話中間插一個「的」。把助詞
 * 單獨放進 catalog 沒辦法翻譯：英文要寫成 "of sBTC" 或 "sBTC's"，而且位置跟中文不同。
 */
export const freshness = {
  unknownAge: '更新時間不明',

  /** 價格來源的短標籤（顯示在價格旁）。'none' = 兩個來源都讀不到，畫面顯示「—」。 */
  priceSource: {
    coingecko: 'CoinGecko',
    oracle: '鏈上價格來源',
    none: '無價格',
  },

  age: {
    seconds: '{n} 秒前',
    minutes: '{n} 分鐘前',
    hours: '{n} 小時前',
    days: '{n} 天前',
  },

  notice: {
    unknownWithAsset:
      '⛔ 無法確認{asset} 的鏈上價格的更新時間（{age}）。確認之前先不送出，避免被鏈上拒絕（StalePrice）卻白付手續費。',
    unknownNoAsset:
      '⛔ 無法確認鏈上價格的更新時間（{age}）。確認之前先不送出，避免被鏈上拒絕（StalePrice）卻白付手續費。',
    staleWithAsset:
      '⛔ {asset} 的鏈上價格已經太久沒更新（最後更新：{age}）。此時買進或賣出都會被鏈上拒絕（StalePrice），請等價格更新後再試。',
    staleNoAsset:
      '⛔ 鏈上價格已經太久沒更新（最後更新：{age}）。此時買進或賣出都會被鏈上拒絕（StalePrice），請等價格更新後再試。',
  },
};
