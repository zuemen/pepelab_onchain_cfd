// 畫面上不再列出的交易者，依鏈分開。鏈上的紀錄不動（BaseScan 上照樣查得到），只是不在
// 排行榜、配置市集、相近交易者裡出現，交易者頁與跟單頁也不讓人跟。
//
// ESG Master（#383）：模擬交易者，策略 esg_tilt 是照平台自評的 ESG 綜合分選股與配權重。
// 平台不再自評 ESG 之後這個策略就沒有依據；它已經在鏈上註冊，重新產生英雄榜資料也拿不掉，
// 所以在這裡隱藏，英雄榜的管線同時拿掉它（heroes/herolab/roster.py）。

//
// 重名（2026-11-11 正式站檢查）：模擬交易者在 Base Sepolia 註冊過兩批，同名、不同地址，排行榜與配置市集
// 會出現兩個「Carbon Zero」等。隱藏較舊、只有 1 版策略、沒有跟隨者的那一個，保留後來持續發策略的那一個。
// 「FrogDemo」也有兩個，但 0x4cd8… 是 10/28 網頁端到端測試的跟隨者錢包，隱藏會連它在動態牆的紀錄一起拿掉，所以不列。
// 兩批中 0 版策略的舊帳號本來就不會出現在列表，不必列。

const HIDDEN: Readonly<Record<number, readonly string[]>> = {
  31337: ['0xfabb0ac9d68b0b445fb7357272ff202c5651694a'],
  84532: [
    '0x7cd08d32f70f828781546adbdfe14dca33fc115b', // ESG Master（#383）
    // 重名的舊模擬交易者（保留的那一個寫在後面）
    '0x8c74ce2d11e5e3f1a3821371bc1bb5705c443a7d', // Green Investor   → 0x16ac…
    '0xd06371e99c15da1ab1800509d0d21151ab637915', // Momentum Mike    → 0x2e57…
    '0x194f4a70ebd848b9d4a0877259bb0debe222af02', // Risk Parity Pro  → 0xcea6…
    '0x7a51fd90f7b5485f93a6923289ad15a94342c93d', // Carbon Zero      → 0xfd6f…
  ],
}

export function isHiddenTrader(chainId: number | null, address: string): boolean {
  if (chainId === null) return false
  return HIDDEN[chainId]?.includes(address.toLowerCase()) ?? false
}
