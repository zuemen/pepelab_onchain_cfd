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
//
// 選用：設定 KEEPER_VAULT_ADDRESS 指向 AssetVaultV2（.3+）就會在價格寫完後呼叫
// observeReserve()，把儲備率釘進可重播的 ReserveObserved 事件（#99）。不設就
// 完全跳過，不影響價格寫入。
import { ethers } from "ethers";
import {
  toPrice8,
  planUpdate,
  guardDeviation,
  planMirror,
  runVerdict,
  DEFAULT_BREAKER_DEVIATION,
  DEFAULT_CONFIRM_TOLERANCE,
  BREAKER_RANGE,
  CONFIRM_TOLERANCE_RANGE,
  parseRatioEnv,
  type ParsedFeed,
  type SourceQuote,
} from "./core.ts";
import { fetchPrice, fetchSecondaryPrice, type QuoteMeta } from "./feeds.ts";
import { classifyProbeError, decideAssetMode, modeName, switchesMode } from "./operator.ts";
import type { MarketSession } from "./market.ts";

const SYMBOLS = [
  "sBTC", "sETH", "sAAPL", "sTSLA", "sNVDA",
  "sMSFT", "sGOOGL", "sGOLD", "sBOND", "sICLN", "sESGU",
] as const;

const DEVIATION_THRESHOLD = Number(process.env.KEEPER_DEVIATION ?? "0.001"); // 0.1%
const HEARTBEAT_SEC = Number(process.env.KEEPER_HEARTBEAT ?? "900");         // 15 分鐘
const DRY_RUN = process.env.DRY_RUN === "1";
// A-5：寫進 MockOracle（交易所實際讀的那顆）的熔斷門檻；超過就需要多源確認，
// 確認不過就拒寫（熔斷語意，見 core.ts guardDeviation）。
// 多源確認：獨立來源彼此差距 ≤ 這個比例且方向一致，才寫入共識價。
// 兩者都驗證是有限數且在合理範圍內，否則 exit 1（NaN 會讓熔斷形同關閉）。
function ratioEnvOrDie(name: string, def: number, range: readonly [number, number]): number {
  const r = parseRatioEnv(name, process.env[name], def, range[0], range[1]);
  if (r.error !== undefined) {
    console.error(`::error::${r.error}`);
    process.exit(1);
  }
  return r.value;
}
const BREAKER_DEVIATION = ratioEnvOrDie("KEEPER_BREAKER_DEVIATION", DEFAULT_BREAKER_DEVIATION, BREAKER_RANGE);
const CONFIRM_TOLERANCE = ratioEnvOrDie("KEEPER_CONFIRM_TOLERANCE", DEFAULT_CONFIRM_TOLERANCE, CONFIRM_TOLERANCE_RANGE);
// 部分失敗門檻：超過這個比例的資產無法更新就讓 CI 變紅（預設 30%）。
const MAX_DEGRADED_RATIO = Number(process.env.KEEPER_MAX_DEGRADED_RATIO ?? "0.3");

const CHAIN = (process.env.KEEPER_CHAIN ?? "base-sepolia").trim();
const CHAIN_ID = CHAIN === "sepolia" ? 11155111 : 84532;

const RPC_URL = (process.env.KEEPER_RPC_URL ?? "").trim();
const PRIVATE_KEY = (process.env.KEEPER_PRIVATE_KEY ?? "").trim();
const ORACLE_ADDR = (process.env.KEEPER_ORACLE_ADDRESS ?? "").trim();
const GUARDED_ADDR = (process.env.KEEPER_GUARDED_ORACLE ?? "").trim();
// #99：讓 AssetVaultV2(.3+) 的儲備率變成可重播的時間序列。選用 —— 沒設就跳過,
// 不影響價格寫入這個 keeper 的主要職責。observeReserve() 本身是 permissionless
// 的一般交易,不需要任何角色,用同一把 keeper 金鑰送即可。
const VAULT_ADDR = (process.env.KEEPER_VAULT_ADDRESS ?? "").trim();

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

