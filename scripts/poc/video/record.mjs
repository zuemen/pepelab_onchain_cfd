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
  },
});

const log = (msg) => console.log(`[poc-video] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const scenePath = path.resolve(HERE, args.scenes);
  const scene = (await import(pathToFileURL(scenePath).href)).default;
  if (!scene?.steps?.length) throw new Error(`劇本 ${args.scenes} 沒有 steps`);

  const [width, height] = args.size.split('x').map(Number);
  const role = args.role ?? scene.role ?? 'investor';
  const allowSend = args['allow-tx'];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName = `${scene.name ?? path.basename(scenePath, '.mjs')}-${stamp}`;
  const tmpVideoDir = path.join(OUT, '.tmp', baseName);
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
  };
  let currentEntry = null;

  // 每個簽章請求（核准或拒絕）都留紀錄：唯讀模式不廣播交易，但仍會簽章
  const onSign = (entry) => {
    const e = { step: currentEntry?.step ?? null, ...entry };
    record.signatures.push(e);
    if (currentEntry) (currentEntry.signatures ??= []).push(e);
  };
  const wallet = await installWallet(page, { role, origin: args.base, rpcUrl: args.rpc, allowSend, allowSign, onSign, log });
  const overlay = createOverlay(page);

  const ctx = {
    page,
    wallet,
    overlay,
    base: args.base,
    log,
    pause: sleep,
    /** 相對路徑導頁（/rwa）；完整 URL 也可。 */
    async goto(p) {
      await page.goto(new URL(p, args.base).href, { waitUntil: 'networkidle' }).catch(async (e) => {
        // vite dev 有 HMR websocket，networkidle 偶爾等不到；退回 load
        log(`networkidle 未達成（${e.message.split('\n')[0]}），改等 load`);
        await page.waitForLoadState('load');
      });
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
  };

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
      await sleep(s.lead ?? 1200); // 先讓觀眾讀字幕
      await s.run(ctx);
      await sleep(s.hold ?? 2000); // 停在結果畫面
    } catch (e) {
      failed = e;
      currentEntry.error = e.message;
      log(`步驟 ${step} 失敗：${e.message}`);
      await page.screenshot({ path: path.join(OUT, `${baseName}-fail-step${step}.png`) }).catch(() => {});
    }
    currentEntry.url = page.url();
    if (failed) break;
  }

  record.finishedAt = new Date().toISOString();
  record.address = wallet.address;

  const video = page.video();
  await context.close(); // 關 context 才會把影片寫完
  await browser.close();

  fs.mkdirSync(OUT, { recursive: true });
  const webm = path.join(OUT, `${baseName}.webm`);
  fs.renameSync(await video.path(), webm);
  fs.rmSync(path.join(OUT, '.tmp'), { recursive: true, force: true });
  record.video = { webm: path.relative(HERE, webm) };

  const mp4 = path.join(OUT, `${baseName}.mp4`);
  if (hasFfmpeg()) {
    log('ffmpeg 轉檔 webm → mp4…');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', webm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium', '-movflags', '+faststart', mp4]);
    record.video.mp4 = path.relative(HERE, mp4);
  } else {
    log('系統沒有 ffmpeg，只輸出 webm（brew install ffmpeg 後可重跑或手動轉檔）');
  }

  const jsonPath = path.join(OUT, `${baseName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(record, null, 2) + '\n');
  log(`影片：${record.video.mp4 ?? record.video.webm}`);
  log(`紀錄：${path.relative(HERE, jsonPath)}`);

  if (failed) process.exitCode = 1;
}

function hasFfmpeg() {
  return spawnSync('which', ['ffmpeg']).status === 0;
}

main().catch((e) => {
  console.error(`[poc-video] 失敗：${e.message}`);
  process.exit(1);
});
