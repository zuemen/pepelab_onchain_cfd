// S5 驗收：rwa-poc 專屬部署的前端頁面都讀到新部署的資料（唯讀，不送交易）。
import { waitForLoaded } from '../helpers.mjs';
import { connectWallet } from './rwa-poc.mjs';

const shot = (name) => async (ctx) => {
  await waitForLoaded(ctx);
  await ctx.pause(2500);
  const body = await ctx.page.locator('body').innerText();
  const failed = (body.match(/讀取失敗|讀不到|Error/g) || []).length;
  ctx.log(`${name}: 讀取失敗字樣 ${failed} 處；含新交易所縮寫 ${/0xbB7f|0xbb7f/i.test(body)}；含 sGOLD ${body.includes('sGOLD')}`);
  (await import('node:fs')).writeFileSync(`out/s5-${name}.txt`, body);
  await ctx.page.screenshot({ path: `out/s5-${name}.png`, fullPage: true });
};

const page = (path, name, caption, waitText) => ({
  caption,
  run: async (ctx) => {
    await ctx.goto(path);
    if (waitText) await ctx.page.getByText(waitText).first().waitFor({ timeout: 90_000 }).catch(() => ctx.log(`${name}: 等不到「${waitText}」`));
    await shot(name)(ctx);
  },
  hold: 500,
});

export default {
  name: 's5-verify',
  role: 'investor',
  steps: [
    { caption: '首頁', run: async (ctx) => { await ctx.goto('/'); } },
    { caption: '連線投資人錢包', run: connectWallet },
    page('/rwa', 'rwa', 'RWA'),
    page('/oracle', 'oracle', 'Oracle'),
    page('/solvency', 'solvency', 'Solvency'),
    page('/sessions', 'sessions', 'Sessions'),
    page('/credentials', 'credentials', 'Credentials'),
    page('/portfolio', 'portfolio', 'Portfolio', '180'),
    page('/terminal', 'terminal', 'Terminal'),
  ],
};
