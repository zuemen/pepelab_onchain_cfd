#!/usr/bin/env node
// 依劇本錄製 PoC 影片。
//
//   node record.mjs [--scenes scenes/rwa-poc.mjs] [--base http://localhost:5173]
//                   [--role investor] [--size 1920x1080] [--slowmo 400]
//                   [--allow-tx] [--no-sign] [--headed] [--rpc https://sepolia.base.org]
//
// 產出（scripts/poc/video/out/，已在 .gitignore）：
//   <scene>-<時間>.webm / .mp4   錄影（mp4 需要系統有 ffmpeg）
//   <scene>-<時間>.json          每步 {step, caption, txHash, url, timestamp}
//
// 預設唯讀：不加 --allow-tx（或 POC_ALLOW_TX=1）時，注入錢包會拒絕所有 eth_sendTransaction。
// 唯讀 ≠ 不簽章：personal_sign / eth_signTypedData_v4 預設照簽（不廣播），全部記進 JSON 的
// signatures；要連簽章都拒絕請加 --no-sign（或 POC_NO_SIGN=1）。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

import { installWallet, DEFAULT_RPC } from './wallet.mjs';
import { createOverlay, BASESCAN_TX } from './overlay.mjs';
import { createTerminal } from './terminal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');

const { values: args } = parseArgs({
  options: {
    scenes: { type: 'string', default: 'scenes/rwa-poc.mjs' },
    base: { type: 'string', default: process.env.POC_BASE_URL ?? 'http://localhost:5173' },
    role: { type: 'string' },
    size: { type: 'string', default: '1920x1080' },
    slowmo: { type: 'string', default: '400' },
    rpc: { type: 'string', default: process.env.POC_RPC_URL ?? DEFAULT_RPC },
    'allow-tx': { type: 'boolean', default: process.env.POC_ALLOW_TX === '1' },
    'no-sign': { type: 'boolean', default: process.env.POC_NO_SIGN === '1' },
    headed: { type: 'boolean', default: false },
    // 除錯用：只跑部分步驟（例如 1,10-14；第 1 步通常是連錢包，記得帶上）。正式錄影不要用。
    steps: { type: 'string' },
  },
});

