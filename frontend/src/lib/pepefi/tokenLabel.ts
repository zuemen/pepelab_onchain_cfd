import { t } from 'src/locales';

// 代幣顯示名稱的單一真相來源。
//
// 這個檔案原本存在但**沒有任何檔案引用它**，於是每一頁都自己手寫標籤，同一頁
// 就會出現「Balance: USDC」「Notional: mUSDC」「保證金使用 USDC」三種說法指向
// 同一顆 MockUSDC。它們現在都必須走這裡。
//
// 三顆幣是真的不一樣，不要合併：
//   STABLE_LABEL       → MockUSDC，平台保證金（測試代幣。鏈上 symbol 是 mUSDC，
//                         但依 ADR-0002 規則 1，畫面一律顯示「USDC」）
//   ALT_STABLE_LABEL   → MockUSDT，只能持有／兌換，PerpetualExchange 不收
//   X402_STABLE_LABEL  → Circle 官方 USDC（EIP-3009），x402 付費 API 的結算幣
//
// ⚠ 平台保證金畫面上叫「USDC」之後，和 x402 的真 USDC 撞名，唯一分得開的是
// 「Circle」這個發行方名字。所以：x402 相關文案一律用 X402_STABLE_LABEL，永遠
// 寫成「Circle USDC」，不可以省成裸的 USDC，也不可以繞過去用 STABLE_LABEL——
// 那會讓使用者以為水龍頭領的測試幣可以拿來付真錢的 API。
//
// 反過來也一樣：平台保證金永遠是裸的「USDC」，不可以加「測試 / 模擬」前綴，
// 否則「裸 USDC = 測試幣、Circle USDC = 真錢」這條規則就不成立了。

/** 平台保證金（MockUSDC）。鏈上 symbol 是 mUSDC，畫面顯示則統一用 USDC。 */
export const STABLE_LABEL = 'USDC';

/** 第二顆模擬穩定幣（MockUSDT）。持有／兌換用，不是保證金。 */
export const ALT_STABLE_LABEL = 'USDT';

/** x402 付費 API 結算用的 Circle 官方 USDC。**「Circle」不可省略**，見 ADR-0002 規則 1。 */
export const X402_STABLE_LABEL = t.common.x402StableLabel;

/** 平台幣。 */
export const PEPE_LABEL = 'PEPE';

/** `123.45 USDC` —— 把數字和標籤黏起來，省得每個呼叫端各自加空白。 */
export function withStable(amount: string | number): string {
  return `${amount} ${STABLE_LABEL}`;
}
