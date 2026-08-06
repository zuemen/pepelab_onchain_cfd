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
  assetIdOf,
  classifyTradeFreshness,
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
  resolveSettlementToken,
  ASSET_IDS,
  type ContractTarget,
} from "@pepelab/shared";
import { isSettlementEnabled, settleRevenue } from "./settlement.ts";
import { getOnchainRevenue, isOnchainRevenueEnabled } from "./onchainRevenue.ts";
import {
  getCandles,
  INTERVAL_KEYS,
  MAX_LIMIT,
  UnknownMarketError,
  BadIntervalError,
} from "./candles.ts";

const NETWORK = (process.env.X402_NETWORK ?? "base-sepolia") as Network;
const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";
const PAY_TO = resolvePayTo(ADDRESSES.FeeRouter);
// 單一來源（shared/env.ts）。這裡與 settlement.ts 以前各有一份**不同**的預設值
// （官方 USDC vs MockUSDC），導致 `_assertCurrencyMatch` 永遠抓不到錯配。
const SETTLEMENT_TOKEN = resolveSettlementToken();

// 單一定價來源：付費牆、帳務、文件共用。
export const PRICE_SIGNALS = 0.01; // USDC
export const PRICE_ORACLE = 0.005; // USDC

// 免費 demo 的預設分析對象：當未帶 trader、未設 DEMO_TRADER_ADDRESS 且鏈上
// registry 尚無註冊 trader 時，退回這個已知有鏈上活動的地址（treasury/deployer），
// 讓「訪客試買」仍能回真實訊號。可用 DEMO_TRADER_ADDRESS env 覆寫。
const DEFAULT_DEMO_TRADER = "0xE80A81360608C1342e66743F70a00f75d792Eb93";

const provider = makeProvider();
const contracts = makeContracts(provider);

// ── ERC-8126 verification layer ───────────────────────────────────────────────
// Verifier identity that signs agent verification attestations. Prefers
// VERIFIER_PRIVATE_KEY; falls back to a process-stable random wallet so the
// endpoint works out-of-the-box (each attestation self-describes its verifier
// DID, and tamper-detection still holds within a process lifetime).
const VERIFIER_IS_EPHEMERAL = (() => {
  const pk = process.env.VERIFIER_PRIVATE_KEY?.trim();
  return !(pk && pk.startsWith("0x") && pk.length === 66);
})();
const VERIFIER_WALLET = (() => {
  const pk = process.env.VERIFIER_PRIVATE_KEY?.trim();
  if (!VERIFIER_IS_EPHEMERAL) return new ethers.Wallet(pk!);
  console.warn("[verifier] 未設 VERIFIER_PRIVATE_KEY → 使用臨時隨機 verifier；正式環境請固定設定以保身分穩定。");
  return ethers.Wallet.createRandom();
})();

// Public base URL for the WAV (web-accessible) self-check.
//
// 稽核（四·Medium）：舊版在缺 SIGNAL_API_PUBLIC_URL 時直接取 `new URL(c.req.url).origin`
// —— 而 serverless 的 request URL 是由**呼叫者可控的 Host header** 組出來的。於是這個
// 免費、未認證的端點會照著攻擊者給的 Host 去發外連請求（SSRF-ish 放大器）。
// 現在：env 優先；否則只接受白名單內的 origin；都不符就退回固定預設值。
const PUBLIC_URL_ALLOWLIST = (process.env.SIGNAL_API_URL_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);
const FALLBACK_API_BASE_URL = "http://localhost:4021";

export function resolveApiBaseUrl(reqUrl: string): string {
  const fromEnv = process.env.SIGNAL_API_PUBLIC_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  try {
    const origin = new URL(reqUrl).origin;
    if (PUBLIC_URL_ALLOWLIST.includes(origin)) return origin;
    const host = new URL(origin).hostname;
    // localhost 開發一律放行；其餘一律不信任請求帶進來的 host。
    if (host === "localhost" || host === "127.0.0.1") return origin;
  } catch {
    /* fall through */
  }
  return FALLBACK_API_BASE_URL;
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
  if (list.length) return list[0];
  // registry 尚無註冊 trader → 退回已知有鏈上活動的 demo 地址，免費試買仍可回真實訊號。
  return DEFAULT_DEMO_TRADER;
}

