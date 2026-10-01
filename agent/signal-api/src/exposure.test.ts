// GET /risk/exposure 測試：假 provider（ExposureReader），不打網路、不送交易。
//   cd agent && npx tsx signal-api/src/exposure.test.ts
import assert from "node:assert";

process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:1";
process.env.FREE_RATE_MAX = "3";
process.env.FREE_RATE_WINDOW_MS = "60000";

const { buildExposureReport, createExposureService, classifyReadError } = await import("./exposure.ts");
const { createApp, exposureTargets } = await import("./app.ts");
type Reader = import("./exposure.ts").ExposureReader;

const E = "0x" + "e1".repeat(20);
const MO = "0x" + "a1".repeat(20);
const GO = "0x" + "a2".repeat(20);
const IV = "0x" + "b1".repeat(20);
const USDC = "0x" + "c1".repeat(20);
const V2 = "0x" + "d1".repeat(20);
const BTC = "0x" + "01".repeat(32);
const ETH = "0x" + "02".repeat(32);
const BLOCK = 123_456;
const BT = 1_790_000_000; // 區塊時間（秒）
const E18 = 10n ** 18n;
const P8 = 10n ** 8n;
const MAX = (1n << 256n) - 1n;

const revert = () => Object.assign(new Error("execution reverted https://rpc.example/v2/SECRETKEY1234567890abcd"), { code: "CALL_EXCEPTION" });
const rpcDown = () => Object.assign(new Error("fetch failed https://rpc.example/v2/SECRETKEY1234567890abcd"), { code: "SERVER_ERROR" });

function fakeReader(over: Record<string, unknown> = {}, opts: { openSize?: boolean } = {}) {
  const calls: Array<{ key: string; blockTag?: number }> = [];
  const table: Record<string, unknown> = {
    [`${E}|adlEnabled|`]: [true],
    [`${E}|maxPriceAge|`]: [21600n],
    [`${E}|FUNDING_INTERVAL|`]: [28800n],
    [`${E}|insuranceVault|`]: [IV],
    [`${E}|globalLongNotional|${BTC}`]: [1500n * E18],
    [`${E}|globalShortNotional|${BTC}`]: [500n * E18],
    [`${E}|globalLongNotional|${ETH}`]: [200n * E18],
    [`${E}|globalShortNotional|${ETH}`]: [300n * E18],
    [`${E}|lastFundingUpdateAt|${BTC}`]: [BigInt(BT - 3600)],
    [`${E}|lastFundingUpdateAt|${ETH}`]: [BigInt(BT - 60)],
    [`${MO}|getPrice|${BTC}`]: [60_000n * P8, BigInt(BT - 120)],
    [`${GO}|getPrice|${BTC}`]: [60_000n * P8, BigInt(BT - 120)],
    [`${MO}|getPrice|${ETH}`]: [3_000n * P8, BigInt(BT - 30)],
    [`${GO}|getPrice|${ETH}`]: [3_030n * P8, BigInt(BT - 900)], // 不一致：+1%
    [`${IV}|totalAssets|`]: [12_345n * E18],
    [`${IV}|usdc|`]: [USDC],
    [`${USDC}|decimals|`]: [18n],
    [`${V2}|reserveStatus|`]: [1000n, 800n, 12500n, 0n, false, false],
    [`${V2}|reserveRatioBps|`]: [12500n],
    ...(opts.openSize
      ? {
          [`${E}|longOpenSize|${BTC}`]: [2n * E18], // 2 BTC
          [`${E}|shortOpenSize|${BTC}`]: [E18 / 2n],
          [`${E}|longOpenSize|${ETH}`]: [E18],
          [`${E}|shortOpenSize|${ETH}`]: [0n],
        }
      : {}),
    ...over,
  };
  const reader: Reader = {
    blockNumber: async () => {
      const v = table["blockNumber"];
      if (typeof v === "function") throw (v as () => Error)();
      return BLOCK;
    },
    blockTimestamp: async () => BT,
    call: async (addr, sig, args, blockTag) => {
      const name = sig.slice(0, sig.indexOf("("));
      const key = `${addr.toLowerCase()}|${name}|${args.join(",")}`;
      calls.push({ key, blockTag });
      const v = table[key];
      if (v === undefined) throw revert(); // 合約沒有這個函式／這個資產 → revert
      if (typeof v === "function") throw (v as () => Error)();
      return v as any;
    },
  };
  return { reader, calls };
}

