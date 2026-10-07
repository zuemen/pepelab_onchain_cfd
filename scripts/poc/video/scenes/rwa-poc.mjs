// RWA PoC 劇本骨架。
//
// 每一步：{ caption, run(ctx), note?, lead?, hold? }
//   caption  字幕列主文字（繁中，說明「這一步在做什麼」）
//   note     字幕列第二行（選填；交易送出後會被 tx hash 取代）
//   lead     字幕出現後、動作開始前的停頓（ms，預設 1200）
//   hold     動作完成後停在畫面上的時間（ms，預設 2000）
//
// ctx 提供：page、wallet（address / role / switchRole / nextTx / waitReceipt）、
//          overlay、goto(path)、pause(ms)、switchRole(name)、recordTx(hash)、assert(cond, msg)、log
//
// 目前只有唯讀步驟。交易步驟請照最下面的 TODO 範例補上，並用 --allow-tx 執行。

import { clickAndWaitTx, smoothScroll, waitForLoaded, waitForText } from '../helpers.mjs';

const short = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

/** 共用：從首頁連接注入錢包，確認畫面顯示正確地址。 */
export async function connectWallet(ctx) {
  const { page, wallet } = ctx;
  await page.getByRole('button', { name: '連接錢包' }).last().click();
  await ctx.pause(800);
  await page.getByText('MetaMask 錢包連線').click();
  // 連上後 WalletButton 顯示「0x1234…abcd」，首頁會自動導到 /portfolio
  await page.getByText(short(wallet.address)).first().waitFor({ state: 'visible', timeout: 20_000 });
  ctx.log(`畫面已顯示錢包地址 ${short(wallet.address)}`);
}

export const readOnlySteps = [
  {
    caption: '開啟 PepeLab 首頁：Base Sepolia 上的 RWA 永續合約平台',
    run: async (ctx) => {
      await ctx.goto('/');
    },
  },
  {
    caption: '以投資人錢包連線（Base Sepolia，chainId 84532）',
    run: connectWallet,
    hold: 2500,
  },
  {
    caption: 'RWA 資產卡與法遵揭露：鏈上資產、發行人與合規狀態',
    run: async (ctx) => {
      await ctx.goto('/rwa');
      await waitForLoaded(ctx);
      await ctx.pause(1500);
      await smoothScroll(ctx, 900);
    },
    hold: 2500,
  },
  {
    caption: '參考價多源見證：每一筆報價都可回溯來源與時間',
    run: async (ctx) => {
      await ctx.goto('/oracle');
      await waitForLoaded(ctx);
      await ctx.pause(1500);
      await smoothScroll(ctx, 900);
    },
    hold: 2500,
  },
  {
    caption: '儲備與償付能力：公開節點即時讀鏈，任何人都能查證',
    run: async (ctx) => {
      await ctx.goto('/solvency');
      await waitForLoaded(ctx);
      await ctx.pause(1500);
      await smoothScroll(ctx, 900);
    },
    hold: 3000,
  },
];

// ---------------------------------------------------------------------------
// TODO（交易步驟）：以下是範例，確認 selector 與流程後搬進 steps 並以 --allow-tx 錄製。
//
// const txSteps = [
//   {
//     caption: '發行人（issuer）鑄造 RWA 代幣給投資人',
//     run: async (ctx) => {
//       await ctx.switchRole('issuer');               // 會對頁面發 accountsChanged
//       await ctx.goto('/rwa');
//       // await typeInto(ctx, 'input[name="amount"]', '1000');
//       await clickAndWaitTx(ctx, 'role=button[name="鑄造"]');   // 字幕列會顯示 tx hash + BaseScan 連結
//       await waitForText(ctx, '鑄造完成');
//     },
//     hold: 4000,
//   },
//   {
//     caption: '切回投資人，確認持倉入帳',
//     run: async (ctx) => {
//       await ctx.switchRole('investor');
//       await ctx.goto('/portfolio');
//     },
//   },
// ];
// ---------------------------------------------------------------------------
void clickAndWaitTx; void waitForText; // 範例會用到，避免 linter 抱怨未使用

export default {
  name: 'rwa-poc',
  role: 'investor',
  steps: [...readOnlySteps /* , ...txSteps */],
};
