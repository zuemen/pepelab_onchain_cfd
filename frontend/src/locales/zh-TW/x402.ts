/**
 * x402 Signal API 的說明頁，以及首頁那張 x402 市集卡。
 *
 * #154：說明頁的讀者是不懂 HTTP 402、EIP-3009、facilitator 的一般使用者，所以前半
 * （lead → benefits → how → products → tryBuy → start → faq）一律用白話；
 * 術語與參數只出現在 `advanced`，那一區預設收合。
 *
 * 端點路徑、合約位址、`curl` 與 `npx` 範例（含範例裡的註解）不進 catalog：那一整塊
 * 是要被逐字複製貼上的程式碼，翻譯它只會讓人貼出跑不動的指令。
 */
export const x402 = {
  docs: {
    title: 'x402：讓 AI 助理自己付費買交易資料',
    testnetChip: '測試網 · 不花真錢',
    lead: '你的 AI 交易助理需要資料時，不用註冊帳號、也不用訂閱月費——它要一筆，就用自己的錢包付一筆小錢（一次 $0.01 起），當場拿到資料。',

    benefits: {
      payPerUse: {
        title: '用多少付多少',
        body: '一筆交易者訊號 $0.01、一筆即時行情 $0.005。沒有月費，也沒有最低消費。',
      },
      autonomous: {
        title: '助理自己完成',
        body: '付款、拿資料、判斷要不要下單都由助理自動處理。訊號不夠強時，它會選擇不進場，只花掉那筆資料費。',
      },
      transparent: {
        title: '錢的去向公開',
        body: '每筆收入 70% 分給提供訊號的交易者、20% 給平台、10% 存進保險金庫，分帳記在鏈上，任何人都查得到。',
      },
    },

    how: {
      heading: '一次購買是怎麼進行的',
      ask: { title: '助理提出要求', body: '助理向 PepeLab 要一筆資料，例如某位交易者的下一步。' },
      quote: { title: 'PepeLab 報價', body: '系統回覆：「這筆 $0.01，請用 Circle USDC 付款。」' },
      pay: {
        title: '付款、拿到資料',
        body: '助理用自己的錢包簽名付款，確認後立刻拿到資料。整個過程幾秒內完成，不需要有人按按鈕。',
      },
    },

    product: {
      heading: '可以買到什麼',
      perCall: '／次',
      signalsName: '交易者訊號',
      signals: '指定一位交易者，取得他下一步的方向、標的與信心程度。',
      oracleName: '即時行情快照',
      oracle: '某個標的此刻的指數價、標記價與資金費率。',
    },

    split: {
      title: '收入怎麼分（即時鏈上數字）',
      accrued: '鏈上累計收入',
      calls: '{count} 次購買',
      callsUnknown: '鏈上未記錄購買次數',
      traders: '交易者',
      platform: '平台',
      vault: '保險金庫',
      /** 圖例是「名稱 + 百分比」，百分比是資料不是文字，所以只留名稱。 */
      share: '{label} {pct}%',
    },

    tryBuy: {
      title: '先免費試一次（不用錢包）',
      description:
        '按下按鈕，免費看一筆真實的即時訊號長什麼樣子。試用不會付款、也不會動到任何錢；上方的收入數字只來自真正付費的購買。',
      busy: '讀取中…',
      cta: '免費試看一筆訊號',
      resultCaption: '助理實際會收到的原始資料：',
      failed: '試用讀取失敗',
      networkError: '連不上訊號服務，請稍後再試。',
      settled: '70/20/10 已上鏈 · ',
      viewSettlement: '在 BaseScan 看這筆分帳 ↗',
    },

    start: {
      heading: '怎麼開始使用',
      note: '目前第 3 步需要一位會跑程式的朋友或開發者幫忙；在應用內一鍵啟用助理的功能還在規劃中。',
      wallet: {
        title: '準備一個測試用錢包',
        body: '安裝 MetaMask 之類的錢包，新增一個全新帳戶，切換到 Base Sepolia 測試網。請不要用存有真實資產的錢包。',
      },
      fund: {
        title: '領免費的測試幣',
        body: '到 Circle 的測試網水龍頭選 Base Sepolia，領 Circle USDC 用來付資料費；再到任一 Base Sepolia 水龍頭領一點 ETH，用來付鏈上手續費（gas）。',
        link: '前往 Circle 水龍頭 ↗',
      },
      connect: {
        title: '把錢包交給你的助理',
        body: '開發者照著下方「給開發者」區塊的範例，把這個錢包設定給助理程式。之後助理需要資料時，就會自己付款。',
      },
      track: {
        title: '隨時查看花了多少',
        body: '每筆付款都有公開紀錄。把錢包地址貼到 BaseScan，就能看到助理的每一筆花費。',
      },
    },

    faq: {
      heading: '常見問題',
      spend: {
        q: '助理會不會亂花錢？',
        a: '助理只花得到那個錢包裡的錢。只放你願意讓它用的金額就好——例如 1 Circle USDC 就夠買 100 筆訊號。',
      },
      trade: {
        q: '助理會幫我下單嗎？',
        a: '可以設定成會。下單用的是你在交易所的保證金，而且只能在你事先授權的範圍內：單筆上限、總預算、槓桿上限與到期日都由合約強制執行，超過就會被拒絕。',
      },
      real: {
        q: '這是真錢嗎？',
        a: '不是。目前在 Base Sepolia 測試網上運作，水龍頭領來的測試幣沒有實際價值。',
      },
    },

    advanced: {
      summary: '給開發者：技術參數與程式範例',
      hint: '一般使用者可以略過這一段。',
      fact: {
        baseUrl: '基礎網址',
        network: '網路',
        asset: '資產',
        assetValue: 'Circle USDC {address} (6-dec, EIP-3009)',
        router: 'x402 分潤 router',
        pricing: '定價',
        pricingValue: 'GET /signals/:trader → $0.01 · GET /oracle/:asset → $0.005',
      },
      step1: '1) 探索（免費）',
      step2: '2) 付費購買（x402-fetch + viem）',
      flow: '流程：GET → 收 402（含 accepts: network/asset/payTo/price）→ 用 Circle USDC 簽 EIP-3009 transferWithAuthorization → 重送帶 X-PAYMENT → 200 + 訊號 + settlement tx。',
      networkErrorHint: '試用連線失敗時，檢查 API 是否已部署、VITE_SIGNAL_API_URL 是否已設定。',
    },

    footer:
      '測試網展示環境（Base Sepolia）；結算金鑰僅供 demo，不涉及真實資產。鏈上分潤數字為即時讀取。付款由公開的 x402.org facilitator 結算並由它支付 gas；本專案未自架 facilitator。',
  },

  /** 首頁那張把人帶到文件頁的卡片。 */
  card: {
    title: '⚡ x402 訊號市集',
    chip: '按次付費',
    description:
      '任何 agent 只要在 Base Sepolia 持有 Circle USDC 即可付費購買訊號（$0.01/$0.005），收入 70/20/10 上鏈分潤。',
    accrued: '鏈上累計：${feeUsd} 收入 · ${traderShare} 歸 traders (70%)',
    busy: '讀取中…',
    tryBuy: '免費試用',
    docs: 'API 文件',
    settled: '✓ 已上鏈：',
    viewSettlement: '在 BaseScan 看 settlement tx ↗',
    apiUnreachable: 'API 未連上（VITE_SIGNAL_API_URL?）',
  },
};
