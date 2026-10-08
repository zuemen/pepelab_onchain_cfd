#!/usr/bin/env node
// PoC 影片後製：片頭卡＋（可選：替換某一景）＋等待區段加速＋片尾卡 → 成片 mp4。
//
//   node postprocess.mjs --main out/<完整版>.json [--replace-scene 6=out/<補拍>.json[+out/<續段>.json]] [--resume-at <秒>]
//                        [--out out/PepeLab-RWA-SSI-PoC-final.mp4] [--frames]
//
// 等待區段：record.mjs 在 JSON 的 waits 記下「等待區塊確認／節點同步／載入／指令執行」的時間（毫秒）。
// 這裡把它們合併後依長度加速（≤ 8 秒 ×4、≤ 20 秒 ×6、更長 ×8；短於 2.5 秒不動），
// 並在右上角疊「⏩ <原因>（加速 ×N）」誠實標示。其餘畫面（字幕、結果、tx）全部原速保留，不剪任何片段。
//
// 替換某一景：把主影片裡字幕以「第 N 景」開頭的那幾步，整段換成另一次錄影（同樣從第一步開始到結束）。
// 用在代理人入金後只補錄第 6 景（docs/tenants/rwa-poc/POC_SCRIPT.md「補拍流程」）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    main: { type: 'string' },
    'replace-scene': { type: 'string' },
    'resume-at': { type: 'string' },
    out: { type: 'string', default: path.join('out', 'PepeLab-RWA-SSI-PoC-final.mp4') },
    frames: { type: 'boolean', default: false },
  },
});
if (!args.main) {
  console.error('用法：node postprocess.mjs --main out/<完整版>.json [--replace-scene 6=out/<補拍>.json[+out/<續段>.json]]');
  process.exit(2);
}
const log = (m) => console.log(`[post] ${m}`);
const W = 1920;
const H = 1080;
const FPS = 25;
const ENC = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium', '-r', String(FPS), '-an'];
const REPO = 'https://github.com/zuemen/pepelab_onchain_cfd';

const load = (p) => {
  const r = JSON.parse(fs.readFileSync(path.resolve(p), 'utf8'));
  if (!r.video?.mp4 || r.t0Ms == null) throw new Error(`${p} 沒有 mp4 或 t0Ms（請用新版 record.mjs 錄）`);
  r.mp4 = path.resolve(HERE, r.video.mp4);
  return r;
};
const main = load(args.main);
const sec = (r, ms) => (ms - r.t0Ms) / 1000;
const sceneOf = (caption) => Number(/^第 (\d+) 景/.exec(caption ?? '')?.[1] ?? 0);

// ── 1. 片段：主影片（可能挖掉某一景換成補拍）────────────────────────────────
/** @type {{ rec: any, a: number, b: number }[]} 秒，相對各自影片 */
let pieces = [{ rec: main, a: 0, b: sec(main, main.endMs) }];
if (args['replace-scene']) {
  // 可用 + 串接多段補拍（依序接上），例如 6=out/實付.json+out/超額.json
  const [n, files] = args['replace-scene'].split('=');
  const reps = files.split('+').map(load);
  const idx = main.steps.map((s, i) => (sceneOf(s.caption) === Number(n) ? i : -1)).filter((i) => i >= 0);
  if (!idx.length) throw new Error(`主影片沒有第 ${n} 景`);
  const a = sec(main, main.steps[idx[0]].startMs);
  const next = main.steps[idx.at(-1) + 1];
  let b = next ? sec(main, next.startMs) : sec(main, main.endMs);
  // 接回主影片時，下一景開頭若還停在被換掉那一景的終端機畫面，要從終端機清畫面那一刻接，
  // 否則會露出舊的輸出。新錄影有 termClearsMs 可自動找；舊錄影用 --resume-at <主影片秒數> 指定。
  const viewAt = (t) => (main.timeline ?? []).filter((x) => sec(main, Date.parse(x.at)) <= t).at(-1)?.view;
  if (args['resume-at'] != null) {
    const r = Number(args['resume-at']);
    if (!(r >= b && r < b + 15)) throw new Error(`--resume-at ${r} 要在下一景開頭 ${b.toFixed(1)} 秒之後 15 秒內`);
    b = r;
  } else if (next && viewAt(b) === 'term') {
    const c = (main.termClearsMs ?? []).map((ms) => sec(main, ms)).find((t) => t >= b && t < b + 15);
    if (c != null) b = c;
    else log(`⚠ 第 ${n} 景之後接回時終端機可能還是舊畫面；舊錄影請用 --resume-at 指定清畫面的秒數`);
  }
  pieces = [
    { rec: main, a: 0, b: a },
    ...reps.map((rep) => ({ rec: rep, a: sec(rep, rep.steps[0].startMs), b: sec(rep, rep.endMs) })),
    { rec: main, a: b, b: sec(main, main.endMs) },
  ];
  log(`第 ${n} 景：主影片 ${a.toFixed(1)}–${b.toFixed(1)} 秒換成 ${files.split('+').map((f) => path.basename(f)).join(' ＋ ')}`);
}

