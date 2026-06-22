// x402-loop.ts — 完全自主：每 INTERVAL 對一組資產各跑一次 Part B 決策。
// agent 看到平台(x402)資料後完全自主操作：付費買資料 → 自己判斷 long/short/skip → 該進才下單。
//
// 冷卻：同資產若「已有未平倉部位」或「N 分鐘內已開過」→ 跳過，避免重複堆倉。
// 每輪印摘要：時間、各資產 edge、決策、tx（若有）。
//
// CLI：npx tsx examples/x402-loop.ts            # 用 env 的 ASSETS / INTERVAL_MIN
// 掛法（見 examples/x402-loop.md）：node 常駐 / pm2 / 系統 cron / GitHub Actions 定時。
//
// env：ASSETS=sBTC,sETH ・ INTERVAL_MIN=15 ・ COOLDOWN_MIN=30 ・ LOOP_MARGIN=50 ・ LOOP_LEVERAGE=3
// 限制同 x402-autonomous（官方 USDC 付費、模擬 USDT 保證金、RWA 需 KYC）。
import { createWalletClient, http, publicActions, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPayment } from "x402-fetch";
import {
  openPositionForSession, getSession, makeProvider, makeContracts, assetIdOf,
} from "@pepelab/shared";
import { decide } from "./x402-autonomous.ts";

const API = (process.env.X402_API_URL ?? "https://agent-git-master-zuemens-projects.vercel.app").replace(/\/$/, "");
const PK = process.env.AGENT_PRIVATE_KEY?.trim();
const RPC = process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";
const SESSION_ID = Number(process.env.DEMO_SESSION_ID ?? "6");
const ASSETS = (process.env.ASSETS ?? "sBTC,sETH").split(",").map((s) => s.trim()).filter(Boolean);
const INTERVAL_MS = Number(process.env.INTERVAL_MIN ?? "15") * 60_000;
const COOLDOWN_MS = Number(process.env.COOLDOWN_MIN ?? "30") * 60_000;
const LOOP_MARGIN = Number(process.env.LOOP_MARGIN ?? "50");
const LOOP_LEVERAGE = Number(process.env.LOOP_LEVERAGE ?? "3");

const link = (h?: string) => (h ? `https://sepolia.basescan.org/tx/${h}` : "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lastOpened: Record<string, number> = {};

function decodePaymentTx(res: Response): string | undefined {
  try {
    const h = res.headers.get("x-payment-response");
    if (!h) return undefined;
    return JSON.parse(Buffer.from(h, "base64").toString("utf8"))?.transaction;
  } catch { return undefined; }
}

/** 鏈上是否已有該資產的未平倉部位（session.user）。 */
async function hasOpenPosition(user: string, symbol: string): Promise<boolean> {
  try {
    const c = makeContracts(makeProvider());
    const assetId = assetIdOf(symbol).toLowerCase();
    const ids = (await c.perp.getUserPositions(user)) as bigint[];
    for (const id of ids) {
      const p: any = await c.perp.getPosition(id);
      if (p?.isOpen && String(p.asset).toLowerCase() === assetId) return true;
    }
  } catch { /* 讀取失敗就當沒有，交給合約把關 */ }
  return false;
}

async function runRound(payFetch: typeof fetch, sessionUser: string, det: any) {
  const stamp = new Date().toISOString();
  console.log(`\n──────── ${stamp} ────────`);
  for (const symbol of ASSETS) {
    try {
      const res = await payFetch(`${API}/oracle/${symbol}`, { method: "GET" });
      const data = ((await res.json()) as any)?.data;
      const payTx = decodePaymentTx(res);

      // 冷卻：N 分內開過 → 跳過
      if (lastOpened[symbol] && Date.now() - lastOpened[symbol] < COOLDOWN_MS) {
        console.log(`  ${symbol}: edge=${data?.edgeScore} → 冷卻中（${COOLDOWN_MS / 60000}分內已開過），跳過　[x402 ${link(payTx)}]`);
        continue;
      }
      // 已有未平倉部位 → 跳過
      if (await hasOpenPosition(sessionUser, symbol)) {
        console.log(`  ${symbol}: edge=${data?.edgeScore} → 已有未平倉部位，跳過　[x402 ${link(payTx)}]`);
        continue;
      }

      const dec = decide({
        data, wantMargin: LOOP_MARGIN, wantLeverage: LOOP_LEVERAGE,
        sessionMaxPerTrade: Number(det.maxMarginPerTrade ?? 0),
        sessionRemainingBudget: Number(det.totalMarginBudget ?? 0) - Number(det.spentMargin ?? 0),
        sessionMaxLev: Number(det.maxLeverage ?? 5),
      });
      if (dec.action === "skip") {
        console.log(`  ${symbol}: edge=${data?.edgeScore} → skip（${dec.reason}）　[x402 ${link(payTx)}]`);
        continue;
      }
      const isLong = dec.action === "long";
      const r = await openPositionForSession({ sessionId: SESSION_ID, symbol, isLong, marginUsdc: dec.margin!, leverage: dec.leverage! });
      if (r.ok) {
        lastOpened[symbol] = Date.now();
        console.log(`  ${symbol}: edge=${data?.edgeScore} → ${dec.action} ✓ position #${r.positionId ?? "?"}　開倉 ${link(r.txHash)}　[x402 ${link(payTx)}]`);
      } else {
        console.log(`  ${symbol}: ${dec.action} 被拒：${r.error}`);
      }
    } catch (e) {
      console.log(`  ${symbol}: 本輪失敗 — ${(e as Error).message}`);
    }
  }
}

async function main() {
  if (!PK || !/^0x[0-9a-fA-F]{64}$/.test(PK)) throw new Error("設 AGENT_PRIVATE_KEY=0x…（需持官方 USDC + ETH）");
  if (!process.env.SESSION_MANAGER_ADDRESS?.trim()) throw new Error("設 SESSION_MANAGER_ADDRESS");

  const account = privateKeyToAccount(PK as Hex);
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) }).extend(publicActions);
  const payFetch = wrapFetchWithPayment(fetch, wallet as unknown as Parameters<typeof wrapFetchWithPayment>[1]) as unknown as typeof fetch;

  const s: any = await getSession(SESSION_ID);
  const det = s?.detail ?? {};
  const sessionUser = det.user ?? account.address;
  console.log(`x402-loop 上線。session #${SESSION_ID}（user ${sessionUser}）・資產 [${ASSETS.join(", ")}]・每 ${INTERVAL_MS / 60000} 分・冷卻 ${COOLDOWN_MS / 60000} 分。`);

  // 立即跑一輪，之後每 INTERVAL 重複（完全自主）。
  for (;;) {
    await runRound(payFetch, sessionUser, det);
    await sleep(INTERVAL_MS);
  }
}

main().catch((e) => { console.error("x402-loop 失敗：", e?.message ?? e); process.exit(1); });
