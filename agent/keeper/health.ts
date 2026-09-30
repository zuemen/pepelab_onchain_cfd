// 只讀的健康檢查：比對每個資產的鏈上 updatedAt 與交易所自己的 maxPriceAge。
//
// 為什麼獨立於 keeper：keeper 沒被排到、被 GitHub 靜默跳過、或整個 workflow 被
// 停用時，它自己不會發出任何訊號。這支腳本只看鏈上事實，所以上述任何一種失敗
// 都會被它抓到。
//
// 休市（第 4 項）：股票／ETF／期貨在休市期間沒有新成交，不更新是合理的；只有在
// 「照一般門檻已超齡」時才向 Yahoo 問 currentTradingPeriod／regularMarketTime，
// 由 market.ts 的 judgeStaleness 判斷。加密資產（sBTC、sETH）維持 24/7 嚴格。
import { writeFileSync } from "node:fs";
import { ethers } from "ethers";
import type { HealthReport } from "./alert.ts";
import { fetchMarketSession } from "./feeds.ts";
import { checkFunding, checkHealth } from "./health-check.ts";

const SYMBOLS = [
  "sBTC", "sETH", "sAAPL", "sTSLA", "sNVDA",
  "sMSFT", "sGOOGL", "sGOLD", "sBOND", "sICLN", "sESGU",
] as const;

const CHAIN = (process.env.KEEPER_CHAIN ?? "base-sepolia").trim();
const CHAIN_ID = CHAIN === "sepolia" ? 11155111 : 84532;
const RPC_URL = (process.env.KEEPER_RPC_URL ?? "").trim();
const ORACLE_ADDR = (process.env.KEEPER_ORACLE_ADDRESS ?? "").trim();
const EXCHANGE_ADDR = (process.env.KEEPER_EXCHANGE_ADDRESS ?? "").trim();

// 沒有 exchange 可問時的後備門檻：實測 GitHub 排程真實間隔 68–169 分鐘，
// 取 3 小時給兩次錯過排程的餘裕。
const FALLBACK_MAX_AGE_SEC = Number(process.env.HEALTH_MAX_AGE ?? "10800");
// 選用：把結果寫成 JSON，給 alert-run.ts 決定要不要開／更新／關 issue。
const REPORT_PATH = (process.env.HEALTH_REPORT_PATH ?? "").trim();
// 窄複審 5：funding 結算延遲的報告（給第二個告警 step）。
const FUNDING_REPORT_PATH = (process.env.HEALTH_FUNDING_REPORT_PATH ?? "").trim();
// 與 base-sepolia-keeper.yml 的 crank 迴圈同一組資產。
const FUNDING_SYMBOLS = (process.env.HEALTH_FUNDING_SYMBOLS ?? "sBTC,sETH,sAAPL,sTSLA")
  .split(",").map((s) => s.trim()).filter(Boolean);
const FUNDING_ABI = [
  "function FUNDING_INTERVAL() view returns (uint256)",
  "function lastFundingUpdateAt(bytes32 asset) view returns (uint256)",
];

function writeReportTo(path: string, r: HealthReport): void {
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify(r, null, 2), "utf8");
  } catch (e) {
    console.error(`::warning::寫不出健檢報告 ${path}：${(e as Error).message}`);
  }
}
function writeReport(r: HealthReport): void {
  writeReportTo(REPORT_PATH, r);
}

const ORACLE_ABI = [
  "function getPrice(bytes32 assetId) view returns (uint256 price, uint256 updatedAt)",
];
const EXCHANGE_ABI = ["function maxPriceAge() view returns (uint256)"];