// ── 2. 每個片段切成「原速／加速」小段 ─────────────────────────────────────────
const factorFor = (d) => (d < 2.5 ? 1 : d <= 8 ? 4 : d <= 20 ? 6 : 8);
function waitsIn(rec, a, b) {
  const ws = (rec.waits ?? [])
    .map((w) => ({ a: Math.max(a, sec(rec, w.startMs)), b: Math.min(b, sec(rec, w.endMs)), label: w.label }))
    .filter((w) => w.b - w.a > 0)
    .sort((x, y) => x.a - y.a);
  const merged = [];
  for (const w of ws) {
    const last = merged.at(-1);
    if (last && w.a <= last.b + 0.3) {
      if (w.b > last.b) last.b = w.b;
      // 合併時以「區塊確認」優先（最能說明為什麼在等），其次是先出現的那個
      if (w.label === '等待區塊確認') last.label = w.label;
    } else merged.push({ ...w });
  }
  return merged;
}
const segs = [];
for (const p of pieces) {
  let t = p.a;
  for (const w of waitsIn(p.rec, p.a, p.b)) {
    const f = factorFor(w.b - w.a);
    if (f === 1) continue;
    if (w.a > t) segs.push({ src: p.rec.mp4, a: t, b: w.a, f: 1 });
    segs.push({ src: p.rec.mp4, a: w.a, b: w.b, f, label: w.label });
    t = w.b;
  }
  if (p.b > t) segs.push({ src: p.rec.mp4, a: t, b: p.b, f: 1 });
}
const srcDur = segs.reduce((s, g) => s + (g.b - g.a), 0);
const outDur = segs.reduce((s, g) => s + (g.b - g.a) / g.f, 0);
log(`原長 ${srcDur.toFixed(0)} 秒 → 加速後 ${outDur.toFixed(0)} 秒（${segs.filter((g) => g.f > 1).length} 段加速）`);

// ── 3. 卡片與加速標籤（HTML → PNG）───────────────────────────────────────────
const WORK = path.join(HERE, 'out', '.post');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });

