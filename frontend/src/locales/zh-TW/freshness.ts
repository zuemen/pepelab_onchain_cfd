/**
 * 鏈上價格的新鮮度：價齡怎麼說，以及擋單時要對使用者說的那句話。
 *
 * 帶標的名稱與不帶標的名稱是**兩個完整的句子**，不是一句話中間插一個「的」。把助詞
 * 單獨放進 catalog 沒辦法翻譯：英文要寫成 "of sBTC" 或 "sBTC's"，而且位置跟中文不同。
 */
export const freshness = {
  unknownAge: '年齡未知',

  /** 模擬報價沒有鏈上年齡可言，所以給的是「這不是真價格」而不是一個時間。 */
  mockLabel: '模擬價格',

  age: {
    seconds: '{n} 秒前',
    minutes: '{n} 分鐘前',
    hours: '{n} 小時前',
    days: '{n} 天前',
  },

  notice: {
    unknownWithAsset:
      '⛔ 無法確認{asset} 的鏈上指數價的更新時間（{age}）。在確認之前不送單，避免鏈上以 StalePrice 拒絕後白付 gas。',
    unknownNoAsset:
      '⛔ 無法確認鏈上指數價的更新時間（{age}）。在確認之前不送單，避免鏈上以 StalePrice 拒絕後白付 gas。',
    staleWithAsset:
      '⛔ {asset} 的鏈上指數價已超過合約的 maxPriceAge（最後更新：{age}）。此時開倉／平倉都會被 StalePrice revert，請等 keeper 更新後再試。',
    staleNoAsset:
      '⛔ 鏈上指數價已超過合約的 maxPriceAge（最後更新：{age}）。此時開倉／平倉都會被 StalePrice revert，請等 keeper 更新後再試。',
  },
};
