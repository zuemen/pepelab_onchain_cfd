#!/usr/bin/env node
// RWA PoC：本機狀態清單主機（docs/tenants/rwa-poc/POC_SCRIPT.md §2）。不需要任何外部套件。
//
//   node scripts/poc/rwa-poc-status-server.mjs --mount investor=agent/.state/public-status/investor \
//        --mount vc=agent/.state/rwa-poc/vc-status [--port 8787]
//
//   GET http://localhost:8787/<mount>/<檔名>.json → 對應目錄裡的檔案
//
// 刻意做得很窄：
//   - 只綁 127.0.0.1（同一區網的機器連不到）。
//   - 只服務 GET／HEAD／OPTIONS；只回 `<mount>/<檔名>.json` 這種一層的路徑（檔名限 [A-Za-z0-9._-]），
//     不列目錄、不跟隨 symlink 到目錄外、不轉址（前端用 redirect: 'manual'）。
//   - CORS：Access-Control-Allow-Origin: *（清單本來就是公開資料）；Cache-Control: no-store（撤銷要立即看得到）。
//   - 檔案不存在回 404：前端與驗證端都把 404 解讀成「這個發證者沒有發佈清單」。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    mount: { type: 'string', multiple: true, default: [] },
    port: { type: 'string', default: '8787' },
  },
});

const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('✖ --port 必須是 1–65535 的整數');
  process.exit(2);
}
const mounts = new Map();
for (const m of values.mount) {
  const i = m.indexOf('=');
  const name = m.slice(0, i);
  const dir = m.slice(i + 1);
  if (i <= 0 || !/^[a-z0-9-]+$/.test(name) || !dir) {
    console.error(`✖ --mount 格式是 <名稱>=<目錄>（名稱限小寫英數與 -）：${m}`);
    process.exit(2);
  }
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    console.error(`✖ 目錄不存在：${abs}`);
    process.exit(2);
  }
  mounts.set(name, fs.realpathSync(abs));
}
if (mounts.size === 0) {
  console.error('✖ 至少要一個 --mount <名稱>=<目錄>');
  process.exit(2);
}

const FILE = /^\/([a-z0-9-]+)\/([A-Za-z0-9._-]+\.json)$/;
const MAX_BYTES = 1024 * 1024;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const done = (code, body = '') => {
    res.statusCode = code;
    res.end(body);
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} → ${code}`);
  };
  if (req.method === 'OPTIONS') return done(204);
  if (req.method !== 'GET' && req.method !== 'HEAD') return done(405);
  let pathname;
  try {
    pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    return done(400);
  }
  const m = FILE.exec(pathname);
  if (!m || !mounts.has(m[1]) || m[2].startsWith('.')) return done(404);
  const root = mounts.get(m[1]);
  const file = path.join(root, m[2]);
  let real;
  try {
    real = fs.realpathSync(file);
  } catch {
    return done(404);
  }
  if (path.dirname(real) !== root) return done(404); // symlink 指到目錄外
  const st = fs.statSync(real);
  if (!st.isFile() || st.size > MAX_BYTES) return done(404);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', String(st.size));
  if (req.method === 'HEAD') return done(200);
  return done(200, fs.readFileSync(real));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`▶ 狀態清單主機 http://127.0.0.1:${port}（只綁本機、CORS *、no-store）`);
  for (const [name, dir] of mounts) console.log(`  /${name}/<檔名>.json → ${dir}`);
});