const FONT = '"PingFang TC","Noto Sans TC","Microsoft JhengHei",system-ui,sans-serif';
const MONO = '"JetBrains Mono","SF Mono",Menlo,ui-monospace,monospace';
const BASE_CSS = `html,body{margin:0;width:${W}px;height:${H}px;background:#0b0f17;color:#e5e7eb;font-family:${FONT}}
  .wrap{position:absolute;inset:0;padding:96px 140px;box-sizing:border-box;background:radial-gradient(1200px 600px at 15% 0%,rgba(34,197,94,.14),transparent 60%),#0b0f17}
  .tag{display:inline-block;padding:6px 16px;border-radius:999px;background:#22c55e;color:#052e16;font-weight:800;font-size:22px}
  .mono{font-family:${MONO}} .muted{color:#9ca3af} .green{color:#86efac}
  .bar{height:4px;width:180px;background:#22c55e;border-radius:4px;margin:28px 0}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const shortTx = (h) => `sepolia.basescan.org/tx/${h.slice(0, 10)}…${h.slice(-6)}`;

const recDate = main.startedAt.slice(0, 10);
const introHtml = `<style>${BASE_CSS}</style><div class="wrap">
  <span class="tag">PoC 錄影</span>
  <div style="font-size:84px;font-weight:800;margin-top:40px;letter-spacing:1px">PepeLab RWA＋SSI PoC</div>
  <div class="bar"></div>
  <div style="font-size:38px;line-height:1.5">可驗證憑證（SSI）接上 RWA 衍生品的開倉資格與 AI 代理人委託：<br>合格投資人 VC → 鏈上准入、委託憑證 v3 → 有上限的代理人、x402 Know-Your-Agent、休市與撤銷。</div>
  <div style="margin-top:56px;font-size:30px" class="mono green">Base Sepolia（chainId 84532）測試網 · 錄製 ${recDate}（UTC）</div>
  <div style="position:absolute;left:140px;right:140px;bottom:96px;padding:22px 28px;border:1px solid rgba(245,181,69,.6);border-radius:14px;background:rgba(245,181,69,.08);font-size:28px;color:#fde68a">
    ⚠ 測試網研究原型，非真實金融商品。保證金與代幣皆為測試用途；發證者與見證者是 PoC 團隊自己的測試錢包，不代表任何真實身分審查或投資建議。</div>
</div>`;

const SCENES = [
  '發證者以 keystore 簽發合格投資人 VC（離線）',
  '未持證開 sGOLD：前端擋下、鏈上 NotKycVerified',
  '/credentials 上傳、本地驗證、送上鏈',
  '持證後 sGOLD 開倉成功',
  'session 上限＋委託憑證 v3＋鏈上錨定',
  'x402 KYA：不帶 VP／超額 被拒（實付待補拍）',
  '代理人額度內下單；超額 MarginExceedsPerTradeCap',
  '休市 ReduceOnly：開倉 AssetNotActive',
  '撤銷資格：投資人與代理人都被拒、平倉成功',
  '/rwa、/oracle、/solvency 揭露',
];
if (args['replace-scene']?.startsWith('6=')) SCENES[5] = 'x402 KYA：不帶 VP 被拒、實付成功、累計超額被拒';
const allRecs = [...new Set(pieces.map((p) => p.rec))];
const keyTx = [];
for (const r of allRecs) {
  for (const s of r.steps) {
    const n = sceneOf(s.caption);
    for (const h of [...new Set(s.txHashes ?? [])]) if (n && !keyTx.some((k) => k.h === h)) keyTx.push({ n, h });
  }
}
keyTx.sort((x, y) => x.n - y.n);
const outroHtml = `<style>${BASE_CSS} li{margin:6px 0} .grid{display:grid;grid-template-columns:1.05fr 1fr;gap:56px;margin-top:30px}</style><div class="wrap" style="padding-top:72px">
  <span class="tag">摘要</span><span style="font-size:44px;font-weight:800;margin-left:20px;vertical-align:middle">PepeLab RWA＋SSI PoC · 10 景</span>
  <div class="grid">
    <ol style="font-size:25px;line-height:1.45;margin:0;padding-left:34px">${SCENES.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
    <div><div class="muted" style="font-size:22px;margin-bottom:8px">鏈上交易（BaseScan）</div>
      <div class="mono" style="font-size:19px;line-height:1.6">${keyTx.map((k) => `<div><span class="green">第 ${k.n} 景</span> ${esc(shortTx(k.h))}</div>`).join('')}</div></div>
  </div>
  <div style="position:absolute;left:140px;right:140px;bottom:72px;font-size:26px;line-height:1.6">
    <div class="mono green">${REPO}</div>
    <div class="muted">文件：docs/tenants/rwa-poc/（POC_SCRIPT.md 有每筆交易的完整連結）· Base Sepolia 測試網研究原型，非真實金融商品</div></div>
</div>`;

const badgeHtml = (label, f) => `<style>html,body{margin:0;background:transparent}
  .b{display:inline-block;padding:12px 22px;border-radius:12px;background:rgba(12,17,29,.86);border:2px solid #22c55e;color:#bbf7d0;font:700 26px ${FONT}}</style>
  <span class="b">⏩ ${esc(label)}（加速 ×${f}）</span>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
async function png(html, file, { transparent = false, clip } = {}) {
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  if (clip) {
    const box = await page.locator('.b').boundingBox();
    await page.screenshot({ path: file, omitBackground: transparent, clip: { x: 0, y: 0, width: Math.ceil(box.width) + 2, height: Math.ceil(box.height) + 2 } });
  } else await page.screenshot({ path: file, omitBackground: transparent });
}
await png(introHtml, path.join(WORK, 'intro.png'));
await png(outroHtml, path.join(WORK, 'outro.png'));
const badges = new Map();
for (const g of segs.filter((x) => x.f > 1)) {
  const key = `${g.label}|${g.f}`;
  if (badges.has(key)) continue;
  const f = path.join(WORK, `badge-${badges.size}.png`);
  await png(badgeHtml(g.label, g.f), f, { transparent: true, clip: true });
  badges.set(key, f);
}
await browser.close();

// ── 4. 逐段編碼，再 concat ────────────────────────────────────────────────────
const ff = (a) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a]);
const parts = [];
const card = (img, dur, name) => {
  const out = path.join(WORK, name);
  ff(['-loop', '1', '-t', String(dur), '-i', img, '-vf', `fps=${FPS},scale=${W}:${H},format=yuv420p,fade=t=in:st=0:d=0.6,fade=t=out:st=${dur - 0.6}:d=0.6`, ...ENC, out]);
  return out;
};
parts.push(card(path.join(WORK, 'intro.png'), 6, 'p-000-intro.mp4'));
segs.forEach((g, i) => {
  const out = path.join(WORK, `p-${String(i + 1).padStart(3, '0')}.mp4`);
  const d = (g.b - g.a).toFixed(3);
  if (g.f === 1) {
    ff(['-ss', g.a.toFixed(3), '-t', d, '-i', g.src, '-vf', `fps=${FPS},scale=${W}:${H},setsar=1`, ...ENC, out]);
  } else {
    const badge = badges.get(`${g.label}|${g.f}`);
    ff(['-ss', g.a.toFixed(3), '-t', d, '-i', g.src, '-i', badge, '-filter_complex',
      `[0:v]setpts=PTS/${g.f},fps=${FPS},scale=${W}:${H},setsar=1[v];[v][1:v]overlay=W-w-36:96[o]`, '-map', '[o]', ...ENC, out]);
  }
  parts.push(out);
});
parts.push(card(path.join(WORK, 'outro.png'), 10, 'p-999-outro.mp4'));