// 選用（預設關閉）：marketOperator 休市切換，見 keeper/operator.ts。
// 需要 exchange 已部署 setAssetMode（contracts/p1-guardian-market-modes）且 owner 已
// setMarketOperator(keeper 地址)。線上舊 exchange 沒有這個函式 → 探測後略過並記錄。
const MARKET_OPERATOR = process.env.KEEPER_MARKET_OPERATOR === "1";
const EXCHANGE_ADDR = (process.env.KEEPER_EXCHANGE_ADDRESS ?? process.env.EXCHANGE ?? "").trim();

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
const VAULT_ABI = [
  "function observeReserve() external returns (uint256 reserve_, uint256 liability, uint256 ratioBps, uint256 unpriced, bool halted)",
  "event ReserveObserved(uint256 reserve, uint256 liability, uint256 ratioBps, uint256 unpriced, uint256 timestamp)",
  "event ReserveBreached(uint256 ratioBps, uint256 minRatioBps, uint256 unpriced)",
  "event ReserveRestored(uint256 ratioBps, uint256 minRatioBps)",
];
const VAULT_IFACE = new ethers.Interface(VAULT_ABI);
const EXCHANGE_MODE_ABI = [
  "function assetMode(bytes32 asset) view returns (uint8)",
  "function setAssetMode(bytes32 asset, uint8 mode) external",
];

/**
 * 從鏈上的參考聚合器讀一個價。拿不到就回 null —— 多數股票在測試網上沒有
 * Chainlink/Pyth feed，那是預期情況，不是錯誤。
 */
