import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/meta.ts`。
 *
 * 型別標註要下在**每個 feature 檔**，不能只在 `en/index.ts` 標一次：index 傳進去的是
 * `meta` 這個變數而不是新鮮的物件字面值，而 TypeScript 的 excess property check 只對
 * 字面值生效——只在 index 標註的話，「多一個 zh-TW 沒有的 key」會被當成合法的結構子型別
 * 而編譯通過。標在這裡才會擋，而且錯誤會指在多出來的那一行上。
 */
export const meta: Catalog['meta'] = {
  title: '{brand} · Digital-asset investing for everyone',
  description:
    '{brand} — a digital-asset platform that helps ordinary people invest: stocks, bonds, gold and more as tokens on Base. Use copy investing to follow strategy sharers whose records are public, plus third-party ESG ratings with carbon tiers and a Pepe game.',
  titleNoCopy: '{brand} · Agent-Native Tokenized RWA',
  descriptionNoCopy:
    '{brand} — a tokenized-asset platform on Base. Buy and redeem tokens that track equities, bonds, gold and crypto on-chain + x402 paid signals + capped AI agent allowances.',
};
