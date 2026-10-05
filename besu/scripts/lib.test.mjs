// besu/scripts/lib.test.mjs —— 純函式的離線測試（不需要節點、不送交易）。
// 執行：npm test（= node --test scripts/lib.test.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLocalChain, assetId, fmt18, fmtPrice8, gbmStep, isLiquidationCandidate,
  makeNormal, mulberry32, parseReplay, usdToPrice8,
} from './lib.mjs';
import { makeSource } from './oracle-pusher.mjs';

test('assetId：bytes32 格式、各資產不同（與鏈上 MockOracle 的比對在 e2e 讀價時完成）', () => {
  assert.match(assetId('sBTC'), /^0x[0-9a-f]{64}$/);
  assert.notEqual(assetId('sBTC'), assetId('sETH'));
});

test('拒絕公開鏈 chainId', () => {
  for (const id of [1, 11155111, 8453, 84532]) assert.throws(() => assertLocalChain(id));
  assert.doesNotThrow(() => assertLocalChain(1337));
});

test('usdToPrice8／fmtPrice8 互為反函式', () => {
  assert.equal(usdToPrice8('41500.25'), 4_150_025_000_000n);
  assert.equal(usdToPrice8('3000'), 300_000_000_000n);
  assert.equal(fmtPrice8(4_150_025_000_000n), '41500.25');
  assert.equal(fmt18(-1_500_000_000_000_000_000n), '-1.5000');
});

test('GBM：同一個種子產生同一串價格（可重播），且價格恆為正', () => {
  const run = () => {
    const src = makeSource({ mode: 'gbm', assets: ['sBTC'], startPrices: { sBTC: 5_000_000_000_000n }, seed: 42, mu: 0, sigma: 0.6, intervalSeconds: 5 });
    return Array.from({ length: 50 }, () => src()[0].price8);
  };
  const a = run(); const b = run();
  assert.deepEqual(a, b);
  assert.ok(a.every((p) => p > 0n));
  assert.notEqual(a[0], 5_000_000_000_000n);
  // 極端波動也不會推出 0（MockOracle 會 revert InvalidPrice）
  const z = makeNormal(mulberry32(1));
  let p = 1n;
  for (let i = 0; i < 100; i++) p = gbmStep(p, { sigma: 50, dtSeconds: 3600, z: z() });
  assert.ok(p >= 1n);
});

test('replay 價格檔解析與錯誤行', () => {
  const rows = parseReplay('# 註解\nsBTC,41500\n\nsETH,2800.5\n');
  assert.deepEqual(rows, [{ symbol: 'sBTC', price8: 4_150_000_000_000n }, { symbol: 'sETH', price8: 280_050_000_000n }]);
  assert.throws(() => parseReplay('sBTC,abc'), /第 1 行/);
  const src = makeSource({ mode: 'replay', replayRows: rows });
  assert.equal(src()[0].symbol, 'sBTC'); assert.equal(src()[0].symbol, 'sETH'); assert.equal(src(), null);
});

test('清算候選門檻與 liquidatePosition 一致（價值 ≤ 名目 × MM）', () => {
  const base = { margin: 1000n * 10n ** 18n, leverage: 5n, maintenanceMarginBps: 500n };
  // 名目 5,000，維持保證金 250
  assert.equal(isLiquidationCandidate({ ...base, value: 250n * 10n ** 18n }), true);
  assert.equal(isLiquidationCandidate({ ...base, value: 250n * 10n ** 18n + 1n }), false);
  assert.equal(isLiquidationCandidate({ ...base, value: 0n }), true);
});
