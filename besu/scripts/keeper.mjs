#!/usr/bin/env node
// besu/scripts/keeper.mjs
// 許可制 keeper：每個新區塊做兩件事——
//
//   1. 資金費率累積
//      任務書寫的 `_pokeFunding` 是 PerpetualExchange 的 internal 函式，外部叫不到。
//      實際的外部入口是 `settleFunding(bytes32 asset)`（external、任何人可呼叫），
//      它內部呼叫 `_pokeFunding`，但有 `FUNDING_INTERVAL`（合約常數 8 小時）的間隔限制：
//      未滿間隔會 revert `FundingIntervalNotElapsed`。所以「每個區塊觸發」在這裡的意思是：
//      每個區塊都檢查 `lastFundingUpdateAt(asset) + FUNDING_INTERVAL`，到期才送交易，
//      沒到期就記錄下次可結算時間，不送注定失敗的交易。
//      另外開倉／平倉／清算本身都會先呼叫 `_pokeFunding`，資金費率不依賴 keeper 才會累積。
//
//   2. 掃描可清算部位並清算
//      合約沒有 `isLiquidatable` 之類的 view。這裡用既有的 view 組出與
//      `liquidatePosition` 相同的門檻：
//        getPositionValue(id) ≤ margin × leverage × maintenanceMarginBpsForAsset(asset) / 10000
//      先用它篩候選，送交易前再用 eth_call 模擬 `liquidatePosition(id)`（合約自己的檢查，
//      健康部位會 revert `PositionIsHealthy`），模擬通過才送出。
//
// 「許可制」怎麼落實：合約層的 `settleFunding`／`liquidatePosition` 本來就是任何人可呼叫
// （這是合約設計，不為此新增方法）。許可在網路層：每個 Besu 節點都開了帳戶白名單
// （--permissions-accounts-config-file），只有白名單帳戶能送交易。keeper 啟動時用
// `perm_getAccountsAllowlist` 確認自己的帳戶在白名單裡，不在就拒絕啟動。
//
// 用法：
//   node scripts/keeper.mjs                 # 常駐，每個新區塊跑一輪
//   node scripts/keeper.mjs --once          # 只跑目前區塊一輪就結束（端到端腳本用）
//   node scripts/keeper.mjs --assets sBTC,sETH --poll-ms 500 --json
//
// 環境變數：BESU_RPC_URL、BESU_KEEPER_PRIVATE_KEY（覆寫 network/accounts.json 的 keeper；只給本地鏈用）。

import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { BaseError, ContractFunctionRevertedError } from 'viem';
import {
  assetId, fmt18, isLiquidationCandidate, loadAbi, loadAccounts, loadDeployment, makeClients,
} from './lib.mjs';

/** 把 viem 的錯誤濃縮成「合約錯誤名稱」或簡短訊息。 */
export function revertName(e) {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName || r.reason || r.shortMessage;
    return e.shortMessage;
  }
  return e?.message || String(e);
}

/** 網路層許可：keeper 帳戶必須在節點的帳戶白名單裡。 */
export async function assertPermitted(ctx) {
  let list;
  try {
    list = await ctx.publicClient.request({ method: 'perm_getAccountsAllowlist', params: [] });
  } catch (e) {
    throw new Error(`讀不到帳戶白名單（perm_getAccountsAllowlist）：${e.shortMessage || e.message}。`
      + '節點必須開 --permissions-accounts-config-file-enabled 並在 --rpc-http-api 加 PERM。');
  }
  const ok = list.map((a) => a.toLowerCase()).includes(ctx.account.address.toLowerCase());
  if (!ok) throw new Error(`keeper 帳戶 ${ctx.account.address} 不在節點的帳戶白名單裡，拒絕啟動。`);
  return list.length;
}

/** keeper 的跨區塊狀態：已知的未平倉部位與掃描游標。 */
export function newKeeperState() {
  return { cursor: 0n, open: new Set() };
}

async function send(ctx, address, abi, functionName, args) {
  const { request } = await ctx.publicClient.simulateContract({
    address, abi, functionName, args, account: ctx.account,
  });
  const hash = await ctx.walletClient.writeContract(request);
  const r = await ctx.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (r.status !== 'success') throw new Error(`${functionName} 交易失敗：${hash}`);
  return { hash, block: r.blockNumber, gasUsed: r.gasUsed };
}

/**
 * 跑一輪 keeper（對應一個區塊）。回傳這一輪做了什麼，給常駐模式印 log、給端到端腳本做斷言。
 */
