/**
 * History 頁：鏈上事件時間軸。
 *
 * 事件明細（`renderDetails`）的動詞和數字、代號混排成一行。單複數
 * （event/events、position/positions、query/queries）各自寫成完整的句子，
 * 不是拼接 's'——中文沒有單複數之分，兩份文字目前相同。
 */
export const history = {
  title: '交易歷史',
  subtitle: '鏈上可稽核性——直接透過 ethers.js 從 Base Sepolia 解碼',
  loading: '載入中…',
  refresh: '↺ 重新整理',

  proofNote: {
    intro:
      '所有活動都直接從 Base Sepolia 區塊鏈讀取——沒有後端、沒有伺服器端資料庫，只有不可竄改的帳本。',
    positionsComplete: '部位資料完整',
    positionsCompleteRest:
      '——你曾開過的每一筆都是從合約儲存讀取，無論多久以前。兌換、保證金異動、手續費與質押則只存在於事件日誌中，RPC 只提供有限區塊範圍內的資料，因此這些內容會隨著此瀏覽器已經看過的範圍逐漸累積。',
    clickToVerify: '點擊',
    clickToVerifyRest: '即可在 BaseScan 上驗證該筆紀錄。',
  },

  tab: {
    mine: '我的活動',
    mineDisconnected: '我的活動（請連接錢包）',
    all: '全部活動',
  },

  filter: {
    all: '全部',
    swap: '兌換',
    position: '部位',
    margin: '保證金',
    social: '社交',
    fee: '手續費',
    price: '預言機',
    stake: '質押',
    /** 篩選中且有結果時：Swap (12) */
    countedLabel: '{label} ({count})',
  },

  noWallet: '連接錢包以查看你的活動。',

  empty: {
    title: '尚無活動',
    windowOnly: '過去 {blocks} 個區塊內找不到事件。',
    windowFiltered: '過去 {blocks} 個區塊內找不到符合篩選「{filter}」的事件。',
  },

  column: {
    time: '時間',
    type: '類型',
    user: '使用者',
    details: '詳情',
    block: '區塊',
    tx: '交易',
  },

  eventType: {
    swap: '兌換',
    opened: '開倉',
    closed: '平倉',
    deposit: '存入',
    withdraw: '提領',
    follow: '跟隨',
    unfollow: '取消跟隨',
    copyFee: '跟單費',
    priceUpdated: '價格更新 ↺',
    stake: '質押',
    slash: '罰沒',
  },

  storageTooltip:
    '從合約儲存讀取——永久保存，但不對應單一交易。可用 getPosition() 在 BaseScan 上驗證。',
  storageLabel: '儲存',

  loadOlder: {
    scanning: '正在掃描較舊的區塊…',
    cta: '↓ 載入較舊資料（區塊 {from}–{to}）',
  },

  footer: {
    eventOne: '已顯示 {count} 筆事件',
    eventMany: '已顯示 {count} 筆事件',
    positionsFull: '部位資料完整讀取自合約儲存',
    scannedBackTo: '· 日誌已掃描回溯至區塊 #{block}',
    cacheNote:
      '· 日誌紀錄僅快取於此瀏覽器；清除網站資料會重置快取，但鏈上資料永久保留。',
  },

  /** 掃描不完整時的說明——缺口不該被誤讀成「沒有資料」。 */
  scanIssue: {
    failedChunkOne: '{count} 個區塊範圍查詢失敗（兌換、保證金、手續費與質押資料可能不完整）',
    failedChunkMany: '{count} 個區塊範圍查詢失敗（兌換、保證金、手續費與質押資料可能不完整）',
    positionIndexUnreadable: '無法讀取部位索引——下方部位資料可能有缺漏',
    missedPositionOne: '{count} 筆部位無法讀取',
    missedPositionMany: '{count} 筆部位無法讀取',
    refreshToRetry: '{notes}。重新整理以再試一次。',
  },

  fetchFailed: '事件讀取失敗',
  fetchOlderFailed: '較舊事件讀取失敗',

  /** 每一種事件明細的敘述。 */
  detail: {
    marginLabel: '保證金：',
    pnlLabel: 'PnL：',
    receivedSuffix: ' | 已收到：{amount}',
    following: '跟隨',
    unfollowed: '取消跟隨',
    earned: '已賺取：',
    feeSuffix: '（手續費：{fee}）',
    staked: '已質押',
    /** 開倉明細行首的方向色塊。 */
    sideLong: '做多',
    sideShort: '做空',
  },
};