const log = (msg) => console.log(`[poc-video] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const scenePath = path.resolve(HERE, args.scenes);
  const scene = (await import(pathToFileURL(scenePath).href)).default;
  if (!scene?.steps?.length) throw new Error(`劇本 ${args.scenes} 沒有 steps`);
  if (args.steps) {
    const keep = new Set();
    for (const part of args.steps.split(',')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= (b || a); i++) keep.add(i);
    }
    scene.steps = scene.steps.filter((_, i) => keep.has(i + 1));
  }

  const [width, height] = args.size.split('x').map(Number);
  const role = args.role ?? scene.role ?? 'investor';
  const allowSend = args['allow-tx'];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName = `${scene.name ?? path.basename(scenePath, '.mjs')}-${stamp}`;
  acquireLock(); // 先搶鎖，搶到才建暫存目錄
  const tmpVideoDir = path.join(OUT, '.tmp', `${baseName}-${process.pid}`);
  fs.mkdirSync(tmpVideoDir, { recursive: true });

  const allowSign = !args['no-sign'];
  log(`劇本 ${scene.name}（${scene.steps.length} 步），角色 ${role}，${allowSend ? '允許送交易（會上鏈）' : '唯讀模式（交易一律拒絕）'}，${allowSign ? '簽章：會簽（personal_sign / typed data，不廣播）' : '簽章：一律拒絕（--no-sign）'}`);

  const browser = await chromium.launch({ headless: !args.headed, slowMo: Number(args.slowmo) });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    locale: 'zh-TW',
    recordVideo: { dir: tmpVideoDir, size: { width, height } },
  });
  const appStart = Date.now();
  const page = await context.newPage();
  page.on('pageerror', (e) => log(`頁面錯誤：${e.message}`));

  const record = {
    scene: scene.name,
    base: args.base,
    startedAt: new Date().toISOString(),
    readOnly: !allowSend,
    signing: allowSign,
    steps: [],
    signatures: [],
    // 「等待區塊確認／節點同步／載入」的區段（毫秒，相對 t0Ms＝剪接後影片的 0 秒），給 postprocess.mjs 加速用
    waits: [],
  };
  const addWait = (w) => {
    if (w.end - w.start < 300) return;
    record.waits.push({ step: currentEntry?.step ?? null, label: w.label, startMs: w.start, endMs: w.end });
  };
  let currentEntry = null;

  // 每個簽章請求（核准或拒絕）都留紀錄：唯讀模式不廣播交易，但仍會簽章
  const onSign = (entry) => {
    const e = { step: currentEntry?.step ?? null, ...entry };
    record.signatures.push(e);
    if (currentEntry) (currentEntry.signatures ??= []).push(e);
  };
  const wallet = await installWallet(page, { role, origin: args.base, rpcUrl: args.rpc, allowSend, allowSign, onSign, log });
  const appOverlay = createOverlay(page);

  // 終端機分頁（CLI 步驟入鏡）。兩個分頁各自錄一支影片，結束後依 timeline 剪接成一支。
  const termStart = Date.now();
  const term = await createTerminal(context, {
    log,
    onTx: (hash) => { ctxRef.recordTx(hash); void overlay.tx(hash); },
  });
  const termOverlay = createOverlay(term.page);
  // 兩個分頁的字幕同步：caption／tx／note 同時畫在兩邊
  const overlay = {
    async caption(...a) { await Promise.all([appOverlay.caption(...a), termOverlay.caption(...a)]); },
    async tx(h) { await Promise.all([appOverlay.tx(h), termOverlay.tx(h)]); },
    async note(n) { await Promise.all([appOverlay.note(n), termOverlay.note(n)]); },
    async reapply() { await Promise.all([appOverlay.reapply(), termOverlay.reapply()]); },
    id: appOverlay.id,
  };
  const timeline = [{ view: 'app', t: Date.now() }];
  let view = 'app';
  async function show(next) {
    if (view === next) return;
    view = next;
    await (next === 'term' ? term.page : page).bringToFront();
    timeline.push({ view: next, t: Date.now() });
  }
  await page.bringToFront();

  const ctxRef = {};
  const ctx = Object.assign(ctxRef, {
    page,
    term,
    wallet,
    overlay,
    base: args.base,
    log,
    pause: sleep,
    /** 相對路徑導頁（/rwa）；完整 URL 也可。 */
    /** 標記一段「等待」（區塊確認、節點同步、載入），後製會加速並在畫面角落註明。 */
    async wait(label, fn) {
      const start = Date.now();
      try {
        return await fn();
      } finally {
        addWait({ label, start, end: Date.now() });
      }
    },
    /** 切到前端分頁（goto 會自動切）。 */
    showApp: () => show('app'),
    /** 切到終端機分頁；title 會清空畫面並換標題列。 */
    async showTerminal(title) {
      if (title !== undefined) await term.clear(title);
      await show('term');
    },
    /** 在終端機分頁執行指令，輸出逐行入鏡；`tx 0x…` 自動記進 JSON 並顯示在字幕列。 */
    async run(cmd, o = {}) {
      await show('term');
      const r = await term.run(cmd, { ...o, onWait: addWait });
      (currentEntry.commands ??= []).push({ display: o.display ?? cmd, exit: r.code, txHashes: r.txHashes, output: r.output.slice(-4000) });
      return r;
    },
    async goto(p) {
      await show('app');
      await ctx.wait('等待頁面載入', () => page.goto(new URL(p, args.base).href, { waitUntil: 'networkidle' }).catch(async (e) => {
        // vite dev 有 HMR websocket，networkidle 偶爾等不到；退回 load
        log(`networkidle 未達成（${e.message.split('\n')[0]}），改等 load`);
        await page.waitForLoadState('load');
      }));
      await overlay.reapply();
    },
    async switchRole(name) {
      const addr = await wallet.switchRole(name);
      if (currentEntry) currentEntry.role = name;
      return addr;
    },
    recordTx(hash) {
      if (!currentEntry) return;
      currentEntry.txHash = hash;
      (currentEntry.txHashes ??= []).push(hash);
      currentEntry.explorer = BASESCAN_TX + hash;
    },
    assert(cond, msg) {
      if (!cond) throw new Error(`檢查失敗：${msg}`);
    },
  });

  let failed = null;
  const total = scene.steps.length;
  for (let i = 0; i < total; i++) {
    const s = scene.steps[i];
    const step = i + 1;
    currentEntry = { step, caption: s.caption, role: wallet.role, txHash: null, url: null, timestamp: new Date().toISOString() };
    record.steps.push(currentEntry);
    log(`步驟 ${step}/${total}：${s.caption}`);
    try {
      await overlay.caption(step, total, s.caption, s.note);
      await sleep(s.lead ?? scene.lead ?? 1200); // 先讓觀眾讀字幕
      await s.run(ctx);
      await sleep(s.hold ?? scene.hold ?? 2000); // 停在結果畫面
    } catch (e) {
      failed = e;
      currentEntry.error = e.message;
      log(`步驟 ${step} 失敗：${e.message}`);
      await page.screenshot({ path: path.join(OUT, `${baseName}-fail-step${step}.png`) }).catch(() => {});
    }
    currentEntry.url = page.url();
    if (failed) break;
  }

  await sleep(1500);
  const endT = Date.now();
  record.finishedAt = new Date().toISOString();
  record.address = wallet.address;
  record.timeline = timeline.map((x) => ({ view: x.view, at: new Date(x.t).toISOString() }));
  record.t0Ms = timeline[0].t;
  record.endMs = endT;
  for (const e of record.steps) e.startMs = Date.parse(e.timestamp);

  const video = page.video();
  const termVideo = term.page.video();
  await context.close(); // 關 context 才會把影片寫完
  await browser.close();

  fs.mkdirSync(OUT, { recursive: true });
  const webm = path.join(OUT, `${baseName}-app.webm`);
  const termWebm = path.join(OUT, `${baseName}-terminal.webm`);
  fs.renameSync(await video.path(), webm);
  fs.renameSync(await termVideo.path(), termWebm);
  // 只清自己的暫存目錄：同時有另一次錄影時，清掉整個 .tmp 會刪掉它還沒寫完的影片
  fs.rmSync(tmpVideoDir, { recursive: true, force: true });
  record.video = { app: path.relative(HERE, webm), terminal: path.relative(HERE, termWebm) };

  const mp4 = path.join(OUT, `${baseName}.mp4`);
  if (hasFfmpeg()) {
    log('ffmpeg 依 timeline 剪接兩個分頁 → mp4…');
    const segs = [];
    for (let i = 0; i < timeline.length; i++) {
      const from = timeline[i].t;
      const to = i + 1 < timeline.length ? timeline[i + 1].t : endT;
      if (to - from < 50) continue;
      const start = (timeline[i].view === 'app' ? appStart : termStart);
      segs.push({ input: timeline[i].view === 'app' ? 0 : 1, a: (from - start) / 1000, b: (to - start) / 1000 });
    }
    const filter = segs.map((g, i) => `[${g.input}:v]trim=start=${g.a.toFixed(3)}:end=${g.b.toFixed(3)},setpts=PTS-STARTPTS,fps=25,scale=${width}:${height},setsar=1[s${i}]`).join(';')
      + ';' + segs.map((_, i) => `[s${i}]`).join('') + `concat=n=${segs.length}:v=1:a=0[out]`;
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-i', termWebm, '-filter_complex', filter, '-map', '[out]',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium', '-movflags', '+faststart', mp4]);
    record.video.mp4 = path.relative(HERE, mp4);
    record.video.segments = segs.length;
  } else {
    log('系統沒有 ffmpeg，只輸出兩個分頁各自的 webm（brew install ffmpeg 後可重跑）');
  }

  const jsonPath = path.join(OUT, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2) + '\n');
  log(`影片：${record.video.mp4 ?? record.video.webm}`);
  log(`紀錄：${path.relative(HERE, jsonPath)}`);

  if (failed) process.exitCode = 1;
}

/**
 * 同一個 out/ 同時只允許一個錄影行程（兩個行程會搶同一個公開 RPC、同一把錢包的 nonce，
 * 舊版還會互相清掉暫存影片）。鎖檔記 pid；pid 已不存在就視為殘留、接手。
 */
const LOCK = path.join(OUT, '.record.lock');
function acquireLock() {
  fs.mkdirSync(OUT, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 'wx'：檔案已存在就失敗——建立與檢查是同一個原子操作，兩個行程不會同時拿到鎖
      const fd = fs.openSync(LOCK, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      process.on('exit', () => {
        try { if (Number(fs.readFileSync(LOCK, 'utf8')) === process.pid) fs.rmSync(LOCK); } catch { /* 已不存在 */ }
      });
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const pid = Number(fs.readFileSync(LOCK, 'utf8').trim());
    let alive = false;
    if (pid) {
      try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    }
    if (alive) throw new Error(`另一個錄影行程（pid ${pid}）正在跑；等它結束再錄（鎖檔 ${LOCK}）`);
    fs.rmSync(LOCK, { force: true }); // 殘留的鎖（行程已不在）：清掉再搶一次
  }
  throw new Error(`拿不到錄影鎖（${LOCK}）`);
}

function hasFfmpeg() {
  return spawnSync('which', ['ffmpeg']).status === 0;
}

main().catch((e) => {
  console.error(`[poc-video] 失敗：${e.message}`);
  process.exit(1);
});