export async function keeperTick(ctx, dep, state, { assets }) {
  const ex = dep.contracts.PerpetualExchange;
  const abi = loadAbi('PerpetualExchange');
  const read = (functionName, args = []) => ctx.publicClient.readContract({ address: ex, abi, functionName, args });
  const block = await ctx.publicClient.getBlock();
  const out = { block: block.number, timestamp: block.timestamp, funding: [], liquidations: [], scanned: 0 };

  // ── 1. 資金費率 ────────────────────────────────────────────────────────────
  const interval = await read('FUNDING_INTERVAL');
  for (const symbol of assets) {
    const id = assetId(symbol);
    const last = await read('lastFundingUpdateAt', [id]);
    // last == 0：這個資產從沒被碰過，settleFunding 會只啟動時鐘（合約註解：不回溯累積）。
    const due = last === 0n || block.timestamp >= last + interval;
    if (!due) {
      out.funding.push({ symbol, status: 'not-due', nextAt: last + interval, waitSeconds: last + interval - block.timestamp });
      continue;
    }
    try {
      const tx = await send(ctx, ex, abi, 'settleFunding', [id]);
      out.funding.push({ symbol, status: last === 0n ? 'clock-started' : 'settled', ...tx });
    } catch (e) {
      out.funding.push({ symbol, status: 'skipped', reason: revertName(e) });
    }
  }

  // ── 2. 清算掃描 ────────────────────────────────────────────────────────────
  const next = await read('nextPositionId');
  for (let id = state.cursor; id < next; id++) state.open.add(id);
  state.cursor = next;
  for (const id of [...state.open].sort((a, b) => (a < b ? -1 : 1))) {
    const pos = await read('getPosition', [id]);
    if (!pos.isOpen) { state.open.delete(id); continue; }
    out.scanned += 1;
    const [value, mmBps] = await Promise.all([
      read('getPositionValue', [id]),
      read('maintenanceMarginBpsForAsset', [pos.asset]),
    ]);
    const candidate = isLiquidationCandidate({
      value, margin: pos.margin, leverage: pos.leverage, maintenanceMarginBps: mmBps,
    });
    if (!candidate) continue;
    try {
      const tx = await send(ctx, ex, abi, 'liquidatePosition', [id]);
      out.liquidations.push({ id, owner: pos.owner, value, status: 'liquidated', ...tx });
      state.open.delete(id);
    } catch (e) {
      // 候選但模擬失敗：例如 StalePrice（價格過期）、GracePeriodActive、或篩選與合約計算的極小差距。
      out.liquidations.push({ id, owner: pos.owner, value, status: 'skipped', reason: revertName(e) });
    }
  }
  return out;
}

function describe(r) {
  const f = r.funding.map((x) => (x.status === 'not-due'
    ? `${x.symbol}:未到期(${x.waitSeconds}s)` : `${x.symbol}:${x.status}${x.reason ? `(${x.reason})` : ''}`)).join(' ');
  const l = r.liquidations.length
    ? r.liquidations.map((x) => `#${x.id}:${x.status}${x.reason ? `(${x.reason})` : ''}`).join(' ')
    : '無';
  return `[keeper] block ${r.block} 資金費率 ${f}｜掃描 ${r.scanned} 個未平倉｜清算 ${l}`;
}

async function main() {
  const { values: opt } = parseArgs({
    args: process.argv.slice(2),
    options: {
      assets: { type: 'string', default: 'sBTC,sETH,sAAPL,sTSLA' },
      'poll-ms': { type: 'string', default: '1000' },
      once: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
    },
  });
  const accounts = loadAccounts();
  const ctx = await makeClients({ privateKey: process.env.BESU_KEEPER_PRIVATE_KEY || accounts.keeper.privateKey });
  const dep = loadDeployment(ctx.chainId);
  const n = await assertPermitted(ctx);
  const assets = opt.assets.split(',').map((s) => s.trim()).filter(Boolean);
  const state = newKeeperState();
  const print = (r) => console.log(opt.json
    ? JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
    : describe(r));
  if (!opt.json) {
    console.log(`[keeper] 帳戶 ${ctx.account.address} 在白名單內（共 ${n} 個帳戶）；exchange ${dep.contracts.PerpetualExchange}`);
  }

  if (opt.once) { print(await keeperTick(ctx, dep, state, { assets })); return; }

  let stop = false;
  process.on('SIGINT', () => { stop = true; });
  process.on('SIGTERM', () => { stop = true; });
  let lastBlock = -1n;
  const pollMs = Number(opt['poll-ms']);
  while (!stop) {
    try {
      const bn = await ctx.publicClient.getBlockNumber({ cacheTime: 0 });
      if (bn > lastBlock) {
        lastBlock = bn;
        const r = await keeperTick(ctx, dep, state, { assets });
        print(r);
        for (const x of r.liquidations.filter((y) => y.status === 'liquidated')) {
          if (!opt.json) console.log(`[keeper]   清算 #${x.id} owner=${x.owner} 清算前價值=${fmt18(x.value)} tx=${x.hash}`);
        }
      }
    } catch (e) {
      // 單一輪失敗（例如節點重啟中）不讓 keeper 退出；下一個區塊再試。
      console.error(`[keeper] 本輪失敗：${e.shortMessage || e.message}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`✖ ${e.shortMessage || e.message}`); process.exit(1); });
}
