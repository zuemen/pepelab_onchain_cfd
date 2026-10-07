// 「終端機畫面」：錄影瀏覽器裡另開一個分頁，顯示 CLI 步驟的指令與輸出（深色、等寬字、逐行出現）。
//
// 由 record.mjs 執行子行程（ctx.run），stdout／stderr 逐行串流到這個分頁；
// `tx 0x…`（64 位 hex）轉成 BaseScan 連結，並回報給 record.mjs 記進 JSON。
//
// 安全邊界：子行程只拿到白名單環境變數（PATH、HOME、LANG 與呼叫端明確給的變數），
// 不繼承錄影工具自己的環境；輸出只顯示到畫面與 JSON，不寫任何其他檔案。
// 子行程用到的金鑰一律是 keystore（cast --account／ISSUER_KEYSTORE…），私鑰不經過這裡。

import { spawn } from 'node:child_process';

import { BASESCAN_TX } from './overlay.mjs';

// 收三種寫法：`tx 0x…`（rwa-poc-tx.sh）、`tx=0x…`（x402 RESULT 行）、`…/tx/0x…`（BaseScan 連結）。
const TX_RE = /(?:\btx[ =]|\/tx\/)(0x[0-9a-fA-F]{64})\b/g;

const HTML = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>PepeLab PoC — 終端機</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #0b0f17; }
  body { font-family: "JetBrains Mono", "SF Mono", Menlo, ui-monospace, "PingFang TC", monospace; color: #d1d5db; }
  #bar { height: 40px; display: flex; align-items: center; gap: 8px; padding: 0 16px; background: #161b26; border-bottom: 1px solid #252b38; }
  .dot { width: 13px; height: 13px; border-radius: 50%; display: inline-block; }
  #title { margin-left: 14px; color: #9ca3af; font-size: 15px; }
  #screen { position: absolute; top: 41px; left: 0; right: 0; bottom: 0; overflow: hidden; padding: 56px 48px 220px; box-sizing: border-box; }
  #lines { font-size: 21px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; }
  .cmd { color: #f9fafb; } .cmd .ps { color: #22c55e; font-weight: 700; } .cmd .cwd { color: #60a5fa; }
  .comment { color: #6b7280; }
  .ok { color: #86efac; } .bad { color: #fca5a5; } .info { color: #fde68a; }
  a { color: #67e8f9; text-decoration: underline; }
  .link { color: #67e8f9; font-size: 17px; }
  .cursor { display: inline-block; width: 11px; height: 22px; background: #22c55e; vertical-align: -3px; animation: b 1s steps(1) infinite; }
  @keyframes b { 50% { opacity: 0; } }
</style></head><body>
<div id="bar"><span class="dot" style="background:#ef4444"></span><span class="dot" style="background:#f59e0b"></span><span class="dot" style="background:#22c55e"></span><span id="title">pepelab — zsh</span></div>
<div id="screen"><div id="lines"></div><span class="cursor"></span></div>
<script>
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  window.__term = {
    title(t) { document.getElementById('title').textContent = t; },
    clear() { document.getElementById('lines').innerHTML = ''; },
    add(kind, text) {
      const el = document.createElement('div');
      let html = esc(text);
      if (kind === 'cmd') {
        el.className = 'cmd';
        html = '<span class="cwd">' + esc(window.__cwd || '~') + '</span> <span class="ps">$</span> ' + html;
      } else {
        el.className = kind;
        html = html.replace(/\\btx (0x[0-9a-fA-F]{64})\\b/g, (m, h) =>
          'tx <a href="${BASESCAN_TX}' + h + '">' + h + '</a><br><span class="link">  ↳ ${BASESCAN_TX}' + h + '</span>');
      }
      el.innerHTML = html;
      const box = document.getElementById('lines');
      box.appendChild(el);
      const screen = document.getElementById('screen');
      while (box.scrollHeight > screen.clientHeight - 290 && box.children.length > 1) box.removeChild(box.firstChild);
      return el;
    },
    async addMany(items, gap) {
      for (const [kind, text] of items) {
        window.__term.add(kind, text);
        await new Promise((r) => setTimeout(r, gap));
      }
    },
    async type(text, delay) {
      const el = window.__term.add('cmd', '');
      const head = '<span class="cwd">' + esc(window.__cwd || '~') + '</span> <span class="ps">$</span> ';
      const step = Math.max(1, Math.ceil(text.length / 120));
      for (let i = step; i < text.length + step; i += step) {
        el.innerHTML = head + esc(text.slice(0, i));
        await new Promise((r) => setTimeout(r, delay));
      }
      el.innerHTML = head + esc(text);
    },
  };
</script></body></html>`;

/** 依內容挑顏色：✓／成功 綠、✖／revert／拒 紅、▶ 黃。 */
function kindOf(line) {
  if (/^\s*#/.test(line)) return 'comment';
  if (/✖|revert|被拒|status 0|HTTP 4\d\d|error|失敗/i.test(line)) return 'bad';
  if (/✓|status 1|HTTP 200|成功/.test(line)) return 'ok';
  if (/^\s*▶/.test(line)) return 'info';
  return 'out';
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {{ log: (m: string) => void, onTx: (hash: string) => void }} opts
 */
export async function createTerminal(context, { log, onTx }) {
  const page = await context.newPage();
  await page.setContent(HTML);

  const call = (fn, ...args) => page.evaluate(([f, a]) => window.__term[f](...a), [fn, args]).catch(() => {});

  return {
    page,
    async clear(title) {
      await call('clear');
      if (title) await call('title', title);
    },
    async comment(text) {
      await call('addMany', String(text).split('\n').map((l) => ['comment', `# ${l}`]), 60);
    },
    /**
     * 執行一個指令並把輸出串流到畫面。回傳 { code, output, txHashes }。
     * @param {string} cmd   交給 bash -c 執行的實際指令
     * @param {{ display?: string, cwd?: string, cwdLabel?: string, env?: Record<string,string>,
     *           typeDelay?: number, allowFail?: boolean, timeout?: number }} [o]
     */
    async run(cmd, o = {}) {
      await page.evaluate((c) => { window.__cwd = c; }, o.cwdLabel ?? '~/pepelab_onchain_cfd');
      const display = o.display ?? cmd;
      // 逐字打出指令（觀眾看得到在打什麼）：在頁面裡跑動畫，只花一次 evaluate（record.mjs 有 slowMo）
      await page.evaluate(([t, d]) => window.__term.type(t, d), [display, o.typeDelay ?? 22]).catch(() => {});
      await new Promise((r) => setTimeout(r, 400));

      log(`$ ${display}`);
      const env = { PATH: `${process.env.PATH}:${process.env.HOME}/.foundry/bin`, HOME: process.env.HOME, LANG: 'zh_TW.UTF-8', TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0', ...(o.env ?? {}) };
      const child = spawn('bash', ['-c', cmd], { cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const txHashes = [];
      const queue = [];
      // stdout 與 stderr 各自一個緩衝：交錯到達的片段不會被拼成同一行
      const bufs = { out: '', err: '' };
      let pumping = Promise.resolve();
      const pump = () => {
        if (!queue.length) return;
        const items = queue.splice(0, queue.length);
        pumping = pumping.then(() => call('addMany', items, 35));
      };
      const pumpTimer = setInterval(pump, 250);
      const flush = (which, final) => {
        const parts = bufs[which].split('\n');
        bufs[which] = final ? '' : parts.pop();
        for (const raw of parts) {
          const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
          if (final && line === '') continue;
          output += line + '\n';
          for (const m of line.matchAll(TX_RE)) {
            if (!txHashes.includes(m[1])) { txHashes.push(m[1]); onTx(m[1]); }
          }
          log(`  │ ${line}`);
          queue.push([kindOf(line), line]);
        }
      };
      child.stdout.on('data', (d) => { bufs.out += d; flush('out', false); });
      child.stderr.on('data', (d) => { bufs.err += d; flush('err', false); });
      const waitStart = Date.now();
      const code = await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGTERM'); }, o.timeout ?? 300_000);
        child.on('close', (c) => { clearTimeout(timer); resolve(c ?? 1); });
      });
      o.onWait?.({ label: o.waitLabel ?? '等待指令執行', start: waitStart, end: Date.now() });
      flush('out', true);
      flush('err', true);
      clearInterval(pumpTimer);
      pump();
      await pumping;
      if (code !== 0 && !o.allowFail) throw new Error(`指令失敗（exit ${code}）：${display}`);
      return { code, output, txHashes };
    },
  };
}
