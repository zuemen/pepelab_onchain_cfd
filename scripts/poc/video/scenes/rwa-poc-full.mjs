// RWA＋SSI PoC 完整錄影劇本：docs/tenants/rwa-poc/POC_SCRIPT.md 的 10 景。
//
//   node record.mjs --scenes scenes/rwa-poc-full.mjs --base http://localhost:4173 --allow-tx
//
// 前提（POC_SCRIPT.md §3 錄影前檢查清單）：keeper 在推價、本機狀態清單主機在 8787、signal-api 在 4021、
// 前端以 rwa-poc 模式在 --base、投資人尚未持有合格投資人資格（isVerified=false）、sGOLD Active、sAAPL ReduceOnly。
//
// 角色：前端一律是投資人（注入錢包）；發證者、代理人、keeper 的動作都在「終端機分頁」以 CLI 執行，
// 金鑰全部是 keystore（cast --account／ISSUER_KEYSTORE），私鑰不經過這支劇本。
//
// 交易：UI 交易由注入錢包送（--allow-tx）；CLI 交易用 scripts/poc/rwa-poc-tx.sh（先模擬再送）。
// 被拒的示範：第 2 景（未持證）與第 8 景（休市）以固定 gas 送出留下 status 0；其他只保留模擬的 revert。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract } from 'ethers';

import { clickAndWaitTx, downloadVia, smoothScroll, uploadFile, waitForLoaded, waitForText } from '../helpers.mjs';
import { connectWallet } from './rwa-poc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const AGENT_DIR = path.join(ROOT, 'agent');
// S6 的 x402 腳本與憑證狀態在 s6 worktree（signal-api 從那裡跑）；可用 POC_X402_ROOT 覆寫。
const X402_ROOT = process.env.POC_X402_ROOT ?? path.resolve(ROOT, '..', 's6');
const POC_DIR = path.join(AGENT_DIR, '.state', 'poc');
const VC_PATH = path.join(POC_DIR, 'investor-qi-vc.json');
const DELEGATION_PATH = path.join(POC_DIR, 'delegation-v3.json');

const A = {
  R: 'https://sepolia.base.org',
  EX: '0xbb7f8059ed5450889c745f5c1f458cb1290fa96b',
  REG: '0x3869405c4641C72E5F01EaD9ced69139B4D830bD',
  MGR: '0xa60a1dC20E1CBb0cBc869464E35AEBa6ff3acbdd',
  ANCHOR: '0x80269C6FfEbce234d6b24979735D987C8e0e5fBD',
  ISSUER: '0xf67bA3C2F6E710415F548C09b73808ba19b9cD83',
  INV: '0xebAFE53877ad3B691664d8cb0b34874CE1240194',
  AGENT: '0xB4e3C19D91B85e5ca22721CE3a7E127146322ef7',
  GOLD: '0x12b611f69af3b5e84f9d2d8a8818b4ad7f2cf0b45274bc7c3b9616f67c7baa1a',
  AAPL: '0xeed17252f75eebef59a2839f0991464677fec970326e35128ddaf7f3acfb7220',
  ZERO: '0x0000000000000000000000000000000000000000',
};
const ENV = { ...A, RWA_POC_RPC_URL: A.R, FEE: '100000000000000' };
// 跨步驟的狀態（session id、代理人部位編號）也寫進檔案，方便以 --steps 只重跑後半段除錯。
const STATE_PATH = path.join(POC_DIR, 'scene-state.json');
const state = (() => { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return { sid: null, agentPos: null }; } })();
const saveState = () => { fs.mkdirSync(POC_DIR, { recursive: true }); fs.writeFileSync(STATE_PATH, JSON.stringify(state) + '\n'); };

