// 只讀的健康檢查：比對每個資產的鏈上 updatedAt 與交易所自己的 maxPriceAge。
//
// 為什麼獨立於 keeper：keeper 沒被排到、被 GitHub 靜默跳過、或整個 workflow 被
// 停用時，它自己不會發出任何訊號。這支腳本只看鏈上事實，所以上述任何一種失敗
// 都會被它抓到。
import { ethers } from "ethers";

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
  const now = Math.floor(Date.now() / 1000);
  const stale: string[] = [];

  console.log(`chain=${CHAIN} oracle=${ORACLE_ADDR} maxPriceAge=${maxAge}s`);
  for (const symbol of SYMBOLS) {
    try {
      const [price, at] = (await oracle.getPrice(ethers.id(symbol))) as [bigint, bigint];
      const age = now - Number(at);
      const bad = age > maxAge;
      if (bad) stale.push(`${symbol}(${(age / 3600).toFixed(1)}h)`);
      console.log(
        `${bad ? "STALE" : "  ok "} ${symbol.padEnd(6)} $${(Number(price) / 1e8).toFixed(2).padStart(10)} age=${(age / 3600).toFixed(1)}h`,
      );
    } catch (e) {
      stale.push(`${symbol}(unreadable)`);
      console.log(`STALE ${symbol.padEnd(6)} 讀取失敗：${(e as Error).message.slice(0, 80)}`);
    }
  }

  if (stale.length > 0) {
    console.error(
      `::error::${stale.length}/${SYMBOLS.length} 個資產超過 maxPriceAge：${stale.join(", ")}。` +
      `交易所會對這些資產 revert StalePrice —— 開倉、平倉、清算全部無法執行。`,
    );
    process.exit(1);
  }
  console.log("所有資產都在 maxPriceAge 之內 ✓");
}

main().catch((e) => {
  console.error("::error::健康檢查中止：", e);
  process.exit(1);
});