const T = {
  chainId: 84532, exchange: E, mockOracle: MO, guardedOracle: GO,
  insuranceVaultFallback: "0x0000000000000000000000000000000000000000", assetVaultV2: V2,
  assets: { sBTC: BTC, sETH: ETH },
};
let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

// 1) 全部讀得到、舊合約（沒有 longOpenSize）→ globalNotional
{
  const { reader, calls } = fakeReader();
  const r = await buildExposureReport(reader, T, BT * 1000 + 5000);
  assert.equal(r.asOfBlock, BLOCK - 3, "blockTag = latest − 3");
  assert.equal(r.asOfBlockTime, new Date(BT * 1000).toISOString());
  assert.deepEqual(r.exchange, { adlEnabled: true, maxPriceAgeSec: 21600, fundingIntervalSec: 28800 });
  assert.equal(r.contracts.insuranceVault, IV, "insuranceVault 位址從 exchange 讀");
  assert.equal(r.insuranceVault.totalAssets, 12345);
  assert.equal(r.insuranceVault.decimals, 18);
  assert.equal(r.v2Vault.reserveStatus!.ratioBps, "12500");
  assert.equal(r.v2Vault.reserveStatus!.ratioUnbounded, false);
  assert.equal(r.v2Vault.reserveRatioBps, "12500");
  const btc = r.assets.find((a) => a.symbol === "sBTC")!;
  assert.equal(btc.openInterest.method, "globalNotional");
  assert.deepEqual([btc.openInterest.longUsd, btc.openInterest.shortUsd, btc.openInterest.netUsd], [1500, 500, 1000]);
  assert.equal(btc.oracle.mock.price, 60000);
  assert.equal(btc.oracle.mock.ageSec, 120, "年齡以區塊時間為基準");
  assert.equal(btc.oracle.agree, true);
  assert.equal(btc.funding.sinceSec, 3600);
  assert.deepEqual(r.totals, { longUsd: 1700, shortUsd: 800 });
  assert.deepEqual(r.unavailable, {});
  assert.ok(calls.every((c) => c.blockTag === BLOCK - 3), "所有 eth_call 都釘在同一個區塊（latest − 3）");
  ok("完整報表：exchange 參數、保險金庫、V2 reserveStatus、OI（globalNotional 退回）、oracle 年齡、funding；所有讀取同一 blockTag（latest − 3）");
}

// 2) 兩顆 oracle 不一致 → agree=false 並給偏離 bps
{
  const { reader } = fakeReader();
  const r = await buildExposureReport(reader, T, BT * 1000);
  const eth = r.assets.find((a) => a.symbol === "sETH")!;
  assert.equal(eth.oracle.agree, false);
  assert.equal(eth.oracle.deviationBps, 100);
  assert.equal(eth.oracle.guarded.ageSec, 900);
  ok("MockOracle 與 GuardedOracle 不一致 → agree=false、deviationBps=100");
}

// 3) 新合約有 longOpenSize → 數量 × 現價
{
  const { reader } = fakeReader({}, { openSize: true });
  const r = await buildExposureReport(reader, T, BT * 1000);
  const btc = r.assets.find((a) => a.symbol === "sBTC")!;
  assert.equal(btc.openInterest.method, "openSize×markPrice");
  assert.deepEqual([btc.openInterest.longUsd, btc.openInterest.shortUsd], [120000, 30000]);
  assert.ok(r.notes.some((x) => x.includes("longOpenSize/shortOpenSize（部位數量")));
  ok("合約有 longOpenSize → OI = 數量 × MockOracle 現價（2 BTC × 60000 = 120000）");
}

