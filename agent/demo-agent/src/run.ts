// Demo Agent（Phase 1）：自管 EOA 付 x402 費用 → 讀訊號 → 印出決策（不真下單）。
// 端到端展示：「agent 付 0.01 USDC 買訊號 → 印出決策」。
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "x402-fetch";
import { loadEnv, ADDRESSES } from "@pepelab/shared";

loadEnv();

const API = process.env.SIGNAL_API_URL ?? "http://localhost:4021";
const ASSET = process.env.DEMO_ASSET ?? "sBTC";
// 預設分析對象：未指定就用部署者/owner（也是 demo trader 候選）。可在 .env 覆寫。
const TRADER =
  process.env.DEMO_TRADER_ADDRESS?.trim() ||
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const PK = process.env.AGENT_PRIVATE_KEY?.trim();

function banner(t: string) {
  console.log("\n" + "─".repeat(64) + `\n${t}\n` + "─".repeat(64));
}

async function main() {
  banner("PepeLab Demo Agent — Phase 1 (read-only, 不真下單)");
  console.log(`Signal API : ${API}`);
  console.log(`分析 trader : ${TRADER}`);
  console.log(`查詢資產    : ${ASSET}`);
  console.log(`收款 payTo  : ${ADDRESSES.FeeRouter}（FeeRouter）`);

  if (!PK || !PK.startsWith("0x") || PK.length !== 66) {
    console.error(
      "\n⚠ 未提供有效 AGENT_PRIVATE_KEY（見 .env.example）。\n" +
        "  需要一個在 Base Sepolia 持有測試 USDC + 少量 ETH 的測試 EOA 才能付款。\n" +
        "  先示範免費端點（定價表），付費流程待你填入金鑰後再跑：",
    );
    const res = await fetch(`${API}/`);
    console.log(JSON.stringify(await res.json(), null, 2));
    return;
  }

  // 自管 EOA：privateKeyToAccount 回傳 LocalAccount，x402 的 Wallet 型別直接接受
  const account = privateKeyToAccount(PK as Hex);
  console.log(`agent 錢包  : ${account.address}（自管 EOA）`);

  // x402：包裝 fetch，遇 402 自動用 EOA 簽 USDC 授權（EIP-3009）並重送
  const payFetch = wrapFetchWithPayment(fetch, account);

  // 1) 付 0.005 USDC 買 oracle 快照
  banner("① 付費讀 oracle 快照（0.005 USDC）");
  const oracleRes = await payFetch(`${API}/oracle/${ASSET}`);
  const oracle = (await oracleRes.json()) as any;
  console.log(JSON.stringify(oracle, null, 2));

  // 2) 付 0.01 USDC 買 trader 訊號
  banner("② 付費讀 trader 訊號（0.01 USDC）");
  const sigRes = await payFetch(`${API}/signals/${TRADER}`);
  const sig = (await sigRes.json()) as any;
  console.log(JSON.stringify(sig, null, 2));

  // 3) 決策（不下單，只印出）
  banner("③ Agent 決策（Phase 1 不真下單）");
  const perf = sig?.data;
  if (!perf?.isRegistered) {
    console.log(`✗ ${TRADER} 尚未註冊為 trader，無策略可跟。決策：SKIP ALL`);
    return;
  }
  const net = perf.positions?.netPnL ?? 0;
  console.log(`trader 淨 PnL：${net} USDC（已實現 ${perf.positions.realizedPnL} + 未實現 ${perf.positions.unrealizedPnL}）`);
  console.log("逐腿決策：");
  for (const s of perf.suggestion ?? []) {
    const follow = !s.fundingHeadwind && net >= 0;
    const verb = follow ? "✓ WOULD FOLLOW" : "✗ SKIP";
    console.log(
      `  ${verb}  ${s.asset} ${s.direction} ${s.leverage}x (權重 ${s.weightPercent}%) — ${s.note}`,
    );
  }
  console.log(
    "\n→ Phase 1 到此為止（只印決策）。Phase 2 才會經 openPositionFor 真下單。",
  );
}

main().catch((err) => {
  console.error("demo agent 失敗：", err);
  process.exit(1);
});
