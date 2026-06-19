// 共用 Hono app 工廠：本機 node 伺服器（src/index.ts）與 Vercel serverless
// （api/index.ts）共用同一份路由與 x402 paymentMiddleware，只差啟動外殼。
//
// serverless 注意事項：
//   - 結算（routeExternalRevenue）在回應前 **await**，並把 tx 一起回傳——serverless
//     不保證「回應後背景跑」，fire-and-forget 會被砍掉。
//   - /revenue 直接讀鏈上（X402 FeeRouter），因 in-memory 帳務每次 invocation 歸零。
import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, type Network } from "x402-hono";
import { ethers } from "ethers";
import {
  resolvePayTo,
  ADDRESSES,
  makeProvider,
  makeContracts,
  makeSigner,
  getSessionManagerAddress,
  getTraderPerformance,
  getOracleSnapshot,
  jsonSafe,
  parseDidPkh,
  agentDid,
  buildAgentVerification,
  type ContractTarget,
} from "@pepelab/shared";
import { isSettlementEnabled, settleRevenue } from "./settlement.ts";
import { getOnchainRevenue, isOnchainRevenueEnabled } from "./onchainRevenue.ts";

const NETWORK = (process.env.X402_NETWORK ?? "base-sepolia") as Network;
const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";
const PAY_TO = resolvePayTo(ADDRESSES.FeeRouter);
const SETTLEMENT_TOKEN =
  process.env.X402_SETTLEMENT_TOKEN?.trim() ||
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // 官方 Base Sepolia USDC

// 單一定價來源：付費牆、帳務、文件共用。
export const PRICE_SIGNALS = 0.01; // USDC
export const PRICE_ORACLE = 0.005; // USDC

const provider = makeProvider();
const contracts = makeContracts(provider);

// ── ERC-8126 verification layer ───────────────────────────────────────────────
// Verifier identity that signs agent verification attestations. Prefers
// VERIFIER_PRIVATE_KEY; falls back to a process-stable random wallet so the
// endpoint works out-of-the-box (each attestation self-describes its verifier
// DID, and tamper-detection still holds within a process lifetime).
const VERIFIER_WALLET = (() => {
  const pk = process.env.VERIFIER_PRIVATE_KEY?.trim();
  if (pk && pk.startsWith("0x") && pk.length === 66) return new ethers.Wallet(pk);
  return ethers.Wallet.createRandom();
})();

// Public base URL for the WAV (web-accessible) self-check. SIGNAL_API_PUBLIC_URL
// overrides; otherwise derived per-request from the incoming origin.
function resolveApiBaseUrl(reqUrl: string): string {
  const fromEnv = process.env.SIGNAL_API_PUBLIC_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  try {
    return new URL(reqUrl).origin;
  } catch {
    return "http://localhost:4021";
  }
}

// ETV targets: settlement token + core protocol contract (must exist on-chain).
const ETV_TARGETS: ContractTarget[] = [
  { label: "USDC (settlement)", address: SETTLEMENT_TOKEN },
  { label: "PerpetualExchange", address: ADDRESSES.PerpetualExchange },
];
// SCV targets: core contracts whose source should be explorer-verified.
const SCV_TARGETS: ContractTarget[] = [
  { label: "PerpetualExchange", address: ADDRESSES.PerpetualExchange },
  { label: "FeeRouter", address: ADDRESSES.FeeRouter },
  { label: "AgentSessionManager", address: getSessionManagerAddress() },
];

// 解析分析對象（demo 用）：env 優先，否則鏈上第一個已註冊 trader。
async function resolveTrader(want?: string): Promise<string> {
  if (want && /^0x[0-9a-fA-F]{40}$/.test(want)) return want;
  const envT = process.env.DEMO_TRADER_ADDRESS?.trim();
  if (envT && /^0x[0-9a-fA-F]{40}$/.test(envT)) return envT;
  const list = (await contracts.registry.getAllTraders()) as string[];
  if (!list.length) throw new Error("鏈上尚無已註冊 trader");
  return list[0];
}

// /demo/buy-signal 速率限制（best-effort）：per-IP 冷卻 + per-instance 硬上限。
// 注意：serverless 上記憶體是 per-instance、X-Forwarded-For 可偽造，故 IP 冷卻只是
// 第一道；真正防線是「demo treasury 只放 dust」(見 README 安全備註) + 這個總量硬上限。
const DEMO_COOLDOWN_MS = Number(process.env.DEMO_COOLDOWN_MS ?? "15000");
const DEMO_MAX_BUYS = Number(process.env.DEMO_MAX_BUYS ?? "50"); // 每個暖實例壽命內上限
const lastBuyByIp = new Map<string, number>();
let demoBuyCount = 0;

