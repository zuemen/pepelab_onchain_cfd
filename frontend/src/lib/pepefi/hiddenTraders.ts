// 畫面上不再列出的交易者，依鏈分開。鏈上的紀錄不動（BaseScan 上照樣查得到），只是不在
// 排行榜、配置市集、相近交易者裡出現，交易者頁與跟單頁也不讓人跟。
//
// ESG Master（#383）：模擬交易者，策略 esg_tilt 是照平台自評的 ESG 綜合分選股與配權重。
// 平台不再自評 ESG 之後這個策略就沒有依據；它已經在鏈上註冊，重新產生英雄榜資料也拿不掉，
// 所以在這裡隱藏，英雄榜的管線同時拿掉它（heroes/herolab/roster.py）。

const HIDDEN: Readonly<Record<number, readonly string[]>> = {
  31337: ['0xfabb0ac9d68b0b445fb7357272ff202c5651694a'],
  84532: ['0x7cd08d32f70f828781546adbdfe14dca33fc115b'],
}

export function isHiddenTrader(chainId: number | null, address: string): boolean {
  if (chainId === null) return false
  return HIDDEN[chainId]?.includes(address.toLowerCase()) ?? false
}
