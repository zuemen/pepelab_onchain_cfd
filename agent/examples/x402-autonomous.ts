// x402-autonomous.ts — 會「自己決定要不要投資」的自主交易 agent。
//
// 與 x402-autotrade 的差別：這支用 Part A 的決策級資料(edge/清算價)，**可以決定不進場(skip)**。
// 流程（每步 console 清楚輸出）：
//   ① x402 真實付費 GET /oracle/<symbol>（402→簽官方 USDC EIP-3009→200），拿 enriched 資料
//      （edgeScore / recommendation / estLiquidation / isStale）。印付款上鏈 tx（x-payment-response）。
//   ② agent 自己判斷（核心：可 skip）：
//      • isStale/缺資料 → skip。
//      • recommendation==="no_trade"（|edge|<門檻）→ skip（訊號不夠強）。
//      • long/short → 方向；再過「清算距離」風險閘（< MIN_LIQ_DIST 就降槓桿；仍不行→skip）；
//        margin 取 min(想要, session 單筆上限)，超過剩餘預算→skip。
//   ③ 決定下單才開倉：openPositionForSession（session #6 限額內），印開倉 tx + positionId。
//   ④ skip：不下單不浪費 gas；但 x402 那筆資料費是真花費（付費做功課、決定不進場，合理）。
//
// 限制：x402 付款用官方 Base Sepolia USDC（Circle, EIP-3009）——錢包要先到 Circle 水龍頭領
// 官方 USDC + ETH。下單保證金是 session.user 在交易所存的模擬 USDT（兩種幣用途不同）。
// 加密 sBTC/sETH 免 KYC；RWA 需先 KYC 否則開倉 revert。edge 是透明規則式啟發、非投資建議。
//
// CLI：npx tsx examples/x402-autonomous.ts <symbol> <maxMargin> <leverage>   # 預設 sBTC 50 3
import { createWalletClient, http, publicActions, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";
import { pathToFileURL } from "node:url";
import { openPositionForSession, getSession } from "@pepelab/shared";

// ── 決策參數（透明可調）──────────────────────────────────────────────────────
const ENTRY_THRESHOLD = Number(process.env.X402_EDGE_ENTRY ?? "25"); // server 也用同門檻
const MIN_LIQ_DIST = Number(process.env.MIN_LIQ_DIST ?? "0.08");     // 現價到清算價最小距離 8%
const HARD_MAX_LEVERAGE = 5;

const API = (process.env.X402_API_URL ?? "https://agent-git-master-zuemens-projects.vercel.app").replace(/\/$/, "");
const PK = process.env.AGENT_PRIVATE_KEY?.trim();
const RPC = process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";
const SESSION_ID = Number(process.env.DEMO_SESSION_ID ?? "6");

const ALIASES: Record<string, string> = {
  btc: "sBTC", sbtc: "sBTC", eth: "sETH", seth: "sETH",
  aapl: "sAAPL", tsla: "sTSLA", nvda: "sNVDA", msft: "sMSFT", googl: "sGOOGL",
  gold: "sGOLD", bond: "sBOND", icln: "sICLN", esgu: "sESGU",
};
const norm = (s: string) => ALIASES[s.toLowerCase()] ?? s;
const link = (h?: string) => (h ? `https://sepolia.basescan.org/tx/${h}` : "(無 tx hash)");

function decodePaymentTx(res: Response): string | undefined {
  try {
    const h = res.headers.get("x-payment-response");
    if (!h) return undefined;
    const j = JSON.parse(Buffer.from(h, "base64").toString("utf8"));
    return j?.transaction ?? j?.txHash ?? undefined;
  } catch { return undefined; }
}

/** 在 want 以內找最高、且清算距離 ≥ minDist 的槓桿；找不到回 0（=不安全，skip）。
 *  清算距離 = 1/L − mm（與方向無關），mm=維持保證金率。 */
function fitLeverage(want: number, mm: number, minDist: number): number {
  for (let L = Math.min(Math.floor(want), HARD_MAX_LEVERAGE); L >= 1; L--) {
    if (1 / L - mm >= minDist) return L;
  }
  return 0;
}

/** 純決策：吃 enriched oracle + 限制，回 {action, ...}。可獨立推理、好展示。 */
export function decide(input: {
  data: any; wantMargin: number; wantLeverage: number;
  sessionMaxPerTrade: number; sessionRemainingBudget: number; sessionMaxLev: number;
}): { action: "long" | "short" | "skip"; margin?: number; leverage?: number; reason: string } {
  const d = input.data;
  if (!d || d.isStale) return { action: "skip", reason: "資料過期/不足（stale），本輪不投資" };
  const rec = d.recommendation as "long" | "short" | "no_trade";
  if (rec === "no_trade") return { action: "skip", reason: `訊號不夠強（edge=${d.edgeScore}，門檻 ${ENTRY_THRESHOLD}），本輪不投資` };
  const isLong = rec === "long";
  const mm = (d.maintenanceMarginBps ?? 500) / 10000;

  // 風險閘：清算距離。先夾 session 最大槓桿，再依清算距離降槓桿。
  const wantLev = Math.min(input.wantLeverage, input.sessionMaxLev || HARD_MAX_LEVERAGE);
  const lev = fitLeverage(wantLev, mm, MIN_LIQ_DIST);
  if (lev === 0) return { action: "skip", reason: `清算距離不足（< ${(MIN_LIQ_DIST * 100).toFixed(0)}%），降槓桿仍不安全，不投資` };
  const dist = 1 / lev - mm;

  // 額度：margin 取 min(想要, session 單筆上限)；超過剩餘預算→skip。
  let margin = Math.min(input.wantMargin, input.sessionMaxPerTrade || input.wantMargin);
  if (margin <= 0) return { action: "skip", reason: "session 單筆上限為 0，不投資" };
  if (margin > input.sessionRemainingBudget) return { action: "skip", reason: `保證金 ${margin} 超過 session 剩餘預算 ${input.sessionRemainingBudget}，不投資` };

  const levNote = lev < input.wantLeverage ? `（已從 ${input.wantLeverage}x 降到 ${lev}x 以滿足清算距離）` : "";
  return { action: isLong ? "long" : "short", margin, leverage: lev,
    reason: `edge=${d.edgeScore} → ${isLong ? "做多" : "做空"}；清算距離 ${(dist * 100).toFixed(1)}% ≥ ${(MIN_LIQ_DIST * 100).toFixed(0)}%${levNote}；保證金 ${margin} USDT` };
}

async function main() {
  const [, , symbolArg = "sBTC", marginArg = "50", levArg = "3"] = process.argv;
  const symbol = norm(symbolArg);
  const wantMargin = Number(marginArg);
  const wantLeverage = Number(levArg);

  if (!PK || !/^0x[0-9a-fA-F]{64}$/.test(PK)) throw new Error("設 AGENT_PRIVATE_KEY=0x…（需持官方 USDC + ETH）");
  if (!process.env.SESSION_MANAGER_ADDRESS?.trim()) throw new Error("設 SESSION_MANAGER_ADDRESS");

  console.log(`\n=== x402-autonomous ===  ${symbol}  maxMargin=${wantMargin}  ${wantLeverage}x  session #${SESSION_ID}`);

  // ① x402 付費取 enriched 資料
  const account = privateKeyToAccount(PK as Hex);
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) }).extend(publicActions);
  const payFetch = wrapFetchWithPayment(fetch, wallet as unknown as Parameters<typeof wrapFetchWithPayment>[1]);
  console.log("付款錢包（官方 USDC）：", account.address);

  console.log(`\n① x402 付費 0.005 USDC → GET /oracle/${symbol}（402 → 簽 EIP-3009 → 200）`);
  const res = await payFetch(`${API}/oracle/${symbol}`, { method: "GET" });
  const body = (await res.json()) as any;
  const data = body?.data ?? body;
  console.log("   HTTP", res.status, "· x402 付款上鏈 tx:", link(decodePaymentTx(res)));
  console.log("   決策級資料：", JSON.stringify({
    price: data?.price, fundingRateBps: data?.fundingRateBps, oiImbalance: data?.oiImbalance,
    edgeScore: data?.edgeScore, recommendation: data?.recommendation, confidence: data?.confidence, isStale: data?.isStale,
  }));

  // 讀 session 限額
  const s: any = await getSession(SESSION_ID);
  const det = s?.detail ?? {};
  const sessionMaxPerTrade = Number(det.maxMarginPerTrade ?? 0);
  const sessionRemainingBudget = Number(det.totalMarginBudget ?? 0) - Number(det.spentMargin ?? 0);
  const sessionMaxLev = Number(det.maxLeverage ?? HARD_MAX_LEVERAGE);

  // ② agent 自己判斷
  const dec = decide({ data, wantMargin, wantLeverage, sessionMaxPerTrade, sessionRemainingBudget, sessionMaxLev });
  console.log(`\n② 決策：${dec.action === "skip" ? "skip（不投資）" : dec.action} — ${dec.reason}`);
  if (dec.action === "skip") {
    console.log("\n④ 本輪不下單（x402 資料費已花，研究後決定不進場）。");
    console.log("\n=== 鐵證 ===\n① x402 付款 tx:", link(decodePaymentTx(res)), "\n（本輪 skip，無開倉 tx）");
    return;
  }

  // ③ 決定下單才開倉
  const isLong = dec.action === "long";
  console.log(`\n③ openPositionForSession(#${SESSION_ID}, ${symbol}, ${isLong ? "long" : "short"}, ${dec.margin}, ${dec.leverage}x) 上鏈中…⏳`);
  const r = await openPositionForSession({ sessionId: SESSION_ID, symbol, isLong, marginUsdc: dec.margin!, leverage: dec.leverage! });
  if (!r.ok) { console.error(`   ❌ 開倉被拒：${r.error}`); process.exit(1); }
  console.log(`   ✓ 開倉 tx: ${link(r.txHash)}  · position #${r.positionId ?? "?"}`);

  console.log("\n=== 鐵證（BaseScan 可查）===");
  console.log("① x402 付款 tx:", link(decodePaymentTx(res)));
  console.log("③ 開倉 tx    :", link(r.txHash));
  console.log("\n結論：agent 付官方 USDC 買決策級資料 → 自己判斷（可不投資）→ 該進才經 session 上鏈。");
}

// 只有「直接執行」這支時才跑 main；被 x402-loop.ts import（取 decide）時不自動執行。
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { console.error("x402-autonomous 失敗：", e?.message ?? e); process.exit(1); });