const sh = (ctx, cmd, o = {}) => ctx.run(cmd, { cwd: ROOT, env: ENV, cwdLabel: '~/pepelab_onchain_cfd', ...o });
const agentSh = (ctx, cmd, o = {}) => ctx.run(cmd, { cwd: AGENT_DIR, env: ENV, cwdLabel: '~/pepelab_onchain_cfd/agent', ...o });
const x402 = (ctx, args) => ctx.run(`bash scripts/poc/rwa-poc-x402.sh ${args}`, { cwd: X402_ROOT, env: {}, cwdLabel: '~/pepelab_onchain_cfd', allowFail: true });
const ISSUER_ENV = 'ISSUER_KEYSTORE=pepelab-rwa-issuer ISSUER_KEYSTORE_PASSWORD_FILE=$HOME/.foundry/pepelab-rwa-issuer.password';
const tx = (wallet, mode, label, to, sig, args, value) =>
  `${value ? 'VALUE=$FEE ' : ''}bash scripts/poc/rwa-poc-tx.sh ${wallet} ${mode} "${label}" ${to} "${sig}" ${args}`;
const OPEN = 'openPosition(bytes32,bool,uint256,uint256)';
const OPEN_S = 'openPositionForSession(uint256,bytes32,bool,uint256,uint256,address)';

/** 收合頁首的「重要揭露」橫幅（每次整頁載入都會出現），讓下單面板在 1080p 裡看得到。 */
async function collapseBanner(ctx) {
  const b = ctx.page.getByRole('button', { name: '收合' }).first();
  if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
}

async function openTerminalAsset(ctx, symbol) {
  await ctx.goto('/terminal');
  await collapseBanner(ctx);
  await waitForLoaded(ctx);
  // 市場選擇列的按鈕文字是「🔒 sAAPL」加上「● 休市」徽章，用自己的文字節點比對
  const ok = await ctx.page.evaluate((sym) => {
    for (const el of document.querySelectorAll('div')) {
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('').replace('🔒', '').trim();
      if (own === sym && getComputedStyle(el).cursor === 'pointer') { el.click(); return true; }
    }
    return false;
  }, symbol);
  ctx.assert(ok, `市場選擇列找不到 ${symbol}`);
  await ctx.pause(2500);
}

async function fillMargin(ctx, v) {
  const input = ctx.page.locator('input[placeholder="0.00"]').first();
  await input.scrollIntoViewIfNeeded();
  await input.click();
  await input.fill('');
  await input.pressSequentially(String(v), { delay: 120 });
  await ctx.pause(800);
}

const cta = (ctx, symbol) => ctx.page.getByRole('button', { name: new RegExp(`開倉 做多 ${symbol}`) }).first();

