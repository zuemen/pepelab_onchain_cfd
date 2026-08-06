// Keeper CLI：把外部價格寫進 MockOracle，並把同一個值分段鏡射進 GuardedOracle。
//
// 取代三份互相漂移的舊實作：
//   - .github/workflows/*.yml 裡的 bash（無法測試，曾把股價寫成前價的 55%）
//   - scripts/priceKeeper.ts（repo 根目錄沒有 node_modules，其實跑不起來）
//   - frontend/price_keeper.cjs（對股票用 Math.random() 隨機漫步，且硬編碼 RPC 金鑰）
//
// 用法：
//   cd agent
//   KEEPER_CHAIN=base-sepolia npx tsx keeper/run.ts
//   KEEPER_CHAIN=base-sepolia DRY_RUN=1 npx tsx keeper/run.ts   # 只讀不寫
import { ethers } from "ethers";
import {
  toPrice8,
  planUpdate,
  stepTowards,
  deviationAccepted,
  guardDeviation,
  DEFAULT_MAX_DEVIATION,
  DEFAULT_REJECT_DEVIATION,
  type ParsedFeed,
} from "./core.ts";
import { fetchPrice, type QuoteMeta } from "./feeds.ts";

const SYMBOLS = [
  "sBTC", "sETH", "sAAPL", "sTSLA", "sNVDA",
  "sMSFT", "sGOOGL", "sGOLD", "sBOND", "sICLN", "sESGU",
] as const;

const DEVIATION_THRESHOLD = Number(process.env.KEEPER_DEVIATION ?? "0.001"); // 0.1%
const HEARTBEAT_SEC = Number(process.env.KEEPER_HEARTBEAT ?? "900");         // 15 分鐘
const DRY_RUN = process.env.DRY_RUN === "1";
// A-5：寫進 MockOracle（交易所實際讀的那顆）的偏離上限與拒寫門檻。
const MAX_DEVIATION = Number(process.env.KEEPER_MAX_DEVIATION ?? String(DEFAULT_MAX_DEVIATION));
const REJECT_DEVIATION = Number(process.env.KEEPER_REJECT_DEVIATION ?? String(DEFAULT_REJECT_DEVIATION));
// 部分失敗門檻：超過這個比例的資產無法更新就讓 CI 變紅（預設 30%）。
const MAX_DEGRADED_RATIO = Number(process.env.KEEPER_MAX_DEGRADED_RATIO ?? "0.3");

const CHAIN = (process.env.KEEPER_CHAIN ?? "base-sepolia").trim();
const CHAIN_ID = CHAIN === "sepolia" ? 11155111 : 84532;

const RPC_URL = (process.env.KEEPER_RPC_URL ?? "").trim();
const PRIVATE_KEY = (process.env.KEEPER_PRIVATE_KEY ?? "").trim();
const ORACLE_ADDR = (process.env.KEEPER_ORACLE_ADDRESS ?? "").trim();
const GUARDED_ADDR = (process.env.KEEPER_GUARDED_ORACLE ?? "").trim();

// PerpetualExchange.oracle 是 immutable，永遠不可能指向 Chainlink/Pyth，除非重新
// 部署交易所而毀掉所有未平倉部位。但它可以「被它們餵」：設定 RELAY_SOURCE 指向
// AggregatorOracleAdapter，keeper 就讀鏈上聚合價並中繼進 MockOracle，交易所因此
// 隔一層地以去中心化資料結算。
//
// 說清楚這是什麼：一個**受信任的中繼，不是無信任的整合**。keeper 的金鑰仍然可以
// 寫任何值。它拿掉的是對中心化交易所 API 的依賴，不是對 keeper 的依賴。
// （這是 docs/KNOWN_LIMITATIONS.md 第 2 條所描述的緩解措施。）
const RELAY_SOURCE = (
  process.env.KEEPER_RELAY_SOURCE ?? process.env.RELAY_SOURCE ?? ""
).trim();

