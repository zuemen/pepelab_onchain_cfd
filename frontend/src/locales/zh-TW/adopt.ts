/**
 * #149 / ADR-007：Simple Mode 的配置市集與「採用」流程。
 *
 * 這是無槓桿的現貨商品——整份 catalog 不能出現交易桌的字（槓桿、清算、交易者、
 * 跟單…），`adoptVocabulary.test.ts` 會擋。用字對照 frontend/CONTEXT.md 的
 * Allocation／Allocation Publisher／Adopt 詞條。
 */
export const adopt = {
  title: '配置市集',
  subtitle: '瀏覽配置發布者公開的資產配置，照同樣的比例把現貨代幣買進你自己的錢包。',

  connectWallet: '連接錢包後即可瀏覽配置。',
  notDeployed: '這個網路還沒有啟用現貨代幣，暫時無法採用配置。',
  /** 已部署，但目前這個連線讀不到鏈上資料——跟 notDeployed 是兩種不同原因，不能共用同一句話。 */
  notConnected: '目前連線讀不到鏈上資料，請重新連接錢包後再試。',
  /** 模擬錢包沒有 provider/signer，任何頁面都讀不到鏈上資料——見 CONTEXT.md 的 Mock Wallet 詞條。 */
  mockWallet: '模擬錢包無法讀取鏈上資料，請改用真實錢包來瀏覽與採用配置。',
  loadFailed: '載入配置失敗：',
  refreshAria: '重新整理配置',
  /** 結果訊息裡列資產名稱時的分隔符號。 */
  listSeparator: '、',

  empty: {
    title: '這條鏈上還沒有可採用的配置',
    description: '目前連線到 {chain}。配置發布者公開配置之後會出現在這裡。',
    unknownChain: '未知網路（chainId {chainId}）',
  },
  /** 已發布、但有成分不能用現貨買進（例如該資產在這條鏈上沒有代幣）——不列出，但講清楚有幾個。 */
  hiddenNote: '另有 {count} 個已發布的配置含有無法以現貨買進的成分，未列出。',

  snapshotNote: '採用是照發布者「現在」的比例買進一次。之後發布者調整配置，你的持有不會自動跟著變動。',

  card: {
    noName: '未命名的配置發布者',
    assetCount: '{count} 檔資產',
    adopt: '採用',
    details: '看這位發布者的紀錄',
  },

  dialog: {
    title: '採用「{name}」的配置',
    amountLabel: '投入金額（USDC）',
    balance: '錢包餘額：{amount} USDC',
    colAsset: '資產',
    colWeight: '比例',
    colAmount: '金額',
    colStatus: '狀態',
    badAmount: '請輸入有效的金額。',
    tooSmall: '金額太小，無法分配給每一檔資產。',
    insufficientBalance: '錢包的 USDC 餘額不足。',
    vaultPaused: '金庫目前暫停中，暫時無法買進。',
    mintingHalted: '金庫目前暫停鑄造，暫時無法買進。贖回不受影響。',
    txCount: '接下來錢包會請你確認 {total} 筆交易：1 筆核准 USDC、{legs} 筆買進。',
    confirm: '確認採用',
    running: '採用中…',
    cancel: '取消',
    close: '關閉',
    viewTx: '查看交易',
  },

  status: {
    waiting: '等待中',
    buying: '買進中…',
    bought: '已買進',
    failed: '失敗',
    unavailable: '目前無法買進',
    notStarted: '未送出',
  },

  /** 結果一定逐檔講清楚——部分成功時使用者必須知道自己手上現在有什麼。 */
  outcome: {
    complete: '採用完成——{count} 檔資產都已買進你的錢包。',
    partial:
      '只完成了一部分：已買進 {bought}；{failed} 買進失敗，之後的沒有送出。已買進的代幣在你的錢包裡，可以到資產頁贖回或自行補買。',
    failed: '採用失敗，沒有買進任何資產。',
    blocked: '{symbols} 目前無法買進。為了避免只買到一部分，這次沒有送出任何交易。',
  },
};
