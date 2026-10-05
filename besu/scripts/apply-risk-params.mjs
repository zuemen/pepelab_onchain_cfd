#!/usr/bin/env node
// besu/scripts/apply-risk-params.mjs
// 部署後設定：把 Phase 3 校準出的 Besu 版風險參數（besu/config/risk-params.besu.json）
// 用 PerpetualExchange **既有的 owner setter** 寫上鏈。不新增任何合約方法、不改合約原始碼。
//
// 依據：docs/BESU_CALIBRATION.md §10（建議參數表）。只處理「有 setter 的參數」；
// 合約 constant（清算人 5%、資金費間隔、MAX_LEVERAGE、預設 MMR…）不在這裡，見同一份文件 §11。
//
// 會呼叫的 setter（全部 onlyOwner，由 deployer 帳戶簽名）：
//   setMaxPriceAge(uint256)                     (0, 7 days]
//   setLiquidationPenaltyBps(uint256)           + LIQUIDATION_REWARD_BPS(500, constant) ≤ 10000
//   setVaultFeeShareBps(uint256)                ≤ 10000
//   setAdlEnabled(bool)
//   setMaxLeverageFor(bytes32, uint256)         ≤ MAX_LEVERAGE(5)
//   setMaintenanceMarginFor(bytes32, uint256)   ≤ 9999，另檢查 m < 1/L − f（否則一開倉就可清算）
// 送完再用既有 view 讀回比對（maxPriceAge、liquidationPenaltyBps、vaultFeeShareBps、adlEnabled、
// maxLeverageForAsset、maintenanceMarginBpsForAsset），不一致就 exit 1。
//
// MMR 調高的保護：setMaintenanceMarginFor 對既有倉位立即生效。送任何交易之前先讀該資產的未平倉 OI，
// OI > 0 時拒絕調高 MMR（整批都不送），除非加 --allow-mmr-raise-with-open-positions（會印出警告）。
// 槓桿的前提：本設定檔的槓桿只在 esgRegistry = 0（碳定價停用，Deploy.s.sol 的 PoC 部署）時成立；
// 接了 esgRegistry 的部署（DeployTenant.s.sol）有效槓桿 = min(設定值, 碳分級上限)，讀回不一致時會提示。
//
// 順序注意：maxPriceAge 改成秒級後，推價一停交易就會 revert。請先啟動推價
// （npm --prefix besu run oracle -- --interval 2 --assets sBTC,sETH,sAAPL,sTSLA），再套用本設定；
// 端到端腳本 e2e 假設的是部署預設值（24h），不要在 e2e 之前套用。
//
// 用法（在 repo 根目錄）：
//   npm --prefix besu run risk-params -- --dry-run          # 只驗證設定並印出要送的交易，不連節點
//   npm --prefix besu run risk-params                       # 連本機 Besu，送交易並讀回
//   npm --prefix besu run risk-params -- --config path.json --json
//   npm --prefix besu run risk-params -- --allow-mmr-raise-with-open-positions   # 有未平倉 OI 仍要調高 MMR（需先揭露）
// 環境變數：BESU_RPC_URL；BESU_DEPLOYER_PRIVATE_KEY（覆寫 network/accounts.json 的 deployer；只給本地鏈用）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { BESU_DIR, DEPLOY_ASSETS, assetId, loadAbi, loadAccounts, loadDeployment, makeClients, sendTx } from './lib.mjs';

export const DEFAULT_CONFIG = join(BESU_DIR, 'config', 'risk-params.besu.json');

// 合約常數（contracts/src/PerpetualExchange.sol）。constant 改了要同步這裡。
export const CONTRACT_LIMITS = {
  MAX_LEVERAGE: 5,                    // :51
  LIQUIDATION_REWARD_BPS: 500,        // :56
  MAX_MAINTENANCE_MARGIN_BPS: 9_999,  // :67-79
  MAX_PRICE_AGE_LIMIT: 7 * 24 * 3600, // :70
};

