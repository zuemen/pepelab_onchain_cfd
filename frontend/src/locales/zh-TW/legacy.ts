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
  title: '舊版合約資產',
  subtitle:
    '平台曾數次重新部署交易合約。舊合約仍保存你當時的保證金與未平倉部位，這一頁只讀取平台公布的舊合約位址，幫你確認並取回。',
  connectPrompt: '連接錢包後，才能查詢你在舊合約上的資產。',
  demoWallet: '展示模式沒有鏈上資料，請連接真實錢包。',
  loading: '正在讀取舊合約…',
  refresh: '重新整理',
  noneOnChain: '{chain} 上沒有任何舊版交易合約。',
  noneFound: '你在 {chain} 的舊合約上沒有保證金或未平倉部位，不需要任何動作。',
  readFailed: '讀取 {address} 失敗，請稍後重新整理。',
  unsupported: '{address} 缺少查詢資產所需的函式，無法在此頁確認你的資產。',
  backToPortfolio: '回到投資組合',

  card: {
    period: '使用期間 {from} – {until}',
    contract: '合約位址',
    freeMargin: '可用保證金',
    contractBalance: '合約 USDC 餘額',
    openPositions: '未平倉部位',
    noPositions: '這個合約上沒有你的未平倉部位。',
  },

  withdraw: {
    button: '提領 {amount} {token}',
    working: '提領中…',
    done: '已從舊合約提領保證金',
    partial: '合約餘額不足以全額提領：目前最多可提領 {amount}，其餘 {shortfall} 需要營運方處理。',
  },

  close: {
    button: '平倉',
    working: '平倉中…',
    done: '舊合約部位已平倉',
    afterClose: '平倉後的結算金額會回到這個舊合約的可用保證金，之後再按一次提領即可轉回錢包。',
  },

  column: {
    id: '編號',
    asset: '標的',
    side: '方向',
    margin: '保證金',
    leverage: '槓桿',
    entryPrice: '開倉價',
    oracleAge: '預言機最後更新',
    action: '操作',
  },
  side: {
    long: '多',
    short: '空',
  },

  staleWarning: '這個舊合約不檢查價格時效：預言機報價最後更新於 {age}，平倉將以該價格結算。',

  /** 預檢失敗的原因。按鈕不會送出交易，這段文字就是使用者看到的全部說明。 */
  block: {
    checking: '預檢中…',
    notSent: '已攔下，沒有送出：這筆交易送出必定失敗。',
    stalePrice: '預言機報價已過期（最後更新於 {age}），舊合約會拒絕平倉。報價恢復更新後即可重試。',
    stalePriceAbandoned: '預言機已很久沒有更新此標的（最後更新於 {age}），看來已停止餵價，需要營運方處理。',
    oracleInvalid: '預言機回傳無效的價格，舊合約會拒絕平倉，需要營運方處理。',
    feeRouterRevoked:
      '此部位平倉時要支付一筆績效費，但收費合約已改為只接受新合約，交易必定失敗。需要營運方調整舊合約的設定後才能平倉。',
    vaultRevoked: '舊合約對保險金庫的授權已轉移到新合約，這筆操作必定失敗，需要營運方處理。',
    exchangeUnderfunded: '舊合約的 USDC 餘額不足以支付這筆金額，需要營運方處理。',
    insufficientFreeMargin: '可用保證金已經變動，請重新整理後再試。',
    notOwner: '這筆部位不屬於目前連接的錢包。',
    alreadyClosed: '這筆部位已經平倉，請重新整理。',
    paused: '舊合約目前暫停中，需要營運方處理。',
    unsupported: '這個舊合約沒有這項操作的函式，無法在此頁處理，需要營運方協助。',
    unknown: '預檢失敗（{code}），送出必定失敗，所以沒有送出。需要營運方協助判斷。',
  },

  contact: {
    title: '需要營運方協助',
    body: '上面標示「需要營運方處理」的項目，無法由你自行在鏈上取回。聯絡時請附上下列資訊：',
    email: '客服信箱：',
    url: '客服頁面',
    none: '此平台尚未設定客服聯絡方式，請透過你取得本服務的管道聯絡營運方，並附上下列資訊。',
    detailsWallet: '錢包位址',
    detailsContract: '舊合約',
    detailsPositions: '部位編號',
    copy: '複製',
    copied: '已複製',
  },

  banner: {
    title: '你在舊版交易合約上還有資產',
    body: '{count} 個已停用的舊合約上仍有你的保證金或未平倉部位，新頁面不會顯示它們。',
    cta: '查看並取回',
  },
};