async function main(): Promise<void> {
  if (!RPC_URL || !ethers.isAddress(ORACLE_ADDR)) {
    console.error("::error::需要 KEEPER_RPC_URL 與 KEEPER_ORACLE_ADDRESS");
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(
    RPC_URL, { chainId: CHAIN_ID, name: CHAIN }, { batchMaxCount: 1, staticNetwork: true },
  );

  let maxAge = FALLBACK_MAX_AGE_SEC;
  if (ethers.isAddress(EXCHANGE_ADDR)) {
    try {
      const exchange = new ethers.Contract(EXCHANGE_ADDR, EXCHANGE_ABI, provider);
      maxAge = Number(await exchange.maxPriceAge());
    } catch {
      console.log(`讀不到 exchange.maxPriceAge()，改用後備門檻 ${FALLBACK_MAX_AGE_SEC}s`);
    }
  }

  const oracle = new ethers.Contract(ORACLE_ADDR, ORACLE_ABI, provider);
  console.log(`chain=${CHAIN} oracle=${ORACLE_ADDR} maxPriceAge=${maxAge}s`);
  const report = await checkHealth({
    chain: CHAIN,
    symbols: SYMBOLS,
    nowSec: Math.floor(Date.now() / 1000),
    maxAgeSec: maxAge,
    getPrice: async (symbol) => (await oracle.getPrice(ethers.id(symbol))) as [bigint, bigint],
    fetchSession: (symbol) => fetchMarketSession(symbol),
  });
  writeReport(report);

  // 窄複審 5：funding 結算延遲（只在有 exchange 位址時）。報告另寫一份，由獨立的告警
  // step 開「funding 未結算」issue；價格健檢壞了也照樣檢查。
  let fundingBad = false;
  if (ethers.isAddress(EXCHANGE_ADDR)) {
    const funding = await checkFundingOnChain(provider);
    if (funding) {
      writeReportTo(FUNDING_REPORT_PATH, funding);
      if (funding.status !== "ok" || funding.unreadable?.length) {
        console.error(
          `::error::funding 結算延遲：${funding.stale.join(", ") || "—"}` +
            `${funding.unreadable?.length ? `；讀不到：${funding.unreadable.join(", ")}` : ""}`,
        );
        fundingBad = true;
      }
    }
  }

  let bad = fundingBad;
  if (report.status === "error") {
    console.error(`::error::健康檢查無法完成：${report.error}`);
    process.exit(1);
  }
  if (report.stale.length > 0) {
    console.error(
      `::error::${report.stale.length}/${SYMBOLS.length} 個資產超過 maxPriceAge：${report.stale.join(", ")}。` +
      `交易所會對這些資產 revert StalePrice —— 開倉、平倉、清算全部無法執行。`,
    );
    bad = true;
  }
  if (report.unreadable?.length) {
    console.error(
      `::error::${report.unreadable.length} 個資產讀不到（RPC 問題，未算過期）：${report.unreadable.join(", ")}`,
    );
    bad = true;
  }
  if (bad) process.exit(1);
  if (report.closed?.length) {
    console.log(`休市中、依市場時段放寬（未告警）：${report.closed.join(", ")}`);
  }
  console.log("所有資產都在 maxPriceAge 之內（或休市中合理未更新） ✓");
}

/** 讀 FUNDING_INTERVAL 與各資產 lastFundingUpdateAt；讀不到 interval 就回 error 報告。 */
async function checkFundingOnChain(provider: ethers.JsonRpcProvider): Promise<HealthReport | null> {
  const exchange = new ethers.Contract(EXCHANGE_ADDR, FUNDING_ABI, provider);
  const nowSec = Math.floor(Date.now() / 1000);
  let interval: number;
  try {
    interval = Number(await exchange.FUNDING_INTERVAL());
  } catch (e) {
    return {
      kind: "funding", chain: CHAIN, status: "error", checkedAtSec: nowSec, maxAgeSec: 0,
      stale: [], lines: [], error: `讀不到 FUNDING_INTERVAL：${(e as Error).message.slice(0, 120)}`,
    };
  }
  console.log(`funding: FUNDING_INTERVAL=${interval}s，上限 2×=${2 * interval}s`);
  return checkFunding({
    chain: CHAIN,
    symbols: FUNDING_SYMBOLS,
    nowSec,
    intervalSec: interval,
    lastFundingAt: async (s) => Number(await exchange.lastFundingUpdateAt(ethers.id(s))),
  });
}

main().catch((e) => {
  writeReport({
    chain: CHAIN, status: "error", checkedAtSec: Math.floor(Date.now() / 1000),
    maxAgeSec: 0, stale: [], lines: [], error: String((e as Error)?.message ?? e).slice(0, 300),
  });
  console.error("::error::健康檢查中止：", e);
  process.exit(1);
});
