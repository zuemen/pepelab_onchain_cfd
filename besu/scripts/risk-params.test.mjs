// besu/scripts/risk-params.test.mjs —— Besu 版風險參數設定的離線測試（不需要節點、不送交易）。
// 執行：npm test（package.json 的 test 會一起跑 lib.test.mjs 與本檔）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_LIMITS, checkMmrRaises, leverageMismatchHint, loadRiskParams, planRiskParams,
} from './apply-risk-params.mjs';
import { assetId } from './lib.mjs';

const cfg = loadRiskParams();
const clone = (o) => JSON.parse(JSON.stringify(o));

test('repo 內的 Besu 設定檔通過所有檢查，並只呼叫既有 setter', () => {
  const { calls, checks } = planRiskParams(cfg);
  const allowed = new Set(['setMaxPriceAge', 'setLiquidationPenaltyBps', 'setVaultFeeShareBps', 'setAdlEnabled',
    'setMaxLeverageFor', 'setMaintenanceMarginFor']);
  for (const c of calls) assert.ok(allowed.has(c.functionName), c.functionName);
  assert.equal(checks.length, calls.length);
  // 四個資產都有槓桿與 MMR
  for (const sym of ['sBTC', 'sETH', 'sAAPL', 'sTSLA']) {
    assert.ok(calls.some((c) => c.functionName === 'setMaxLeverageFor' && c.args[0] === assetId(sym)), sym);
    assert.ok(calls.some((c) => c.functionName === 'setMaintenanceMarginFor' && c.args[0] === assetId(sym)), sym);
  }
});

test('設定值與 BESU_CALIBRATION 建議表一致（秒級 maxPriceAge、每區塊推價）', () => {
  assert.ok(cfg.exchange.maxPriceAgeSeconds <= 300, 'Besu 的 maxPriceAge 應為秒到分鐘級');
  assert.ok(cfg.exchange.maxPriceAgeSeconds >= 3 * cfg.offchain.oraclePushIntervalSeconds);
  assert.equal(cfg.offchain.oraclePushIntervalSeconds, cfg.offchain.blockPeriodSeconds);
  assert.equal(cfg.exchange.liquidationPenaltyBps + CONTRACT_LIMITS.LIQUIDATION_REWARD_BPS <= 10_000, true);
});

test('超出合約界線或模型不變式的設定會被擋下', () => {
  const bad = (mut, re) => {
    const c = clone(cfg);
    mut(c);
    assert.throws(() => planRiskParams(c), re);
  };
  bad((c) => { c.exchange.maxPriceAgeSeconds = 0; }, /maxPriceAgeSeconds/);
  bad((c) => { c.exchange.maxPriceAgeSeconds = 8 * 24 * 3600; }, /maxPriceAgeSeconds/);
  bad((c) => { c.exchange.maxPriceAgeSeconds = 4; }, /3 × max/);                     // 小於 3 個推價間隔
  bad((c) => { c.exchange.liquidationPenaltyBps = 9_600; }, /liquidationPenaltyBps/); // 9600 + 500 > 10000
  bad((c) => { c.assets.sETH.maxLeverage = 6; }, /maxLeverage/);
  bad((c) => { c.assets.sETH.maintenanceMarginBps = 10_000; }, /maintenanceMarginBps/);
  // 5x：1/L − f = 2000 − 10 = 1990 bps；MMR 1990 一開倉就可清算
  bad((c) => { c.assets.sETH.maxLeverage = 5; c.assets.sETH.maintenanceMarginBps = 1_990; }, /一開倉就可清算/);
  bad((c) => { c.assets.sXYZ = { maxLeverage: 1, maintenanceMarginBps: 500 }; }, /未知資產/);
  bad((c) => { c.exchange.adlEnabled = 'yes'; }, /adlEnabled/);
});

test('1989 bps 在 5x 時仍可開倉（與 RISK_MODEL_CFD §2.6 的整數分界一致）', () => {
  const c = clone(cfg);
  c.assets = { sETH: { maxLeverage: 5, maintenanceMarginBps: 1_989 } };
  assert.doesNotThrow(() => planRiskParams(c));
});

// ── MMR 調高對既有倉位立即生效：有未平倉 OI 時預設拒絕 ─────────────────────────
const AAPL = assetId('sAAPL');
const ETH = assetId('sETH');
const currentWith = (oi) => {
  const cur = {};
  for (const sym of ['sBTC', 'sETH', 'sAAPL', 'sTSLA']) cur[assetId(sym)] = { mmBps: 500n, longOI: 0n, shortOI: 0n };
  cur[AAPL] = { mmBps: 500n, longOI: oi, shortOI: 0n };
  return cur;
};

test('沒有未平倉 OI 時可以調高 MMR', () => {
  const r = checkMmrRaises(planRiskParams(cfg), currentWith(0n));
  assert.deepEqual(r, { blocked: [], warnings: [] });
});

test('有未平倉 OI 時調高 MMR（AAPL 5% → 15%）預設被擋下，加旗標才放行並警告', () => {
  const plan = planRiskParams(cfg);
  const r = checkMmrRaises(plan, currentWith(10n ** 21n));
  assert.equal(r.blocked.length, 1);
  assert.match(r.blocked[0], /sAAPL/);
  assert.match(r.blocked[0], /當場可清算/);
  const ok = checkMmrRaises(plan, currentWith(10n ** 21n), { allowRaiseWithOpenPositions: true });
  assert.equal(ok.blocked.length, 0);
  assert.equal(ok.warnings.length, 1);
});

test('調低或不變的 MMR 不受 OI 限制；讀不到目前值一律拒絕', () => {
  const plan = planRiskParams(cfg);
  const cur = currentWith(10n ** 21n);
  cur[AAPL].mmBps = 2_000n;                              // 目前 20%，設定 15%：調低
  assert.equal(checkMmrRaises(plan, cur).blocked.length, 0);
  delete cur[ETH];
  assert.match(checkMmrRaises(plan, cur).blocked.join(), /讀不到/);
});

test('讀回的有效槓桿低於設定值時提示碳分級上限', () => {
  assert.match(leverageMismatchHint('maxLeverageForAsset', 5n, 1n), /碳分級/);
  assert.equal(leverageMismatchHint('maxLeverageForAsset', 5n, 5n), '');
  assert.equal(leverageMismatchHint('maxPriceAge', 60n, 30n), '');
});