// /demo/buy-signal 速率限制（best-effort）：per-IP 冷卻 + per-instance 硬上限。
// 注意：serverless 上記憶體是 per-instance、X-Forwarded-For 可偽造，故 IP 冷卻只是
// 第一道；真正防線是「demo treasury 只放 dust」(見 README 安全備註) + 這個總量硬上限。
const DEMO_COOLDOWN_MS = Number(process.env.DEMO_COOLDOWN_MS ?? "15000");
const DEMO_MAX_BUYS = Number(process.env.DEMO_MAX_BUYS ?? "50"); // 每個暖實例壽命內上限
const lastBuyByIp = new Map<string, number>();
let demoBuyCount = 0;

/** `lastBuyByIp` 以前永不淘汰 → 長壽實例的記憶體無上界。定期清掉過期項目。 */
function pruneIpMap(map: Map<string, number>, ttlMs: number, cap = 5_000): void {
  const now = Date.now();
  for (const [k, t] of map) if (now - t > ttlMs) map.delete(k);
  // 極端情況（大量不同 IP 在 TTL 內湧入）仍要有硬上限。
  if (map.size > cap) {
    const excess = map.size - cap;
    let i = 0;
    for (const k of map.keys()) {
      map.delete(k);
      if (++i >= excess) break;
    }
  }
}

function clientIp(c: { req: { header: (k: string) => string | undefined } }): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

// ── 免費端點的節流（稽核 四·Low：CORS 全開且免費端點無節流）────────────────
// 免費端點每一個都會打 RPC / 外部 API，未節流時任何人都能把它當放大器。
// serverless 上這是 per-instance 的 best-effort，與 /demo 的硬上限同一等級的防線。
const FREE_RATE_WINDOW_MS = Number(process.env.FREE_RATE_WINDOW_MS ?? "60000");
const FREE_RATE_MAX = Number(process.env.FREE_RATE_MAX ?? "60"); // 每 IP 每視窗
const freeHits = new Map<string, { count: number; resetAt: number }>();

function freeRateLimited(ip: string): { limited: boolean; retryAfterSec: number } {
  const now = Date.now();
  const e = freeHits.get(ip);
  if (!e || now >= e.resetAt) {
    freeHits.set(ip, { count: 1, resetAt: now + FREE_RATE_WINDOW_MS });
    if (freeHits.size > 5_000) {
      for (const [k, v] of freeHits) if (now >= v.resetAt) freeHits.delete(k);
    }
    return { limited: false, retryAfterSec: 0 };
  }
  e.count += 1;
  if (e.count > FREE_RATE_MAX) {
    return { limited: true, retryAfterSec: Math.ceil((e.resetAt - now) / 1000) };
  }
  return { limited: false, retryAfterSec: 0 };
}

// CORS：GET 的公開資料維持全開（agent/瀏覽器都要用），但**寫入型**的
// POST /demo/buy-signal 只允許白名單 origin（預設只有本機與正式前端）。
const CORS_ALLOWED_ORIGINS = (
  process.env.CORS_ALLOWED_ORIGINS ??
  "http://localhost:5173,http://localhost:4173,https://pepelab-onchain-cfd-djot.vercel.app"
)
  .split(",")
  .map((s) => s.trim().replace(/\/$/, ""))
  .filter(Boolean);