async function fetchFromRelay(
  agg: ethers.Contract | null,
  assetId: string,
): Promise<{ price: number; updatedAt: number } | null> {
  if (!agg) return null;
  try {
    if ((await agg.isStale(assetId)) as boolean) return null;
    const [raw, at] = (await agg.getPrice(assetId)) as [bigint, bigint];
    const p = Number(raw) / 1e8;
    // updatedAt 給多源確認判斷新鮮度（鏈上時間戳，不是 keeper 讀取的時間）。
    return Number.isFinite(p) && p > 0 ? { price: p, updatedAt: Number(at) } : null;
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

  let exchange: ethers.Contract | null = null;
  if (MARKET_OPERATOR) {
    if (!ethers.isAddress(EXCHANGE_ADDR)) {
      console.log("::warning::KEEPER_MARKET_OPERATOR=1 但 KEEPER_EXCHANGE_ADDRESS/EXCHANGE 未設，略過休市切換");
    } else {
      exchange = new ethers.Contract(EXCHANGE_ADDR, EXCHANGE_MODE_ABI, signer ?? provider);
      console.log(`marketOperator: 啟用（exchange ${EXCHANGE_ADDR}）`);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  let wrote = 0;
  let failed = 0;
  let available = 0;   // 拿到合法價格的資產數
  let skipped = 0;     // 來源壞掉而跳過的資產數
  let rejected = 0;    // 觸發價格熔斷、被拒寫的資產數（A-5）
  let confirmed = 0;   // 超過熔斷門檻但多源確認通過、寫入共識價的資產數

  for (const symbol of SYMBOLS) {
    const assetId = ethers.id(symbol); // == cast keccak "$SYM"

    // 優先中繼鏈上的去中心化聚合價；聚合器沒有這個資產的 feed（測試網上多數股票
    // 都是如此）或自報過期時，才退回外部 API。
    const relayed = await fetchFromRelay(relay, assetId);
    const feed: ParsedFeed & QuoteMeta & { source: string } =
      relayed !== null
        ? {
            value: relayed.price,
            reason: "ok",
            source: "chainlink/pyth relay",
            quoteAgeSec: Math.max(0, nowSec - relayed.updatedAt),
          }
        : await fetchPrice(symbol);

    // 休市切換放在價格判斷之前：價格來源壞了不影響「現在是不是休市」。
    if (exchange) {
      const r = await applyMarketMode(exchange, assetId, symbol, nowSec, feed.session ?? null);
      if (r === "missing") exchange = null; // 舊 exchange：整輪不再探測
      if (r === "failed") failed += 1;
    }

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

    // A-5：價格熔斷。MockOracle 是交易所實際結算/清算所讀的那顆，沒有任何鏈上
    // 保護，所以「離譜但合法」的價格必須在這裡擋下 —— 只寫完整價格或不寫。
    // 偏離超過熔斷門檻時才去湊第二個獨立來源（正常路徑不多打任何請求）：
    // relay（Pyth）、主要外部 API（CoinGecko/Yahoo）、次要外部 API（Yahoo BTC-USD…）。
    // 每一票都帶報價年齡：relay 用鏈上 updatedAt、CoinGecko 用 last_updated_at、
    // Yahoo 用 regularMarketTime；年齡不明或過舊的票在 confirmLargeMove 裡不算數。
    const asQuote = (f: ParsedFeed & QuoteMeta, source: string): SourceQuote => ({
      source,
      value: f.value as number,
      ageSec: f.quoteAgeSec,
      stale: f.quoteStale === true,
    });
    const quotes: SourceQuote[] = [asQuote(feed, feed.source)];
    if (current > 0 && Math.abs(feed.value - current) / current > BREAKER_DEVIATION) {
      if (relayed !== null) {
        const api = await fetchPrice(symbol);
        if (api.value !== null) quotes.push(asQuote(api, api.source));
      }
      const second = await fetchSecondaryPrice(symbol);
      if (second.value !== null) quotes.push(asQuote(second, `${second.source}(secondary)`));
      console.log(
        `  多源確認：${quotes
          .map((q) => `${q.source}=$${q.value.toFixed(2)}(age ${q.ageSec ?? "?"}s${q.stale ? ",stale" : ""})`)
          .join(", ")}`,
      );
    }
    const guard = guardDeviation({
      target: feed.value,
      current,
      breakerDeviation: BREAKER_DEVIATION,
      quotes,
      confirmTolerance: CONFIRM_TOLERANCE,
    });
    if (!guard.write) {
      rejected += 1;
      console.error(`::error::${symbol} ${guard.reason}`);
      continue;
    }
    if (guard.confirmed) {
      confirmed += 1;
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

  // #99: reuses the same failed-counter/exit(1) mechanism every other genuine
  // problem in this file already goes through, rather than a separate,
  // always-::warning:: path — see observeVaultReserve()'s own docstring.
  if (VAULT_ADDR && !(await observeVaultReserve(provider, signer))) {
    failed += 1;
  }

  console.log(
    `\navailable=${available} skipped=${skipped} rejected=${rejected} confirmed=${confirmed} wrote=${wrote} failed=${failed}`,
  );

  // 有價格可寫卻一筆都沒成功、全部來源無效、降級比例過高（10/11 資產跳過而 CI
  // 全綠正是 oracle 靜默腐爛 9.5 天的原因）、熔斷拒寫、寫入失敗 —— 任一都讓 job 紅。
  const verdict = runVerdict(
    { total: SYMBOLS.length, available, skipped, rejected, wrote, failed },
    MAX_DEGRADED_RATIO,
  );
  for (const msg of verdict.errors) console.error(`::error::${msg}`);
  if (verdict.exitCode !== 0) process.exit(verdict.exitCode);
}

function revertInfo(e: unknown): { code?: unknown; data?: unknown } {
  const x = e as { code?: unknown; data?: unknown; info?: { error?: { data?: unknown } } };
  return { code: x?.code, data: x?.data ?? x?.info?.error?.data };
}

/**
 * marketOperator：讀 assetMode → decideAssetMode → staticCall 探測 → 送出。
 *   "missing" — exchange 沒有 assetMode/setAssetMode（線上舊合約），略過並記錄；
 *               呼叫端整輪停用，不算失敗。
 *   "failed"  — 已確定要切換卻送不出去（權限、RPC），計入 failed 讓 CI 變紅。
 *   "ok"      — 其他（含 skip、DRY_RUN）。
 */
async function applyMarketMode(
  exchange: ethers.Contract,
  assetId: string,
  symbol: string,
  nowSec: number,
  session: MarketSession | null,
): Promise<"ok" | "missing" | "failed"> {
  // 加密／期貨不做休市切換：連 RPC 都不打。
  if (!switchesMode(symbol)) return "ok";

  let current: number;
  try {
    current = Number(await exchange.assetMode(assetId));
  } catch (e) {
    const kind = classifyProbeError(revertInfo(e));
    if (kind === "missing") {
      console.log(`  → marketOperator：exchange 沒有 assetMode()（舊合約），本輪略過休市切換`);
      return "missing";
    }
    console.log(`::warning::${symbol} 讀 assetMode 失敗（${kind}）：${(e as Error).message.slice(0, 100)}`);
    return "ok";
  }

  const d = decideAssetMode({ symbol, nowSec, currentMode: current, session });
  if (d.action === "skip") {
    console.log(`  → marketOperator ${symbol}: skip（${d.reason}）`);
    return "ok";
  }

  try {
    await exchange.setAssetMode.staticCall(assetId, d.mode);
  } catch (e) {
    const kind = classifyProbeError(revertInfo(e));
    if (kind === "missing") {
      console.log(`  → marketOperator：exchange 沒有 setAssetMode()（舊合約），本輪略過休市切換`);
      return "missing";
    }
    if (DRY_RUN && kind === "denied") {
      // DRY_RUN 沒有 signer，staticCall 的 from 是零位址，被拒是預期的。
      console.log(`  → marketOperator ${symbol}: 會 ${d.reason}（DRY_RUN，權限未驗證）`);
      return "ok";
    }
    console.error(`::error::${symbol} setAssetMode(${modeName(d.mode)}) 預檢失敗（${kind}）：${(e as Error).message.slice(0, 140)}`);
    return "failed";
  }

  if (DRY_RUN) {
    console.log(`  → marketOperator ${symbol}: 會 ${d.reason}（DRY_RUN）`);
    return "ok";
  }
  try {
    const tx = await exchange.setAssetMode(assetId, d.mode);
    await tx.wait();
    console.log(`  → marketOperator ${symbol}: ${d.reason} ✓ ${tx.hash}`);
    return "ok";
  } catch (e) {
    console.error(`::error::${symbol} setAssetMode(${modeName(d.mode)}) 失敗：${(e as Error).message.slice(0, 140)}`);
    return "failed";
  }
}

/**
 * 呼叫 AssetVaultV2(.3+) 的 observeReserve()，把儲備率釘進 ReserveObserved 事件
 * 的時間序列。#99：這是 README 早就自豪「每個狀態改變都發事件、/history 可重
 * 播」唯獨漏掉的那個數字。
 *
 * 回傳比照 mirror()：true 代表這輪沒問題，false 代表真的失敗（RPC 抖動、gas
 * 估算失敗、地址設錯）——呼叫端把 false 計進 failed，讓既有的「failed > 0 就
 * exit(1)」機制接管，而不是另外發明一條「永遠只 warning、CI 永遠綠」的例外
 * 路徑。observeReserve() 是選用功能（KEEPER_VAULT_ADDRESS 沒設就完全不會呼叫
 * 到這裡），但一旦設了，它失敗就跟其他任何價格寫入失敗一樣該讓 CI 變紅——不然
 * 「可重播的儲備歷史」會在沒人發現的情況下停止累積。
 *
 * 只送一次交易，不額外做 staticCall 預覽（DRY_RUN 除外，那是唯一不送真交易的
 * 模式，此時只能用 staticCall 才看得到會發生什麼）：reserve/liability/ratio/
 * unpriced 這些數字直接從交易收據裡的 ReserveObserved 事件解出來 log，不用再
 * 打第二次 RPC、跑第二次 O(n) 的 oracle 掃描，也不會有「staticCall 快照」與
 * 「實際上鏈結果」中間夾了別筆交易而兜不起來的問題。
 *
 * ReserveBreached 出現時回傳 false（連同一個獨立的 log 訊息），讓呼叫端也計進
 * failed——這不是「keeper 壞了」，是「儲備率真的跌破門檻」，但兩者都值得讓這次
 * 排程執行在 CI 上顯眼地標紅，而不是全綠地滑過去。
 */
async function observeVaultReserve(
  provider: ethers.JsonRpcProvider,
  signer: ethers.Wallet | null,
): Promise<boolean> {
  if (!ethers.isAddress(VAULT_ADDR)) {
    console.error(`::error::KEEPER_VAULT_ADDRESS 不是合法地址`);
    return false;
  }
  const vault = new ethers.Contract(VAULT_ADDR, VAULT_ABI, signer ?? provider);

  if (DRY_RUN) {
    try {
      const [reserve, liability, ratioBps, unpriced, halted] =
        (await vault.observeReserve.staticCall()) as [bigint, bigint, bigint, bigint, boolean];
      console.log(`\n${_fmtReserveLine(reserve, liability, ratioBps, unpriced, halted)}`);
      console.log("  → observeReserve() 略過（DRY_RUN，以上為預覽值）");
      return true;
    } catch (e) {
      console.error(`::error::observeReserve 預覽失敗：${(e as Error).message.slice(0, 140)}`);
      return false;
    }
  }

  try {
    const tx = await vault.observeReserve();
    const receipt = await tx.wait();
    console.log(`  → observeReserve() ✓ ${tx.hash}`);

    let breached = false;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== VAULT_ADDR.toLowerCase()) continue;
      let parsed;
      try { parsed = VAULT_IFACE.parseLog(log); } catch { continue; } // not one of ours
      if (parsed?.name === "ReserveObserved") {
        const [reserve, liability, ratioBps, unpriced] = parsed.args as unknown as
          [bigint, bigint, bigint, bigint, bigint];
        console.log(`\n${_fmtReserveLine(reserve, liability, ratioBps, unpriced, null)}`);
      } else if (parsed?.name === "ReserveBreached") {
        breached = true;
      } else if (parsed?.name === "ReserveRestored") {
        console.log("  → ReserveRestored —— 儲備率已恢復，mint() 重新開放。");
      }
    }
    if (breached) {
      console.error(
        `::error::ReserveBreached —— 儲備率跌破門檻，mint() 已暫停（redeem 不受影響）。`,
      );
      return false;
    }
    return true;
  } catch (e) {
    console.error(`::error::observeReserve 失敗：${(e as Error).message.slice(0, 140)}`);
    return false;
  }
}

function _fmtReserveLine(
  reserve: bigint, liability: bigint, ratioBps: bigint, unpriced: bigint, halted: boolean | null,
): string {
  const ratioTxt = ratioBps === ethers.MaxUint256 ? "∞" : `${(Number(ratioBps) / 100).toFixed(1)}%`;
  const haltedTxt = halted === null ? "" : ` halted=${halted}`;
  return `reserve=$${(Number(reserve) / 1e18).toFixed(2)} ` +
    `liability=$${(Number(liability) / 1e18).toFixed(2)} ratio=${ratioTxt} unpriced=${unpriced}${haltedTxt}`;
}

/**
 * 把完整價格鏡射進 GuardedOracle。鏈上 maxDeviationBps 不接受完整價格時**不寫部分
 * 步進**（那是明知錯誤的價格，2026-09-29 審查移除 stepTowards），記為 failed 並
 * 輸出 ::error::，由人依 RUNBOOK_KEEPER.md「價格熔斷」處置。
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

    const plan = planMirror(price, target8, cap);
    if (plan.action === "skip") {
      console.log(`  → GuardedOracle ${plan.reason}`);
      return true;
    }
    if (plan.action === "reject") {
      console.error(`::error::${symbol} GuardedOracle ${plan.reason}`);
      return false;
    }

    const tx = await guarded.updatePrice(assetId, plan.value);
    await tx.wait();
    console.log(`  → GuardedOracle ✓ ${plan.value}`);
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