const isInt = (x) => Number.isInteger(x);

/**
 * 驗證設定並產生要送的 setter 呼叫（純函式，不連節點；npm test 會測）。
 * 回傳 { calls: [{ functionName, args, why }], checks: [{ view, args, expect }] }；設定不合法就丟錯（列出所有問題）。
 */
export function planRiskParams(cfg) {
  const errs = [];
  const ex = cfg?.exchange ?? {};
  const off = cfg?.offchain ?? {};
  const block = off.blockPeriodSeconds ?? 2;
  const push = off.oraclePushIntervalSeconds ?? block;
  const delta = Math.max(block, push);
  const feeBps = off.assumedTradingFeeBps ?? 10;
  const calls = [];
  const checks = [];

  const A = ex.maxPriceAgeSeconds;
  if (!isInt(A) || A <= 0 || A > CONTRACT_LIMITS.MAX_PRICE_AGE_LIMIT) {
    errs.push(`maxPriceAgeSeconds 必須是 (0, ${CONTRACT_LIMITS.MAX_PRICE_AGE_LIMIT}] 的整數，收到 ${A}`);
  } else if (A < 3 * delta) {
    // 正常運作時價格年齡最多 Δ；留至少 3 個推價間隔的餘裕，否則一兩次推價延遲就會讓所有交易 revert
    errs.push(`maxPriceAgeSeconds = ${A} 小於 3 × max(出塊, 推價) = ${3 * delta} 秒，正常運作就會頻繁 revert`);
  } else {
    calls.push({ functionName: 'setMaxPriceAge', args: [BigInt(A)], why: 'BESU_CALIBRATION §4' });
    checks.push({ view: 'maxPriceAge', args: [], expect: BigInt(A) });
  }

  const pen = ex.liquidationPenaltyBps;
  if (!isInt(pen) || pen < 0 || pen + CONTRACT_LIMITS.LIQUIDATION_REWARD_BPS > 10_000) {
    errs.push(`liquidationPenaltyBps 必須是整數且 + ${CONTRACT_LIMITS.LIQUIDATION_REWARD_BPS} ≤ 10000，收到 ${pen}`);
  } else {
    calls.push({ functionName: 'setLiquidationPenaltyBps', args: [BigInt(pen)], why: 'BESU_CALIBRATION §6' });
    checks.push({ view: 'liquidationPenaltyBps', args: [], expect: BigInt(pen) });
  }

  if (ex.vaultFeeShareBps !== undefined) {
    const v = ex.vaultFeeShareBps;
    if (!isInt(v) || v < 0 || v > 10_000) errs.push(`vaultFeeShareBps 必須是 [0, 10000] 的整數，收到 ${v}`);
    else {
      calls.push({ functionName: 'setVaultFeeShareBps', args: [BigInt(v)], why: 'BESU_CALIBRATION §6' });
      checks.push({ view: 'vaultFeeShareBps', args: [], expect: BigInt(v) });
    }
  }

  if (ex.adlEnabled !== undefined) {
    if (typeof ex.adlEnabled !== 'boolean') errs.push(`adlEnabled 必須是 true/false，收到 ${ex.adlEnabled}`);
    else {
      calls.push({ functionName: 'setAdlEnabled', args: [ex.adlEnabled], why: 'RISK_MODEL_CFD §4（ADL 是第二道）' });
      checks.push({ view: 'adlEnabled', args: [], expect: ex.adlEnabled });
    }
  }

  const assets = cfg?.assets ?? {};
  if (Object.keys(assets).length === 0) errs.push('assets 不可為空');
  for (const [sym, a] of Object.entries(assets)) {
    if (!(sym in DEPLOY_ASSETS)) { errs.push(`未知資產 ${sym}（Deploy.s.sol 只註冊 ${Object.keys(DEPLOY_ASSETS).join(', ')}）`); continue; }
    const L = a.maxLeverage;
    const mm = a.maintenanceMarginBps;
    if (!isInt(L) || L < 1 || L > CONTRACT_LIMITS.MAX_LEVERAGE) {
      errs.push(`${sym}.maxLeverage 必須是 1–${CONTRACT_LIMITS.MAX_LEVERAGE} 的整數，收到 ${L}`);
      continue;
    }
    if (!isInt(mm) || mm < 1 || mm > CONTRACT_LIMITS.MAX_MAINTENANCE_MARGIN_BPS) {
      errs.push(`${sym}.maintenanceMarginBps 必須是 1–${CONTRACT_LIMITS.MAX_MAINTENANCE_MARGIN_BPS} 的整數，收到 ${mm}`);
      continue;
    }
    // 清算價 S* = S₀(1 − 1/L + m + f)：m ≥ 1/L − f 時一開倉就可清算（setter 本身不檢查這條）
    if (mm >= 10_000 / L - feeBps) {
      errs.push(`${sym}：MMR ${mm} bps ≥ 1/L − f = ${10_000 / L - feeBps} bps，一開倉就可清算`);
      continue;
    }
    const id = assetId(sym);
    calls.push({ functionName: 'setMaxLeverageFor', args: [id, BigInt(L)], asset: sym, why: `BESU_CALIBRATION §5（${sym}）` });
    calls.push({ functionName: 'setMaintenanceMarginFor', args: [id, BigInt(mm)], asset: sym, why: `BESU_CALIBRATION §5（${sym}）` });
    checks.push({ view: 'maxLeverageForAsset', args: [id], asset: sym, expect: BigInt(L) });
    checks.push({ view: 'maintenanceMarginBpsForAsset', args: [id], asset: sym, expect: BigInt(mm) });
  }
  if (errs.length) throw new Error(`風險參數設定不合法：\n  - ${errs.join('\n  - ')}`);
  return { calls, checks };
}

