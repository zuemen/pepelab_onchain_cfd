/**
 * /legacy 頁（舊版交易合約資產取回）與 Portfolio 上的入口提示。
 *
 * 用的是交易端的詞（保證金、平倉）而不是 Simple Mode 的說法：這一頁處理的就是舊的
 * 永續合約本身，使用者要拿著這些詞與合約位址去找客服，換成別的說法反而對不上。
 *
 * 不提跟單：績效費那一條的成因雖然是跟單部位，但對使用者而言只需要知道「平倉時要付
 * 一筆費用、而收費的合約已不再接受舊合約」，見 copyWording.test.ts。
 */
export const legacy = {
  title: '舊版鏈上程式資產',
  subtitle:
    '平台曾數次重新部署投資用的鏈上程式。舊版程式仍保存你當時的投入金額與還沒賣出的投資，這一頁只讀取平台公布的舊版程式位址，幫你確認並取回。',
  connectPrompt: '連接錢包後，才能查詢你在舊版鏈上程式上的資產。',
  demoWallet: '訪客模式沒有鏈上資料，請連接錢包。',
  loading: '正在讀取舊版鏈上程式…',
  refresh: '重新整理',
  noneOnChain: '{chain} 上沒有任何舊版鏈上程式。',
  noneFound: '你在 {chain} 的舊版鏈上程式上沒有投入金額或還沒賣出的投資，不需要任何動作。',
  readFailed: '讀取 {address} 失敗，請稍後重新整理。',
  unsupported: '{address} 缺少查詢資產所需的函式，無法在此頁確認你的資產。',
  backToPortfolio: '回到投資組合',

  card: {
    period: '使用期間 {from} – {until}',
    contract: '鏈上程式位址',
    freeMargin: '可提領的投入金額',
    contractBalance: '程式內 USDC 餘額',
    openPositions: '還沒賣出的投資',
    noPositions: '這個舊版程式上沒有你還沒賣出的投資。',
    truncated: '你在這個舊版程式上的投資紀錄超過 {max} 筆，此處只檢查了最新的 {max} 筆，可能還有更多投資未列出，請聯絡客服確認。',
  },

  withdraw: {
    button: '提領 {amount} {token}',
    working: '提領中…',
    done: '已從舊版鏈上程式提領投入金額',
    partial: '程式內餘額不足以全額提領：目前最多可提領 {amount}，其餘 {shortfall} 需要營運方處理。',
  },

  close: {
    button: '賣出',
    working: '賣出中…',
    done: '舊版程式上的投資已賣出',
    afterClose: '賣出後的結算金額會回到這個舊版程式的可提領金額，之後再按一次提領即可轉回錢包。',
  },

  column: {
    id: '編號',
    asset: '標的',
    side: '方向',
    margin: '投入金額',
    leverage: '放大比例',
    entryPrice: '買進價',
    oracleAge: '價格來源最後更新',
    action: '操作',
  },
  side: {
    long: '看漲',
    short: '看跌',
  },

  staleWarning: '這個舊版程式不檢查價格時效：價格來源最後更新於 {age}，賣出將以該價格結算。',

  /** 預檢失敗的原因。按鈕不會送出交易，這段文字就是使用者看到的全部說明。 */
  block: {
    notSent: '已攔下，沒有送出：這筆操作送出必定失敗。',
    stalePrice: '價格來源的報價已過期（最後更新於 {age}），舊版程式會拒絕賣出。報價恢復更新後即可重試。',
    stalePriceAbandoned: '價格來源已很久沒有更新此資產（最後更新於 {age}），看來已停止更新，需要營運方處理。',
    oracleInvalid: '價格來源回傳無效的價格，舊版程式會拒絕賣出，需要營運方處理。',
    feeRouterRevoked:
      '這筆投資賣出時要支付一筆績效費，但收費程式已改為只接受新版程式，送出必定失敗。需要營運方調整舊版程式的設定後才能賣出。',
    vaultRevoked: '舊版程式對風險準備金的授權已轉移到新版程式，這筆操作必定失敗，需要營運方處理。',
    exchangeUnderfunded: '舊版程式的 USDC 餘額不足以支付這筆金額，需要營運方處理。',
    insufficientFreeMargin: '可提領的投入金額已經變動，請重新整理後再試。',
    notOwner: '這筆投資不屬於目前連接的錢包。',
    alreadyClosed: '這筆投資已經賣出，請重新整理。',
    paused: '舊版程式目前暫停中，需要營運方處理。',
    unsupported: '這個舊版程式沒有這項操作的函式，無法在此頁處理，需要營運方協助。',
    unknown: '預檢失敗（{code}），送出必定失敗，所以沒有送出。需要營運方協助判斷。',
  },

  contact: {
    title: '需要營運方協助',
    body: '上面標示「需要營運方處理」的項目，無法由你自行在鏈上取回。聯絡時請附上下列資訊：',
    email: '客服信箱：',
    url: '客服頁面',
    none: '此平台尚未設定客服聯絡方式，請透過你取得本服務的管道聯絡營運方，並附上下列資訊。',
    detailsWallet: '錢包位址',
    detailsContract: '舊版鏈上程式',
    detailsPositions: '投資編號',
    copy: '複製',
    copied: '已複製',
  },

  banner: {
    title: '你在舊版鏈上程式上還有資產',
    body: '{count} 個已停用的舊版鏈上程式上仍有你的投入金額或還沒賣出的投資，新頁面不會顯示它們。',
    cta: '查看並取回',
    readFailedHint: '舊版鏈上程式的資料暫時讀不到，可稍後再查看。',
    readFailedLink: '舊版鏈上程式資產',
  },
};
