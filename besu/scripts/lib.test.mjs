// besu/scripts/lib.test.mjs —— 純函式的離線測試（不需要節點、不送交易）。
// 執行：npm test（= node --test scripts/lib.test.mjs）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  assertLocalBesu, makeClients, rejectPublicChainIdForGenesis, assetId, fmt18, fmtPrice8, gbmStep, isLiquidationCandidate,
  makeNormal, mulberry32, parseReplay, usdToPrice8,
} from './lib.mjs';
import { makeSource } from './oracle-pusher.mjs';

test('assetId：bytes32 格式、各資產不同（與鏈上 MockOracle 的比對在 e2e 讀價時完成）', () => {
  assert.match(assetId('sBTC'), /^0x[0-9a-f]{64}$/);
  assert.notEqual(assetId('sBTC'), assetId('sETH'));
});

test('連線白名單：chainId 必須等於本機網路、client 必須是 Besu', () => {
  const ok = { chainId: 1337, clientVersion: 'besu/v26.9.0/linux-x86_64/openjdk-java-25', expectedChainId: 1337 };
  assert.doesNotThrow(() => assertLocalBesu(ok));
  assert.doesNotThrow(() => assertLocalBesu({ ...ok, clientVersion: 'Besu/v26.9.0' }));
  // chainId 不符：包括沒列在任何黑名單裡的鏈，以及公開鏈
  assert.throws(() => assertLocalBesu({ ...ok, chainId: 2026 }), /chainId=2026/);
  assert.throws(() => assertLocalBesu({ ...ok, chainId: 84532 }), /chainId=84532/);
  // anvil（預設 chainId 31337），或 chainId 對了但不是 Besu
  assert.throws(() => assertLocalBesu({ ...ok, chainId: 31337, clientVersion: 'anvil/v1.7.1' }));
  assert.throws(() => assertLocalBesu({ ...ok, clientVersion: 'anvil/v1.7.1' }), /不是 Besu/);
  assert.throws(() => assertLocalBesu({ ...ok, clientVersion: 'Geth/v1.16.0' }), /不是 Besu/);
  assert.throws(() => assertLocalBesu({ ...ok, clientVersion: undefined }), /不是 Besu/);
  // 沒有預期 chainId（accounts.json 不完整）一律拒絕
  assert.throws(() => assertLocalBesu({ ...ok, expectedChainId: undefined }), /拒絕連線/);
});

test('genesis chainId 防呆：不選公開鏈使用中的 ID', () => {
  for (const id of [1, 11155111, 8453, 84532]) assert.throws(() => rejectPublicChainIdForGenesis(id));
  assert.doesNotThrow(() => rejectPublicChainIdForGenesis(1337));
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

/** 假 JSON-RPC 節點（本機 HTTP，只回 eth_chainId／web3_clientVersion），驗證 makeClients 真的走白名單。 */
async function withFakeNode({ chainIdHex, clientVersion }, fn) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const msgs = [].concat(JSON.parse(body));
      const out = msgs.map(({ id, method }) => ({
        jsonrpc: '2.0', id,
        result: method === 'eth_chainId' ? chainIdHex : method === 'web3_clientVersion' ? clientVersion : null,
      }));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? out : out[0]));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('makeClients：非 Besu 或 chainId 不符的節點一律拒絕連線', async () => {
  await withFakeNode({ chainIdHex: '0x539', clientVersion: 'anvil/v1.7.1' }, (rpcUrl) =>
    assert.rejects(makeClients({ rpcUrl, expectedChainId: 1337 }), /不是 Besu/));
  await withFakeNode({ chainIdHex: '0x14a34', clientVersion: 'besu/v26.9.0' }, (rpcUrl) =>
    assert.rejects(makeClients({ rpcUrl, expectedChainId: 1337 }), /chainId=84532/));
  await withFakeNode({ chainIdHex: '0x539', clientVersion: 'besu/v26.9.0/linux-x86_64' }, async (rpcUrl) => {
    const ctx = await makeClients({ rpcUrl, expectedChainId: 1337 });
    assert.equal(ctx.chainId, 1337);
  });
});