if (!RPC_URL) {
  console.error("::error::KEEPER_RPC_URL 未設");
  process.exit(1);
}
if (!DRY_RUN && (!PRIVATE_KEY.startsWith("0x") || PRIVATE_KEY.length !== 66)) {
  console.error("::error::KEEPER_PRIVATE_KEY 未設或格式錯誤");
  process.exit(1);
}
if (!ethers.isAddress(ORACLE_ADDR)) {
  console.error("::error::KEEPER_ORACLE_ADDRESS 未設或不是合法地址");
  process.exit(1);
}

const ORACLE_ABI = [
  "function updatePrice(bytes32 assetId, uint256 newPrice) external",
  "function getPrice(bytes32 assetId) view returns (uint256 price, uint256 updatedAt)",
];
const GUARDED_ABI = [
  "function updatePrice(bytes32 assetId, uint256 newPrice) external",
  "function peek(bytes32 assetId) view returns (uint256 price, uint256 updatedAt, bool exists, bool frozen)",
  "function maxDeviationBps() view returns (uint256)",
];
const AGGREGATOR_ABI = [
  "function getPrice(bytes32 assetId) view returns (uint256 price, uint256 updatedAt)",
  "function isStale(bytes32 assetId) view returns (bool)",
];

/**
 * 從鏈上的參考聚合器讀一個價。拿不到就回 null —— 多數股票在測試網上沒有
 * Chainlink/Pyth feed，那是預期情況，不是錯誤。
 */
