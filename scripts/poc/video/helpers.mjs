// 劇本可用的小工具。全部收 ctx（record.mjs 建立），而不是裸 page，
// 因為交易相關的 helper 需要同時碰到 page、注入錢包與字幕列。

/**
 * 點一個會觸發 eth_sendTransaction 的按鈕，等注入錢包送出交易、字幕列顯示 tx hash，
 * 再等交易上鏈。回傳 tx hash。
 *
 * 唯讀模式（沒加 --allow-tx）下錢包會以 4001 拒絕，這裡就會逾時失敗——這是刻意的。
 *
 * @param {object} ctx  record.mjs 傳進劇本的 ctx
 * @param {string} selector  Playwright selector，例如 'role=button[name="鑄造"]'
 * @param {{ timeout?: number, confirmations?: number }} [opts]
 */
export async function clickAndWaitTx(ctx, selector, { timeout = 120_000, confirmations = 1 } = {}) {
  const pending = ctx.wallet.nextTx({ timeout });
  await ctx.page.locator(selector).first().click();
  const hash = await pending;
  ctx.recordTx(hash);
  await ctx.overlay.tx(hash);
  const receipt = await ctx.wallet.waitReceipt(hash, confirmations);
  if (receipt && receipt.status !== 1) throw new Error(`交易失敗（reverted）：${hash}`);
  await ctx.overlay.note(null);
  return hash;
}

/** 填欄位：找 label 或 placeholder，慢慢打字讓觀眾看得到。 */
export async function typeInto(ctx, selector, value, { delay = 60 } = {}) {
  const el = ctx.page.locator(selector).first();
  await el.click();
  await el.fill('');
  await el.pressSequentially(String(value), { delay });
}

/** 等某段文字出現在畫面上（例如交易完成後的狀態列）。 */
export async function waitForText(ctx, text, { timeout = 30_000 } = {}) {
  await ctx.page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
}

/** 慢慢捲到元素，讓觀眾跟得上畫面移動。 */
export async function scrollTo(ctx, selector) {
  await ctx.page.locator(selector).first().scrollIntoViewIfNeeded();
  await ctx.pause(600);
}

/** 平滑捲動整頁一段距離（像素）。 */
export async function smoothScroll(ctx, dy, { steps = 10, stepDelay = 80 } = {}) {
  for (let i = 0; i < steps; i++) {
    await ctx.page.mouse.wheel(0, dy / steps);
    await ctx.pause(stepDelay);
  }
}

/**
 * 等畫面上的「讀取中…」都消失（讀鏈完成）再繼續，避免影片拍到一整頁 loading。
 * 逾時不算失敗——有些欄位本來就可能一直讀不到，影片照樣往下走。
 */
export async function waitForLoaded(ctx, { text = '讀取中', timeout = 30_000 } = {}) {
  try {
    await ctx.page.waitForFunction((t) => !document.body.innerText.includes(t), text, { timeout, polling: 500 });
  } catch {
    ctx.log(`等待「${text}」消失逾時（${timeout}ms），繼續下一步`);
  }
}