// 4) 欄位級降級：個別讀取失敗 → 該欄位 null＋原因代碼，其他照給，不丟錯、不外洩原文
{
  const { reader } = fakeReader({
    [`${GO}|getPrice|${BTC}`]: revert,
    [`${E}|adlEnabled|`]: rpcDown,
    [`${IV}|totalAssets|`]: rpcDown,
    [`${V2}|reserveStatus|`]: revert,
    [`${E}|globalLongNotional|${ETH}`]: rpcDown,
  });
  const r = await buildExposureReport(reader, T, BT * 1000);
  assert.equal(r.ok, true);
  assert.equal(r.exchange.adlEnabled, null);
  assert.equal(r.exchange.maxPriceAgeSec, 21600, "其他欄位照給");
  assert.equal(r.insuranceVault.totalAssets, null);
  assert.equal(r.v2Vault.reserveStatus, null);
  assert.equal(r.v2Vault.reserveRatioBps, "12500");
  const btc = r.assets.find((a) => a.symbol === "sBTC")!;
  assert.equal(btc.oracle.guarded.price, null);
  assert.equal(btc.oracle.agree, null, "一顆讀不到 → 一致性未知＝null，不是 false");
  const eth = r.assets.find((a) => a.symbol === "sETH")!;
  assert.equal(eth.openInterest.longUsd, null);
  assert.equal(r.totals.longUsd, null, "有資產 OI 未知 → 總計不給（避免低估）");
  assert.deepEqual(r.unavailable, {
    "assets.sBTC.oracle.guarded": "CALL_REVERTED",
    "exchange.adlEnabled": "RPC_ERROR",
    "insuranceVault.totalAssets": "RPC_ERROR",
    "v2Vault.reserveStatus": "CALL_REVERTED",
    "assets.sETH.openInterest": "RPC_ERROR",
  });
  assert.ok(!JSON.stringify(r).includes("SECRETKEY"), "不可外洩錯誤原文");
  ok("欄位級降級：失敗欄位 null＋unavailable 原因代碼；其他欄位照給；不含錯誤原文");
}

// 5) 區塊號讀不到 → asOfBlock null、改用 latest＋伺服器時間，報表仍出
{
  const { reader, calls } = fakeReader({ blockNumber: rpcDown });
  const r = await buildExposureReport(reader, T, BT * 1000 + 10_000);
  assert.equal(r.asOfBlock, null);
  assert.equal(r.unavailable.asOfBlock, "RPC_ERROR");
  assert.equal(r.assets[0].oracle.mock.ageSec, 130);
  assert.ok(calls.every((c) => c.blockTag === undefined));
  ok("區塊號讀不到 → asOfBlock=null＋原因代碼，改以伺服器時間計算年齡");
}

// 6) 未設定的合約（V2 未部署、oracle 0x0）→ NOT_CONFIGURED，不打 RPC
{
  const { reader, calls } = fakeReader();
  const r = await buildExposureReport(reader, { ...T, assetVaultV2: null, guardedOracle: "0x0000000000000000000000000000000000000000" }, BT * 1000);
  assert.equal(r.unavailable["v2Vault.reserveStatus"], "NOT_CONFIGURED");
  assert.equal(r.unavailable["assets.sBTC.oracle.guarded"], "NOT_CONFIGURED");
  assert.ok(!calls.some((c) => c.key.startsWith(V2)));
  ok("未部署的合約 → NOT_CONFIGURED，不送 RPC");
}

// 7) reserveRatio 無上限（liability=0）
{
  const { reader } = fakeReader({ [`${V2}|reserveStatus|`]: [5n, 0n, MAX, 0n, false, false] });
  const r = await buildExposureReport(reader, T, BT * 1000);
  assert.equal(r.v2Vault.reserveStatus!.ratioUnbounded, true);
  ok("liability=0 → ratioUnbounded=true");
}

