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

import { LocalNonceSigner } from "./nonceSigner.ts";
import {
  runVerdict,
  summaryLine,
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
import { isTimeout, runRound, type RoundResult } from "./round.ts";
import { describeProtection, protectAsset } from "./protect.ts";
import type { HealthReport } from "./alert.ts";
import { writeFileSync } from "node:fs";
import { CLOSE_LEAD_RANGE, DEFAULT_CLOSE_LEAD_SEC, classifyProbeError, marketOperatorEnabled } from "./operator.ts";
import { classifyProtected, closedForTrading, createMarketMode } from "./marketMode.ts";

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

// marketOperator 休市切換（w36 起預設啟用；KEEPER_MARKET_OPERATOR=0 才關），見 keeper/operator.ts。
// 需要 exchange 已部署 setAssetMode（contracts/p1-guardian-market-modes）且 owner 已
// setMarketOperator(keeper 地址)。線上舊 exchange 沒有這個函式 → 探測後略過，並以
// ::warning:: 列出「休市中仍可對收盤價開倉」的資產（docs/KNOWN_LIMITATIONS.md §31）。
const MARKET_OPERATOR = marketOperatorEnabled(process.env);
// 審查 H1：收盤前多久就收緊（秒）。預設 3 小時，理由見 operator.ts DEFAULT_CLOSE_LEAD_SEC。
const CLOSE_LEAD_SEC = numEnvOrDie("KEEPER_CLOSE_LEAD_SEC", DEFAULT_CLOSE_LEAD_SEC, CLOSE_LEAD_RANGE, { minInclusive: true });
// 審查 L2：租戶 workflow 會設 FUNDING_SYMBOLS（已註冊資產，空白分隔）；只切這些資產的模式。
const MODE_SYMBOLS: ReadonlySet<string> | null = process.env.FUNDING_SYMBOLS?.trim()
  ? new Set(process.env.FUNDING_SYMBOLS.trim().split(/\s+/))
  : null;
const EXCHANGE_ADDR = (process.env.KEEPER_EXCHANGE_ADDRESS ?? process.env.EXCHANGE ?? "").trim();
// 選用：熔斷報告（alert.ts 的 HealthReport 形狀）與拒寫清單（一行一個 symbol，
// funding crank 據此跳過）。workflow 設在 $RUNNER_TEMP。
const REPORT_PATH = (process.env.KEEPER_REPORT_PATH ?? "").trim();
const REFUSED_PATH = (process.env.KEEPER_REFUSED_PATH ?? "").trim();
// 選用（審查 M2）：結束時把 LocalNonceSigner 的下一個 nonce 寫到這裡，讓 workflow 的
// funding crank 取 max(RPC pending, 這個值)，不必再相信負載平衡 RPC 的 pending nonce。
// workflow 設在 $RUNNER_TEMP；本機沒設就不寫。
const NONCE_PATH = (process.env.KEEPER_NONCE_PATH ?? "").trim();
/** 休市切換與 observeReserve 等確認的上限（審查 L3），與 round.ts 的預設一致。 */
const TX_WAIT_TIMEOUT_MS = 120_000;

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
  "function guardianLocked(bytes32 asset) view returns (bool)",
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
  "function marketOperator() view returns (address)",
  "function assetMode(bytes32 asset) view returns (uint8)",
  "function guardianLocked(bytes32 asset) view returns (bool)",
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

  const wallet = DRY_RUN ? null : new ethers.Wallet(PRIVATE_KEY, provider);
  // 所有合約共用這一個 signer，nonce 在本機遞增（見 nonceSigner.ts 的事故說明）。
  const signer = wallet ? new LocalNonceSigner(wallet) : null;
  activeSigner = signer;

  // 沒油就直接停 —— 這正是 Base Sepolia keeper 靜默失敗 9.5 天的原因，
  // 當時每筆 cast send 都以 "gas required exceeds allowance (0)" 失敗，
  // 而 `|| echo` 把它吞掉，CI 依然全綠。
  if (wallet) {
    const bal = await provider.getBalance(wallet.address);
    console.log(`keeper ${wallet.address} balance=${ethers.formatEther(bal)} ETH`);
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

  let marketMode: ReturnType<typeof createMarketMode> | null = null;
  if (MARKET_OPERATOR) {
    if (!ethers.isAddress(EXCHANGE_ADDR)) {
      console.log("marketOperator 休市切換：未設 KEEPER_EXCHANGE_ADDRESS/EXCHANGE，略過");
    } else {
      const ex = new ethers.Contract(EXCHANGE_ADDR, EXCHANGE_MODE_ABI, signer ?? provider);
      marketMode = createMarketMode({
        exchange: {
          marketOperator: async () => (await ex.marketOperator()) as string,
          assetMode: async (id) => (await ex.assetMode(id)) as bigint,
          guardianLocked: async (id) => (await ex.guardianLocked(id)) as boolean,
          checkSetAssetMode: (id, mode) => ex.setAssetMode.staticCall(id, mode),
          setAssetMode: (id, mode) => ex.setAssetMode(id, mode),
        },
        signerAddress: wallet?.address ?? null,
        now: () => Math.floor(Date.now() / 1000),
        fetchSession: (symbol) => fetchMarketSession(symbol),
        leadSec: CLOSE_LEAD_SEC,
        allowed: MODE_SYMBOLS,
        revertInfo,
        isTimeout,
        waitTimeoutMs: TX_WAIT_TIMEOUT_MS,
      });
      console.log(`marketOperator: 啟用（exchange ${EXCHANGE_ADDR}，收盤提前量 ${CLOSE_LEAD_SEC / 3600}h）`);
      await marketMode.prepare();
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
    // 收緊階段：寫價前、只會切 ReduceOnly。放寬在本輪結束後、只對 round.priced 做。
    beforeAsset:
      marketMode?.state === "ready" || marketMode?.state === "unverified"
        ? (symbol, id, feed) => marketMode!.tighten(symbol, id, feed)
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
  // 審查 L3：本輪有等確認逾時、狀態未知的交易 → 停單與 observeReserve 都不送。
  // 那個 nonce 可能卡在 mempool，後面的交易只會排在它後面一起逾時；也可能已上鏈，
  // 得先人工確認。拒寫清單已含全部資產，funding crank 同樣不送。
  const txUnknown = round.unknown > 0;
  if (txUnknown) {
    console.error(
      `::error::本輪有 ${round.unknown} 筆交易等確認逾時、狀態未知 —— 停單（ReduceOnly）、` +
        `observeReserve 與 funding crank 本輪都不送交易，請先查 explorer`,
    );
  }
  for (const ref of round.refused) {
    if (txUnknown) {
      const note = `${ref.symbol}: 本輪有狀態未知的交易，未送停單（ReduceOnly）；拒寫原因：${ref.reason}`;
      console.error(`::error::${note}`);
      protectionNotes.push(note);
      continue;
    }
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
      signerAddress: wallet?.address ?? null,
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
  // w36：休市切換的放寬階段 —— 只對本輪價格通過所有檢查的資產（round.priced），每個資產
  // 重新取時間（審查 H1）。被熔斷拒寫的資產不在 priced 裡，上面剛切的 ReduceOnly 這一輪
  // 不會被解除；之後價格重新通過、開盤、報價新鮮時才會（guardian 上鎖的除外）。
  if (marketMode?.state === "ready") {
    if (txUnknown) {
      console.log("::warning::本輪有狀態未知的交易，休市切換的放寬階段略過（資產維持 ReduceOnly 較安全）");
    } else {
      failed += await marketMode.loosenPass(round.priced);
    }
  }
  // w36：做不到休市停開倉時必須說出來 —— keeper 休市照常 heartbeat（出場要用），
  // 鏈上 updatedAt 因此一直新鮮，交易所會接受以收盤價開新倉。審查 L5：本輪有狀態未知的
  // 交易時，後面資產的收緊沒送，也要說出來。
  const modeSyms = SYMBOLS.filter((s) => MODE_SYMBOLS === null || MODE_SYMBOLS.has(s));
  const closedNow = closedForTrading(modeSyms, Math.floor(Date.now() / 1000), CLOSE_LEAD_SEC);
  const tightenOk = marketMode?.state === "ready" || marketMode?.state === "unverified";
  const deniedNow = closedNow.filter((s) => marketMode?.deniedTighten.includes(s));
  if (closedNow.length && (!tightenOk || txUnknown || deniedNow.length)) {
    const why = !MARKET_OPERATOR
      ? "KEEPER_MARKET_OPERATOR=0（休市切換已關閉）"
      : !marketMode
        ? "未設交易所位址"
        : marketMode.state === "missing"
          ? "線上交易所沒有 assetMode／setAssetMode（舊合約）"
          : marketMode.state === "not-operator"
            ? "keeper 不是交易所的 marketOperator"
            : txUnknown
              ? "本輪有狀態未知的交易，收緊可能沒有送出"
              : "收緊預檢被拒（keeper 可能沒有 marketOperator 權限）";
    console.log(
      `::warning::休市中（含收盤前 ${CLOSE_LEAD_SEC / 3600}h）但無法確認已切 ReduceOnly（${why}）：` +
        `${(deniedNow.length && tightenOk && !txUnknown ? deniedNow : closedNow).join(", ")}` +
        ` 可能仍可對收盤價開新倉 —— heartbeat 讓鏈上 updatedAt 保持新鮮。見 docs/KNOWN_LIMITATIONS.md §31`,
    );
  }

  // 窄複審 4：報告帶上交易所目前仍在保護中（非 Active）的資產；有就不自動關 issue。
  // 審查 M2：休市造成的 ReduceOnly（開盤後 keeper 會自動放寬）不算保護中。
  const modeView = exchangeView
    ? await classifyProtected({
        symbols: SYMBOLS,
        exchange: {
          assetMode: async (id) => (await exchangeView.assetMode(id)) as bigint,
          guardianLocked: async (id) => (await exchangeView.guardianLocked(id)) as boolean,
        },
        assetIdOf: (s) => ethers.id(s),
        nowSec: Math.floor(Date.now() / 1000),
        leadSec: CLOSE_LEAD_SEC,
        revertInfo,
      })
    : { protected: [] as string[], closed: [] as string[] };
  const protectedAssets = modeView.protected;
  if (modeView.closed.length) console.log(`交易所休市中的資產：${modeView.closed.join(", ")}（開盤後 keeper 自動放寬）`);
  if (protectedAssets.length) {
    console.log(
      `::warning::交易所保護中的資產：${protectedAssets.join(", ")}（熔斷或 guardian 造成；guardian 上鎖或 Halted 需 owner 解除，` +
        `keeper 自己設的 ReduceOnly 在價格重新通過檢查且開盤時自動解除）`,
    );
  }
  writeRefusal(round, protectionNotes, nowSec, exchangeMaxAge, protectedAssets);

  // #99: reuses the same failed-counter/exit(1) mechanism every other genuine
  // problem in this file already goes through, rather than a separate,
  // always-::warning:: path — see observeVaultReserve()'s own docstring.
  if (VAULT_ADDR && txUnknown) {
    console.log("::warning::observeReserve() 本輪略過（有狀態未知的交易，見上）");
  } else if (VAULT_ADDR && !(await observeVaultReserve(provider, signer))) {
    failed += 1;
  }

  // 2026-09-30 事故：來源無效而跳過的資產也計入失敗率（workflow 以 failed/available
  // 對 MAX_FAIL_PCT 判斷）。格式維持 `available=N … failed=N` 讓 workflow 的 grep 相容。
  console.log(`\n${summaryLine({ available, skipped, rejected, confirmed, wrote, failed })}`);

  // 有價格可寫卻一筆都沒成功、全部來源無效、降級比例過高（10/11 資產跳過而 CI
  // 全綠正是 oracle 靜默腐爛 9.5 天的原因）、熔斷拒寫、寫入失敗 —— 任一都讓 job 紅。
  const verdict = runVerdict(
    { total: SYMBOLS.length, available, skipped, rejected, wrote, failed },
    MAX_DEGRADED_RATIO,
  );
  for (const msg of verdict.errors) console.error(`::error::${msg}`);
  writeNextNonce();
  if (verdict.exitCode !== 0) process.exit(verdict.exitCode);
}

/** main() 建立的 signer；結束時（含例外中止）據此寫出下一個 nonce。 */
let activeSigner: LocalNonceSigner | null = null;

/**
 * 審查 M2：把本機追蹤的下一個 nonce 交給 funding crank。只有送過（或被拒收而對齊過）
 * 交易時才有值；null 代表這一輪沒動到 nonce，crank 照舊只問 RPC。
 * 失敗時不遞增的語意由 LocalNonceSigner 保證：寫出的值只算節點接受過的交易。
 */
function writeNextNonce(): void {
  if (!NONCE_PATH) return;
  const next = activeSigner?.nextNonce ?? null;
  if (next === null) return;
  try {
    writeFileSync(NONCE_PATH, `${next}\n`, "utf8");
    console.log(`next nonce ${next} → ${NONCE_PATH}`);
  } catch (e) {
    console.error(`::warning::寫不出 ${NONCE_PATH}：${(e as Error).message}（crank 會退回只問 RPC）`);
  }
}

/**
 * 拒寫清單（給 funding crank）。窄複審 5：runRound 一回傳就寫，不等停單與報告 ——
 * 後面任何一步丟例外都不能讓清單消失（清單不存在時 crank 會失敗）。
 * 「沒判斷到」的資產（skippedSymbols：來源無效、RPC 失敗、寫入停止）也列入：
 * 無法確認它們的價格可信，同樣不該拿來結算 funding。
 */
function writeRefusedList(round: RoundResult): void {
  if (!REFUSED_PATH) return;
  // 審查 L3：有狀態未知的交易 → 全部資產都列入，funding crank 本輪一筆都不送。
  const syms =
    round.unknown > 0
      ? [...SYMBOLS]
      : [...new Set([...round.refused.map((r) => r.symbol), ...round.skippedSymbols])];
  try {
    writeFileSync(REFUSED_PATH, syms.map((s) => `${s}\n`).join(""), "utf8");
  } catch (e) {
    console.error(`::error::寫不出拒寫清單 ${REFUSED_PATH}：${(e as Error).message}`);
  }
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
  signer: ethers.Signer | null,
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
    const receipt = await tx.wait(1, TX_WAIT_TIMEOUT_MS);
    if (!receipt) throw new Error("observeReserve 沒有收據");
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
    const what = isTimeout(e) ? "等確認逾時，狀態未知（請查 explorer）" : "失敗";
    console.error(`::error::observeReserve ${what}：${(e as Error).message.slice(0, 140)}`);
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
  writeNextNonce();
  process.exit(1);
});