async function fetchFromRelay(
  agg: ethers.Contract | null,
  assetId: string,
): Promise<number | null> {
  if (!agg) return null;
  try {
    if ((await agg.isStale(assetId)) as boolean) return null;
    const [raw] = (await agg.getPrice(assetId)) as [bigint, bigint];
    const p = Number(raw) / 1e8;
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  // batchMaxCount:1 —— 公共節點對 JSON-RPC batch 的處理不穩，逐筆送最可靠。
  const provider = new ethers.JsonRpcProvider(
    RPC_URL,
    { chainId: CHAIN_ID, name: CHAIN },
    { batchMaxCount: 1, staticNetwork: true },
  );

  const onChainId = Number((await provider.getNetwork()).chainId);
  if (onChainId !== CHAIN_ID) {
    console.error(`::error::RPC 指向 chainId ${onChainId}，預期 ${CHAIN_ID}`);
    process.exit(1);
  }

  const signer = DRY_RUN ? null : new ethers.Wallet(PRIVATE_KEY, provider);

  // 沒油就直接停 —— 這正是 Base Sepolia keeper 靜默失敗 9.5 天的原因，
  // 當時每筆 cast send 都以 "gas required exceeds allowance (0)" 失敗，
  // 而 `|| echo` 把它吞掉，CI 依然全綠。
  if (signer) {
    const bal = await provider.getBalance(signer.address);
    console.log(`keeper ${signer.address} balance=${ethers.formatEther(bal)} ETH`);
    if (bal === 0n) {
      console.error(`::error::keeper 錢包在 ${CHAIN} 上餘額為 0，無法送出任何交易`);
      process.exit(1);
    }
  }

  const oracle = new ethers.Contract(ORACLE_ADDR, ORACLE_ABI, signer ?? provider);
  const guarded =
    GUARDED_ADDR && ethers.isAddress(GUARDED_ADDR)
      ? new ethers.Contract(GUARDED_ADDR, GUARDED_ABI, signer ?? provider)
      : null;
  const guardedCap: bigint = guarded ? await guarded.maxDeviationBps() : 0n;

  const relay =
    RELAY_SOURCE && ethers.isAddress(RELAY_SOURCE)
      ? new ethers.Contract(RELAY_SOURCE, AGGREGATOR_ABI, provider)
      : null;
  if (relay) console.log(`relay source: ${RELAY_SOURCE}（優先於外部 API）`);

  const nowSec = Math.floor(Date.now() / 1000);
  let wrote = 0;
  let failed = 0;
  let available = 0;   // 拿到合法價格的資產數
  let skipped = 0;     // 來源壞掉而跳過的資產數
  let rejected = 0;    // 價格離譜、被偏離上限拒寫的資產數（A-5）
  let clamped = 0;     // 被夾到偏離上限、分段逼近的資產數

  for (const symbol of SYMBOLS) {
    const assetId = ethers.id(symbol); // == cast keccak "$SYM"

    // 優先中繼鏈上的去中心化聚合價；聚合器沒有這個資產的 feed（測試網上多數股票
    // 都是如此）或自報過期時，才退回外部 API。
    const relayed = await fetchFromRelay(relay, assetId);
    const feed: ParsedFeed & QuoteMeta & { source: string } =
      relayed !== null
        ? { value: relayed, reason: "ok", source: "chainlink/pyth relay" }
        : await fetchPrice(symbol);

    if (feed.value === null) {
      // 拒絕而不是夾擠：夾擠出來的價格讀者無法分辨真假。
      console.log(`${symbol.padEnd(6)} 來源無效，跳過 (${feed.source}: ${feed.reason})`);
      skipped += 1;
      continue;
    }
    available += 1;

    let current = 0;
    let lastUpdated = 0;
    try {
      const [raw, at] = (await oracle.getPrice(assetId)) as [bigint, bigint];
      current = Number(raw) / 1e8;
      lastUpdated = Number(at);
    } catch {
      // 資產還沒被 addAsset：current 留 0，planUpdate 會判為 seed。
    }

    const plan = planUpdate({
      target: feed.value,
      current,
      lastUpdatedSec: lastUpdated,
      nowSec,
      deviationThreshold: DEVIATION_THRESHOLD,
      heartbeatSec: HEARTBEAT_SEC,
    });

    const ageMin = lastUpdated > 0 ? ((nowSec - lastUpdated) / 60).toFixed(1) : "n/a";
    const quoteAge =
      typeof feed.quoteAgeSec === "number" ? ` quote=${(feed.quoteAgeSec / 3600).toFixed(1)}h` : "";
    console.log(
      `${symbol.padEnd(6)} [${feed.source.padEnd(20)}] live=$${feed.value.toFixed(2).padStart(10)} ` +
      `chain=$${current.toFixed(2).padStart(10)} age=${ageMin}m${quoteAge} → ${plan.write ? "WRITE" : "skip"} (${plan.reason})`,
    );
    // 偽新鮮度：報價本身很舊（週末收盤價/來源凍結），寫上鏈會讓 updatedAt 看起來
    // 新鮮但價格是好幾天前的。價格照寫（否則週末會全部跳過），但必須說出來。
    if (feed.quoteStale) {
      console.log(
        `::warning::${symbol} 來源報價已 ${((feed.quoteAgeSec ?? 0) / 3600).toFixed(1)} 小時未更新` +
          `（可能是週末/假日收盤價）—— 鏈上 updatedAt 會顯示新鮮，但價格並非即時。`,
      );
    }

    if (!plan.write) continue;

    // A-5：偏離上限。MockOracle 是交易所實際結算/清算所讀的那顆，沒有任何鏈上
    // 保護，所以「離譜但合法」的價格必須在這裡就被擋下或夾住。
    const guard = guardDeviation({
      target: feed.value,
      current,
      maxDeviation: MAX_DEVIATION,
      rejectDeviation: REJECT_DEVIATION,
    });
    if (!guard.write) {
      rejected += 1;
      console.error(`::error::${symbol} ${guard.reason}`);
      continue;
    }
    if (guard.clamped) {
      clamped += 1;
      console.log(`::warning::${symbol} ${guard.reason}`);
    }

    if (DRY_RUN) continue;

    const price8 = toPrice8(guard.value);
    try {
      const tx = await oracle.updatePrice(assetId, price8);
      await tx.wait();
      wrote += 1;
      console.log(`  → MockOracle ✓ ${tx.hash}`);
    } catch (e) {
      failed += 1;
      console.error(`::error::${symbol} MockOracle 寫入失敗：${(e as Error).message.slice(0, 140)}`);
      continue;
    }

    if (guarded && !(await mirror(guarded, assetId, symbol, price8, guardedCap))) {
      // 鏡射失敗以前是完全靜默的 console.log。GuardedOracle 追不上就等於那條
      // 「有保護的價格路徑」實際上是死的，必須算進 failed 並讓 CI 看得到。
      failed += 1;
    }
  }

  console.log(
    `\navailable=${available} skipped=${skipped} rejected=${rejected} clamped=${clamped} wrote=${wrote} failed=${failed}`,
  );

  // 有價格可寫卻一筆都沒成功 = keeper 壞了。這一定要讓 CI 變紅。
  if (available > 0 && wrote === 0 && failed > 0) {
    console.error(
      `::error::Keeper 寫入 0 筆（${failed} 筆失敗）。檢查簽章者權限與錢包餘額。`,
    );
    process.exit(1);
  }
  if (skipped === SYMBOLS.length) {
    console.error("::error::所有價格來源都無效 —— 來源可能已下線。");
    process.exit(1);
  }
  // 部分失敗也要紅：10/11 資產跳過而 CI 全綠，正是 oracle 靜默腐爛 9.5 天的原因。
  const degraded = skipped + rejected;
  const degradedRatio = degraded / SYMBOLS.length;
  if (degradedRatio > MAX_DEGRADED_RATIO) {
    console.error(
      `::error::${degraded}/${SYMBOLS.length} 個資產無法更新` +
        `（skipped=${skipped} rejected=${rejected}，${(degradedRatio * 100).toFixed(0)}% > ` +
        `${(MAX_DEGRADED_RATIO * 100).toFixed(0)}% 門檻）—— 價格來源或偏離守衛出了問題。`,
    );
    process.exit(1);
  }
  if (rejected > 0) {
    console.error(`::error::${rejected} 個資產的價格離譜被拒寫，請人工確認來源。`);
    process.exit(1);
  }
  if (failed > 0) {
    console.error(`::error::寫入 ${wrote} 筆，${failed} 筆失敗。`);
    process.exit(1);
  }
}

/**
 * 把價格鏡射進 GuardedOracle，超出偏離上限時走一步而不是放棄。
 * 舊 keeper 每次都寫全額目標價，落後超過上限後就永遠被 DeviationTooLarge 打回。
 *
 * 回 true 代表「這一輪沒有問題」（含：資產不存在、已凍結、已是目標值）；
 * 回 false 代表真的失敗 —— 呼叫端會計進 failed 讓 CI 變紅。舊版把失敗寫成
 * `console.log` 完全靜默，於是「有保護的價格路徑」死掉也沒人知道。
 */
async function mirror(
  guarded: ethers.Contract,
  assetId: string,
  symbol: string,
  target8: bigint,
  cap: bigint,
): Promise<boolean> {
  try {
    const [price, , exists, frozen] = (await guarded.peek(assetId)) as [
      bigint, bigint, boolean, boolean,
    ];
    if (!exists) return true;
    if (frozen) {
      console.log(`  → GuardedOracle 已凍結，略過鏡射`);
      return true;
    }

    const next = stepTowards(price, target8, cap);
    if (next === price) {
      console.log(`  → GuardedOracle 已是目標值`);
      return true;
    }
    if (!deviationAccepted(price, next, cap)) {
      // 到不了這裡；到了代表 stepTowards 與合約失去同步，必須大聲。
      console.error(`::error::${symbol} stepTowards 產生會被拒絕的值 ${next}（cap=${cap}）`);
      return false;
    }

    const tx = await guarded.updatePrice(assetId, next);
    await tx.wait();
    const partial = next !== target8 ? "（分段逼近，下一輪繼續）" : "";
    console.log(`  → GuardedOracle ✓ ${next} ${partial}`);
    return true;
  } catch (e) {
    console.error(`::error::${symbol} GuardedOracle 鏡射失敗：${(e as Error).message.slice(0, 120)}`);
    return false;
  }
}

main().catch((e) => {
  console.error("::error::keeper 未預期地中止：", e);
  process.exit(1);
});