// 7b) 從未結算 funding（lastFundingUpdateAt=0）→ 不是錯誤，也不給 1970 年的假距今
{
  const { reader } = fakeReader({ [`${E}|lastFundingUpdateAt|${ETH}`]: [0n] });
  const r = await buildExposureReport(reader, T, BT * 1000);
  const eth = r.assets.find((a) => a.symbol === "sETH")!;
  assert.deepEqual(eth.funding, { lastFundingUpdateAt: null, sinceSec: null, neverSettled: true });
  assert.equal(r.unavailable["assets.sETH.funding.lastFundingUpdateAt"], undefined);
  const btc = r.assets.find((a) => a.symbol === "sBTC")!;
  assert.equal(btc.funding.neverSettled, false);
  ok("lastFundingUpdateAt=0 → neverSettled=true，sinceSec=null（非讀取失敗）");
}

// 8) classifyReadError
{
  // ethers v6 會把 eth_call 的任何節點錯誤包成 CALL_EXCEPTION：
  const headerNotFound = {
    code: "CALL_EXCEPTION", data: null, reason: null,
    shortMessage: "missing revert data", message: "missing revert data (action=\"call\", data=null, reason=null…)",
    info: { error: { code: -32000, message: "header not found" } },
  };
  assert.equal(classifyReadError(headerNotFound), "RPC_ERROR", "header not found 不是 revert");
  assert.equal(classifyReadError({ ...headerNotFound, info: { error: { code: -32000, message: "some node glitch" } } }), "RPC_ERROR", "沒有 revert data 也沒說 revert → RPC_ERROR");
  assert.equal(classifyReadError({ code: "CALL_EXCEPTION", data: "0x", info: { error: { message: "execution reverted" } } }), "CALL_REVERTED");
  assert.equal(classifyReadError({ code: "CALL_EXCEPTION", data: "0x08c379a0" }), "CALL_REVERTED", "帶 revert data");
  assert.equal(classifyReadError({ code: "CALL_EXCEPTION", message: "execution reverted: AssetNotFound" }), "CALL_REVERTED");
  assert.equal(classifyReadError({ code: "SERVER_ERROR", info: { error: { message: "429 Too Many Requests" } } }), "RPC_ERROR");
  assert.equal(classifyReadError({ code: "BAD_DATA" }), "BAD_DATA");
  assert.equal(classifyReadError({ code: "TIMEOUT" }), "RPC_TIMEOUT");
  assert.equal(classifyReadError(new Error("x")), "RPC_ERROR");
  ok("錯誤分類：header not found / 無 revert data → RPC_ERROR；節點明說 revert 或帶 revert data → CALL_REVERTED");
}

// 8b) 暫時性錯誤重試一次；revert 不重試
{
  let n1 = 0;
  const { reader } = fakeReader();
  const base = reader.call;
  let revertCalls = 0;
  reader.call = async (addr, sig, args, tag) => {
    if (sig.startsWith("adlEnabled")) {
      n1++;
      if (n1 === 1) throw { code: "CALL_EXCEPTION", data: null, info: { error: { message: "header not found" } } };
      return [true] as any;
    }
    if (sig.startsWith("longOpenSize")) revertCalls++;
    return base(addr, sig, args, tag);
  };
  const r = await buildExposureReport(reader, T, BT * 1000);
  assert.equal(n1, 2, "第一次 header not found → 重試一次");
  assert.equal(r.exchange.adlEnabled, true);
  assert.equal(r.unavailable["exchange.adlEnabled"], undefined);
  assert.equal(revertCalls, 1, "longOpenSize 探測 revert → 不重試");
  ok("暫時性錯誤重試一次後成功 → 欄位正常；revert 不重試");
}

