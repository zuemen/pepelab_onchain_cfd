// x402 付費 Signal API（Phase 1, read-only）
//   GET /signals/:trader  — trader 績效摘要 + 開倉建議  (0.01 USDC)
//   GET /oracle/:asset    — 價格 + funding + OI 快照     (0.005 USDC)
// Phase 4：付費結算與合約狀態讀取同走 Base Sepolia（同鏈，跨鏈 caveat 已解）。
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, type Network } from "x402-hono";
import {
  loadEnv,
  resolvePayTo,
  ADDRESSES,
  makeProvider,
  makeContracts,
  getTraderPerformance,
  getOracleSnapshot,
  jsonSafe,
} from "@pepelab/shared";
import { recordRevenue, getRevenueSummary } from "./revenue.ts";
import { isSettlementEnabled, settleRevenue } from "./settlement.ts";

loadEnv();

const PORT = Number(process.env.SIGNAL_API_PORT ?? 4021);
const NETWORK = (process.env.X402_NETWORK ?? "base-sepolia") as Network;
const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";
// payTo 必須是能持有官方 USDC 的 treasury EOA。未設 PAY_TO 會回退到 MockUSDC 版
// FeeRouter，官方 USDC 付進去會卡死（與 settlement 幣別守衛打架）→ 開機即警告。
const PAY_TO = resolvePayTo(ADDRESSES.FeeRouter);
if (!process.env.PAY_TO?.trim()) {
  console.warn(
    `⚠ 未設 PAY_TO，回退到 MockUSDC FeeRouter ${ADDRESSES.FeeRouter}；` +
      "官方 USDC 付款會卡死。請在 .env 設 PAY_TO=treasury EOA。",
  );
}

// 單一定價來源：付費牆與收入帳務共用，避免漂移。
const PRICE_SIGNALS = 0.01; // USDC
const PRICE_ORACLE = 0.005; // USDC

const provider = makeProvider();
const contracts = makeContracts(provider);

const app = new Hono();

// 允許瀏覽器跨來源讀取（前端監控面板會打 / 與 /revenue）。
app.use("*", cors());

// ── 免費端點：健康檢查 + 定價表（agent 可先探索） ──────────────────────────
app.get("/", (c) =>
  c.json({
    service: "pepelab-signal-api",
    network_read: "base-sepolia",
    network_settle: NETWORK,
    payTo: PAY_TO,
    revenueModel: "FeeRouter 70/20/10 (trader/platform/vault)",
    endpoints: {
      "GET /signals/:trader": `${PRICE_SIGNALS} USDC — trader 績效 + 開倉建議`,
      "GET /oracle/:asset": `${PRICE_ORACLE} USDC — 價格 + funding + OI 快照`,
      "GET /revenue": "free — x402 收入歸屬 + 70/20/10 分潤帳務",
    },
  }),
);

// ── 免費端點：收入帳務（x402 收入如何按 FeeRouter 70/20/10 歸屬） ─────────────
app.get("/revenue", (c) => c.json(jsonSafe(getRevenueSummary())));

// ── x402 付費牆：只保護兩個 GET 端點 ────────────────────────────────────────
app.use(
  paymentMiddleware(
    PAY_TO as `0x${string}`,
    {
      // 注意：x402 的路徑比對用 [param] 語法（→ [^/]+），與 Hono 的 :param 不同。
      // 這裡要對得上「實際請求路徑」/signals/0x… ，故用中括號。
      "GET /signals/[trader]": {
        price: `$${PRICE_SIGNALS}`,
        network: NETWORK,
        config: { description: "Trader 即時績效摘要 + 開倉建議" },
      },
      "GET /oracle/[asset]": {
        price: `$${PRICE_ORACLE}`,
        network: NETWORK,
        config: { description: "聚合價格 + funding rate + OI 快照" },
      },
    },
    { url: FACILITATOR_URL as `${string}://${string}` },
  ),
);

// ── 付費後才會執行到這裡 ────────────────────────────────────────────────────
app.get("/signals/:trader", async (c) => {
  const trader = c.req.param("trader");
  try {
    const perf = await getTraderPerformance(contracts, trader);
    // 付費已由 x402 中介層結算；把這筆收入按 70/20/10 歸給該 trader。
    const entry = recordRevenue({ endpoint: "signals", feeUsd: PRICE_SIGNALS, trader });
    // 若啟用鏈上結算：真的呼叫 FeeRouter.routeExternalRevenue（fire-and-forget，
    // 不擋 agent 的回應；結果寫回帳務，/revenue 可見 tx）。
    if (isSettlementEnabled()) {
      entry.settlement = { status: "pending" };
      void settleRevenue(trader, PRICE_SIGNALS).then((r) => {
        entry.settlement = r;
        if (r.status === "settled") console.log(`  ⛓ settled ${PRICE_SIGNALS} USDC → FeeRouter for ${trader}: ${r.tx}`);
        else console.warn(`  ⚠ settlement failed: ${r.error}`);
      });
    }
    return c.json(jsonSafe({ ok: true, data: perf }));
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 400);
  }
});

app.get("/oracle/:asset", async (c) => {
  const asset = c.req.param("asset");
  try {
    const snap = await getOracleSnapshot(contracts, asset);
    recordRevenue({ endpoint: "oracle", feeUsd: PRICE_ORACLE, asset });
    return c.json(jsonSafe({ ok: true, data: snap }));
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 400);
  }
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`▶ Signal API listening on http://localhost:${info.port}`);
  console.log(`  payTo (x402 收款 → FeeRouter): ${PAY_TO}`);
  console.log(`  結算網路: ${NETWORK}  facilitator: ${FACILITATOR_URL}`);
  console.log(`  讀取網路: Base Sepolia (84532, 同鏈結算)`);
  console.log(`  鏈上分潤結算 (FeeRouter.routeExternalRevenue): ${isSettlementEnabled() ? "ON ⛓" : "off (僅鏈下帳務)"}`);
});