const list = path.join(WORK, 'list.txt');
fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n') + '\n');
const out = path.resolve(HERE, args.out);
ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out]);
const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
log(`成片：${path.relative(process.cwd(), out)}（${Math.floor(dur / 60)} 分 ${Math.round(dur % 60)} 秒）`);

// ── 5. 關鍵畫面（給人工檢查）─────────────────────────────────────────────────
if (args.frames) {
  // 成片時間軸：片頭 6 秒 + 各段加速後長度；找出每景第一筆 tx 所在的段落換算時間
  const at = (rec, ms) => {
    let t = 6;
    for (const g of segs) {
      const s = sec(rec, ms);
      if (g.src === rec.mp4 && s >= g.a && s < g.b) return t + (s - g.a) / g.f;
      t += (g.b - g.a) / g.f;
    }
    return null;
  };
  const picks = [['intro', 3]];
  const want = [3, 5, 8, 9];
  for (const n of want) {
    const s = main.steps.filter((x) => sceneOf(x.caption) === n).at(-1);
    const next = main.steps[main.steps.indexOf(s) + 1];
    const t = next ? at(main, next.startMs - 1500) : null;
    if (t) picks.push([`scene${n}`, t]);
  }
  picks.push(['outro', dur - 4]);
  for (const [name, t] of picks) {
    const f = path.join(path.dirname(out), `keyframe-${name}.png`);
    ff(['-ss', t.toFixed(2), '-i', out, '-frames:v', '1', f]);
    log(`關鍵畫面 ${path.basename(f)} @ ${t.toFixed(1)} 秒`);
  }
}
