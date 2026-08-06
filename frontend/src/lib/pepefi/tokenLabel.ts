// 代幣顯示名稱的單一真相來源。
//
// 這個檔案原本存在但**沒有任何檔案引用它**，於是每一頁都自己手寫標籤，同一頁
// 就會出現「Balance: USDC」「Notional: mUSDC」「保證金使用 USDC」三種說法指向
// 同一顆 MockUSDC。它們現在都必須走這裡。
//
// 三顆幣是真的不一樣，不要合併：
//   STABLE_LABEL       → MockUSDC，平台保證金（測試代幣，鏈上 symbol 就是 mUSDC）
//   ALT_STABLE_LABEL   → MockUSDT，只能持有／兌換，PerpetualExchange 不收
//   X402_STABLE_LABEL  → Circle 官方 USDC（EIP-3009），x402 付費 API 的結算幣
//
// ⚠ x402 相關文案一律用 X402_STABLE_LABEL，永遠是「官方 USDC」，不可以改成
// mUSDC，也不可以繞過去用 STABLE_LABEL——那會把真錢和測試幣講成同一個東西。

/** 平台保證金（MockUSDC）。鏈上 symbol 是 mUSDC，"m" 就是用來和真 USDC 區分的。 */
export const STABLE_LABEL = 'mUSDC';

/** 第二顆模擬穩定幣（MockUSDT）。持有／兌換用，不是保證金。 */
export const ALT_STABLE_LABEL = 'USDT';

/** x402 付費 API 結算用的 Circle 官方 USDC。**不要改。** */
export const X402_STABLE_LABEL = '官方 USDC';

/** 平台幣。 */
export const PEPE_LABEL = 'PEPE';

/** `123.45 mUSDC` —— 把數字和標籤黏起來，省得每個呼叫端各自加空白。 */
export function withStable(amount: string | number): string {
  return `${amount} ${STABLE_LABEL}`;
}
