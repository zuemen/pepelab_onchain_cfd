// Demo Agent（北極星 demo）：自管 EOA 付 x402 費用 → 讀訊號 → 依決策**經 session
// 限額真的開一筆受限部位** → 印出 tx hash 與部位。
// 端到端展示：「agent 付 0.01 USDC 買訊號 → 自主下單」。
// 優雅退化：
//   - 無有效金鑰：DRY-RUN，直接讀鏈上訊號（跳過 x402 結算）仍印決策。
//   - 無 session（缺 SESSION_MANAGER_ADDRESS / DEMO_SESSION_ID）：只讀 + 印出
//     「本來會下的單」，不送鏈、不 crash。
import { type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPayment } from "x402-fetch";
import {
  loadEnv,
  ADDRESSES,
  makeProvider,
  makeContracts,
  getOracleSnapshot,
  getTraderPerformance,
  openPositionForSession,
  getSessionManagerAddress,
  jsonSafe,
} from "@pepelab/shared";

loadEnv();

const API = process.env.SIGNAL_API_URL ?? "http://localhost:4021";
const ASSET = process.env.DEMO_ASSET ?? "sBTC";
const PK = process.env.AGENT_PRIVATE_KEY?.trim();
const SESSION_ID = process.env.DEMO_SESSION_ID?.trim();
const DEMO_MARGIN = Number(process.env.DEMO_MARGIN ?? "10"); // USDC，≥ MIN_MARGIN(10)
const ZERO = "0x0000000000000000000000000000000000000000";

// 分析對象：env 優先；未指定就自動挑鏈上第一個已註冊 trader（讓 demo 直接有料）。
let TRADER = process.env.DEMO_TRADER_ADDRESS?.trim() || "";

async function resolveTrader(): Promise<string> {
  if (TRADER) return TRADER;
  const c = makeContracts(makeProvider());
  const list = (await c.registry.getAllTraders()) as string[];
  if (list.length === 0) {
    throw new Error("鏈上尚無任何已註冊 trader，請在 .env 指定 DEMO_TRADER_ADDRESS");
  }
  TRADER = list[0];
  return TRADER;
}

function banner(t: string) {
  console.log("\n" + "─".repeat(64) + `\n${t}\n` + "─".repeat(64));
}

/** 把訊號餵進決策引擎並印出（付費路徑與 dry-run 路徑共用）。 */
function printDecision(oracle: any, perf: any) {
  banner("③ Agent 決策（Phase 1 不真下單）");
  console.log(
    `${ASSET} 現價 ${oracle.price}（${oracle.isStale ? "⚠ 陳舊" : "新鮮"}），funding ${oracle.fundingRatePercent}% ${oracle.fundingDirection}`,
  );
  if (!perf?.isRegistered) {
    console.log(`✗ ${TRADER} 尚未註冊為 trader，無策略可跟。決策：SKIP ALL`);
    return;
  }
  const net = perf.positions?.netPnL ?? 0;
  console.log(
    `trader「${perf.displayName}」淨 PnL：${net.toFixed(2)} USDC（已實現 ${perf.positions.realizedPnL.toFixed(2)} + 未實現 ${perf.positions.unrealizedPnL.toFixed(2)}）`,
  );
  console.log("逐腿決策：");
  for (const s of perf.suggestion ?? []) {
    const follow = !s.fundingHeadwind && net >= 0;
    const verb = follow ? "✓ WOULD FOLLOW" : "✗ SKIP";
    console.log(
      `  ${verb}  ${s.asset} ${s.direction} ${s.leverage}x (權重 ${s.weightPercent}%) — ${s.note}`,
    );
  }
}

/** 從績效訊號挑出第一筆值得跟的腿（與 printDecision 的 follow 規則一致）。 */
function pickTrade(
  perf: any,
): { symbol: string; isLong: boolean; leverage: number } | null {
  if (!perf?.isRegistered) return null;
  const net = perf.positions?.netPnL ?? 0;
  if (net < 0) return null;
  for (const s of perf.suggestion ?? []) {
    if (!s.fundingHeadwind) {
      return {
        symbol: s.asset,
        isLong: s.direction === "long",
        leverage: s.leverage,
      };
    }
  }
  return null;
}

