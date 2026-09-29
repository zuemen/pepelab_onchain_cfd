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
  runVerdict,
  isRevertWith,
  ASSET_NOT_FOUND_SELECTOR,
  DEFAULT_BREAKER_DEVIATION,
  DEFAULT_CONFIRM_TOLERANCE,
  BREAKER_RANGE,
  CONFIRM_TOLERANCE_RANGE,
  DEVIATION_THRESHOLD_RANGE,
  HEARTBEAT_RANGE,
  DEGRADED_RATIO_RANGE,
  parseRatioEnv,
} from "./core.ts";
import { fetchMarketSession, fetchPrice, fetchSecondaryPrice } from "./feeds.ts";
import { runRound, type RoundResult } from "./round.ts";
import { describeProtection, protectAsset } from "./protect.ts";
import type { HealthReport } from "./alert.ts";
import { writeFileSync } from "node:fs";
import { classifyProbeError, decideAssetMode, modeName, switchesMode } from "./operator.ts";
import type { MarketSession } from "./market.ts";

const SYMBOLS = [
  "sBTC", "sETH", "sAAPL", "sTSLA", "sNVDA",
  "sMSFT", "sGOOGL", "sGOLD", "sBOND", "sICLN", "sESGU",
] as const;

// 所有數值型環境變數都驗證是有限數且在合理範圍內，否則 exit 1（複審 Low）：
// NaN 會讓每個比較都是 false —— 熔斷形同關閉、heartbeat 永不觸發、降級門檻失效。
function numEnvOrDie(
  name: string,
  def: number,
  range: readonly [number, number],
  opts: { minInclusive?: boolean } = {},
): number {
  const r = parseRatioEnv(name, process.env[name], def, range[0], range[1], opts);
  if (r.error !== undefined) {
    console.error(`::error::${r.error}`);
    process.exit(1);
  }
  return r.value;
}
const DEVIATION_THRESHOLD = numEnvOrDie("KEEPER_DEVIATION", 0.001, DEVIATION_THRESHOLD_RANGE); // 0.1%
const HEARTBEAT_SEC = numEnvOrDie("KEEPER_HEARTBEAT", 900, HEARTBEAT_RANGE);                   // 15 分鐘
const DRY_RUN = process.env.DRY_RUN === "1";
// A-5：寫進 MockOracle（交易所實際讀的那顆）的熔斷門檻；超過就需要多源確認，
// 確認不過就拒寫（熔斷語意，見 core.ts guardDeviation）。實際使用時再被 GuardedOracle
// 的上限壓低（round.ts effectiveBreaker）。
const BREAKER_DEVIATION = numEnvOrDie("KEEPER_BREAKER_DEVIATION", DEFAULT_BREAKER_DEVIATION, BREAKER_RANGE);
// 多源確認：獨立來源彼此差距 ≤ 這個比例且方向一致，才寫入共識價。
const CONFIRM_TOLERANCE = numEnvOrDie("KEEPER_CONFIRM_TOLERANCE", DEFAULT_CONFIRM_TOLERANCE, CONFIRM_TOLERANCE_RANGE);
// 部分失敗門檻：超過這個比例的資產無法更新就讓 CI 變紅（預設 30%）。
const MAX_DEGRADED_RATIO = numEnvOrDie("KEEPER_MAX_DEGRADED_RATIO", 0.3, DEGRADED_RATIO_RANGE, { minInclusive: true });

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
// 選用：熔斷報告（alert.ts 的 HealthReport 形狀）與拒寫清單（一行一個 symbol，
// funding crank 據此跳過）。workflow 設在 $RUNNER_TEMP。
const REPORT_PATH = (process.env.KEEPER_REPORT_PATH ?? "").trim();
const REFUSED_PATH = (process.env.KEEPER_REFUSED_PATH ?? "").trim();

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
// 熔斷停單（切 ReduceOnly）與訊息用的 maxPriceAge；舊 exchange 沒有前三個函式。
// keeper 不再凍結 GuardedOracle（窄複審 1，見 protect.ts）。
const EXCHANGE_PROTECT_ABI = [
  "function marketOperator() view returns (address)",
  "function assetMode(bytes32 asset) view returns (uint8)",
  "function setAssetMode(bytes32 asset, uint8 mode) external",
  "function maxPriceAge() view returns (uint256)",
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
  const round = await runRound({
    symbols: SYMBOLS,
    nowSec,
    dryRun: DRY_RUN,
    deviationThreshold: DEVIATION_THRESHOLD,
    heartbeatSec: HEARTBEAT_SEC,
    breakerDeviation: BREAKER_DEVIATION,
    confirmTolerance: CONFIRM_TOLERANCE,
    assetIdOf: (symbol) => ethers.id(symbol), // == cast keccak "$SYM"
    isAssetNotFound: (e) => isRevertWith(revertInfo(e).data, ASSET_NOT_FOUND_SELECTOR),
    oracle: {
      getPrice: async (id) => (await oracle.getPrice(id)) as [bigint, bigint],
      updatePrice: (id, p) => oracle.updatePrice(id, p),
    },
    guarded: guarded
      ? {
          peek: async (id) => (await guarded.peek(id)) as [bigint, bigint, boolean, boolean],
          // guarded 以 signer 建立，staticCall 的 from 就是 keeper —— role 也一併預檢。
          checkUpdate: (id, p) => guarded.updatePrice.staticCall(id, p),
          updatePrice: (id, p) => guarded.updatePrice(id, p),
        }
      : null,
    guardedCap,
    fetchRelay: (id) => fetchFromRelay(relay, id),
    fetchPrice: (symbol) => fetchPrice(symbol),
    fetchSecondary: (symbol) => fetchSecondaryPrice(symbol),
    beforeAsset: exchange
      ? async (symbol, id) => {
          const r = await applyMarketMode(exchange!, id, symbol, nowSec);
          return r === "missing" ? "stop" : r;
        }
      : undefined,
  });
  writeRefusedList(round);
  const { available, skipped, rejected, confirmed, wrote } = round;
  let failed = round.failed;

  // 複審 H2：拒寫的資產立刻嘗試停單，做不到的部分明寫。
  const exchangeView = ethers.isAddress(EXCHANGE_ADDR)
    ? new ethers.Contract(EXCHANGE_ADDR, EXCHANGE_PROTECT_ABI, signer ?? provider)
    : null;
  let exchangeMaxAge: number | null = null;
  if (exchangeView && round.refused.length > 0) {
    try {
      exchangeMaxAge = Number(await exchangeView.maxPriceAge());
    } catch {
      exchangeMaxAge = null;
    }
  }
  const protectionNotes: string[] = [];
  for (const ref of round.refused) {
    const res = await protectAsset({
      symbol: ref.symbol,
      assetId: ref.assetId,
      exchange: exchangeView
        ? {
            marketOperator: async () => (await exchangeView.marketOperator()) as string,
            assetMode: async (id) => (await exchangeView.assetMode(id)) as bigint,
            checkSetAssetMode: (id, mode) => exchangeView.setAssetMode.staticCall(id, mode),
            setAssetMode: (id, mode) => exchangeView.setAssetMode(id, mode),
          }
        : null,
      signerAddress: signer?.address ?? null,
      isMissingFunction: (e) => classifyProbeError(revertInfo(e)) === "missing",
    });
    const { notes, exchangeStillTrading } = describeProtection(res, exchangeMaxAge);
    for (const n of notes) {
      if (exchangeStillTrading) console.error(`::error::${n}`);
      else console.log(`::warning::${n}`);
    }
    if (res.mode === "failed") failed += 1;
    protectionNotes.push(...notes);
  }
  // 窄複審 4：報告帶上交易所目前仍在保護中（非 Active）的資產；有就不自動關 issue。
  const protectedAssets = exchangeView ? await readProtected(exchangeView) : [];
  if (protectedAssets.length) console.log(`::warning::交易所保護中的資產：${protectedAssets.join(", ")}（解除需人工）`);
  writeRefusal(round, protectionNotes, nowSec, exchangeMaxAge, protectedAssets);

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

/**
 * 拒寫清單（給 funding crank）。窄複審 5：runRound 一回傳就寫，不等停單與報告 ——
 * 後面任何一步丟例外都不能讓清單消失（清單不存在時 crank 會失敗）。
 * 「沒判斷到」的資產（skippedSymbols：來源無效、RPC 失敗、寫入停止）也列入：
 * 無法確認它們的價格可信，同樣不該拿來結算 funding。
 */
function writeRefusedList(round: RoundResult): void {
  if (!REFUSED_PATH) return;
  const syms = [...new Set([...round.refused.map((r) => r.symbol), ...round.skippedSymbols])];
  try {
    writeFileSync(REFUSED_PATH, syms.map((s) => `${s}\n`).join(""), "utf8");
  } catch (e) {
    console.error(`::error::寫不出拒寫清單 ${REFUSED_PATH}：${(e as Error).message}`);
  }
}

/**
 * 讀每個資產在交易所的 assetMode，回傳非 Active 的（例如 "sAAPL(ReduceOnly)"）。
 * 舊 exchange 沒有 assetMode → 回空陣列（沒有保護機制可言）；單一資產讀失敗時保守
 * 地列為 "(unknown)"，一樣會擋住自動關閉。
 */
async function readProtected(exchange: ethers.Contract): Promise<string[]> {
  const out: string[] = [];
  for (const symbol of SYMBOLS) {
    try {
      const m = Number(await exchange.assetMode(ethers.id(symbol)));
      if (m !== 0) out.push(`${symbol}(${modeName(m)})`);
    } catch (e) {
      if (classifyProbeError(revertInfo(e)) === "missing") return [];
      out.push(`${symbol}(unknown)`);
    }
  }
  return out;
}

/** 熔斷報告（給 alert-run.ts）。 */
function writeRefusal(
  round: RoundResult,
  notes: string[],
  nowSec: number,
  exchangeMaxAge: number | null,
  protectedAssets: string[],
): void {
  try {
    if (REPORT_PATH) {
      const report: HealthReport = {
        kind: "breaker",
        chain: CHAIN,
        status: round.refused.length > 0 ? "stale" : "ok",
        checkedAtSec: nowSec,
        maxAgeSec: exchangeMaxAge ?? 0,
        stale: round.refused.map((r) => r.symbol),
        // 這一輪來源無效而沒判斷到的資產：不能證明熔斷已解除，擋住自動關閉。
        unreadable: round.skippedSymbols,
        notes,
        protected: protectedAssets,
        lines: round.refused.map((r) => `${r.symbol}: ${r.reason}`),
      };
      writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
    }
  } catch (e) {
    console.log(`::warning::寫不出熔斷報告：${(e as Error).message}`);
  }
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
): Promise<"ok" | "missing" | "failed"> {
  // 加密／期貨不做休市切換：連 RPC 都不打。
  if (!switchesMode(symbol)) return "ok";
  // 市場時段獨立取得（審查 Low），不依賴價格來源：價格改走 relay、或 Yahoo 價格因
  // 報價過舊被拒時，feed 上都不會帶 session。拿不到就是 null → 行事曆只准收緊。
  const session: MarketSession | null = await fetchMarketSession(symbol);

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
    // assetMode() 已讀成功 → 新 exchange，setAssetMode 必定存在；空 revert 算 denied
    // 並記 failed，不能當成「舊合約」靜默略過。
    const kind = classifyProbeError(revertInfo(e), { functionExists: true });
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

main().catch((e) => {
  console.error("::error::keeper 未預期地中止：", e);
  process.exit(1);
});