export function createApp(): Hono {
  const app = new Hono();

  // GET 資料端點對所有來源開放（瀏覽器 demo + 外部 agent 都要用）。
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

  // /demo/*（會動用伺服器錢包）額外限制來源。
  // 註：CORS header 只約束瀏覽器讀取回應，擋不住任何非瀏覽器客戶端 —— 所以這裡是
  // 直接**拒絕請求**（403），而不是只把 Access-Control-Allow-Origin 拿掉。
  // 沒有 Origin header 的請求（curl / agent）不受此限，仍受下方的 per-IP 冷卻與
  // 總量硬上限約束。
  app.use("/demo/*", async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const origin = c.req.header("origin")?.replace(/\/$/, "");
    if (origin && !CORS_ALLOWED_ORIGINS.includes(origin)) {
      return c.json({ ok: false, error: `origin 未在白名單內：${origin}` }, 403);
    }
    return next();
  });

  // ── 極簡 liveness（隔離進入點/adapter 問題用，立即回 200） ────────────────
  app.get("/healthz", (c) => c.text("ok"));

  // ── 免費端點節流（healthz 除外，它必須永遠即時回應）──────────────────────
  app.use("*", async (c, next) => {
    const p = c.req.path;
    if (p === "/healthz") return next();
    // 付費端點由 x402 付款牆自然節流，不重複限流。
    if (p.startsWith("/oracle/") || p.startsWith("/signals/")) return next();
    const { limited, retryAfterSec } = freeRateLimited(clientIp(c));
    if (limited) {
      return c.json(
        { ok: false, error: `rate limited — 每 ${FREE_RATE_WINDOW_MS / 1000}s 上限 ${FREE_RATE_MAX} 次，請 ${retryAfterSec}s 後再試` },
        429,
        { "Retry-After": String(retryAfterSec) },
      );
    }
    return next();
  });

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
      // 誠實描述金流：x402 的付款直接進 payTo，70/20/10 是平台事後另外送的一筆
      // 交易。把兩者寫成同一件事會讓讀者以為買方付的那筆錢就是被分潤的那筆錢。
      revenueModel:
        `x402 付款直接進 payTo（${PAY_TO}）；70/20/10 分潤由平台另行透過 ` +
        `FeeRouter.routeExternalRevenue 上鏈結算，累計可於 /revenue 查詢。` +
        `兩者是不同的兩筆交易。`,
      endpoints: {
        "GET /signals/:trader": { price: `$${PRICE_SIGNALS}`, paid: true, desc: "trader 績效 + 開倉建議" },
        "GET /oracle/:asset": { price: `$${PRICE_ORACLE}`, paid: true, desc: "決策級快照：價格 / funding / OI 失衡 / 預估清算價 / edge 建議（long·short·no_trade）。與 /signals 一樣會走 FeeRouter 70/20/10 結算並回 settlementTx" },
        "GET /revenue": { price: "free", desc: "鏈上 70/20/10 累計（可選 ?trader=）" },
        "GET /candles/:symbol": {
          price: "free",
          desc:
            "K 線 OHLCV。?interval= 預設 1h，?limit= 預設 300（上限 " +
            `${MAX_LIMIT}）。回應帶 source 出處，圖表須標示。`,
          intervals: INTERVAL_KEYS,
        },
        "GET /agent/:did/verification": { price: "free", desc: "ERC-8126 agent 驗證（ETV/SCV/WAV/WV + 0–100 風險分數，verifier 簽章）" },
        "POST /demo/buy-signal": { price: "free", desc: "訪客試買（免費回訊號；真實 70/20/10 分潤見付費 x402 端點 + /revenue 累計）" },
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

  // ── 免費：K 線（OHLCV）──────────────────────────────────────────────────
  //
  // ⚠ 位置有意義：Hono 依註冊順序比對，這條必須留在下面 paymentMiddleware 的
  //   app.use() **之前**，否則會被 x402 付費牆攔下。圖表資料是前端每次載入頁面
  //   都要打的公開資料，不是付費商品。
  app.get("/candles/:symbol", async (c) => {
    try {
      const data = await getCandles(
        c.req.param("symbol"),
        c.req.query("interval") ?? "1h",
        c.req.query("limit"),
      );
      return c.json(data);
    } catch (err) {
      if (err instanceof UnknownMarketError || err instanceof BadIntervalError) {
        return c.json({ ok: false, error: (err as Error).message }, 400);
      }
      // getCandles 內部有模擬保底，走到這裡代表是預期外的錯誤。
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
        // 誠實標示降級：未設 VERIFIER_PRIVATE_KEY 時每個實例一把隨機金鑰，
        // 簽章仍真、但那個 verifier 身分無法被任何人 pin 住。
        verifierEphemeral: VERIFIER_IS_EPHEMERAL,
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
    const ip = clientIp(c);
    const now = Date.now();
    pruneIpMap(lastBuyByIp, Math.max(DEMO_COOLDOWN_MS * 10, 600_000));
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
      // serverless 關鍵修正：Vercel Node runtime 常已先消化掉 request body，
      // 導致 Hono 的 c.req.json() **永遠 hang**（不 resolve 也不 reject，.catch 救不了）
      // → 整個 function 撐到 30s timeout。這正是 /demo/buy-signal 卡死的真因
      //（GET 端點 /diag、/revenue 不讀 body 故正常）。
      // 解法：body 解析加 1.5s 預算，逾時就當沒帶 body；trader 也接受 ?trader= query。
      const body = (await Promise.race([
        c.req.json().catch(() => ({})),
        new Promise<Record<string, never>>((r) => setTimeout(() => r({}), 1500)),
      ])) as { trader?: string };
      const trader = await resolveTrader(body.trader ?? c.req.query("trader"));
      const signal = await getTraderPerformance(contracts, trader);

      // 免費 demo：**不在請求內做鏈上結算**。理由——鏈上結算要 mint→approve→
      // routeExternalRevenue 最多 3 筆循序 tx，在 serverless 上即使「背景觸發」，
      // 平台仍會等事件圈清空才回應（callbackWaitsForEmptyEventLoop），導致整個
      // function 撐到 30s 上限 → FUNCTION_INVOCATION_TIMEOUT。故 demo 只回訊號，
      // 真實 70/20/10 分潤由「付費 x402 端點」實際結算，累計可於 /revenue 查。
      const settlementTx: string | undefined = undefined;
      const settleError: string | undefined = isSettlementEnabled()
        ? "demo 免費試買不即時結算（避免 serverless 逾時）；真實分潤見付費 x402 端點 + /revenue 鏈上累計"
        : undefined;
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

  // ── 付費前的新鮮度閘門 ────────────────────────────────────────────────────
  //
  // /oracle/:asset 賣的是價格。當鏈上價格已超過交易所自己的 maxPriceAge 時，
  // 這份資料既不能用來交易（openPosition 會 revert StalePrice），也沒有市場意義。
  // x402 沒有退費機制，所以必須在 402 之前擋下來，而不是收了錢再回一個 isStale:true。
  //
  // 註冊順序有意義：Hono 依序執行 middleware，這一段必須在 paymentMiddleware
  // 之前，否則買方已經付款了。
  //
  // 2026-08-06 的實況：Base Sepolia 的 oracle 已 9.5–44 天未更新，這個端點會用
  // $0.005 賣出 sAAPL $199.15（真實 $311）。
  // ── 付費前的輸入驗證（稽核 四·Medium）──────────────────────────────────────
  //
  // x402 沒有退費機制，所以「這個請求根本不可能成功」必須在 402 之前就回 400。
  // 舊行為：`/oracle/sDOGE` 先付了 $0.005，付款成功後才在 handler 裡 assetIdOf
  // 丟錯回 400 —— 錢已經進了 payTo，買方拿到的是一個錯誤訊息。
  // 註冊順序有意義：這段必須在 paymentMiddleware 之前。
  app.use("/oracle/*", async (c, next) => {
    const asset = decodeURIComponent(c.req.path.split("/")[2] ?? "");
    if (!asset) {
      return c.json({ ok: false, error: "缺少資產代號，例如 /oracle/sBTC" }, 400);
    }
    if (!(asset in ASSET_IDS)) {
      return c.json(
        {
          ok: false,
          error: `未知資產 "${asset}"`,
          known: Object.keys(ASSET_IDS),
          note: "未付款：無效輸入在 x402 付費牆之前就被擋下（x402 無退費機制）。",
        },
        400,
      );
    }
    return next();
  });

  app.use("/signals/*", async (c, next) => {
    const trader = decodeURIComponent(c.req.path.split("/")[2] ?? "");
    if (!/^0x[0-9a-fA-F]{40}$/.test(trader)) {
      return c.json(
        {
          ok: false,
          error: `不是合法的 EVM 地址："${trader}"`,
          note: "未付款：無效輸入在 x402 付費牆之前就被擋下（x402 無退費機制）。",
        },
        400,
      );
    }
    if (/^0x0{40}$/.test(trader)) {
      return c.json(
        {
          ok: false,
          error: "trader 不可為零地址（70% 分潤會被送進黑洞）。",
          note: "未付款：無效輸入在 x402 付費牆之前就被擋下。",
        },
        400,
      );
    }
    return next();
  });

  app.use("/oracle/*", async (c, next) => {
    const asset = c.req.path.split("/")[2];
    if (!asset) return next();
    try {
      const assetId = assetIdOf(asset);
      const [[, updatedAt], maxPriceAge] = await Promise.all([
        contracts.oracle.getPrice(assetId) as Promise<[bigint, bigint]>,
        contracts.perp.maxPriceAge() as Promise<bigint>,
      ]);
      const tf = classifyTradeFreshness({
        updatedAtSec: Number(updatedAt),
        nowSec: Math.floor(Date.now() / 1000),
        maxPriceAgeSec: Number(maxPriceAge),
      });
      if (!tf.fresh) {
        return c.json(
          {
            ok: false,
            error: "price_stale",
            message:
              `${asset} 的鏈上價格已 ${Math.round(tf.ageSec / 3600)} 小時未更新，` +
              `超過交易所的 maxPriceAge（${tf.maxPriceAgeSec} 秒）。此時開倉會 revert ` +
              `StalePrice，故不販售這份快照。`,
            asset,
            ageSec: tf.ageSec,
            maxPriceAgeSec: tf.maxPriceAgeSec,
          },
          503,
        );
      }
    } catch {
      // 讀不到（資產不存在、RPC 抖動）→ 交給下游處理，不要因為監測失敗就擋住服務。
    }
    return next();
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
          config: { description: "決策級快照：價格 + funding + OI 失衡 + 預估清算價 + edge 建議" },
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
      // 稽核（四·Medium）：/oracle 以前**完全沒有結算** —— 自主 agent 打的正是這個
      // 端點，那筆錢從未進 FeeRouter，而 `GET /` 卻宣稱 70/20/10。現在與 /signals
      // 一致：回應前 await routeExternalRevenue，並把 tx 一起回傳。
      let settlementTx: string | undefined;
      let settleError: string | undefined;
      if (isSettlementEnabled()) {
        try {
          const beneficiary = await resolveTrader();
          const r = await settleRevenue(beneficiary, PRICE_ORACLE);
          if (r.status === "settled") settlementTx = r.tx;
          else settleError = r.error;
        } catch (e) {
          settleError = (e as Error).message;
        }
      }
      return c.json(
        jsonSafe({ ok: true, settled: !!settlementTx, data: snap, settlementTx, settleError }),
      );
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message }, 400);
    }
  });

  return app;
}

export const config = { PAY_TO, NETWORK, FACILITATOR_URL, SETTLEMENT_TOKEN, isSettlementEnabled, isOnchainRevenueEnabled };