/** 北極星步驟：依決策經 session 限額真下單；缺 session/key 時優雅退化成模擬。 */
async function executeOrSimulate(
  trade: { symbol: string; isLong: boolean; leverage: number } | null,
) {
  banner("④ 經 session 自主下單（受限委派）");
  if (!trade) {
    console.log("無可跟訊號（淨 PnL<0 或全逆風）→ 不下單。");
    return;
  }
  const wouldBe = `${trade.symbol} ${trade.isLong ? "LONG" : "SHORT"} ${trade.leverage}x，保證金 ${DEMO_MARGIN} USDC`;
  const hasKey = PK && PK.startsWith("0x") && PK.length === 66;

  if (!hasKey || !SESSION_ID || getSessionManagerAddress() === ZERO) {
    console.log(
      "⚠ 未配置自主下單（需 AGENT_PRIVATE_KEY + SESSION_MANAGER_ADDRESS + DEMO_SESSION_ID）。",
    );
    console.log(`  本來會下的單：${wouldBe}（模擬，未送鏈）。`);
    return;
  }

  console.log(`送出：${wouldBe}（session #${SESSION_ID}）…`);
  const res = await openPositionForSession({
    sessionId: Number(SESSION_ID),
    symbol: trade.symbol,
    isLong: trade.isLong,
    marginUsdc: DEMO_MARGIN,
    leverage: trade.leverage,
  });
  if (res.ok) {
    console.log(
      `✓ 已開倉：tx ${res.txHash}，positionId ${res.positionId}（agent ${res.agent}，session #${res.sessionId}）`,
    );
  } else {
    console.log(`✗ 下單失敗：${res.error}`);
    console.log(`  （優雅退化）本來會下的單：${wouldBe}`);
  }
}

/** DRY-RUN：沒有付款錢包時，直接讀鏈上拿訊號（跳過 x402 結算），仍跑決策。 */
async function dryRun() {
  console.log(
    "\n⚠ 未提供有效 AGENT_PRIVATE_KEY（見 .env.example）。\n" +
      "  進入 DRY-RUN：跳過 x402 USDC 結算，直接讀鏈上訊號並印決策。\n" +
      "  要跑真正「付 0.01 USDC」流程，請在 .env 填入有 Base Sepolia 測試\n" +
      "  USDC + ETH 的 AGENT_PRIVATE_KEY，並把 PAY_TO 設為 Base 上可收款地址。",
  );
  const c = makeContracts(makeProvider());
  banner("① 讀 oracle 快照（DRY-RUN，未付費）");
  const oracle = jsonSafe(await getOracleSnapshot(c, ASSET));
  console.log(JSON.stringify(oracle, null, 2));
  banner("② 讀 trader 訊號（DRY-RUN，未付費）");
  const perf = jsonSafe(await getTraderPerformance(c, TRADER));
  console.log(JSON.stringify(perf, null, 2));
  printDecision(oracle, perf);
  await executeOrSimulate(pickTrade(perf));
}

/** 真實付費路徑：經 signal-api 付 x402 費用拿訊號。 */
async function paidRun() {
  const account = privateKeyToAccount(PK as Hex);
  console.log(`agent 錢包  : ${account.address}（自管 EOA）`);

  // x402：包裝 fetch，遇 402 自動用 EOA 簽 USDC 授權（EIP-3009）並重送
  const payFetch = wrapFetchWithPayment(fetch, account);

  banner("① 付費讀 oracle 快照（0.005 USDC）");
  const oracle = (await (await payFetch(`${API}/oracle/${ASSET}`)).json()) as any;
  console.log(JSON.stringify(oracle, null, 2));

  banner("② 付費讀 trader 訊號（0.01 USDC）");
  const sig = (await (await payFetch(`${API}/signals/${TRADER}`)).json()) as any;
  console.log(JSON.stringify(sig, null, 2));

  const perf = sig?.data;
  printDecision(oracle?.data ?? oracle, perf);
  await executeOrSimulate(pickTrade(perf));
}

async function main() {
  banner("PepeLab Demo Agent — Phase 1 (read-only, 不真下單)");
  await resolveTrader();
  console.log(`Signal API : ${API}`);
  console.log(`分析 trader : ${TRADER}${process.env.DEMO_TRADER_ADDRESS ? "" : "（自動挑選鏈上首位）"}`);
  console.log(`查詢資產    : ${ASSET}`);
  console.log(`收款 payTo  : ${ADDRESSES.FeeRouter}（FeeRouter）`);

  const hasKey = PK && PK.startsWith("0x") && PK.length === 66;
  if (hasKey) {
    await paidRun();
  } else {
    await dryRun();
  }
}

main().catch((err) => {
  console.error("demo agent 失敗：", err);
  process.exit(1);
});
