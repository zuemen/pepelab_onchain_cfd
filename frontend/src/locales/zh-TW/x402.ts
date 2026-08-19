/**
 * x402 Signal API 的文件頁，以及首頁那張 x402 市集卡。
 *
 * 端點路徑、合約位址、`curl` 與 `npx` 範例（含範例裡的註解）不進 catalog：那一整塊
 * 是要被逐字複製貼上的程式碼，翻譯它只會讓人貼出跑不動的指令。
 */
export const x402 = {
  docs: {
    title: 'x402 訊號 API',
    audienceChip: '開發者 / Agent',
    commerceChip: 'Agent 原生商務',

    /** #36：開頭這句夾了兩段 `<b>`，拆成 bold 前後的三個片段。 */
    introBold1: '開發者 / AI agent 專用',
    introMid: '的按次付費交易訊號 API。',
    introBold2: '端點本身就是商品',
    introAfter: '——任何在 Base Sepolia 上持有 Circle USDC 的 agent / CLI 都能直接付費購買，收入經 FeeRouter 70/20/10 上鏈分潤。',

    fact: {
      baseUrl: '基礎網址',
      network: '網路',
      asset: '資產',
      assetValue: 'Circle USDC {address} (6-dec, EIP-3009)',
      router: 'x402 分潤 router',
      pricing: '定價',
      pricingValue: 'GET /signals/:trader → $0.01 · GET /oracle/:asset → $0.005',
    },

    product: {
      heading: '端點即商品',
      perCall: '／次',
      signals: '指定交易者的下一步訊號（方向 / 標的 / 信心度）。',
      oracle: '單一標的的即時預言機快照（index / mark / funding）。',
    },

    split: {
      title: '即時 70/20/10 分潤',
      accrued: '鏈上累計收入',
      calls: '{count} 次呼叫',
      traders: '交易者',
      platform: '平台',
      vault: '金庫',
      /** 圖例是「名稱 + 百分比」，百分比是資料不是文字，所以只留名稱。 */
      share: '{label} {pct}%',
    },

    tryBuy: {
      title: '互動試買（訪客免錢包）',
      description:
        '按下後由伺服器 demo 錢包代付一筆 $0.01 並在鏈上跑 70/20/10，回傳真實 settlement tx。 （真實外部 agent 則自帶錢包，見下方範例。）',
      busy: '購買中…（送鏈，約數秒）',
      cta: '試買一筆訊號 ($0.01)',
      failed: '示範購買失敗',
      networkError: '網路錯誤——API 是否已部署 / 是否已設定 VITE_SIGNAL_API_URL？',
      settled: '70/20/10 已上鏈 · ',
      viewSettlement: '在 BaseScan 看 settlement tx ↗',
    },

    external: {
      divider: '外部 agent 自帶錢包付費',
      step1: '1) 探索（免費）',
      step2: '2) 付費購買（x402-fetch + viem）',
      flow: '流程：GET → 收 402（含 accepts: network/asset/payTo/price）→ 用 Circle USDC 簽 EIP-3009 transferWithAuthorization → 重送帶 X-PAYMENT → 200 + 訊號 + settlement tx。',
    },

    footer:
      '測試網展示環境（Base Sepolia）；結算金鑰僅供 demo，不涉及真實資產。鏈上分潤數字為即時讀取。',
  },

  /** 首頁那張把人帶到文件頁的卡片。 */
  card: {
    title: '⚡ x402 訊號市集',
    chip: '按次付費',
    description:
      '任何 agent 只要在 Base Sepolia 持有 Circle USDC 即可付費購買訊號（$0.01/$0.005），收入 70/20/10 上鏈分潤。',
    accrued: '鏈上累計：${feeUsd} 收入 · ${traderShare} 歸 traders (70%)',
    busy: '購買中…',
    tryBuy: '試買 ($0.01)',
    docs: 'API 文件',
    settled: '✓ 已上鏈：',
    viewSettlement: '在 BaseScan 看 settlement tx ↗',
    apiUnreachable: 'API 未連上（VITE_SIGNAL_API_URL?）',
  },
};
