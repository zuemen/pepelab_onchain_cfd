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
  agentDid, appendAudit, type AuditRecord, type AuthorizationVC,
} from "@pepelab/shared";
import { decide } from "./x402-autonomous.ts";
import { loadVc, localVerifyVc, fetchAgentVerification, AUDIT_PATH, type VcCheck } from "./vc-gate.ts";

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

interface RoundCtx {
  payFetch: typeof fetch; sessionUser: string; det: any;
  vc: AuthorizationVC | null; vcChk: VcCheck; agentAddress: string;
  agentVerification: { overallRiskScore: number; riskTier: string } | null;
}

/** 每資產：付費研究 → 寫一筆稽核（不論下單/skip）→ 有效 VC + 決策才開倉。 */
async function runRound(ctx: RoundCtx) {
  const { payFetch, sessionUser, det, vc, vcChk, agentAddress, agentVerification } = ctx;
  console.log(`\n──────── ${new Date().toISOString()} ────────`);
  for (const symbol of ASSETS) {
    const rec: AuditRecord = {
      ts: new Date().toISOString(), issuerDid: vcChk.issuerDid, agentDid: agentDid(agentAddress),
      sessionId: SESSION_ID, vc: { id: vcChk.id, expiry: vcChk.expiry, verified: vcChk.ok, reason: vcChk.reason },
      research: { resource: `/oracle/${symbol}`, priceUsdc: "0.005", settlementTx: null },
      decision: { edgeScore: null, side: "skip", reason: "" },
      action: { opened: false, positionId: null, txHash: null }, agentVerification,
    };
    try {
      const res = await payFetch(`${API}/oracle/${symbol}`, { method: "GET" });
      const data = ((await res.json()) as any)?.data;
      rec.research.settlementTx = decodePaymentTx(res) ?? null;
      rec.decision.edgeScore = data?.edgeScore ?? null;
      const payTx = rec.research.settlementTx ?? undefined;

      // 冷卻 / 已有部位 → skip（仍寫稽核）
      if (lastOpened[symbol] && Date.now() - lastOpened[symbol] < COOLDOWN_MS) {
        rec.decision.reason = `冷卻中（${COOLDOWN_MS / 60000} 分內已開過）`;
        console.log(`  ${symbol}: edge=${data?.edgeScore} → 冷卻，跳過　[x402 ${link(payTx)}]`);
        appendAudit(AUDIT_PATH, rec); continue;
      }
      if (await hasOpenPosition(sessionUser, symbol)) {
        rec.decision.reason = "已有未平倉部位";
        console.log(`  ${symbol}: edge=${data?.edgeScore} → 已有部位，跳過　[x402 ${link(payTx)}]`);
        appendAudit(AUDIT_PATH, rec); continue;
      }

      const dec = decide({
        data, wantMargin: LOOP_MARGIN, wantLeverage: LOOP_LEVERAGE,
        sessionMaxPerTrade: Number(det.maxMarginPerTrade ?? 0),
        sessionRemainingBudget: Number(det.totalMarginBudget ?? 0) - Number(det.spentMargin ?? 0),
        sessionMaxLev: Number(det.maxLeverage ?? 5),
      });
      rec.decision.side = dec.action; rec.decision.reason = dec.reason;

      if (dec.action === "skip") {
        console.log(`  ${symbol}: edge=${data?.edgeScore} → skip（${dec.reason}）　[x402 ${link(payTx)}]`);
      } else if (!vcChk.ok) {
        rec.decision.reason += `；VC 無效 → 拒絕下單`;
        console.log(`  ${symbol}: ${dec.action} 但 VC 無效 → 拒絕下單（${vcChk.reason}）`);
      } else {
        const isLong = dec.action === "long";
        const r = await openPositionForSession({ sessionId: SESSION_ID, symbol, isLong, marginUsdc: dec.margin!, leverage: dec.leverage!, authVc: vc! });
        if (r.ok) {
          lastOpened[symbol] = Date.now();
          rec.action = { opened: true, positionId: r.positionId ?? null, txHash: r.txHash ?? null };
          console.log(`  ${symbol}: edge=${data?.edgeScore} → ${dec.action} ✓ #${r.positionId ?? "?"}　開倉 ${link(r.txHash)}　[x402 ${link(payTx)}]`);
        } else {
          rec.decision.reason += `；開倉被拒：${r.error}`;
          console.log(`  ${symbol}: ${dec.action} 被拒：${r.error}`);
        }
      }
    } catch (e) {
      rec.decision.reason = `本輪失敗 — ${(e as Error).message}`;
      console.log(`  ${symbol}: 本輪失敗 — ${(e as Error).message}`);
    }
    appendAudit(AUDIT_PATH, rec);
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

  // VC/SSI 閘門（E1）：載入使用者簽發的 VC。缺/無效 → 全程只研究，拒絕下單。
  const vc = loadVc();
  const vcChk = localVerifyVc(vc, account.address, SESSION_ID);
  const agentVerification = await fetchAgentVerification(API, agentDid(account.address)); // E3
  console.log(`x402-loop 上線。session #${SESSION_ID}（user ${sessionUser}）・資產 [${ASSETS.join(", ")}]・每 ${INTERVAL_MS / 60000} 分・冷卻 ${COOLDOWN_MS / 60000} 分。`);
  console.log(`VC/SSI：${vcChk.ok ? "✓ 有效，可下單" : "✗ " + vcChk.reason + " → 全程只研究、拒絕下單"}。稽核 → ${AUDIT_PATH}`);

  const ctx: RoundCtx = { payFetch, sessionUser, det, vc, vcChk, agentAddress: account.address, agentVerification };
  // 立即跑一輪，之後每 INTERVAL 重複（完全自主）。
  for (;;) {
    await runRound(ctx);
    await sleep(INTERVAL_MS);
  }
}

main().catch((e) => { console.error("x402-loop 失敗：", e?.message ?? e); process.exit(1); });
