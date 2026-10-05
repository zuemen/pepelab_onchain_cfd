#!/usr/bin/env node
// besu/scripts/oracle-pusher.mjs
// 模擬「機構內部行情源」定期把價格寫進鏈上 MockOracle。
//
// 寫價走 MockOracle 既有的 `updatePrice(bytes32 assetId, uint256 newPrice)`（onlyOwner）。
// deploy.sh 已把 MockOracle 的 owner 轉給本機產生的 oracle 帳戶，所以只有它簽的交易寫得進去；
// 本腳本啟動時會先讀 owner() 比對，不是授權帳戶就直接拒絕，不會送出注定失敗的交易。
//
// 三種行情來源（擇一）：
//   GBM（預設）   幾何布朗運動隨機價，種子固定 → 每次重跑同一串價格（可重播）
//   --replay 檔案  CSV 價格檔，每行 `symbol,price`（美元，最多 8 位小數），依序每個 tick 推一行
//   --set         一次性指定價格，例如 --set sBTC=41500 --set sETH=2800.5，推完即結束
//
// 用法：
//   node scripts/oracle-pusher.mjs                               # GBM，sBTC+sETH，每 5 秒
//   node scripts/oracle-pusher.mjs --interval 2 --sigma 0.8 --seed 7 --assets sBTC
//   node scripts/oracle-pusher.mjs --replay prices.csv --interval 3
//   node scripts/oracle-pusher.mjs --set sBTC=41500 --once
//   node scripts/oracle-pusher.mjs --ticks 10 --json             # 跑 10 個 tick，輸出 JSON 行
//
// 環境變數：BESU_RPC_URL（預設 http://127.0.0.1:8545）、ORACLE_INTERVAL（秒，被 --interval 覆寫）、
//           BESU_ORACLE_PRIVATE_KEY（覆寫 network/accounts.json 的 oracle 帳戶；只給本地鏈用）。

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  assetId, fmtPrice8, gbmStep, loadAbi, loadAccounts, loadDeployment, makeClients,
  makeNormal, mulberry32, parseReplay, usdToPrice8,
} from './lib.mjs';

/** 讀鏈上目前價格（8 位小數）與更新時間。 */
export async function readPrice(ctx, oracle, symbol) {
  const abi = loadAbi('MockOracle');
  const [price, updatedAt] = await ctx.publicClient.readContract({
    address: oracle, abi, functionName: 'getPrice', args: [assetId(symbol)],
  });
  return { price, updatedAt };
}

/** 確認簽名帳戶就是 MockOracle 的 owner（授權寫價者）。 */
export async function assertOracleSigner(ctx, oracle) {
  const abi = loadAbi('MockOracle');
  const owner = await ctx.publicClient.readContract({ address: oracle, abi, functionName: 'owner' });
  if (owner.toLowerCase() !== ctx.account.address.toLowerCase()) {
    throw new Error(`簽名帳戶 ${ctx.account.address} 不是 MockOracle 的 owner（${owner}），無權寫價。`);
  }
}

/**
 * 推一批價格：[{ symbol, price8 }]。同一批交易用連號 nonce 一次送出、再一起等收據，
 * 這樣一個 tick 的多個資產通常落在同一個區塊。任何一筆失敗都丟錯。
 */
export async function pushPrices(ctx, oracle, updates) {
  const abi = loadAbi('MockOracle');
  const { publicClient, walletClient, account } = ctx;
  let nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });
  const hashes = [];
  for (const { symbol, price8 } of updates) {
    // 先模擬：資產不存在／價格為 0／不是 owner 時在這裡就拿到 revert 原因。
    const { request } = await publicClient.simulateContract({
      address: oracle, abi, functionName: 'updatePrice', args: [assetId(symbol), price8], account,
    });
    hashes.push({ symbol, price8, hash: await walletClient.writeContract({ ...request, nonce }) });
    nonce += 1;
  }
  const results = [];
  for (const h of hashes) {
    const r = await publicClient.waitForTransactionReceipt({ hash: h.hash, timeout: 60_000 });
    if (r.status !== 'success') throw new Error(`updatePrice(${h.symbol}) 交易失敗：${h.hash}`);
    results.push({ symbol: h.symbol, price8: h.price8, block: r.blockNumber, hash: h.hash });
  }
  return results;
}

