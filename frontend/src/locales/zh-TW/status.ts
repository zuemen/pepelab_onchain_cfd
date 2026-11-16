/**
 * 「這是什麼版本、價格多新、市場是否休市」：交易頁的市場狀態徽章、下單前的休市確認，
 * 以及頁尾的版本資訊（lib/pepefi/marketStatus.ts、lib/pepefi/buildInfo.ts）。
 *
 * 休市文案要照實說：線上的 exchange 沒有 assetMode 時，休市**不會**停單，下單照樣以
 * 收盤價成交（KNOWN_LIMITATIONS #31）。不能只寫「休市中」讓人以為單會被擋。
 */
export const status = {
  market: {
    /** 交易頁標的列下方：解釋整排「只能減倉」，不然看起來像全站都不能交易。 */
    reduceOnlyHint: '「只能賣出」＝該市場目前休市或暫停新的買進：已有的投資可以賣出，開盤後才能再買進。美股與 ETF 開盤時間是美東週一至週五 09:30–16:00。🔒 代表買進需要通過資格審核。',
    /** 資產標頭的徽章（完整句子）。 */
    badge: {
      always: '24/7 可投資',
      open: '開盤中',
      closed: '休市中',
      closedNoStop: '休市中（此站未啟用休市停單，送出會以收盤價成交）',
      closedActive: '休市中（休市停單尚未生效，送出會以收盤價成交）',
      reduceOnly: '只能賣出',
      halted: '暫停',
    },
    /** 市場列表的短標籤。 */
    short: {
      always: '24/7',
      open: '開盤',
      closed: '休市',
      reduceOnly: '只能賣出',
      halted: '暫停',
    },
    hint:
      '依資產類別判斷：美股／ETF 用美東時間正規時段 09:30–16:00（含夏令時間），黃金在週五 17:00 到週日 18:00（美東）休市，加密資產 24/7。只看排定時段，不含假日。\n\n「只能賣出」「暫停」是鏈上程式對這個資產目前的設定，不是推測。',
    priceAge: '最後寫價',
    priceAgeHint:
      '鏈上價格來源最後一次寫入這個資產價格距今多久，以最新區塊的時間計算（與鏈上程式判斷過期用的是同一個時鐘）。超過上限（{max}）就會變紅：此時買進、賣出都會被鏈上程式拒絕。',
    maxAgeHours: '{n} 小時',
    priceAgeLocalClock: '（鏈上時間讀不到，暫用本機時鐘）',
    confirm: {
      title: '市場休市中',
      bodyNoStop:
        '{asset} 目前休市。此站未啟用休市停單，這筆會以最後收盤價成交；開盤時價格可能跳空，之後賣出的價格可能與現在差很多。',
      bodyActive:
        '{asset} 目前休市，但平台的休市停單尚未生效，這筆會以最後收盤價成交；開盤時價格可能跳空，之後賣出的價格可能與現在差很多。',
      note: '這只是提醒，不會擋下這筆。',
      proceed: '仍要送出',
      cancel: '取消',
    },
  },

  /** 頁尾的版本資訊。只顯示鏈與 build 的 commit／時間，不顯示任何環境變數內容。 */
  build: {
    network: '網路',
    version: '版本',
    builtAt: '建置',
    localDev: '本機開發',
    unknownChain: 'chainId {id}',
  },
};