/**
 * MMR 調高的安全檢查（純函式）。`setMaintenanceMarginFor` 對**既有倉位立即生效**：清算門檻是
 * 「開倉名目 × 目前的 MMR」，調高後既有倉位可能當場變成可清算（例：AAPL 5x 由 5% 調到 15%，
 * 清算距離由約 15% 縮到約 5%）。所以該資產還有未平倉 OI 時，預設拒絕調高；
 * 明確加 --allow-mmr-raise-with-open-positions 才放行，並列出警告。
 * current：{ [assetId]: { mmBps, longOI, shortOI } }（bigint，由鏈上 view 讀出）。
 * 回傳 { blocked: [訊息], warnings: [訊息] }。
 */
export function checkMmrRaises(plan, current, { allowRaiseWithOpenPositions = false } = {}) {
  const blocked = [];
  const warnings = [];
  for (const c of plan.calls) {
    if (c.functionName !== 'setMaintenanceMarginFor') continue;
    const [id, next] = c.args;
    const cur = current[id];
    if (!cur) { blocked.push(`${c.asset ?? id}：讀不到目前的 MMR 與 OI，拒絕套用`); continue; }
    const oi = BigInt(cur.longOI) + BigInt(cur.shortOI);
    if (BigInt(next) <= BigInt(cur.mmBps) || oi === 0n) continue;
    const msg = `${c.asset ?? id}：MMR ${cur.mmBps} → ${next} bps，該資產仍有未平倉 OI（多 ${cur.longOI}、空 ${cur.shortOI}）；`
      + '調高立即套用到既有倉位，可能讓它們當場可清算';
    (allowRaiseWithOpenPositions ? warnings : blocked).push(msg);
  }
  return { blocked, warnings };
}

/** 讀回的有效槓桿低於設定值時的說明（接了 esgRegistry 時有效槓桿 = min(設定值, 碳分級上限)）。 */
export function leverageMismatchHint(view, expect, got) {
  if (view !== 'maxLeverageForAsset' || BigInt(got) >= BigInt(expect)) return '';
  return '：有效槓桿低於設定值，可能被碳分級上限壓低（接了 esgRegistry 時有效槓桿 = min(setMaxLeverageFor, 碳分級上限)；'
    + '新 registry 的資產預設 Unrated＝1x）。本設定檔的槓桿只在 esgRegistry = 0 的部署成立，見 BESU_CALIBRATION §5.1';
}