// 8c) 逾時不重試；429 重試一次；整份報表總時限
{
  const { isRetryableReadError } = await import("./exposure.ts");
  assert.equal(isRetryableReadError({ code: "TIMEOUT" }), false);
  assert.equal(isRetryableReadError({ code: "SERVER_ERROR", info: { error: { message: "429 Too Many Requests" } } }), true);
  assert.equal(isRetryableReadError({ code: "CALL_EXCEPTION", info: { error: { message: "header not found" } } }), true);
  assert.equal(isRetryableReadError({ code: "SERVER_ERROR", message: "fetch failed" }), false);

  const count: Record<string, number> = {};
  const { reader } = fakeReader();
  const base = reader.call;
  reader.call = async (addr, sig, args, tag) => {
    const name = sig.slice(0, sig.indexOf("("));
    count[name] = (count[name] ?? 0) + 1;
    if (name === "adlEnabled") throw { code: "TIMEOUT" };
    if (name === "maxPriceAge" && count[name] === 1) throw { code: "SERVER_ERROR", info: { error: { message: "429 Too Many Requests" } } };
    if (name === "FUNDING_INTERVAL") return new Promise(() => {}) as any; // 永遠不回
    return base(addr, sig, args, tag);
  };
  const t0 = Date.now();
  const r = await buildExposureReport(reader, T, BT * 1000, { deadlineMs: 400, callTimeoutMs: 10_000 });
  const took = Date.now() - t0;
  assert.equal(count.adlEnabled, 1, "逾時不重試");
  assert.equal(r.unavailable["exchange.adlEnabled"], "RPC_TIMEOUT");
  assert.equal(count.maxPriceAge, 2, "429 重試一次");
  assert.equal(r.exchange.maxPriceAgeSec, 21600);
  assert.equal(r.exchange.fundingIntervalSec, null);
  assert.equal(r.unavailable["exchange.fundingIntervalSec"], "REPORT_DEADLINE");
  assert.ok(took < 2000, `總時限生效（${took}ms）`);
  assert.equal(r.assets.length, 2, "其他欄位照給");
  ok("逾時不重試、429 重試一次；整份報表總時限到點 → 未完成欄位 null＋REPORT_DEADLINE");
}

// 8d) 逾時分類必須是確定性的：由「排程當下哪個上限先到」決定，不能在計時器觸發後回頭讀時鐘
//     （CI run 36713844423：Node 計時器走 libuv 的單調時鐘、以毫秒截斷排程，Date.now() 是牆上時鐘；
//      計時器可能比 Date.now() 意義上的 deadline 早約 1ms 觸發 → 以前會被誤判成 RPC_TIMEOUT）。
{
  const realNow = Date.now;
  const hang = (name: string) => {
    const { reader } = fakeReader();
    const base = reader.call;
    reader.call = async (addr, sig, args, tag) => {
      if (sig.startsWith(name)) return new Promise(() => {}) as any; // 永遠不回
      return base(addr, sig, args, tag);
    };
    return reader;
  };
  try {
    // (a) 報表總時限先到（剩餘 < 單筆逾時）：計時器觸發當下牆上時鐘「看起來」還沒到 deadline
    //     （模擬上述毫秒截斷差，放大成 1 秒以免依賴實際排程誤差）→ 仍必須是 REPORT_DEADLINE。
    const r1 = hang("FUNDING_INTERVAL");
    const base1 = r1.call;
    r1.call = async (addr, sig, args, tag) => {
      if (sig.startsWith("FUNDING_INTERVAL")) Date.now = () => realNow() - 1_000;
      return base1(addr, sig, args, tag);
    };
    const a = await buildExposureReport(r1, T, BT * 1000, { deadlineMs: 150, callTimeoutMs: 10_000 });
    Date.now = realNow;
    assert.equal(a.unavailable["exchange.fundingIntervalSec"], "REPORT_DEADLINE", "總時限的計時器觸發 → REPORT_DEADLINE（與觸發當下的時鐘讀數無關）");

    // (b) 單筆逾時先到（單筆 < 剩餘）：計時器因事件迴圈被佔住而晚到、晚過報表 deadline
    //     → 仍是 RPC_TIMEOUT（單筆逾時才是先到期的那個上限）。
    const r2 = hang("FUNDING_INTERVAL");
    const block = setTimeout(() => { const s = realNow(); while (realNow() - s < 300) {} }, 10);
    const b = await buildExposureReport(r2, T, BT * 1000, { deadlineMs: 200, callTimeoutMs: 50 });
    clearTimeout(block);
    assert.equal(b.unavailable["exchange.fundingIntervalSec"], "RPC_TIMEOUT", "單筆逾時的計時器觸發 → RPC_TIMEOUT（即使實際觸發時已過報表 deadline）");
  } finally {
    Date.now = realNow;
  }
  ok("逾時分類確定性：排程時哪個上限先到期就回哪個原因代碼，不因計時器早／晚觸發而翻轉");
}