/**
 * 價格來源：回傳一個 next() 函式，每呼叫一次給出下一個 tick 要推的 [{symbol, price8}]；
 * 回傳 null 代表來源用完（replay 檔到底）。
 */
export function makeSource({ mode, assets, startPrices, seed, mu, sigma, intervalSeconds, replayRows }) {
  if (mode === 'replay') {
    let i = 0;
    return () => (i < replayRows.length ? [replayRows[i++]] : null);
  }
  const normal = makeNormal(mulberry32(seed));
  const cur = { ...startPrices };
  return () => assets.map((symbol) => {
    cur[symbol] = gbmStep(cur[symbol], { mu, sigma, dtSeconds: intervalSeconds, z: normal() });
    return { symbol, price8: cur[symbol] };
  });
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      assets: { type: 'string', default: 'sBTC,sETH' },
      interval: { type: 'string', default: process.env.ORACLE_INTERVAL || '5' },
      sigma: { type: 'string', default: '0.6' },
      mu: { type: 'string', default: '0' },
      seed: { type: 'string', default: '42' },
      replay: { type: 'string' },
      set: { type: 'string', multiple: true },
      ticks: { type: 'string' },
      once: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  return values;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const opt = parseCli(process.argv.slice(2));
  if (opt.help) {
    console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
    return;
  }
  const accounts = loadAccounts();
  const privateKey = process.env.BESU_ORACLE_PRIVATE_KEY || accounts.oracle.privateKey;
  const ctx = await makeClients({ privateKey });
  const dep = loadDeployment(ctx.chainId);
  const oracle = dep.contracts.MockOracle;
  await assertOracleSigner(ctx, oracle);

  const log = (obj, text) => console.log(opt.json ? JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) : text);

  // 一次性指定價格
  if (opt.set?.length) {
    const updates = opt.set.map((s) => {
      const [symbol, usd] = s.split('=');
      if (!symbol || !usd) throw new Error(`--set 格式應為 SYMBOL=PRICE，收到「${s}」`);
      return { symbol, price8: usdToPrice8(usd) };
    });
    for (const r of await pushPrices(ctx, oracle, updates)) {
      log({ event: 'price', ...r }, `[oracle] ${r.symbol} → ${fmtPrice8(r.price8)}（block ${r.block}）`);
    }
    return;
  }

  const assets = opt.assets.split(',').map((s) => s.trim()).filter(Boolean);
  const intervalSeconds = Number(opt.interval);
  if (!(intervalSeconds > 0)) throw new Error(`--interval 必須大於 0，收到 ${opt.interval}`);
  const startPrices = {};
  for (const a of assets) startPrices[a] = (await readPrice(ctx, oracle, a)).price;

  const source = makeSource({
    mode: opt.replay ? 'replay' : 'gbm',
    assets,
    startPrices,
    seed: Number(opt.seed),
    mu: Number(opt.mu),
    sigma: Number(opt.sigma),
    intervalSeconds,
    replayRows: opt.replay ? parseReplay(readFileSync(opt.replay, 'utf8')) : [],
  });
  const maxTicks = opt.once ? 1 : opt.ticks ? Number(opt.ticks) : Infinity;
  log({ event: 'start', oracle, signer: ctx.account.address, assets, intervalSeconds },
    `[oracle] 推價開始：oracle=${oracle} signer=${ctx.account.address} 間隔 ${intervalSeconds}s `
    + `${opt.replay ? `replay=${opt.replay}` : `GBM σ=${opt.sigma} μ=${opt.mu} seed=${opt.seed}`}`);

  let stop = false;
  process.on('SIGINT', () => { stop = true; });
  process.on('SIGTERM', () => { stop = true; });
  for (let tick = 1; tick <= maxTicks && !stop; tick++) {
    const t0 = Date.now();
    const updates = source();
    if (!updates) { log({ event: 'replay-end' }, '[oracle] 價格檔已推完'); break; }
    for (const r of await pushPrices(ctx, oracle, updates)) {
      log({ event: 'price', tick, ...r }, `[oracle] #${tick} ${r.symbol} → ${fmtPrice8(r.price8)}（block ${r.block}）`);
    }
    if (tick < maxTicks) await sleep(Math.max(0, intervalSeconds * 1000 - (Date.now() - t0)));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`✖ ${e.shortMessage || e.message}`); process.exit(1); });
}
