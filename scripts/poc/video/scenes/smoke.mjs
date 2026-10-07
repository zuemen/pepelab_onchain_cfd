// 自檢劇本：不送任何交易，驗證
//   1. 頁面認得注入錢包、顯示正確地址
//   2. personal_sign 走 Node 端簽名橋接，簽出來的簽名能還原回目前角色地址（不廣播）
//   3. eth_sendTransaction 在唯讀模式被拒絕；domain.chainId ≠ 84532 的 typed data 被拒絕；iframe 拿不到錢包
//   4. 中途切換角色會觸發 accountsChanged，畫面地址跟著換
//   5. 字幕列有出現
// 執行：node record.mjs --scenes scenes/smoke.mjs

import { verifyMessage } from 'ethers';

import { connectWallet, readOnlySteps } from './rwa-poc.mjs';

const short = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;

export default {
  name: 'smoke',
  role: 'investor',
  steps: [
    readOnlySteps[0],
    { caption: '自檢：連接注入錢包並確認畫面上的地址', run: connectWallet },
    {
      caption: '自檢：字幕列已注入畫面',
      run: async (ctx) => {
        const visible = await ctx.page.locator(`#${ctx.overlay.id}`).isVisible();
        ctx.assert(visible, '字幕列不存在');
      },
      hold: 500,
    },
    {
      caption: '自檢：personal_sign 簽名橋接（只簽不送）',
      run: async (ctx) => {
        const msg = `PepeLab PoC video self-check ${new Date().toISOString()}`;
        const sig = await ctx.page.evaluate(async (m) => {
          const [addr] = await window.ethereum.request({ method: 'eth_accounts' });
          return window.ethereum.request({ method: 'personal_sign', params: [m, addr] });
        }, msg);
        const recovered = verifyMessage(msg, sig);
        ctx.assert(recovered === ctx.wallet.address, `簽名還原地址 ${recovered} ≠ ${ctx.wallet.address}`);
        ctx.log(`personal_sign 還原地址相符：${recovered}`);
        await ctx.overlay.note(`簽名還原地址 ${recovered}（未廣播）`);
      },
    },
    {
      caption: '自檢：唯讀模式下 eth_sendTransaction 會被拒絕',
      run: async (ctx) => {
        const res = await ctx.page.evaluate(async () => {
          const [addr] = await window.ethereum.request({ method: 'eth_accounts' });
          try {
            await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: addr, to: addr, value: '0x0' }] });
            return { sent: true };
          } catch (e) {
            return { sent: false, code: e.code };
          }
        });
        ctx.assert(!res.sent && res.code === 4001, `交易未被攔下：${JSON.stringify(res)}`);
      },
      hold: 500,
    },
    {
      caption: '自檢：typed data 的 domain.chainId 不是 84532 會被拒絕',
      run: async (ctx) => {
        const res = await ctx.page.evaluate(async () => {
          const [addr] = await window.ethereum.request({ method: 'eth_accounts' });
          const typed = {
            types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'chainId', type: 'uint256' }], Ping: [{ name: 'n', type: 'uint256' }] },
            primaryType: 'Ping',
            domain: { name: 'PoC smoke', chainId: 1 },
            message: { n: 1 },
          };
          try {
            await window.ethereum.request({ method: 'eth_signTypedData_v4', params: [addr, JSON.stringify(typed)] });
            return { signed: true };
          } catch (e) {
            return { signed: false, code: e.code };
          }
        });
        ctx.assert(!res.signed && res.code === 4001, `chainId 1 的 typed data 沒被拒絕：${JSON.stringify(res)}`);
      },
      hold: 500,
    },
    {
      caption: '自檢：iframe 拿不到錢包，也不能直接呼叫簽名橋接',
      run: async (ctx) => {
        await ctx.page.evaluate(() => new Promise((resolve) => {
          const f = document.createElement('iframe');
          f.id = '__poc_smoke_iframe';
          f.style.display = 'none';
          f.srcdoc = '<p>x</p>';
          f.onload = resolve;
          document.body.appendChild(f);
        }));
        const frame = ctx.page.frames().find((f) => f !== ctx.page.mainFrame());
        ctx.assert(frame, '找不到測試 iframe');
        const res = await frame.evaluate(async () => {
          const hasProvider = !!window.ethereum;
          let bridge = null;
          if (typeof window.__pepePocBridge === 'function') {
            const r = await window.__pepePocBridge('personal_sign', JSON.stringify(['0x01', '0x0000000000000000000000000000000000000000']));
            bridge = r.error ? r.error.code : 'signed';
          }
          return { hasProvider, bridge };
        });
        await ctx.page.evaluate(() => document.getElementById('__poc_smoke_iframe')?.remove());
        ctx.assert(!res.hasProvider, 'iframe 裡出現了 window.ethereum');
        ctx.assert(res.bridge === null || res.bridge === 4100, `iframe 直接呼叫橋接沒被拒絕：${res.bridge}`);
        ctx.log(`iframe 檢查：provider=${res.hasProvider}，bridge=${res.bridge}`);
      },
      hold: 500,
    },
    {
      caption: '自檢：中途切換角色 investor → issuer，畫面地址跟著換',
      run: async (ctx) => {
        const addr = await ctx.switchRole('issuer');
        await ctx.page.getByText(short(addr)).first().waitFor({ state: 'visible', timeout: 15_000 });
        ctx.log(`accountsChanged 後畫面顯示 ${short(addr)}`);
        await ctx.switchRole('investor');
        await ctx.page.getByText(short(ctx.wallet.address)).first().waitFor({ state: 'visible', timeout: 15_000 });
      },
    },
    ...readOnlySteps.slice(2),
  ],
};