export function loadRiskParams(path = DEFAULT_CONFIG) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const show = (x) => (typeof x === 'bigint' ? x.toString() : x);

async function main() {
  const { values: opt } = parseArgs({
    options: {
      config: { type: 'string', default: DEFAULT_CONFIG },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'allow-mmr-raise-with-open-positions': { type: 'boolean', default: false },
    },
  });
  const cfg = loadRiskParams(opt.config);
  const plan = planRiskParams(cfg);
  const print = (o, text) => console.log(opt.json ? JSON.stringify(o, (_, v) => show(v)) : text);
  for (const c of plan.calls) {
    print({ event: 'plan', ...c }, `[risk-params] ${c.functionName}(${c.args.map(show).join(', ')})  ← ${c.why}`);
  }
  if (opt['dry-run']) {
    print({ event: 'dry-run', calls: plan.calls.length }, `[risk-params] dry-run：${plan.calls.length} 筆，未連節點`);
    return;
  }
  const accounts = loadAccounts();
  const ctx = await makeClients({ privateKey: process.env.BESU_DEPLOYER_PRIVATE_KEY || accounts.deployer.privateKey });
  const dep = loadDeployment(ctx.chainId);
  const address = dep.contracts.PerpetualExchange;
  const abi = loadAbi('PerpetualExchange');
  // MMR 調高前先讀目前值與未平倉 OI（既有 view：maintenanceMarginBpsForAsset、globalLongNotional、globalShortNotional）
  const read = (functionName, args) => ctx.publicClient.readContract({ address, abi, functionName, args });
  const current = {};
  for (const c of plan.calls.filter((x) => x.functionName === 'setMaintenanceMarginFor')) {
    const id = c.args[0];
    const [mmBps, longOI, shortOI] = await Promise.all([
      read('maintenanceMarginBpsForAsset', [id]), read('globalLongNotional', [id]), read('globalShortNotional', [id]),
    ]);
    current[id] = { mmBps, longOI, shortOI };
  }
  const mm = checkMmrRaises(plan, current, { allowRaiseWithOpenPositions: opt['allow-mmr-raise-with-open-positions'] });
  for (const w of mm.warnings) {
    print({ event: 'warning', message: w }, `  ⚠ ${w}（已加 --allow-mmr-raise-with-open-positions，照樣送出）`);
  }
  if (mm.blocked.length) {
    throw new Error(`拒絕套用（沒有送出任何交易）：\n  - ${mm.blocked.join('\n  - ')}\n`
      + '先讓既有倉位平倉或完成揭露後再調，或確認後加 --allow-mmr-raise-with-open-positions。');
  }
  for (const c of plan.calls) {
    const r = await sendTx(ctx, { address, abi, functionName: c.functionName, args: c.args });
    print({ event: 'sent', functionName: c.functionName, block: r.blockNumber }, `  ✔ ${c.functionName}（block ${r.blockNumber}）`);
  }
  let bad = 0;
  for (const k of plan.checks) {
    const got = await ctx.publicClient.readContract({ address, abi, functionName: k.view, args: k.args });
    const ok = got === k.expect;
    if (!ok) bad += 1;
    const hint = ok ? '' : leverageMismatchHint(k.view, k.expect, got);
    print({ event: 'check', view: k.view, asset: k.asset, expect: k.expect, got, ok, hint },
      `  ${ok ? '✔' : '✖'} ${k.view}(${k.asset ?? k.args.map(show).join(', ')}) = ${show(got)}（預期 ${show(k.expect)}）${hint}`);
  }
  if (bad) {
    console.error(`[risk-params] ${bad} 項讀回不一致`);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`✖ ${e.message}`); process.exit(1); });
}
