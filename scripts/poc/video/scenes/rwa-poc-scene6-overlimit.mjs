// 補拍第 6 景的續段：實付那一段（rwa-poc-scene6-pay.mjs）若中途有一次 facilitator 失敗（未扣款、KYA 花費帳已退回），
// `pay` 的三次呼叫會用來湊滿兩筆成功，就錄不到「累計超額被拒」。這一段在**同一個 signal-api 行程**（花費帳是 memory）
// 再帶 VP 呼叫一次，預期 403 kya_spend_limit_exceeded、不送結算、不扣款。
//
//   node record.mjs --scenes scenes/rwa-poc-scene6-overlimit.mjs --base http://localhost:4173 --no-sign
//   node postprocess.mjs --main out/<完整版>.json --replace-scene 6=out/<實付>.json+out/<這次>.json
import { x402 } from './scene6-x402.mjs';

export default {
  name: 'rwa-poc-scene6-overlimit',
  role: 'agent',
  lead: 1500,
  steps: [
    {
      caption: '第 6 景｜兩筆 0.01 已結算，這張憑證的 x402 上限 0.02 用完 → 再出示 VP 付費，賣方在收錢前拒絕（403），不送結算',
      note: '上一段第 2 次呼叫是 facilitator 回 402（未扣款，KYA 花費帳已退回），第 3 次才完成第二筆結算',
      run: async (ctx) => {
        await ctx.showTerminal('代理人 — x402 付費呼叫（本機 signal-api :4021，KYA on）');
        await x402(ctx, 'call main vp');
        await x402(ctx, 'balance');
      },
      hold: 6500,
    },
  ],
};