// 9) 快取 60 秒＋single-flight；降級報表只快取 10 秒
{
  let clock = 0;
  const { reader, calls } = fakeReader();
  const svc = createExposureService(reader, T, { now: () => clock });
  const [a, b] = await Promise.all([svc.get(), svc.get()]);
  const perReport = calls.length / 1;
  assert.equal(a.cacheHit, false);
  assert.equal(b.report, a.report, "同時兩個請求共用同一次讀取");
  clock = 59_000;
  const c = await svc.get();
  assert.equal(c.cacheHit, true);
  assert.equal(c.ageSec, 59);
  assert.equal(calls.length, perReport, "60 秒內不再打 RPC");
  clock = 60_001;
  const d = await svc.get();
  assert.equal(d.cacheHit, false);
  assert.equal(calls.length, perReport * 2);

  let clock2 = 0;
  const bad = fakeReader({ [`${E}|adlEnabled|`]: rpcDown });
  const svc2 = createExposureService(bad.reader, T, { now: () => clock2 });
  const first = await svc2.get();
  assert.deepEqual([first.ttlSec, first.remainingSec], [10, 10]);
  clock2 = 4_000;
  assert.equal((await svc2.get()).remainingSec, 6, "剩餘秒數隨時間遞減（= Cache-Control max-age）");
  clock2 = 10_001;
  assert.equal((await svc2.get()).cacheHit, false, "有欄位暫時性失敗的報表 10 秒後就重讀");

  // NOT_CONFIGURED（部署狀態）不觸發短 TTL
  let clock3 = 0;
  const nc = fakeReader();
  const svc3 = createExposureService(nc.reader, { ...T, assetVaultV2: null }, { now: () => clock3 });
  const r3 = await svc3.get();
  assert.equal(r3.report.unavailable["v2Vault.reserveStatus"], "NOT_CONFIGURED");
  assert.equal(r3.ttlSec, 60);
  clock3 = 30_000;
  assert.equal((await svc3.get()).cacheHit, true);
  ok("快取 60 秒、single-flight；暫時性降級只快取 10 秒；NOT_CONFIGURED 仍 60 秒；remainingSec 遞減");
}

// 10) 路由：GET /risk/exposure（免費、不經 x402）＋ per-IP 節流
{
  const { reader } = fakeReader();
  const app = createApp({
    payTo: "0x4444444444444444444444444444444444444444",
    payoutCodeReader: { getCode: async () => "0x" },
    exposureReader: reader,
  });
  const get = () => app.fetch(new Request("http://localhost/risk/exposure", { headers: { "x-forwarded-for": "9.9.9.9" } }));
  const res = await get();
  assert.equal(res.status, 200);
  const j = (await res.json()) as any;
  assert.equal(j.ok, true);
  assert.equal(typeof j.asOfBlock, "number");
  // 假 reader 對真實位址一律 revert → 降級報表：TTL 10 秒，Cache-Control 必須一致
  assert.equal(j.cache.ttlSec, 10);
  assert.equal(res.headers.get("cache-control"), `public, max-age=${j.cache.remainingSec}`, "Cache-Control 與實際快取剩餘時間一致");
  assert.equal(j.assets.length, Object.keys(exposureTargets().assets).length);
  await get();
  await get();
  const limited = await get();
  assert.equal(limited.status, 429, "比照既有免費端點的 per-IP 節流");
  ok("GET /risk/exposure → 200（不需付款）、Cache-Control = 實際剩餘快取秒數、per-IP 節流 429");
}

console.log(`\n✅ exposure.test.ts 全過（${n} 組）`);
