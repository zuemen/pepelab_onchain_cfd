// x402 付費 Signal API（Phase 1, read-only）
//   GET /signals/:trader  — trader 績效摘要 + 開倉建議  (0.01 USDC)
//   GET /oracle/:asset    — 價格 + funding + OI 快照     (0.005 USDC)
// 付費結算走 Base Sepolia USDC；合約狀態讀 Ethereum Sepolia。
import { serve } from "@hono/node-server";
import { Hono } from "hono";
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

loadEnv();

const PORT = Number(process.env.SIGNAL_API_PORT ?? 4021);
const NETWORK = (process.env.X402_NETWORK ?? "base-sepolia") as Network;
const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";
const PAY_TO = resolvePayTo(ADDRESSES.FeeRouter);

// 單一定價來源：付費牆與收入帳務共用，避免漂移。
const PRICE_SIGNALS = 0.01; // USDC
const PRICE_ORACLE = 0.005; // USDC

const provider = makeProvider();
const contracts = makeContracts(provider);

const app = new Hono();

// ── 免費端點：健康檢查 + 定價表（agent 可先探索） ──────────────────────────
app.get("/", (c) =>
  c.json({
    service: "pepelab-signal-api",
    phase: "1 (read-only)",
    network_read: "ethereum-sepolia",
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
    recordRevenue({ endpoint: "signals", feeUsd: PRICE_SIGNALS, trader });
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
  console.log(`  讀取網路: Ethereum Sepolia`);
});
