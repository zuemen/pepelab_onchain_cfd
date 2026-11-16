/**
 * History 頁：鏈上事件時間軸。
 *
 * 事件明細（`renderDetails`）的動詞和數字、代號混排成一行。單複數
 * （event/events、position/positions、query/queries）各自寫成完整的句子，
 * 不是拼接 's'——中文沒有單複數之分，兩份文字目前相同。
 */
export const history = {
  title: '活動紀錄',
  subtitle: '你在平台上的每一筆操作，都直接讀自 Base Sepolia 鏈上，可以點連結自己核對。',
  loading: '載入中…',
  /** 部位已顯示、背景還在掃較新的日誌（交易雜湊、入金、手續費等事件）。 */
  scanningLogs: '同步鏈上日誌…',
  refresh: '↺ 重新整理',

  proofNote: {
    intro:
      '所有活動都直接從 Base Sepolia 區塊鏈讀取——沒有後端、沒有伺服器端資料庫，只有不可竄改的帳本。',
    positionsComplete: '投資紀錄完整',
    positionsCompleteRest:
      '——你曾買進的每一筆都是從鏈上程式的儲存讀取，無論多久以前。兌換、投入金額異動、手續費與履約押金則只存在於事件日誌中，RPC 只提供有限區塊範圍內的資料，因此這些內容會隨著此瀏覽器已經看過的範圍逐漸累積。',
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
    asset: '代幣化資產',
    vault: '風險準備金',
    position: '投資',
    margin: '投入金額',
    social: '社交',
    fee: '手續費',
    price: '價格來源',
    stake: '履約押金',
    /** 篩選中且有結果時：Swap (12) */
    countedLabel: '{label} ({count})',
  },

  noWallet: '連接錢包以查看你的活動。',

  empty: {
    title: '尚無活動',
    windowOnly: '最近約 30 分鐘（{blocks} 個區塊）內找不到活動。更早的活動可以往下載入較舊的區塊。',
    windowFiltered: '最近約 30 分鐘（{blocks} 個區塊）內找不到符合篩選「{filter}」的活動。更早的活動可以往下載入較舊的區塊。',
  },

  column: {
    time: '時間',
    type: '類型',
    user: '使用者',
    details: '詳情',
    block: '區塊',
    tx: '鏈上紀錄',
  },

  eventType: {
    swap: '兌換',
    /** 舊版 MockSwapRouter 的兌換事件（已由 PepeAMM 取代）。 */
    swapLegacy: '兌換（舊版）',
    ammSwap: '兌換（AMM）',
    mint: '鑄造',
    redeem: '贖回',
    vaultDeposit: '風險準備金存入',
    vaultWithdraw: '風險準備金提領',
    opened: '新增投資',
    closed: '結束投資',
    deposit: '存入',
    withdraw: '提領',
    follow: '跟隨',
    unfollow: '停止跟隨',
    copyFee: '跟著投資的分潤費',
    priceUpdated: '價格更新 ↺',
    stake: '履約押金',
    slash: '扣罰',
  },

  /** 舊版兌換（MockSwapRouter）類型標籤的說明。 */
  legacySwapTooltip: '舊版 MockSwapRouter 的兌換紀錄（該路由已由 PepeAMM 取代，保留以供查閱）。',
  storageTooltip:
    '這一列讀自鏈上程式的儲存（永久保存），但儲存不記錄是哪一筆鏈上紀錄寫入的；日誌裡找到對應的紀錄後，這裡會換成紀錄編號與 BaseScan 連結。也可以到 BaseScan 上自己核對。',
  storageLabel: '鏈上程式儲存',

  loadOlder: {
    scanning: '正在掃描較舊的區塊…',
    cta: '↓ 載入較舊資料（區塊 {from}–{to}）',
    /** 還沒有任何確定讀到的區塊時（例如首次讀取最新一段就失敗）。 */
    ctaStart: '↻ 開始讀取日誌（區塊 {from}–{to}）',
  },

  footer: {
    eventOne: '已顯示 {count} 筆事件',
    eventMany: '已顯示 {count} 筆事件',
    positionsFull: '投資紀錄完整讀取自鏈上程式儲存',
    scannedBackTo: '· 日誌已掃描回溯至區塊 #{block}',
    cacheNote:
      '· 日誌紀錄僅快取於此瀏覽器；清除網站資料會重置快取，但鏈上資料永久保留。',
  },

  /** 掃描不完整時的說明——缺口不該被誤讀成「沒有資料」。 */
  scanIssue: {
    failedChunkOne: '{count} 個區塊範圍查詢失敗（事件日誌——兌換、鑄造／贖回、投入金額、風險準備金、手續費與履約押金——可能不完整）',
    failedChunkMany: '{count} 個區塊範圍查詢失敗（事件日誌——兌換、鑄造／贖回、投入金額、風險準備金、手續費與履約押金——可能不完整）',
    positionIndexUnreadable: '無法讀取投資索引——下方投資紀錄可能有缺漏',
    missedPositionOne: '{count} 筆投資無法讀取',
    missedPositionMany: '{count} 筆投資無法讀取',
    refreshToRetry: '{notes}。重新整理以再試一次。',
  },

  /** 掃描失敗時取代空狀態——失敗絕不能顯示成「沒有資料」。 */
  readFailed: {
    title: '讀取失敗',
    description:
      '鏈上事件讀取失敗或不完整，這裡的空白不代表沒有活動。請按「重新整理」重試。',
  },
  fetchFailed: '事件讀取失敗',
  /** 節點太久沒回應（逾時）：loading 已結束，按重新整理再試。 */
  timeoutRetry: '讀取失敗（節點逾時），可按「重新整理」重試。',
  fetchOlderFailed: '較舊事件讀取失敗',

  /** 每一種事件明細的敘述。 */
  detail: {
    marginLabel: '投入金額：',
    pnlLabel: '損益：',
    receivedSuffix: ' | 已收到：{amount}',
    following: '跟隨',
    unfollowed: '停止跟隨',
    earned: '已賺取：',
    feeSuffix: '（手續費：{fee}）',
    staked: '存入履約押金',
    slashed: '已扣罰',
    /** 開倉明細行首的方向色塊。 */
    sideLong: '看漲',
    sideShort: '看跌',
    mint: '鑄造 {amount} {asset}，支付 {usdc} USDC（手續費 {fee} USDC）',
    redeem: '贖回 {amount} {asset}，取回 {usdc} USDC（手續費 {fee} USDC）',
    vaultDeposit: '存入 {usdc} USDC，取得 {shares} 份額',
    vaultWithdraw: '贖回 {shares} 份額，取回 {usdc} USDC',
  },
};
