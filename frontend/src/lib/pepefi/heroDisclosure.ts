import { t } from 'src/locales';

// 模擬交易者的揭露（#309、#344）。排行榜、個人頁、跟單頁、動態牆、策略實驗室共用。
// 時間壓縮的回放（公開站的 Base Sepolia 資料）用另一段：「本機鏈」在那裡不是事實，
// 而且要多講清楚借款費與資金費率沒有計入、上鏈時間是回放當天，以及測試網的 KYC 怎麼運作。

export const heroDisclosure = (timeCompressed: boolean): string =>
  timeCompressed ? t.marketplace.hero.disclosureCompressed : t.marketplace.hero.disclosure;
