// 只讀的 live integration 測試：Base Sepolia 公共 RPC + 正式 signal-api 的免費端點。
// 預設 skip；`SDK_LIVE=1` 或 `--live` 才跑：
//   cd agent && npm run test:sdk:live
//
// 不送任何交易、不簽任何東西、不付任何錢：
//   • 鏈上只有 eth_call／eth_getBlock*（simulateContract 也是 eth_call）；
//   • 付費端點只在「沒有注入 payment client」的情況下呼叫 —— SDK 根本沒有能力付款，
//     預期拿到 PayToUnsafeError（現況）或 PaymentRequiredError。
import assert from "node:assert";
import { createPublicClient, http, type Abi } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

import {
  AGENT_SESSION_MANAGER_ABI,
  ASSET_SYMBOLS,
  ERC20_ABI,
  INLINE_SCHEMA_KEYS,
  MARGIN_DECIMALS,
  PERPETUAL_EXCHANGE_ABI,
  PaymentRequiredError,
  PayToUnsafeError,
  SCHEMA_KEYS,
  SignalApiClient,
  buildClosePosition,
  createReadClient,
} from "../src/index.ts";

const LIVE = process.env.SDK_LIVE === "1" || process.argv.includes("--live");
if (!LIVE) {
  console.log("↷ sdk live.test.ts 略過（設定 SDK_LIVE=1 或 `npm run test:sdk:live` 才會連網）");
  process.exit(0);
}

const RPC = process.env.SDK_LIVE_RPC_URL ?? "https://sepolia.base.org";
const API = process.env.SDK_LIVE_API_URL ?? "https://agent-git-master-zuemens-projects.vercel.app";
let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);
const hasRequired = (label: string, body: unknown, required: readonly string[]) => {
  const missing = required.filter((k) => !(k in (body as object)));
  assert.deepEqual(missing, [], `${label} 缺少 openapi 必填欄位：${missing.join(", ")}`);
};

// ── 鏈上 ─────────────────────────────────────────────────────────────────────
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC, { retryCount: 3, timeout: 20_000 }) });
const read = createReadClient({ chainId: 84532, publicClient, latestBlockLag: 3 });
const A = read.addresses;
const ctx = await read.getBlockContext();
console.log(`  區塊 ${ctx.blockNumber}（${new Date(Number(ctx.blockTimestamp) * 1000).toISOString()}）`);

{
  // addresses.ts 與鏈上互相指向：exchange.usdc/oracle、sessionManager.exchange
  const at = { blockNumber: ctx.blockNumber };
  const [usdc, oracle, mgrExchange, decimals] = await Promise.all([
    publicClient.readContract({ address: A.perpetualExchange, abi: PERPETUAL_EXCHANGE_ABI as Abi, functionName: "usdc", ...at }),
    publicClient.readContract({ address: A.perpetualExchange, abi: PERPETUAL_EXCHANGE_ABI as Abi, functionName: "oracle", ...at }),
    publicClient.readContract({ address: A.sessionManager!, abi: AGENT_SESSION_MANAGER_ABI as Abi, functionName: "exchange", ...at }),
    publicClient.readContract({ address: A.marginToken, abi: ERC20_ABI as Abi, functionName: "decimals", ...at }),
  ]);
  assert.equal(String(usdc).toLowerCase(), A.marginToken.toLowerCase(), "exchange.usdc() == addresses.MockUSDC");
  assert.equal(String(oracle).toLowerCase(), A.oracle.toLowerCase(), "exchange.oracle() == addresses.MockOracle");
  assert.equal(String(mgrExchange).toLowerCase(), A.perpetualExchange.toLowerCase(), "sessionManager.exchange() == exchange");
  assert.equal(Number(decimals), MARGIN_DECIMALS, "保證金代幣 18 位小數");
  ok("位址一致：exchange.usdc/oracle、sessionManager.exchange 與 addresses.ts 相符；保證金 18 位小數");
}

const markets = await read.getMarkets(ASSET_SYMBOLS, { blockNumber: ctx.blockNumber });
{
  assert.equal(markets.length, ASSET_SYMBOLS.length);
  for (const m of markets) {
    assert.equal(m.blockNumber, ctx.blockNumber);
    assert.ok(m.oracle.price.raw > 0n, `${m.asset} 價格 > 0`);
    assert.ok(m.oracle.freshness.maxPriceAgeSec > 0);
  }
  const m0 = markets[0]!;
  console.log(
    `  ${m0.asset} $${m0.oracle.price.formatted} age ${m0.oracle.freshness.ageSec}s / max ${m0.oracle.freshness.maxPriceAgeSec}s ` +
      `fresh=${m0.oracle.freshness.fresh} mode=${m0.mode.supported ? m0.mode.value : "unsupported"} ` +
      `paused=${m0.paused.supported ? m0.paused.value : "unsupported"} longNotional=${m0.openInterest.longNotional.formatted}`,
  );
  const fresh = markets.filter((m) => m.oracle.freshness.fresh).length;
  console.log(`  ${fresh}/${markets.length} 個資產價格新鮮；P1 getter ${m0.mode.supported ? "存在" : "不存在（現行部署版）"}`);
  ok(`getMarkets：${markets.length} 個資產同一區塊讀完`);
}

