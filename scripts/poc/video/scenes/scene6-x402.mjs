// 第 6 景（x402 Know-Your-Agent）。主劇本 rwa-poc-full.mjs 引用 scene6Pending（代理人尚未入金的版本）；
// 代理人領到測試 USDC 之後，用 scenes/rwa-poc-scene6-pay.mjs 只重錄這一段，再以 postprocess.mjs --replace-scene 6=… 插回成片。
//
// S6 的腳本與憑證狀態在 s6 worktree（signal-api 從那裡跑）；可用 POC_X402_ROOT 覆寫。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const X402_ROOT = process.env.POC_X402_ROOT ?? path.resolve(ROOT, '..', 's6');

export const x402 = (ctx, args) =>
  ctx.run(`bash scripts/poc/rwa-poc-x402.sh ${args}`, {
    cwd: X402_ROOT, env: {}, cwdLabel: '~/pepelab_onchain_cfd', allowFail: true, waitLabel: '等待付費 API 回應',
  });

export const LABEL = process.env.POC_X402_LABEL ?? 'main';
if (!/^[a-z0-9-]{1,20}$/.test(LABEL)) throw new Error(`POC_X402_LABEL 格式不對：${LABEL}`);

const NOTE = 'x402 用的是 S6 為付費 API 建立的 session #0（上限 0.02）與 #1（上限 0.005）';

const noVp = {
  caption: '第 6 景｜代理人買訊號（x402）：不出示委託憑證 → 賣方在收錢前就拒絕（403）',
  note: NOTE,
  run: async (ctx) => {
    await ctx.showTerminal('代理人 — x402 付費呼叫（本機 signal-api :4021，KYA on）');
    await x402(ctx, `call ${LABEL} novp`);
  },
  hold: 5500,
};

/** 代理人 USDC 為 0 時的版本（字幕照實說明實付待補拍）。 */
export const scene6Pending = [
  noVp,
  {
    caption: '第 6 景｜出示 VP，但這張憑證的 x402 上限 0.005 USDC 低於單價 0.01 → 超額被拒，不會送去結算',
    run: async (ctx) => { await x402(ctx, 'call lowcap vp'); },
    hold: 5500,
  },
  {
    caption: '第 6 景｜出示 VP、上限足夠：KYA 全部通過才交給 facilitator；代理人測試 USDC 餘額為 0，付款失敗——x402 實付待代理人入金後補拍',
    run: async (ctx) => {
      await x402(ctx, 'balance');
      await x402(ctx, 'call main vp');
    },
    hold: 6500,
  },
];

/** 入金後的版本：不帶 VP 被拒 → 帶 VP 實付兩筆（真 facilitator、真測試 USDC）→ 累計超額被拒（pay 會呼叫到被拒為止）。
 *  label 用 POC_X402_LABEL（預設 main）；main 的上限已在 2026-10-08 用滿，重拍請先 setup 新憑證並設這個變數。 */
export const scene6Paid = [
  noVp,
  {
    caption: '第 6 景｜出示 VP 付費：KYA 通過後才交給 facilitator 結算（Base Sepolia 測試 USDC，每次 0.01）',
    note: '憑證的 x402 總額上限 0.02 USDC：兩筆結算後，下一次累計超額被拒、不送結算',
    run: async (ctx) => {
      await x402(ctx, 'balance');
      await x402(ctx, `pay ${LABEL}`);
    },
    hold: 7000,
  },
];