export function createApp(): Hono {
  const app = new Hono();

  // GET 端點對所有來源開放（瀏覽器 demo + 外部 agent）；只開 GET/OPTIONS/POST 給 demo。
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

  // ── 極簡 liveness（隔離進入點/adapter 問題用，立即回 200） ────────────────
  app.get("/healthz", (c) => c.text("ok"));

  // ── 免費：可被發現的服務目錄（agent/CLI 先探索） ─────────────────────────
  app.get("/", (c) =>
    c.json({
      service: "pepelab-signal-api",
      discoverable: true,
      description:
        "Pay-per-call trading signals over x402. The endpoint IS the product — " +
        "any agent with a Base Sepolia USDC wallet can pay and consume directly.",
      network: NETWORK,
      asset: SETTLEMENT_TOKEN,
      payTo: PAY_TO,
      revenueModel: "FeeRouter 70/20/10 (trader/platform/vault), settled on-chain",
      endpoints: {
        "GET /signals/:trader": { price: `$${PRICE_SIGNALS}`, paid: true, desc: "trader 績效 + 開倉建議" },
        "GET /oracle/:asset": { price: `$${PRICE_ORACLE}`, paid: true, desc: "價格 + funding + OI 快照" },
        "GET /revenue": { price: "free", desc: "鏈上 70/20/10 累計（可選 ?trader=）" },
        "GET /agent/:did/verification": { price: "free", desc: "ERC-8126 agent 驗證（ETV/SCV/WAV/WV + 0–100 風險分數，verifier 簽章）" },
        "POST /demo/buy-signal": { price: "free", desc: "訪客試買（伺服器代付，回真實 settlement tx）" },
      },
      example: {
        curl: "curl -s <BASE_URL>/  # discover, then pay with any x402 client",
        node: "see agent/examples/buy-signal.ts (x402-fetch + viem)",
      },
    }),
  );

  // ── 免費：鏈上收入（X402 FeeRouter 真實累計） ────────────────────────────
  app.get("/revenue", async (c) => {
    try {
      const trader = c.req.query("trader");
      return c.json(jsonSafe(await getOnchainRevenue(trader)));
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 502);
    }
  });

  // ── 免費：ERC-8126 agent 驗證層（對手方/marketplace 可查「這個 agent 可不可信」）──
  app.get("/agent/:did/verification", async (c) => {
    const raw = c.req.param("did");
    try {
      // 接受 did:pkh 或裸 0x 地址；裸地址轉成 did:pkh。
      const did = raw.startsWith("did:") ? raw : agentDid(raw);
      parseDidPkh(did); // 驗證格式；malformed 直接丟錯 → 400
      const av = await buildAgentVerification({
        did,
        verifier: VERIFIER_WALLET,
        provider,
        apiBaseUrl: resolveApiBaseUrl(c.req.url),
        etvTargets: ETV_TARGETS,
        scvTargets: SCV_TARGETS,
        explorerApiKey:
          process.env.ETHERSCAN_API_KEY?.trim() ||
          process.env.BASESCAN_API_KEY?.trim(),
        paidPath: "/oracle/sBTC",
        // 若伺服器持有的 session key 正好是此 agent，附上持有證明（WV）。
        holderSigner: (() => {
          const s = makeSigner(provider);
          if (!s) return undefined;
          try {
            return ethers.getAddress(s.address) === parseDidPkh(did).address
              ? s
              : undefined;
          } catch {
            return undefined;
          }
        })(),
      });
      return c.json(jsonSafe({ ok: true, verification: av }));
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  });

  // ── 免費 demo：訪客不需自帶錢包；伺服器以 settlement 錢包代付並回真實 tx ──
  app.post("/demo/buy-signal", async (c) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";
    const now = Date.now();
    const last = lastBuyByIp.get(ip) ?? 0;
    if (now - last < DEMO_COOLDOWN_MS) {
      return c.json(
        { ok: false, error: `rate limited — wait ${Math.ceil((DEMO_COOLDOWN_MS - (now - last)) / 1000)}s` },
        429,
      );
    }
    if (demoBuyCount >= DEMO_MAX_BUYS) {
      return c.json(
        { ok: false, error: "demo spend cap reached — 外部 agent 請自帶錢包經 x402 付費（見 /）" },
        429,
      );
    }
    lastBuyByIp.set(ip, now);
    demoBuyCount += 1;

    try {
      const body = (await c.req.json().catch(() => ({}))) as { trader?: string };
      const trader = await resolveTrader(body.trader);
      const signal = await getTraderPerformance(contracts, trader);

      let settlementTx: string | undefined;
      let settleError: string | undefined;
      if (isSettlementEnabled()) {
        const r = await settleRevenue(trader, PRICE_SIGNALS); // 真的上鏈 70/20/10
        if (r.status === "settled") settlementTx = r.tx;
        else settleError = r.error;
      }
      return c.json(
        jsonSafe({
          ok: true,
          paymentInfo: {
            model: "x402 70/20/10 on-chain",
            priceUsd: PRICE_SIGNALS,
            asset: SETTLEMENT_TOKEN,
            note: "demo: 伺服器代付；真實外部 agent 自帶錢包經 x402 付費（見 /）",
          },
          settlementTx,
          settleError,
          trader,
          signal,
        }),
      );
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  });

  // ── x402 付費牆：保護兩個 GET 端點 ──────────────────────────────────────
  app.use(
    paymentMiddleware(
      PAY_TO as `0x${string}`,
      {
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

  // ── 付費後才會執行到這裡 ─────────────────────────────────────────────────
  app.get("/signals/:trader", async (c) => {
    const trader = c.req.param("trader");
    try {
      const perf = await getTraderPerformance(contracts, trader);
      // serverless：在回應前 await 結算，並把 tx 一起回（沿用幣別守衛）。
      let settlementTx: string | undefined;
      let settleError: string | undefined;
      if (isSettlementEnabled()) {
        const r = await settleRevenue(trader, PRICE_SIGNALS);
        if (r.status === "settled") settlementTx = r.tx;
        else settleError = r.error;
      }
      // 付費者已拿到訊號（ok:true）；`settled` 讓消費端能偵測「付了但分潤未上鏈」。
      return c.json(
        jsonSafe({ ok: true, settled: !!settlementTx, data: perf, settlementTx, settleError }),
      );
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  });

  app.get("/oracle/:asset", async (c) => {
    const asset = c.req.param("asset");
    try {
      const snap = await getOracleSnapshot(contracts, asset);
      return c.json(jsonSafe({ ok: true, data: snap }));
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  });

  return app;
}

export const config = { PAY_TO, NETWORK, FACILITATOR_URL, SETTLEMENT_TOKEN, isSettlementEnabled, isOnchainRevenueEnabled };