{
  const s = await read.getSession(0, { blockNumber: ctx.blockNumber });
  console.log(`  session 0：exists=${s.exists} active=${s.active} unrestricted=${s.unrestricted} assets=${s.allowedAssets.map((a) => a.asset).join(",") || "-"}`);
  if (s.exists) {
    const acct = await read.getAccount(s.user, { blockNumber: ctx.blockNumber, includeClosed: true });
    console.log(`  session 0 user：freeMargin ${acct.freeMargin.formatted}、部位 ${acct.positionIds.length} 筆（未平倉 ${acct.positions.filter((p) => p.isOpen).length}）`);
    for (const p of acct.positions) assert.equal(p.owner.toLowerCase(), s.user.toLowerCase(), "getPosition 解碼（13 欄 ABI 讀現行合約）");
  }
  // 現行 exchange 可能還沒有任何部位；至少確認 getPosition 的 tuple 解碼能吃下現行合約（16 欄）的回傳。
  const p0 = await read.getPosition(0, { blockNumber: ctx.blockNumber });
  assert.equal(typeof p0.isOpen, "boolean");
  console.log(`  getPosition(0)：owner ${p0.owner} isOpen=${p0.isOpen}`);
  ok("getSession／getAccount（部位 struct 解碼）");
}

{
  // simulateContract（eth_call，不是交易）：確認 request 形狀能直接給 viem 用。
  // 隨機地址平一個不存在的部位 → 合約 revert，代表請求確實抵達合約並被執行。
  const nobody = privateKeyToAccount(generatePrivateKey());
  const tx = buildClosePosition(A, { positionId: 2n ** 64n });
  await assert.rejects(
    publicClient.simulateContract({ ...tx.request, account: nobody }),
    (e: Error) => /revert/i.test(e.message),
  );
  ok("simulateContract 吃得下 builder 的 request（eth_call，合約 revert 如預期）");
}

// ── signal-api 免費端點 ──────────────────────────────────────────────────────
const api = new SignalApiClient({ baseUrl: API, timeoutMs: 30_000 });
{
  assert.equal((await api.healthz()).trim(), "ok");
  const d = await api.discover();
  hasRequired("discover", d, SCHEMA_KEYS.Discovery.required);
  assert.equal(d.service, "pepelab-signal-api");
  console.log(`  payTo ${d.payTo} safe=${d.payToSafety.safe}`);
  const c = await api.getCandles("sBTC", { interval: "1h", limit: 2 });
  hasRequired("candles", c, SCHEMA_KEYS.CandleResponse.required);
  for (const k of c.candles) hasRequired("candle", k, SCHEMA_KEYS.Candle.required);
  const rev = await api.getRevenue();
  hasRequired("revenue", rev, SCHEMA_KEYS.Revenue.required);
  const b = await api.getBenchmarks();
  hasRequired("benchmarks", b, SCHEMA_KEYS.BenchmarksResponse.required);
  const x = await api.getRiskExposure();
  hasRequired("risk/exposure", x, INLINE_SCHEMA_KEYS["GET /risk/exposure 200"].required);
  assert.equal(x.chainId, 84532);
  console.log(`  /risk/exposure asOfBlock ${x.asOfBlock}、unavailable ${Object.keys(x.unavailable).length} 欄`);
  ok("免費端點：healthz／discover／candles／revenue／benchmarks／risk/exposure 回應含 openapi 必填欄位");
}

{
  // 付費端點：沒有 payment client → 不可能付款。現況收款地址未通過守門 → 503 payto_unsafe。
  const noPay = new SignalApiClient({ baseUrl: API, timeoutMs: 30_000, retry: { retries: 0 } });
  let outcome = "";
  try {
    await noPay.getOracleSnapshot("sBTC");
    outcome = "200（伺服器未要求付款）";
  } catch (e) {
    assert.ok(e instanceof PayToUnsafeError || e instanceof PaymentRequiredError, `非預期錯誤：${(e as Error).name} ${(e as Error).message}`);
    outcome = (e as Error).name;
    if (e instanceof PayToUnsafeError) hasRequired("payto_unsafe", e.body, SCHEMA_KEYS.PayToUnsafe.required);
  }
  assert.equal(noPay.spentAtomic(), 0n);
  console.log(`  /oracle/sBTC（無 payment client）→ ${outcome}`);
  ok("付費端點在無 payment client 下回型別化錯誤，花費 0");
}

console.log(`\n✅ sdk live.test.ts 全過（${n} 項）`);