export default {
  name: 'rwa-poc-full',
  role: 'investor',
  steps: [
    // ── 片頭 ────────────────────────────────────────────────────────────────
    {
      caption: 'PepeLab RWA＋SSI PoC：Base Sepolia 測試網、測試代幣；發證者與見證者都是 PoC 團隊自己的測試錢包',
      note: '這支影片示範流程與合約行為，不涉及真實資產、真實身分審查或真錢',
      run: async (ctx) => {
        fs.mkdirSync(POC_DIR, { recursive: true });
        const ex = new Contract(A.EX, ['function executionFee() view returns (uint256)'], ctx.wallet.provider);
        ENV.FEE = String(await ex.executionFee());
        await ctx.goto('/');
        await ctx.pause(1500);
        await connectWallet(ctx);
      },
      hold: 3000,
    },

    // ── 第 1 景：發證 ────────────────────────────────────────────────────────
    {
      caption: '第 1 景｜發證者以加密 keystore 簽發「合格投資人」可驗證憑證（離線簽名，不上鏈）',
      note: '發證者 0xf67b…cD83 是測試錢包；鏈下審查在這裡省略',
      run: async (ctx) => {
        await ctx.showTerminal('發證者 — agent/issuer/cli.ts');
        await ctx.term.comment('發證者只讀 keystore（ISSUER_KEYSTORE＋密碼檔），私鑰不經過環境變數或指令列');
        await agentSh(ctx, `NONCE=$(cast call $REG "nonces(address)(uint256)" $INV -r $R | cut -d' ' -f1); echo "鏈上 nonces(投資人) = $NONCE"; \\
${ISSUER_ENV} npm run -s issuer -- issue --subject $INV --registry $REG --chain-id 84532 --type QUALIFIED_INVESTOR --nonce $NONCE --status-base-url http://localhost:8787/investor --out .state/poc/investor-qi-vc.json`);
        await agentSh(ctx, `jq '{type, issuer, credentialSubject, validUntil, credentialStatus: .credentialStatus.statusListCredential}' .state/poc/investor-qi-vc.json`);
        await agentSh(ctx, `npm run -s issuer -- verify --vc .state/poc/investor-qi-vc.json --registry $REG --chain-id 84532 --dir .state/public-status/investor --rpc $R | jq '{"簽章有效": .signature.valid, "發證者": .signature.issuer, "撤銷狀態正常": .status.ok, "發證者受信任": .onchain.issuerTrusted, "已登記上鏈": .onchain.submitted}'`, { allowFail: true });
      },
      hold: 4000,
    },

    // ── 第 2 景：未持證被拒 ──────────────────────────────────────────────────
    {
      caption: '第 2 景｜投資人還沒有資格：開 sGOLD（RWA 市場）多單，前端先擋下',
      run: async (ctx) => {
        await openTerminalAsset(ctx, 'sGOLD');
        await fillMargin(ctx, 20);
        const notice = ctx.page.getByText('開倉需要有效的合格投資人資格').first();
        await notice.scrollIntoViewIfNeeded();
        await notice.waitFor({ timeout: 30_000 });
        ctx.assert(await cta(ctx, 'sGOLD').isDisabled(), '未持證時下單按鈕應停用');
      },
      hold: 4000,
    },
    {
      caption: '第 2 景｜直接送上鏈也會被交易所合約拒絕：NotKycVerified（固定 gas 送出，留下 status 0 的鏈上紀錄）',
      run: async (ctx) => {
        await ctx.showTerminal('投資人 — cast（keystore pepelab-rwa-investor）');
        await sh(ctx, tx('investor', 'fail-send', '未持證開 sGOLD 多單（保證金 20、1 倍）', '$EX', OPEN, '$GOLD true $(cast to-wei 20) 1', true));
      },
      hold: 4000,
    },

    // ── 第 3 景：提交憑證 ────────────────────────────────────────────────────
    {
      caption: '第 3 景｜投資人在 /credentials 上傳憑證，瀏覽器本地驗證簽章、效期與撤銷狀態',
      run: async (ctx) => {
        await ctx.goto('/credentials');
        await collapseBanner(ctx);
        await waitForText(ctx, '合格投資人憑證');
        await uploadFile(ctx, VC_PATH);
        await ctx.pause(1200);
        await ctx.page.getByRole('button', { name: '本地驗證' }).click();
        await waitForText(ctx, '發證者受信任', { timeout: 60_000 });
        await ctx.page.getByText('簽章有效').first().scrollIntoViewIfNeeded();
      },
      hold: 4500,
    },
    {
      caption: '第 3 景｜送出資格證明上鏈：登錄合約自己再驗一次發證者簽章，鏈上只記地址、類型、到期日與憑證雜湊',
      run: async (ctx) => {
        await clickAndWaitTx(ctx, 'role=button[name="送出資格證明上鏈"]');
        await waitForText(ctx, '你的錢包已具 RWA 市場資格', { timeout: 90_000 });
        await ctx.page.getByText('你的錢包已具 RWA 市場資格').first().scrollIntoViewIfNeeded();
      },
      hold: 4500,
    },

    // ── 第 4 景：持證開倉 ────────────────────────────────────────────────────
    {
      caption: '第 4 景｜同一個錢包、同一筆單：資格登記上鏈之後，sGOLD 開倉成功',
      note: 'sGOLD 碳分級 3 級，交易所槓桿上限 1 倍',
      run: async (ctx) => {
        await openTerminalAsset(ctx, 'sGOLD');
        await fillMargin(ctx, 20);
        const b = cta(ctx, 'sGOLD');
        await b.scrollIntoViewIfNeeded();
        await ctx.page.waitForFunction(() => !document.body.innerText.includes('開倉需要有效的合格投資人資格'), null, { timeout: 60_000 });
        await clickAndWaitTx(ctx, 'role=button[name=/開倉 做多 sGOLD/]');
        await waitForText(ctx, 'sGOLD 已開倉', { timeout: 60_000 }).catch(() => {});
        await smoothScroll(ctx, 500);
      },
      hold: 4500,
    },

    // ── 第 5 景：建 session、簽發委託憑證 v3、錨定 ─────────────────────────────
    {
      caption: '第 5 景｜投資人為 AI 代理人建立有上限的 session：單筆 30、總預算 60、1 倍、24 小時、只限 sGOLD',
      note: '代理人 0xB4e3…22ef7 用自己的 session key，投資人不交出主錢包',
      run: async (ctx) => {
        const { page } = ctx;
        await ctx.goto('/sessions');
        await collapseBanner(ctx);
        await waitForText(ctx, '建立 Session');
        const set = async (sel, v) => {
          const el = page.locator(sel).first();
          await el.scrollIntoViewIfNeeded();
          await el.click();
          await el.fill('');
          await el.pressSequentially(String(v), { delay: 60 });
        };
        await set('input[placeholder^="0x"]', A.AGENT);
        await set('input[placeholder="1000"]', 30);
        await set('input[placeholder="5000"]', 60);
        await set('input[placeholder="5"]', 1);
        await set('input[placeholder="24"]', 24);
        const group = page.getByRole('group', { name: '允許交易的標的' });
        for (const sym of ['sBTC', 'sETH', 'sGOLD']) {
          const chip = group.getByRole('button', { name: sym, exact: true });
          const on = (await chip.getAttribute('aria-pressed')) === 'true';
          if ((sym === 'sGOLD') !== on) await chip.click();
        }
        await ctx.pause(800);
        await clickAndWaitTx(ctx, 'role=button[name="建立 Session"]');
        await page.getByRole('dialog').getByText('委託授權憑證 v3').first().waitFor({ timeout: 90_000 });
      },
      hold: 3000,
    },
    {
      caption: '第 5 景｜把同樣的上限與 x402 付費額度簽成委託憑證 v3（EIP-712，錢包簽名，不是交易）',
      run: async (ctx) => {
        const dlg = ctx.page.getByRole('dialog');
        for (const [label, v] of [['每期間上限（USDC）', '0.02'], ['期間（小時）', '1'], ['總額上限（USDC）', '0.02']]) {
          const el = dlg.getByLabel(label);
          await el.click();
          await el.fill('');
          await el.pressSequentially(v, { delay: 80 });
        }
        await dlg.getByRole('button', { name: '以錢包簽發 v3' }).click();
        await dlg.getByRole('button', { name: '錨定到鏈上' }).waitFor({ timeout: 60_000 });
      },
      hold: 3000,
    },
    {
      caption: '第 5 景｜把憑證雜湊錨定到 SessionCredentialAnchor：任何服務都查得到「誰授權了哪個代理人、到哪裡」',
      run: async (ctx) => {
        const dlg = ctx.page.getByRole('dialog');
        await clickAndWaitTx(ctx, 'role=dialog >> role=button[name="錨定到鏈上"]');
        await dlg.getByText('已錨定').first().waitFor({ timeout: 90_000 });
        await downloadVia(ctx, 'role=dialog >> role=button[name="下載憑證 .json"]', DELEGATION_PATH);
        const vc = JSON.parse(fs.readFileSync(DELEGATION_PATH, 'utf8'));
        state.sid = Number(vc.credentialSubject.sessionId);
        saveState();
        ctx.log(`新 session #${state.sid}`);
      },
      hold: 4000,
    },
    {
      caption: '第 5 景｜鏈上讀回：session 條款與錨定的憑證雜湊',
      run: async (ctx) => {
        await ctx.page.getByRole('dialog').getByRole('button', { name: '關閉' }).click().catch(() => {});
        await ctx.showTerminal('任何人 — 鏈上讀回');
        await agentSh(ctx, `SID=$(jq -r .credentialSubject.sessionId .state/poc/delegation-v3.json); echo "session #$SID"; \\
cast call $MGR "sessions(uint256)(address,address,uint256,uint256,uint256,uint256,uint256,bool)" $SID -r $R; \\
echo "錨定的憑證雜湊："; cast call $ANCHOR "currentCredential(uint256)(bytes32)" $SID -r $R`);
      },
      hold: 4000,
    },

    // ── 第 6 景：x402 KYA ───────────────────────────────────────────────────
    {
      caption: '第 6 景｜代理人買訊號（x402）：不出示委託憑證 → 賣方在收錢前就拒絕（403）',
      note: 'x402 用的是 S6 為付費 API 建立的 session #0（上限 0.02）與 #1（上限 0.005）',
      run: async (ctx) => {
        await ctx.showTerminal('代理人 — x402 付費呼叫（本機 signal-api :4021，KYA on）');
        await x402(ctx, 'call main novp');
      },
      hold: 4000,
    },
    {
      caption: '第 6 景｜出示 VP，但這張憑證的 x402 上限 0.005 USDC 低於單價 0.01 → 超額被拒，不會送去結算',
      run: async (ctx) => {
        await x402(ctx, 'call lowcap vp');
      },
      hold: 4000,
    },
    {
      caption: '第 6 景｜出示 VP、上限足夠：KYA 全部通過，交給 facilitator；代理人測試 USDC 餘額為 0，所以付款失敗（實付待入金後補拍）',
      run: async (ctx) => {
        await x402(ctx, 'balance');
        await x402(ctx, 'call main vp');
      },
      hold: 5000,
    },

    // ── 第 7 景：代理人下單 ──────────────────────────────────────────────────
    {
      caption: '第 7 景｜代理人用自己的 session key 在上限內下單：sGOLD 保證金 15，部位記在投資人名下',
      note: '代理人金鑰是 keystore pepelab-rwa-agent，直接呼叫 AgentSessionManager（上限由合約強制）',
      run: async (ctx) => {
        ctx.assert(state.sid !== null, '沒有 session id（第 5 景失敗？）');
        const ex = new Contract(A.EX, ['function nextPositionId() view returns (uint256)'], ctx.wallet.provider);
        await ctx.showTerminal('代理人 — cast（keystore pepelab-rwa-agent）');
        const r = await sh(ctx, tx('agent', 'ok', `session #${state.sid} 額度內開 sGOLD 多單（保證金 15）`, '$MGR', OPEN_S, `${state.sid} $GOLD true $(cast to-wei 15) 1 $ZERO`, true));
        // 部位編號：這筆交易之後 nextPositionId − 1（同一區塊沒有其他開倉時成立；下面用事件再確認）
        const h = r.txHashes[0];
        const rc = await ctx.wallet.provider.getTransactionReceipt(h);
        const topic = rc.logs.find((l) => l.address.toLowerCase() === A.MGR.toLowerCase());
        state.agentPos = topic ? Number(BigInt('0x' + topic.data.slice(2, 66))) : Number(await ex.nextPositionId()) - 1;
        saveState();
        ctx.log(`代理人開的部位 #${state.agentPos}`);
      },
      hold: 3500,
    },
    {
      caption: '第 7 景｜超過單筆上限（保證金 50 > 30）：合約拒絕 MarginExceedsPerTradeCap（只模擬，不送出）',
      run: async (ctx) => {
        await sh(ctx, tx('agent', 'fail', `session #${state.sid} 超額開 sGOLD（保證金 50）`, '$MGR', OPEN_S, `${state.sid} $GOLD true $(cast to-wei 50) 1 $ZERO`, true));
        await sh(ctx, `cast call $MGR "sessions(uint256)(address,address,uint256,uint256,uint256,uint256,uint256,bool)" ${state.sid} -r $R | sed -n '3,5p' | paste -sd' ' - | awk '{print "單筆上限 "$1"  總預算 "$3"  已用 "$5}'`);
      },
      hold: 4000,
    },

    // ── 第 8 景：休市 ───────────────────────────────────────────────────────
    {
      caption: '第 8 景｜美股休市：keeper 依交易所行事曆把 sAAPL 切成「只能減倉」（ReduceOnly）',
      run: async (ctx) => {
        await ctx.goto('/rwa');
        await collapseBanner(ctx);
        await waitForLoaded(ctx);
        await ctx.page.getByText('只能減倉').first().scrollIntoViewIfNeeded().catch(() => {});
        await ctx.pause(2500);
        await ctx.showTerminal('任何人 — 鏈上讀回');
        await sh(ctx, `echo "assetMode(sAAPL) = $(cast call $EX "assetMode(bytes32)(uint8)" $AAPL -r $R)   # 0 Active、1 ReduceOnly"; echo "assetMode(sGOLD) = $(cast call $EX "assetMode(bytes32)(uint8)" $GOLD -r $R)"`);
      },
      hold: 4000,
    },
    {
      caption: '第 8 景｜休市時開 sAAPL 新倉：前端先警告，確認送出後被合約拒絕',
      run: async (ctx) => {
        await openTerminalAsset(ctx, 'sAAPL');
        await fillMargin(ctx, 10);
        const b = cta(ctx, 'sAAPL');
        await b.scrollIntoViewIfNeeded();
        await b.click();
        const proceed = ctx.page.getByTestId('closed-market-proceed');
        if (await proceed.isVisible({ timeout: 5000 }).catch(() => false)) {
          await ctx.pause(2500);
          await proceed.click();
        }
        await ctx.pause(6000);
      },
      hold: 3000,
    },
    {
      caption: '第 8 景｜鏈上證據：AssetNotActive（固定 gas 送出，status 0）。既有部位隨時可以平倉',
      run: async (ctx) => {
        await ctx.showTerminal('投資人 — cast（keystore pepelab-rwa-investor）');
        await sh(ctx, tx('investor', 'fail-send', '休市時開 sAAPL 多單（保證金 10）', '$EX', OPEN, '$AAPL true $(cast to-wei 10) 1', true));
      },
      hold: 4000,
    },

    // ── 第 9 景：撤銷 ───────────────────────────────────────────────────────
    {
      caption: '第 9 景｜發證者撤銷資格：先簽新的狀態清單，再以 keystore 送出鏈上 revoke（鏈上是權威）',
      run: async (ctx) => {
        await ctx.showTerminal('發證者 — 撤銷');
        await agentSh(ctx, `${ISSUER_ENV} npm run -s issuer -- revoke --vc .state/poc/investor-qi-vc.json --registry $REG --chain-id 84532 --dir .state/public-status/investor`);
        await sh(ctx, `HASH=$(jq -r .proof.attestation.credentialHash agent/.state/poc/investor-qi-vc.json); ${tx('issuer', 'ok', '鏈上撤銷合格投資人憑證', '$REG', 'revoke(bytes32)', '$HASH', false)}`);
        await sh(ctx, `echo "isVerified(投資人) = $(cast call $REG "isVerified(address)(bool)" $INV -r $R)"`);
      },
      hold: 4000,
    },
    {
      caption: '第 9 景｜投資人重新驗證憑證：狀態清單顯示「已撤銷」，錢包不再具有 RWA 市場資格',
      run: async (ctx) => {
        await ctx.goto('/credentials');
        await collapseBanner(ctx);
        await waitForText(ctx, '合格投資人憑證');
        await uploadFile(ctx, VC_PATH);
        await ctx.pause(1000);
        await ctx.page.getByRole('button', { name: '本地驗證' }).click();
        await waitForText(ctx, '發證者已撤銷這張憑證', { timeout: 60_000 });
        await ctx.page.getByText('發證者已撤銷這張憑證').first().scrollIntoViewIfNeeded();
      },
      hold: 4500,
    },
    {
      caption: '第 9 景｜投資人與代理人的新開倉都被拒：代理人代表投資人下單，交易所檢查的是 session 的使用者（只模擬）',
      run: async (ctx) => {
        await ctx.showTerminal('投資人與代理人 — 撤銷後再開倉');
        await sh(ctx, tx('investor', 'fail', '投資人開 sGOLD（撤銷後）', '$EX', OPEN, '$GOLD true $(cast to-wei 20) 1', true));
        await sh(ctx, tx('agent', 'fail', `代理人經 session #${state.sid} 開 sGOLD（撤銷後）`, '$MGR', OPEN_S, `${state.sid} $GOLD true $(cast to-wei 15) 1 $ZERO`, true));
      },
      hold: 4500,
    },
    {
      caption: '第 9 景｜撤銷只擋開新倉：代理人平掉自己開的部位',
      run: async (ctx) => {
        await sh(ctx, tx('agent', 'ok', `代理人平倉 #${state.agentPos}（session #${state.sid}）`, '$MGR', 'closePositionForSession(uint256,uint256)', `${state.sid} ${state.agentPos}`, false));
      },
      hold: 3500,
    },
    {
      caption: '第 9 景｜投資人在終端機平掉自己的 sGOLD 部位：成功，保證金回到可用',
      run: async (ctx) => {
        await openTerminalAsset(ctx, 'sGOLD');
        const close = ctx.page.getByRole('button', { name: '平倉', exact: true }).first();
        await close.waitFor({ timeout: 60_000 });
        await close.scrollIntoViewIfNeeded();
        await ctx.pause(1500);
        await clickAndWaitTx(ctx, 'role=button[name="平倉"]');
        await ctx.pause(4000);
      },
      hold: 4000,
    },

    // ── 第 10 景：揭露 ──────────────────────────────────────────────────────
    {
      caption: '第 10 景｜/rwa：資產類別、鏈上 RWA 旗標、碳分級（見證者是 PoC 自己）與目前的交易模式',
      run: async (ctx) => {
        await ctx.goto('/rwa');
        await collapseBanner(ctx);
        await waitForLoaded(ctx);
        await ctx.pause(2000);
        await smoothScroll(ctx, 1200, { steps: 16 });
      },
      hold: 3000,
    },
    {
      caption: '第 10 景｜/oracle：鏈上價格（本機 keeper 寫入）與鏈下參考價的差距',
      run: async (ctx) => {
        await ctx.goto('/oracle');
        await collapseBanner(ctx);
        await waitForLoaded(ctx);
        await ctx.pause(2500);
        await smoothScroll(ctx, 900, { steps: 12 });
      },
      hold: 3000,
    },
    {
      caption: '第 10 景｜/solvency：保險金庫（測試網種子 1 USDC）、金庫儲備與 ADL，全部直接讀鏈',
      run: async (ctx) => {
        await ctx.goto('/solvency');
        await collapseBanner(ctx);
        await waitForLoaded(ctx);
        await ctx.pause(2500);
        await smoothScroll(ctx, 900, { steps: 12 });
      },
      hold: 4000,
    },
  ],
};
