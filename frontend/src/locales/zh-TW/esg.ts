/**
 * ESG 資訊頁。
 *
 * #383：平台不再自評 E／S／G 分數，這頁只轉述第三方評級（thirdParty），並把碳分級
 * 明白標成平台的風險政策。
 */
export const esg = {
  /**
   * #152：見證碳等級。跟第三方 ESG 評級**刻意不合併**——前者是評級機構對
   * 「整體永續表現」的判斷,這個講「鏈上見證到的定價依據」,資料來源與用途都不同。
   *
   * chip 層級的字全部住在這裡,/tokens 的詳情面板也讀這一組。同一句話在兩個
   * catalog 各寫一份,遲早會漂成兩種講法。
   */
  attested: {
    title: '見證碳等級',
    lead: '等級本身就是被見證的事實，由見證者連同判定依據一起記錄在鏈上，不是讀取時從碳強度換算出來的。金庫的鑄造費率用的就是這個等級。',
    vsOld:
      '上方的第三方評級是評級機構對整體永續表現的判斷；這一區講的是鏈上見證的定價依據，是平台的風險政策。兩者資料來源不同、用途也不同，所以分開呈現，不合併成單一分數。',
    column: {
      asset: '資產',
      tier: '見證等級',
    },
    countUnit: '{count} 筆見證',
    noAttestations: '尚無有效見證',
    agree: '見證一致',
    apart: '見證相差 {n} 級',
    unrated: '未評等',
    failed: '讀取見證失敗，暫時無法確認。這不代表「未評等」。',
    loading: '讀取見證中…',
  },

  /**
   * #105：碳權退役（ADR-022）。退役的是本平台自行鑄造的**模擬碳權**——issue #105 要求這件事
   * 必須寫在畫面上，所以聲明不可收合、不可關閉，也不看合約讀數決定顯不顯示。
   * 沒有設定退役合約位址時整個區塊不渲染（不說「尚未部署」，見 CONTEXT.md 的 The Vault）。
   */
  retirement: {
    title: '碳權退役紀錄',
    lead: '平台份額的手續費中，有合約寫死的固定比例自動撥入退役合約，用來買入碳權並在同一筆交易裡銷毀。每一次退役都是鏈上可查、不可逆的紀錄。',
    simulatedChip: '模擬碳權',
    disclaimerTitle: '模擬碳權：這裡沒有真實的減碳',
    disclaimer:
      '這裡退役的是本平台在測試網自行鑄造的模擬碳權（mtCO2e），不是任何碳權登錄機構核發的碳權，不對應任何真實的減碳或移除量，銷毀它不抵銷任何真實的溫室氣體排放。買入款項付給本平台控制的模擬賣方地址，沒有流向任何真實的碳權專案。真實的只有機制：手續費依合約寫死的比例撥入，退役在鏈上不可逆。',
    totalTonnes: '累計退役（模擬）',
    tonnesUnit: '{n} 公噸 CO₂e',
    totalSpent: '累計買入金額',
    budget: '待退役預算',
    count: '退役次數',
    recentTitle: '最近的退役',
    column: {
      time: '時間',
      tonnes: '數量（模擬）',
      amount: '金額',
      tx: '鏈上交易',
    },
    empty: '還沒有任何退役紀錄。',
    failed: '讀取退役紀錄失敗，暫時無法確認。這不代表「沒有退役」。',
    loading: '讀取退役紀錄中…',
    /** #333：受益人規則——同一噸只能被一方宣稱。 */
    beneficiaryTitle: '退役的受益人是平台',
    beneficiary:
      '同一噸只能被一方宣稱。這裡的退役噸數歸屬平台，不是任何使用者個人的減碳：你的交易促成了退役，但這些噸數不能算成你自己的排放減少。',
    fundingTitle: '錢從哪裡來',
    funding:
      '平台收到的手續費分潤中，平台的 {platform}% 份額裡有 {carbon}% 自動撥入退役預算，相當於這筆手續費的 {total}%。比例寫死在合約裡（immutable），平台不能調整；要改只能重新部署，而部署本身在鏈上看得到。分配與退役任何人都能觸發，觸發的人只決定何時，錢去哪裡由合約決定。',
    /** 只在跟單旗標開啟時渲染（copyWording.test.ts 的白名單）。 */
    fundingCopy:
      '經過這條路的收入是跟單手續費（跟單金額的 0.3%）與跟單部位獲利的績效費；一般交易的手續費不經過它。退役用的是平台自己的收入，使用者不會因此多付任何費用。',
    viewTx: '查看交易',
    shownOf: '顯示最近 {shown} 筆，共 {count} 筆',
    more: '顯示更早的紀錄',
  },

  /** #333：交易者頁與投資組合的「碳分級組成」卡片（CarbonTierMixCard）。 */
  impact: {
    tierTitle: '碳分級組成',
    tierLead: '持倉有多少比例落在各碳分級。不同資產的碳強度單位不同，不能加總成一個噸數，所以這裡只比較分級。',
    /** 低／中／高／未評等沿用 tokens.provenance.carbonTier（同一套等級）；這裡只有讀取失敗的那一格。 */
    tierUnknown: '未知（讀取失敗）',
    tierSource: '分級讀自交易所定價用的鏈上見證；讀不到的資產列為未知，不算成低碳。',
    traderSource: '依這位交易者目前發布的策略權重計算，策略讀自鏈上。',
    portfolioSource: '依你目前部位的市值計算。',
    empty: '沒有持倉，無法計算。',
    pct: '{pct}%',
  },

  title: 'ESG 資訊',
  lead: '平台不替資產評分。下面是各家評級機構自己公布的結果，每一筆都附來源、評級日與查詢日；點任一列看這檔資產的細節。',

  /**
   * #383：第三方評級。評級本身（AAA、61、B）是評級機構的代號或分數，留在資料檔
   * （lib/pepefi/esgRatingsData.ts），這裡只放講解它們的字。
   */
  thirdParty: {
    /** 條款：S&P、MSCI、Morningstar 寫明未經同意不得轉載，LSEG 要書面同意；團隊在 #383 決定以學術專題身分附出處顯示。 */
    rights:
      '評級的著作權屬於各評級機構。這裡為學術、非商業的專題用途轉述並附上原始頁面；要引用請回原始頁面查最新值。',
    legend: {
      title: '怎麼讀這張表',
      light: '燈號只用評級機構自己定義的分組：MSCI 的領先／中等／落後、Sustainalytics 的五個風險等級、Morningstar 基金的地球數。綠、黃、紅代表那家分組裡較佳、中等、較差的一組。',
      scoreOnly: '只給分數、沒有自己分組的機構（LSEG、S&P Global），只顯示數字、不上色；平台不替它們切門檻。',
      noAverage: '各家方法、尺度、方向都不同（Sustainalytics 越低越好，其他越高越好），所以不加總、不平均，也不依評級排名。',
    },
    column: {
      asset: '資產',
      carbonTier: '碳分級',
      carbonTierSub: '平台風險政策',
    },
    light: {
      good: '較佳',
      middle: '中等',
      poor: '較差',
    },
    cell: {
      notPublic: '未公開',
      unrated: '未評等',
      notApplicable: '不適用',
    },
    noRating: '未評等',
    provider: {
      msci: {
        name: 'MSCI',
        scale: 'AAA–CCC。AAA、AA 為領先，A、BBB、BB 為中等，B、CCC 為落後。',
        scope: 'ETF 用的是 MSCI ESG 基金評級，讀自 iShares 產品頁；MSCI 的公司評級只提供付費客戶，所以股票標「未公開」。',
      },
      sustainalytics: {
        name: 'Sustainalytics',
        scale: '股票是 ESG 風險分數，越低越好，分成可忽略、低、中、高、嚴重五級；ETF 是 Morningstar 的地球數（1–5，越多越好），跟同類基金比。',
        scope: 'Morningstar Sustainalytics 的評級，讀自 morningstar.com 的個股與基金頁。',
      },
      lseg: {
        name: 'LSEG',
        scale: '2026 年版 ESG Scores，0–5，越高越好；另有環境、社會、治理三項與 12 個主題的分數。',
        scope: '只評公司，依公司自行揭露的年度資料；讀自 LSEG 官網的 ESG Scores Finder。',
      },
      spGlobal: {
        name: 'S&P Global',
        scale: '0–100，越高越好，只能跟同產業的公司比，不能跨產業比較。',
        scope: '只評公司，不評 ETF 與加密資產。',
      },
      ccdata: {
        name: 'CCData × CCRI',
        scale: 'AA–E，評 40 檔流動性最高的加密資產。',
        scope: '目前查得到的是 2023 年 7 月的第一版，之後的版本查不到原始頁面，所以評級可能已經過時。',
      },
    },
    /** 評級機構自己的分組名稱。 */
    group: {
      msci: { good: '領先', middle: '中等', poor: '落後' },
      sustainalytics: { negligible: '可忽略風險', low: '低風險', medium: '中風險', high: '高風險', severe: '嚴重風險' },
      globes: { g1: '低', g2: '低於平均', g3: '平均', g4: '高於平均', g5: '高' },
      controversy: { c1: '低', c2: '中等', c3: '顯著', c4: '高', c5: '嚴重' },
    },
    /** Sustainalytics 頁面上的議題與爭議領域。 */
    issue: {
      humanCapital: '人力資本',
      businessEthics: '商業倫理',
      dataPrivacy: '資料隱私與資安',
      productGovernance: '產品治理',
      carbonProducts: '碳排（產品與服務）',
    },
    area: {
      customer: '客戶',
      societyCommunity: '社會與社區',
      operations: '營運',
      businessEthics: '商業倫理',
      employee: '員工',
    },
    /** LSEG 的三項與 12 個主題。 */
    pillar: { e: '環境', s: '社會', g: '治理' },
    theme: {
      climateTransition: '氣候轉型',
      energyResourceUse: '能源與資源使用',
      biodiversity: '生物多樣性',
      waterUse: '用水',
      wastePollution: '廢棄物與污染',
      labourRelations: '勞資關係',
      healthSafety: '健康與安全',
      humanRightsCommunity: '人權與社區',
      boardManagement: '董事會與管理',
      shareholderRights: '股東權益',
      conductAntiCorruption: '商業行為與反貪腐',
      taxTransparency: '稅務透明與會計',
    },
    detail: {
      ratedOn: '評級日',
      retrievedOn: '查詢日',
      fiscalYear: '資料年度',
      fiscalYearValue: 'FY{year}（公司自行揭露）',
      source: '原始頁面',
      outOf: '／{max}',
      industry: '產業分類',
      industryRank: '產業排名',
      industryRankValue: '第 {rank} 名，共 {of} 家',
      pillars: '環境、社會、治理（0–5）',
      themes: '12 個主題（0–5）',
      msciQuality: 'ESG 品質分數（0–10）',
      msciPeer: '同類基金百分位',
      msciPeerValue: '{pct}%（共 {count} 檔）',
      msciWaci: '持股加權碳強度（tCO2e／每百萬美元營收）',
      msciItr: '隱含升溫',
      msciCoverage: 'MSCI 涵蓋率',
      controversy: '最高爭議等級（1 低、5 嚴重）',
      controversyAsOf: '爭議評估日',
      controversyAreas: '涉及領域',
      topIssues: '前三大重大 ESG 議題',
      fundRisk: '投資組合的企業 ESG 風險分數（0–50，越低越好）',
      fundRiskValue: '目前 {now}，歷史 {hist}',
      fundCoverage: '有評分的資產占基金規模',
      spCsa: 'CSA 分數（不含模型推估）',
      spUnderReview: 'S&P 標示評分審查中：正在評估一件與這家公司有關的爭議，分數可能調整。',
      spRespondent: '這家公司有回覆 S&P 的永續問卷（CSA）。',
      spPublicInfo: '這家公司沒有回覆 S&P 的永續問卷，分數依公開資訊與模型推估。',
      noRating: '目前沒有任何一家公開了這檔資產的評級。這不代表它被評為差，只是沒有人評。',
      rawTitle: '原始環境數據',
      rawLead: '只列數據和出處，不換算成分數或燈號。',
      carbonTierTitle: '碳分級（平台風險政策）',
      carbonTierNote:
        '碳分級依公開的排放數據套固定門檻，決定這檔資產在交易所的手續費與槓桿上限。它是平台的風險政策，不是 ESG 評級。',
    },
    method: {
      title: '為什麼這樣呈現',
      items: [
        'ESG 評級是專業研究，平台不自己替資產打分數，只轉述評級機構公布的結果。',
        'MSCI 的公司評級目前沒有公開查詢，所以股票的 MSCI 欄是「未公開」；CDP 的條款限定分數只能內部使用，Bloomberg 與 WRDS 是學校的學術授權，都不能放上公開網站。',
        '「未公開」是有評但看不到；「未評等」是沒有評；「不適用」是這家根本不評這類資產。三者意思不同，分開標示。',
      ],
    },
  },
};
