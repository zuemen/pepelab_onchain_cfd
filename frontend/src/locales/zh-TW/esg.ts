/**
 * ESG Asset Explorer。
 *
 * 三份資料表都是顯示字串，所以整份搬進來：七級評級的名稱與說明、三個維度的
 * 檢查項目、每個標的一句話的評分理由。評級代號本身（AAA…CCC）留在元件裡，
 * 它是分級代號而不是文字，和代幣代號同一類。
 */
export const esg = {
  title: '🌱 ESG 資產瀏覽器',
  subtitle: '環境 · 社會 · 治理 — 11 項合成資產，鏈上登記',

  connectWallet: '連接錢包以從鏈上 ESGRegistry 載入即時 ESG 評分。',
  wrongNetwork: 'ESGRegistry 僅部署於 Ethereum Sepolia。請連接 Ethereum Sepolia 以查看即時鏈上評分。',
  loadFailed: 'ESG 資料載入失敗，請重新整理頁面。',

  methodology: {
    title: 'A · ESG 評分方法論',
    ratingTable: '七級評級對照表',
  },

  /** 三個維度的名稱，以及各自的檢查項目。 */
  dimension: {
    environmental: '環境',
    environmentalItems: [
      '碳足跡與能源結構',
      '實體氣候風險',
      '土地／水資源使用影響',
      '廢棄物與排放管理',
    ],

    social: '社會',
    socialItems: [
      '勞工實務與工作場所安全',
      '社區與利害關係人影響',
      '資料隱私與安全',
      '供應鏈責任',
    ],

    governance: '治理',
    governanceItems: [
      '董事會獨立性與多元性',
      '高階經理人課責',
      '揭露與透明度',
      '股東權益保障',
    ],
  },

  /** 七級評級。代號留在元件裡，這裡是它的名稱與一句話說明。 */
  rating: {
    aaa: 'ESG 冠軍',
    aaaDesc: '三大構面表現皆屬頂尖',
    aa: 'ESG 領導者',
    aaDesc: 'E、S、G 三構面表現強勁且穩定',
    a: 'ESG 關注者',
    aDesc: '高於平均水準；某一構面仍有改善空間',
    bbb: '尚可',
    bbbDesc: '符合基本標準；仍有明顯落差',
    bb: '發展中',
    bbDesc: '低於平均水準；已展開改善行動',
    b: '未達標準',
    bDesc: 'ESG 風險顯著，尚未妥善管理',
    ccc: '高風險',
    cccDesc: 'ESG 疑慮重大，緩解證據有限',

    /** 門檻那一格：有下限就寫下限，最後一級寫上限。 */
    atLeast: '≥ {min}',
    below30: '< 30',
  },

  ranking: {
    title: 'B · 11 資產 ESG 排行（composite 由高到低）',
    rank: '#{n}',
    outOf: '/ 100',
  },

  radar: {
    title: 'C · E/S/G 雷達圖',
    noData: '尚無資料 — 請在 Ethereum Sepolia 連接錢包',
    composite: '綜合分數',
    hint: '點擊左側任一資產卡片即可更新雷達圖',
  },

  /** 每個標的一句話的評分理由。 */
  rationale: {
    sBTC: '工作量證明的高耗能特性主導了整體評分，儘管治理模式本身無需許可且高度去中心化。',
    sETH: 'PoS 合併（Merge）將能源消耗降低 99.95%；透明的鏈上治理與包容的開發者文化提升了各個構面的表現。',
    sAAPL: '供應鏈碳中和承諾與強健的董事會獨立性；製造端的輕微勞工疑慮限制了 S 構面的評分。',
    sTSLA: '電動車使命讓 E 構面高於產業平均；執行長治理爭議與勞資關係事件則拖累了 S 與 G 構面。',
    sGOLD: '採礦活動對土地造成顯著破壞並產生大量 CO₂；各生產商採用負責任採礦標準的程度並不一致。',
    sBOND: '追蹤 iShares USD Green Bond ETF：持股全為依 Green Bond Principles 篩選、募資專款投入環境專案的投資等級綠色債券，發行人層級 ESG 資料可取得。',
    sNVDA: '資料中心 GPU 的用電需求偏高，但 AI 能效發展藍圖有所抵銷；半導體產業的治理標準高於平均水準。',
    sMSFT: '碳負排放承諾、100% 再生能源目標，以及穩健的董事會治理，共同創造接近冠軍等級的 ESG 表現。',
    sGOOGL: '全球最大的企業再生能源採購者（E↑）；反壟斷調查與資料隱私爭議則對 S 與 G 構面帶來一定程度的限制。',
    sICLN: '追蹤全球潔淨能源生產商；E 構面評分近乎滿分；土地使用與電網穩定性考量則帶來較為細緻的社會面風險。',
    sESGU: '廣泛的 MSCI USA ESG 篩選指數在三大構面皆有頂尖四分位表現，並具備強勁的產業分散度。',
  },
};
