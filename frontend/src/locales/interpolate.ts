/** catalog 字串裡的具名佔位符。`{token}` 會被替換，`{ token }`（有空白）不會。 */
const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

/**
 * 把 catalog 字串裡的 `{name}` 換成實際值。
 *
 * 具名而非位置式：翻譯時如果目標語言要把這個值移到句子另一端，譯者不該需要知道
 * 它原本是第幾個參數。
 */
export function interpolate(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    if (!(name in vars)) {
      // 留下原本的 `{token}`，不要變成 "undefined"。少傳一個變數是開發期的錯，
      // 而 "undefined" 讀起來像真的文字，會安靜地混進畫面；`{token}` 一眼就知道漏了。
      console.warn(`[interpolate] 樣板需要變數 "${name}"，但呼叫端沒有提供：${template}`);
      return whole;
    }
    return String(vars[name]);
  });
}
