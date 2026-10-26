// 跟單自動同步（ADR-024）的 MCP 工具：唯讀查詢與「產生待簽交易」。
//
//   - copy_sync_status      → 跟隨者每筆跟單的同步狀態：跟到第幾版／最新第幾版、自動同步設定、指定執行者、
//                             油箱餘額與還能代為同步幾次、冷卻到期時間、執行費是否仍在同意範圍內、下一步建議。
//   - prepare_copy_sync_tx  → 產生「未簽名」的交易（to／data／value），交給跟隨者自己的錢包簽：立即同步
//                             （resyncAtVersion，附新版各腿與實際槓桿的預覽）、開關自動同步、指定執行者、存提油箱。
//   - prepare_copy_follow_tx → 由 agent 發起跟單：產生「USDC approve（需要時）＋跟單」兩筆未簽名交易。跟單一律釘住
//                             交易者鏈上最新版（followTraderAtVersion／followTraderAtVersionWithAutoSync），附各腿
//                             預覽、費用、KYC 檢查與 eth_call 模擬；可一併開啟自動同步並預存油箱。
//
// 自託管：這三個工具都**不簽名、不送出**任何交易，也不需要任何私鑰。agent 能做的是「查」與「把要簽的東西準備好、
// 講清楚」；簽不簽由跟隨者在自己的錢包決定。交易的內容也全部受合約約束（*AtVersion 釘住版本、自動同步與立即同步
// 釘住執行費上限，交易者在簽名前又發一版或交易所調高執行費，交易整筆 revert）。
//
// 背景同步（交易者發版後自動調倉）是 agent/copy-sync 執行者的工作，不在這裡。
import { ethers } from "ethers";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonSafe, redactSecrets, symbolOfAssetId } from "@pepelab/shared";

// ── 介面（human-readable ABI；copyTools.test.ts 逐一對照 forge 產物 frontend/src/contracts/abi/*.json）──

export const COPY_TRACKER_TOOL_ABI = [
  "function registry() view returns (address)",
  "function exchange() view returns (address)",
  "function totalSyncGas() view returns (uint256)",
  "function MAX_TIP_WEI() view returns (uint256)",
  "function MIN_SYNC_INTERVAL() view returns (uint32)",
  "function usdc() view returns (address)",
  "function previewCopyAllocation(address trader, uint256 totalMargin) view returns (uint256 copyFee, uint256 totalTradingFee, uint256 marginForPositions, uint256[] portions)",
  "function previewCopyAllocationWithCap(address trader, uint256 totalMargin, uint8 maxLeverage) view returns (uint256 copyFee, uint256 totalTradingFee, uint256 marginForPositions, uint256[] portions)",
  "function followTraderAtVersion(address trader, uint256 totalMargin, uint256 expectedVersion) payable",
  "function followTraderAtVersionWithAutoSync(address trader, uint256 totalMargin, uint256 expectedVersion, uint8 maxLeverage, uint32 minSyncInterval, uint96 tipWei, uint256 maxExecFeePerLeg) payable",
  "function getCopyRecords(address follower) view returns (tuple(address trader, uint256 versionId, uint256 initialAmount, uint256[] positionIds, uint256 copiedAt, bool active, uint256 deployedAmount)[])",
  "function syncConfig(address follower, uint256 recordIdx) view returns (bool autoSync, uint8 maxLeverage, uint32 minSyncInterval, uint96 tipWei)",
  "function getSyncState(address follower, uint256 recordIdx) view returns (tuple(uint64 lastSyncedAt, uint32 syncCount, bool followerClosed, uint256 scoredBasis, int256 scoredRealized))",
  "function syncExecFeeCap(address follower, uint256 recordIdx) view returns (uint256)",
  "function syncExecutor(address follower, uint256 recordIdx) view returns (address)",
  "function syncReadyAt(address follower, uint256 recordIdx) view returns (uint256)",
  "function syncGasBalance(address follower) view returns (uint256)",
  "function pendingSync(address follower, uint256 recordIdx) view returns (bool syncable, uint256 latestVersion, uint256 cost)",
  "function resyncAtVersion(uint256 recordIdx, uint256 expectedVersion, uint256 maxExecFeePerLeg) payable",
  "function setAutoSync(uint256 recordIdx, bool enabled, uint8 maxLeverage, uint32 minSyncInterval, uint96 tipWei, uint256 maxExecFeePerLeg)",
  "function setSyncExecutor(uint256 recordIdx, address executor)",
  "function depositSyncGas() payable",
  "function withdrawSyncGas(uint256 amount)",
] as const;

export const REGISTRY_TOOL_ABI = [
  "function getLatestStrategy(address trader) view returns (tuple(bytes32 asset, uint256 weight, bool isLong, uint256 leverage)[] allocations, uint256 versionId)",
  "function isEligibleTrader(address trader) view returns (bool)",
] as const;

export const EXCHANGE_TOOL_ABI = [
  "function executionFee() view returns (uint256)",
  "function maxLeverageForAsset(bytes32 asset) view returns (uint256)",
  "function MIN_MARGIN() view returns (uint256)",
  "function rwaAsset(bytes32 asset) view returns (bool)",
  "function kyc() view returns (address)",
] as const;

export const KYC_TOOL_ABI = ["function isVerified(address user) view returns (bool)"] as const;

/** CopyTracker 的結算代幣（MockUSDC；介面是標準 ERC-20）。 */
export const ERC20_TOOL_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
] as const;

/** 模擬失敗時解碼原因用：交易所在開倉時冒泡上來的錯誤（名稱與參數，對照 PerpetualExchange.sol）。 */
const EXCHANGE_ERRORS = [
  "error NotKycVerified(address user)",
  "error AssetNotActive(bytes32 asset, uint8 mode)",
  "error AssetHalted(bytes32 asset)",
  "error EnforcedPause()",
  "error StalePrice(bytes32 asset, uint256 updatedAt)",
  "error InvalidPrice(bytes32 asset)",
  "error MarginTooLow()",
  "error InvalidLeverage()",
  "error InsufficientFreeMargin()",
  "error OpenInterestCapExceeded(bytes32 asset, bool isLong, uint256 resultingOI, uint256 cap)",
  "error GracePeriodActive(bytes32 asset, uint256 until)",
  "error CopyTrackerNotSet()",
] as const;

const TRACKER = new ethers.Interface(COPY_TRACKER_TOOL_ABI as unknown as string[]);
const ERC20 = new ethers.Interface(ERC20_TOOL_ABI as unknown as string[]);
const TRACKER_ERRORS = new ethers.Interface([
  "error NoStrategyPublished()",
  "error StrategyVersionMismatch(uint256 expected, uint256 actual)",
  "error TraderNotEligible(address trader)",
  "error TradingFeeExceedsMargin(uint256 fee, uint256 margin)",
  "error InsufficientExecutionFee(uint256 required, uint256 sent)",
  "error ExecutionFeeAboveCap(uint256 fee, uint256 cap)",
  "error InvalidSyncConfig()",
  ...EXCHANGE_ERRORS,
]);

/** CopyTracker 的跟單入口（selector 探測用；舊版 tracker 可能沒有）。 */
export const SIG_FOLLOW_PINNED = "followTraderAtVersion(address,uint256,uint256)";
export const SIG_FOLLOW_AUTOSYNC = "followTraderAtVersionWithAutoSync(address,uint256,uint256,uint8,uint32,uint96,uint256)";
export const SIG_PREVIEW_CAP = "previewCopyAllocationWithCap(address,uint256,uint8)";

/** 預設冷卻：24 小時（與前端 DEFAULT_COOLDOWN 相同；冷卻越短，交易者能讓你付的交易費越多）。 */
export const DEFAULT_COOLDOWN_SEC = 24 * 3600;
/** 合約下限（CopyTracker.MIN_SYNC_INTERVAL）。 */
export const MIN_COOLDOWN_SEC = 3600;
/** 跟單時預設預存的油箱：夠讓別人代為同步這麼多次（與前端 DEFAULT_PREFUND_SYNCS 相同）。 */
export const DEFAULT_PREFUND_SYNCS = 5n;
/** 績效費（PerpetualExchange.PERFORMANCE_FEE_BPS）：同步時獲利的腿先結算。 */
const PERFORMANCE_FEE_PCT = 10;

// ── 讀鏈 ─────────────────────────────────────────────────────────────────────

export interface RecordView {
  trader: string;
  versionId: bigint;
  positionIds: bigint[];
  copiedAt: bigint;
  active: boolean;
  deployedAmount: bigint;
}

export interface Alloc {
  asset: string;
  weight: bigint;
  isLong: boolean;
  leverage: bigint;
}

/** 工具用到的鏈上讀取（測試以假物件替換）。 */
export interface CopyReads {
  chainId: number;
  tracker: string;
  /** tracker 是不是自動同步版（讀得到 totalSyncGas）。 */
  supported(): Promise<boolean>;
  /** tracker 有沒有 syncExecutor（指定執行者）。 */
  hasExecutor(): Promise<boolean>;
  records(follower: string): Promise<RecordView[]>;
  syncConfig(follower: string, idx: number): Promise<{ autoSync: boolean; maxLeverage: number; minSyncInterval: number; tipWei: bigint }>;
  syncState(follower: string, idx: number): Promise<{ lastSyncedAt: number; syncCount: number; followerClosed: boolean }>;
  syncExecFeeCap(follower: string, idx: number): Promise<bigint>;
  syncExecutor(follower: string, idx: number): Promise<string | null>;
  syncReadyAt(follower: string, idx: number): Promise<number>;
  syncGasBalance(follower: string): Promise<bigint>;
  pendingSync(follower: string, idx: number): Promise<{ syncable: boolean; latestVersion: bigint; cost: bigint }>;
  latestStrategy(trader: string): Promise<{ allocations: Alloc[]; versionId: bigint } | null>;
  executionFee(): Promise<bigint>;
  maxLeverageForAsset(asset: string): Promise<bigint | null>;
  maxTipWei(): Promise<bigint>;
  /** 最新區塊時間（秒）。冷卻用鏈上時間判斷。 */
  now(): Promise<number>;
  // ── 跟單（prepare_copy_follow_tx）──
  /** tracker 的 runtime bytecode 裡有沒有這個函式的 selector（舊版 tracker 沒有某些入口）。 */
  hasFunction(signature: string): Promise<boolean>;
  traderEligible(trader: string): Promise<boolean>;
  /** previewCopyAllocation（cap = null）或 previewCopyAllocationWithCap。 */
  previewFollow(trader: string, totalMargin: bigint, cap: number | null): Promise<FollowPreview>;
  /** PerpetualExchange.MIN_MARGIN：每一條腿的最低保證金。 */
  minMargin(): Promise<bigint>;
  /** tracker 的結算代幣與跟隨者的餘額、對 tracker 的授權額度。 */
  usdc(follower: string): Promise<{ token: string; decimals: number; balance: bigint; allowance: bigint }>;
  /** 各資產是不是 RWA（需要 KYC）與跟隨者是否通過 KYC；讀不到為 null。 */
  kycGate(follower: string, assets: string[]): Promise<{ rwa: Record<string, boolean | null>; verified: boolean | null }>;
  /** eth_call 模擬（不簽名、不廣播）；revert 時回傳解碼後的原因。 */
  simulate(tx: { from: string; to: string; data: string; value: bigint }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface FollowPreview {
  copyFee: bigint;
  totalTradingFee: bigint;
  marginForPositions: bigint;
  portions: bigint[];
}

/** revert 資料 → 「錯誤名稱(參數)」；解不開就回 null。 */
export function decodeRevert(data: string | null | undefined): string | null {
  if (!data || data === "0x") return null;
  try {
    const e = TRACKER_ERRORS.parseError(data);
    if (!e) return null;
    // Error(string)（require 訊息）直接回傳訊息本身
    if (e.signature === "Error(string)") return String(e.args[0]);
    return `${e.name}(${e.args.map((x) => String(x)).join(", ")})`;
  } catch {
    return null; // 不是已知的錯誤
  }
}

export function makeCopyReads(
  provider: ethers.Provider,
  opts: { chainId: number; tracker: string; exchange: string },
): CopyReads {
  const t = new ethers.Contract(opts.tracker, COPY_TRACKER_TOOL_ABI as unknown as string[], provider);
  const x = new ethers.Contract(opts.exchange, EXCHANGE_TOOL_ABI as unknown as string[], provider);
  let registry: Promise<ethers.Contract> | null = null;
  const reg = () =>
    (registry ??= (t.registry() as Promise<string>).then(
      (a) => new ethers.Contract(a, REGISTRY_TOOL_ABI as unknown as string[], provider),
    ));
  let code: Promise<string> | null = null;
  const trackerCode = () => (code ??= provider.getCode(opts.tracker).then((c) => c.toLowerCase()));
  const probe = async (f: () => Promise<unknown>) => {
    try {
      await f();
      return true;
    } catch {
      return false;
    }
  };
  return {
    chainId: opts.chainId,
    tracker: opts.tracker,
    supported: () => probe(() => t.totalSyncGas()),
    hasExecutor: () => probe(() => t.syncExecutor(ethers.ZeroAddress, 0)),
    async records(f) {
      const recs = (await t.getCopyRecords(f)) as ethers.Result[];
      return recs.map((r) => ({
        trader: String(r[0]),
        versionId: r[1] as bigint,
        positionIds: [...(r[3] as bigint[])],
        copiedAt: r[4] as bigint,
        active: Boolean(r[5]),
        deployedAmount: r[6] as bigint,
      }));
    },
    async syncConfig(f, i) {
      const r = (await t.syncConfig(f, i)) as ethers.Result;
      return { autoSync: Boolean(r[0]), maxLeverage: Number(r[1]), minSyncInterval: Number(r[2]), tipWei: r[3] as bigint };
    },
    async syncState(f, i) {
      const r = (await t.getSyncState(f, i)) as ethers.Result;
      return { lastSyncedAt: Number(r[0]), syncCount: Number(r[1]), followerClosed: Boolean(r[2]) };
    },
    syncExecFeeCap: async (f, i) => (await t.syncExecFeeCap(f, i)) as bigint,
    async syncExecutor(f, i) {
      const a = String(await t.syncExecutor(f, i));
      return a === ethers.ZeroAddress ? null : ethers.getAddress(a);
    },
    syncReadyAt: async (f, i) => Number(await t.syncReadyAt(f, i)),
    syncGasBalance: async (f) => (await t.syncGasBalance(f)) as bigint,
    async pendingSync(f, i) {
      const r = (await t.pendingSync(f, i)) as ethers.Result;
      return { syncable: Boolean(r[0]), latestVersion: r[1] as bigint, cost: r[2] as bigint };
    },
    async latestStrategy(trader) {
      try {
        const [allocs, v] = (await (await reg()).getLatestStrategy(trader)) as [ethers.Result[], bigint];
        return {
          versionId: v,
          allocations: allocs.map((a) => ({
            asset: String(a[0]),
            weight: a[1] as bigint,
            isLong: Boolean(a[2]),
            leverage: a[3] as bigint,
          })),
        };
      } catch {
        return null; // 交易者沒有任何策略時 registry 會 revert
      }
    },
    executionFee: async () => (await x.executionFee()) as bigint,
    async maxLeverageForAsset(asset) {
      try {
        return (await x.maxLeverageForAsset(asset)) as bigint;
      } catch {
        return null;
      }
    },
    maxTipWei: async () => (await t.MAX_TIP_WEI()) as bigint,
    async now() {
      const b = await provider.getBlock("latest");
      if (!b) throw new Error("讀不到最新區塊");
      return Number(b.timestamp);
    },
    async hasFunction(signature) {
      // 與前端 contractProbe 相同：找 dispatcher 裡的 PUSH4 selector。讀不到 bytecode 一律當成沒有。
      try {
        return (await trackerCode()).includes(ethers.id(signature).slice(2, 10));
      } catch {
        return false;
      }
    },
    traderEligible: async (trader) => Boolean(await (await reg()).isEligibleTrader(trader)),
    async previewFollow(trader, totalMargin, cap) {
      const r = (cap === null
        ? await t.previewCopyAllocation(trader, totalMargin)
        : await t.previewCopyAllocationWithCap(trader, totalMargin, cap)) as ethers.Result;
      return { copyFee: r[0] as bigint, totalTradingFee: r[1] as bigint, marginForPositions: r[2] as bigint, portions: [...(r[3] as bigint[])] };
    },
    minMargin: async () => (await x.MIN_MARGIN()) as bigint,
    async usdc(follower) {
      const token = String(await t.usdc());
      const c = new ethers.Contract(token, ERC20_TOOL_ABI as unknown as string[], provider);
      const [decimals, balance, allowance] = await Promise.all([
        (c.decimals() as Promise<bigint>).then(Number).catch(() => 18),
        c.balanceOf(follower) as Promise<bigint>,
        c.allowance(follower, opts.tracker) as Promise<bigint>,
      ]);
      return { token: ethers.getAddress(token), decimals, balance, allowance };
    },
    async kycGate(follower, assets) {
      const rwa: Record<string, boolean | null> = {};
      await Promise.all(
        assets.map(async (a) => {
          rwa[a] = await (x.rwaAsset(a) as Promise<boolean>).then(Boolean).catch(() => null);
        }),
      );
      let verified: boolean | null = null;
      try {
        const k = String(await x.kyc());
        verified = k === ethers.ZeroAddress
          ? true // 交易所沒有接 KYC 登錄：RWA 也不檢查
          : Boolean(await new ethers.Contract(k, KYC_TOOL_ABI as unknown as string[], provider).isVerified(follower));
      } catch {
        verified = null;
      }
      return { rwa, verified };
    },
    async simulate(tx) {
      try {
        await provider.call({ from: tx.from, to: tx.to, data: tx.data, value: tx.value });
        return { ok: true };
      } catch (e) {
        const err = e as { data?: string; info?: { error?: { data?: string } }; shortMessage?: string; message?: string };
        const data = typeof err.data === "string" ? err.data : err.info?.error?.data;
        return { ok: false, reason: decodeRevert(data) ?? redactSecrets(err.shortMessage ?? err.message ?? String(e)).slice(0, 200) };
      }
    },
  };
}

// ── 純函式 ───────────────────────────────────────────────────────────────────

/** 畫面與通知的版本號從 1 起算（與前端「第 N 版」一致）；合約的 versionId 從 0 起算。 */
export const versionLabel = (v: bigint | number) => `v${Number(v) + 1}`;

/** 同步時每條腿實際用的槓桿：策略、交易所該資產上限、跟隨者上限（0 = 不另設）三者取小（與合約 _legLeverages 相同）。 */
export function effectiveLeverage(strategy: bigint, assetMax: bigint | null, followerMax: number): bigint {
  let lev = strategy;
  if (assetMax !== null && assetMax > 0n && lev > assetMax) lev = assetMax;
  if (followerMax > 0 && lev > BigInt(followerMax)) lev = BigInt(followerMax);
  return lev;
}

const eth = (wei: bigint) => ethers.formatEther(wei);
const iso = (sec: number) => new Date(sec * 1000).toISOString();

function assertAddress(a: string, what: string): string {
  if (!ethers.isAddress(a)) throw new Error(`${what} 不是合法地址：${a}`);
  return ethers.getAddress(a);
}

// ── copy_sync_status ────────────────────────────────────────────────────────

export async function copySyncStatus(r: CopyReads, followerRaw: string, recordIdx?: number) {
  const follower = assertAddress(followerRaw, "follower");
  if (!(await r.supported())) {
    return {
      supported: false,
      tracker: r.tracker,
      message:
        "這條鏈上的 CopyTracker 還不是自動同步版（ADR-024），跟單仍是快照式：交易者發新版後要取消跟單再重跟。" +
        "部署步驟見 docs/OWNER_ACTIONS.md 第 8 步。",
    };
  }
  const [recs, gas, fee, now, hasExecutor] = await Promise.all([
    r.records(follower),
    r.syncGasBalance(follower),
    r.executionFee(),
    r.now(),
    r.hasExecutor(),
  ]);
  const indices = recordIdx === undefined ? recs.map((_, i) => i) : [recordIdx];
  const out = [];
  for (const i of indices) {
    const rec = recs[i];
    if (!rec) throw new Error(`follower ${follower} 沒有第 ${i} 筆跟單`);
    if (!rec.active) {
      if (recordIdx !== undefined) out.push({ recordIdx: i, trader: rec.trader, active: false });
      continue;
    }
    const [cfg, st, cap, executor, readyAt, pending, latest] = await Promise.all([
      r.syncConfig(follower, i),
      r.syncState(follower, i),
      r.syncExecFeeCap(follower, i),
      hasExecutor ? r.syncExecutor(follower, i) : Promise.resolve(null),
      r.syncReadyAt(follower, i),
      r.pendingSync(follower, i),
      r.latestStrategy(rec.trader),
    ]);
    const latestVersion = latest?.versionId ?? null;
    const behind = latestVersion !== null && latestVersion > rec.versionId;
    const legs = latest?.allocations.length ?? rec.positionIds.length;
    const thirdPartyCost = fee * BigInt(legs) + cfg.tipWei;
    const selfCost = fee * BigInt(legs);
    const feeOk = fee <= cap;
    let nextStep: string;
    if (!behind) nextStep = "已是交易者最新版，不需要動作。";
    else if (!cfg.autoSync) {
      nextStep = "有新版，自動同步未開啟：先用 prepare_copy_sync_tx（action=resync）預覽新版各腿與實際槓桿，確認後由本人錢包簽名同步。";
    } else if (!feeOk) {
      nextStep = "交易所調高了執行費，超過跟隨者同意的費率：別人暫時不能代為同步。本人重新簽 setAutoSync（action=enable）同意新費率，或自己同步。";
    } else if (now < readyAt) {
      nextStep = `有新版，冷卻中：${iso(readyAt)} 之後${executor ? `由指定的執行者 ${executor}` : "任何執行者"}可以代為同步；本人隨時可以自己同步。`;
    } else if (gas < thirdPartyCost) {
      nextStep = `有新版，但油箱不夠付一次代為同步（需要 ${eth(thirdPartyCost)} ETH）：存入油箱（action=deposit），或本人自己同步。`;
    } else {
      nextStep = executor
        ? `有新版，條件都滿足：等指定的執行者 ${executor} 送出同步（其他人會被合約拒絕）。`
        : "有新版，條件都滿足：等任何執行者送出同步（交易所端的 KYC、休市、OI 上限要靠模擬才知道）。";
    }
    out.push({
      recordIdx: i,
      trader: rec.trader,
      active: true,
      version: {
        current: versionLabel(rec.versionId),
        currentVersionId: rec.versionId,
        latest: latestVersion === null ? null : versionLabel(latestVersion),
        latestVersionId: latestVersion,
        behind,
      },
      autoSync: {
        enabled: cfg.autoSync,
        maxLeverage: cfg.maxLeverage === 0 ? null : cfg.maxLeverage,
        cooldownHours: cfg.minSyncInterval / 3600,
        tipEth: eth(cfg.tipWei),
        // null = 任何人（開啟時）；有值 = 只有這個地址（與本人）能代為同步
        designatedExecutor: executor,
        consentedExecFeePerLegEth: cfg.autoSync ? eth(cap) : null,
        executionFeeWithinConsent: cfg.autoSync ? feeOk : null,
      },
      cooldown: {
        readyAt: iso(readyAt),
        cooling: now < readyAt,
      },
      syncState: {
        syncCount: st.syncCount,
        lastSyncedAt: st.lastSyncedAt === 0 ? null : iso(st.lastSyncedAt),
        followerClosedALeg: st.followerClosed,
      },
      cost: {
        perThirdPartySyncEth: eth(thirdPartyCost),
        perSelfSyncEth: eth(selfCost),
        thirdPartySyncsAffordable: thirdPartyCost > 0n ? (gas / thirdPartyCost).toString() : null,
      },
      // 合約 pendingSync：只看 tracker 與 registry 的條件；不看指定執行者，也不含交易所端的 KYC／市場模式
      pendingSyncByThirdParty: pending.syncable,
      nextStep,
    });
  }
  return {
    supported: true,
    chainId: r.chainId,
    tracker: r.tracker,
    follower,
    syncGasBalanceEth: eth(gas),
    executionFeePerLegEth: eth(fee),
    chainTime: iso(now),
    records: out,
  };
}

// ── prepare_copy_sync_tx ────────────────────────────────────────────────────

export const PREPARE_ACTIONS = ["resync", "enable", "disable", "set-executor", "deposit", "withdraw"] as const;
export type PrepareAction = (typeof PREPARE_ACTIONS)[number];

export interface PrepareArgs {
  follower: string;
  action: PrepareAction;
  recordIdx?: number;
  /** enable：槓桿上限 1..5（必填，不替跟隨者決定）。 */
  maxLeverage?: number;
  /** enable：冷卻小時數（預設 24；合約下限 1）。 */
  cooldownHours?: number;
  /** enable：每次代為同步的小費（ETH，預設 0）。 */
  tipEth?: string;
  /** set-executor：指定的執行者地址；省略或零位址 = 解除指定（回到任何人）。 */
  executor?: string;
  /** deposit／withdraw：金額（ETH）。 */
  amountEth?: string;
}

export interface UnsignedTx {
  chainId: number;
  from: string;
  to: string;
  data: string;
  value: string;
  valueEth: string;
  summary: string;
  warnings: string[];
  preview?: unknown;
  note: string;
}

const UNSIGNED_NOTE =
  "未簽名、未送出：請用跟隨者自己的錢包（MetaMask、硬體錢包或 cast send --account）檢查內容後簽名。agent 與平台都不持有你的私鑰。";

function parseEth(s: string | undefined, what: string): bigint {
  if (s === undefined || !/^\d+(\.\d{1,18})?$/.test(s.trim())) throw new Error(`${what} 必須是 ETH 金額字串，例如 "0.01"`);
  return ethers.parseEther(s.trim());
}

async function activeRecord(r: CopyReads, follower: string, idx: number | undefined): Promise<RecordView> {
  if (idx === undefined || !Number.isInteger(idx) || idx < 0) throw new Error("recordIdx 必填（非負整數）");
  const rec = (await r.records(follower))[idx];
  if (!rec) throw new Error(`follower ${follower} 沒有第 ${idx} 筆跟單`);
  if (!rec.active) throw new Error(`第 ${idx} 筆跟單已結束`);
  return rec;
}

export async function prepareCopyTx(r: CopyReads, a: PrepareArgs): Promise<UnsignedTx> {
  const follower = assertAddress(a.follower, "follower");
  if (!(await r.supported())) throw new Error("這條鏈上的 CopyTracker 還不是自動同步版（ADR-024），沒有這些函式");
  const base = { chainId: r.chainId, from: follower, to: r.tracker, note: UNSIGNED_NOTE };
  const tx = (data: string, value: bigint, summary: string, warnings: string[] = [], preview?: unknown): UnsignedTx => ({
    ...base,
    data,
    value: value.toString(),
    valueEth: eth(value),
    summary,
    warnings,
    ...(preview === undefined ? {} : { preview }),
  });

  switch (a.action) {
    case "resync": {
      const rec = await activeRecord(r, follower, a.recordIdx);
      const latest = await r.latestStrategy(rec.trader);
      if (!latest) throw new Error("交易者沒有任何策略");
      if (latest.versionId <= rec.versionId) throw new Error(`已是交易者最新版（${versionLabel(rec.versionId)}），沒有東西可同步`);
      const [cfg, fee, gas] = await Promise.all([r.syncConfig(follower, a.recordIdx!), r.executionFee(), r.syncGasBalance(follower)]);
      const legs = await Promise.all(
        latest.allocations.map(async (al) => {
          const assetMax = await r.maxLeverageForAsset(al.asset);
          return {
            asset: symbolOfAssetId(al.asset) ?? al.asset,
            direction: al.isLong ? "long" : "short",
            weightPct: Number(al.weight) / 100,
            strategyLeverage: Number(al.leverage),
            leverageUsed: Number(effectiveLeverage(al.leverage, assetMax, cfg.maxLeverage)),
          };
        }),
      );
      const need = fee * BigInt(latest.allocations.length);
      const topUp = need > gas ? need - gas : 0n;
      const warnings = [
        `同步會先平掉這筆跟單的全部部位（獲利的腿先結算 ${PERFORMANCE_FEE_PCT}% 績效費給交易者），再用釋出的保證金依新版開倉，` +
          "平倉與開倉各付一次交易費；任何一腿開不起來（RWA 未 KYC、休市、OI 上限）整筆取消、部位維持原狀。",
        `釘住 ${versionLabel(latest.versionId)} 與每腿執行費 ${eth(fee)} ETH：交易者在你簽名前又發一版、或交易所調高執行費，這筆交易會整筆 revert。`,
      ];
      if (cfg.maxLeverage === 0) {
        warnings.push("這筆跟單沒有設定槓桿上限：會照新版的槓桿開倉（交易所的資產上限仍適用）。想設上限，先送 action=disable 或 enable 帶 maxLeverage。");
      }
      if (topUp > 0n) warnings.push(`油箱不夠付這次的執行費：這筆交易會附上 ${eth(topUp)} ETH，先存進油箱再扣。`);
      return tx(
        TRACKER.encodeFunctionData("resyncAtVersion", [a.recordIdx!, latest.versionId, fee]),
        topUp,
        `把第 ${a.recordIdx} 筆跟單從 ${versionLabel(rec.versionId)} 同步到交易者最新的 ${versionLabel(latest.versionId)}（本人同步：不付小費、不受冷卻）`,
        warnings,
        { from: versionLabel(rec.versionId), to: versionLabel(latest.versionId), executionFeeEth: eth(need), legs },
      );
    }
    case "enable": {
      await activeRecord(r, follower, a.recordIdx);
      const lev = a.maxLeverage;
      if (lev === undefined || !Number.isInteger(lev) || lev < 1 || lev > 5) {
        throw new Error("maxLeverage 必填（1–5 的整數）：同步時槓桿的上限由跟隨者自己決定，不替你預設");
      }
      const hours = a.cooldownHours ?? DEFAULT_COOLDOWN_SEC / 3600;
      const interval = Math.round(hours * 3600);
      if (!Number.isFinite(hours) || interval < MIN_COOLDOWN_SEC || interval > 0xffffffff) throw new Error("cooldownHours 至少 1（合約下限）");
      const tip = a.tipEth === undefined ? 0n : parseEth(a.tipEth, "tipEth");
      const maxTip = await r.maxTipWei();
      if (tip > maxTip) throw new Error(`tipEth 超過合約上限 ${eth(maxTip)} ETH`);
      const fee = await r.executionFee();
      const warnings = [
        `開啟後，任何人（或你指定的執行者）都能在交易者發布新版時，把部位調成鏈上最新版：每次都全平再開、各付一次交易費，` +
          `獲利的腿先結算 ${PERFORMANCE_FEE_PCT}% 績效費。冷卻越短，交易者能讓你付的交易費越多。`,
        `同意的每腿執行費上限 = 目前的 ${eth(fee)} ETH：交易所之後調高費率，別人就不能代為同步，直到你重新同意。`,
      ];
      if (interval < DEFAULT_COOLDOWN_SEC) warnings.push(`冷卻 ${hours} 小時短於預設的 24 小時。`);
      return tx(
        TRACKER.encodeFunctionData("setAutoSync", [a.recordIdx!, true, lev, interval, tip, fee]),
        0n,
        `開啟第 ${a.recordIdx} 筆跟單的自動同步：槓桿上限 ${lev}×、冷卻 ${hours} 小時、小費 ${eth(tip)} ETH`,
        warnings,
      );
    }
    case "disable": {
      await activeRecord(r, follower, a.recordIdx);
      const cfg = await r.syncConfig(follower, a.recordIdx!);
      const maxTip = await r.maxTipWei();
      const tip = cfg.tipWei > maxTip ? maxTip : cfg.tipWei;
      // 關閉時保留槓桿上限：本人手動同步仍套用它（關閉永遠不看執行費，帶 0）
      return tx(
        TRACKER.encodeFunctionData("setAutoSync", [a.recordIdx!, false, cfg.maxLeverage, cfg.minSyncInterval, tip, 0n]),
        0n,
        `關閉第 ${a.recordIdx} 筆跟單的自動同步（保留槓桿上限${cfg.maxLeverage ? ` ${cfg.maxLeverage}×` : "：未設定"}，本人手動同步時套用）`,
      );
    }
    case "set-executor": {
      await activeRecord(r, follower, a.recordIdx);
      if (!(await r.hasExecutor())) throw new Error("這個 CopyTracker 版本沒有 setSyncExecutor（指定執行者）");
      const ex = a.executor && a.executor !== ethers.ZeroAddress ? assertAddress(a.executor, "executor") : ethers.ZeroAddress;
      const warnings: string[] = [];
      if (ex === follower) warnings.push("執行者設成你自己：等於只有你本人能同步（自動同步實際上不會由別人執行）。");
      if (ex !== ethers.ZeroAddress) {
        warnings.push("指定之後，除了你本人，只有這個地址能代為同步；自動同步仍要開著，冷卻、小費、執行費上限照舊。這把執行者金鑰外洩，最壞只是觸發合約本來就允許的同步。");
      }
      return tx(
        TRACKER.encodeFunctionData("setSyncExecutor", [a.recordIdx!, ex]),
        0n,
        ex === ethers.ZeroAddress
          ? `解除第 ${a.recordIdx} 筆跟單的指定執行者（開著自動同步時，回到任何人都能代為同步）`
          : `第 ${a.recordIdx} 筆跟單只讓 ${ex}（與本人）代為同步`,
        warnings,
      );
    }
    case "deposit": {
      const v = parseEth(a.amountEth, "amountEth");
      if (v === 0n) throw new Error("amountEth 必須大於 0");
      return tx(TRACKER.encodeFunctionData("depositSyncGas", []), v, `存 ${eth(v)} ETH 進自動同步油箱（記在你名下，隨時可以提領）`);
    }
    case "withdraw": {
      const v = parseEth(a.amountEth, "amountEth");
      const bal = await r.syncGasBalance(follower);
      if (v === 0n || v > bal) throw new Error(`amountEth 必須在 0 與油箱餘額 ${eth(bal)} ETH 之間`);
      return tx(TRACKER.encodeFunctionData("withdrawSyncGas", [v]), 0n, `從自動同步油箱提領 ${eth(v)} ETH 到你的錢包`);
    }
    default:
      throw new Error(`未知的 action：${String(a.action)}`);
  }
}

// ── prepare_copy_follow_tx ──────────────────────────────────────────────────

export interface FollowArgs {
  /** 跟隨者地址（交易的簽名者）。 */
  follower: string;
  trader: string;
  /** 投入金額（結算代幣，十進位字串，例如 "1000"）。 */
  amountUsdc: string;
  /** 是否一併開啟自動同步（跟隨者的明確同意，不替他預設）。 */
  autoSync: boolean;
  /** autoSync：槓桿上限 1..5（必填），也套用在這次開倉。 */
  maxLeverage?: number;
  /** autoSync：冷卻小時數（預設 24；合約下限 1）。 */
  cooldownHours?: number;
  /** autoSync：每次代為同步的小費（ETH，預設 0）。 */
  tipEth?: string;
  /** autoSync：預存進油箱的 ETH；省略＝夠別人代為同步 5 次。 */
  prefundEth?: string;
}

export interface FollowPlan {
  chainId: number;
  from: string;
  /** 依序簽名送出；approve 已足夠時只有跟單這一筆。 */
  steps: UnsignedTx[];
  preview: unknown;
  /** 跟單這筆交易的 eth_call 模擬結果；還沒 approve 時無法模擬（null）。 */
  simulation: { ok: true } | { ok: false; reason: string } | null;
  warnings: string[];
  nextSteps: string[];
  note: string;
}

function parseUnitsStr(s: string | undefined, decimals: number, what: string): bigint {
  const v = (s ?? "").trim();
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(v)) throw new Error(`${what} 必須是金額字串，例如 "1000"`);
  return ethers.parseUnits(v, decimals);
}

export async function prepareCopyFollow(r: CopyReads, a: FollowArgs): Promise<FollowPlan> {
  const follower = assertAddress(a.follower, "follower");
  const trader = assertAddress(a.trader, "trader");
  if (follower === trader) throw new Error("不能跟單自己");
  if (typeof a.autoSync !== "boolean") throw new Error("autoSync 必填（true／false）：是否開啟自動同步由跟隨者決定，不替你預設");

  const latest = await r.latestStrategy(trader);
  if (!latest || latest.allocations.length === 0) throw new Error("交易者還沒有發布任何策略，沒有東西可跟");
  if (!(await r.traderEligible(trader))) {
    throw new Error("交易者目前不符資格（質押不足或正在申請取回質押）：合約不接受新的跟單（TraderNotEligible）");
  }

  // 入口：一律釘住交易者鏈上最新版（M10）。舊版 tracker 沒有釘版本入口時拒絕，不退回不釘版本的 followTrader。
  let cap: number | null = null;
  let interval = 0;
  let tip = 0n;
  if (a.autoSync) {
    if (!(await r.supported()) || !(await r.hasFunction(SIG_FOLLOW_AUTOSYNC))) {
      throw new Error("這條鏈上的 CopyTracker 沒有一筆完成「跟單＋自動同步」的入口（ADR-024 之前的版本）：改用 autoSync=false 跟單");
    }
    const lev = a.maxLeverage;
    if (lev === undefined || !Number.isInteger(lev) || lev < 1 || lev > 5) {
      throw new Error("開啟自動同步時 maxLeverage 必填（1–5 的整數）：槓桿上限由跟隨者自己決定，也套用在這次開倉");
    }
    cap = lev;
    const hours = a.cooldownHours ?? DEFAULT_COOLDOWN_SEC / 3600;
    interval = Math.round(hours * 3600);
    if (!Number.isFinite(hours) || interval < MIN_COOLDOWN_SEC || interval > 0xffffffff) throw new Error("cooldownHours 至少 1（合約下限）");
    tip = a.tipEth === undefined ? 0n : parseEth(a.tipEth, "tipEth");
    const maxTip = await r.maxTipWei();
    if (tip > maxTip) throw new Error(`tipEth 超過合約上限 ${eth(maxTip)} ETH`);
  } else if (!(await r.hasFunction(SIG_FOLLOW_PINNED))) {
    throw new Error("這條鏈上的 CopyTracker 沒有釘版本的跟單入口（followTraderAtVersion）：請改用網頁 /copy 跟單");
  }

  const [token, fee, minMargin, recs] = await Promise.all([r.usdc(follower), r.executionFee(), r.minMargin(), r.records(follower)]);
  const amount = parseUnitsStr(a.amountUsdc, token.decimals, "amountUsdc");
  if (amount === 0n) throw new Error("amountUsdc 必須大於 0");
  const fmt = (v: bigint) => ethers.formatUnits(v, token.decimals);

  // 預覽：與合約開倉同一套算法（勾了自動同步時套用跟隨者的槓桿上限）。
  const pv = await r.previewFollow(trader, amount, cap !== null && (await r.hasFunction(SIG_PREVIEW_CAP)) ? cap : null);
  if (pv.marginForPositions === 0n) throw new Error(`金額太小：手續費緩衝 ${fmt(pv.totalTradingFee)} 已經吃掉全部淨保證金`);
  const smallest = pv.portions.reduce((m, p) => (p < m ? p : m), pv.portions[0] ?? 0n);
  if (smallest < minMargin) {
    // 份額與投入金額大致成正比：等比放大到最小那一腿達到 MIN_MARGIN，再取整數。
    const need = smallest === 0n ? null : (amount * minMargin + smallest - 1n) / smallest;
    const unit = 10n ** BigInt(token.decimals);
    throw new Error(
      `金額太小：拆到各腿後最小一腿只有 ${fmt(smallest)}，低於交易所每腿最低保證金 ${fmt(minMargin)}，合約會整筆 revert` +
        (need === null ? "" : `；至少要投入約 ${fmt(((need + unit - 1n) / unit) * unit)}`),
    );
  }

  const legs = await Promise.all(
    latest.allocations.map(async (al, i) => {
      const assetMax = await r.maxLeverageForAsset(al.asset);
      return {
        asset: symbolOfAssetId(al.asset) ?? al.asset,
        direction: al.isLong ? "long" : "short",
        weightPct: Number(al.weight) / 100,
        strategyLeverage: Number(al.leverage),
        leverageUsed: Number(effectiveLeverage(al.leverage, assetMax, cap ?? 0)),
        margin: fmt(pv.portions[i] ?? 0n),
      };
    }),
  );
  const openFee = fee * BigInt(latest.allocations.length);
  const syncCost = fee * BigInt(latest.allocations.length) + tip;
  const prefund = !a.autoSync ? 0n : a.prefundEth === undefined ? syncCost * DEFAULT_PREFUND_SYNCS : parseEth(a.prefundEth, "prefundEth");
  const value = openFee + prefund;

  const warnings: string[] = [
    `跟單費 ${fmt(pv.copyFee)}（0.3%）先付給交易者與平台；交易手續費緩衝 ${fmt(pv.totalTradingFee)}，實際投入保證金 ${fmt(pv.marginForPositions)}，` +
      `依權重開 ${latest.allocations.length} 檔部位；開倉執行費每檔 ${eth(fee)} ETH，共 ${eth(openFee)} ETH。獲利的部位平倉時付交易者 ${PERFORMANCE_FEE_PCT}% 績效費。`,
    `釘住交易者鏈上最新的 ${versionLabel(latest.versionId)}：交易者在你簽名前又發一版，這筆跟單整筆 revert（StrategyVersionMismatch），不會跟到你沒看過的版本。`,
  ];
  if (a.autoSync) {
    warnings.push(
      "開啟自動同步後，任何人（或你之後指定的執行者）都能在交易者發布新版時，把部位調成鏈上最新版；他們不能選資產、方向或槓桿" +
        `（槓桿＝策略、交易所上限、你的上限 ${cap}× 三者取小）。每次同步全平再開、各付一次交易費；冷卻越短，交易者能讓你付的交易費越多。` +
        "你可以隨時關閉自動同步、隨時提領油箱。",
      `同意的每腿執行費上限＝目前的 ${eth(fee)} ETH（簽進交易）：交易所在你簽名前調高費率，這筆跟單整筆 revert（ExecutionFeeAboveCap），` +
        "油箱的 ETH 不會被當成開倉執行費收走；之後調高，別人就不能代為同步，直到你重新同意。",
    );
    if (prefund === 0n) warnings.push("油箱預存 0：在你存入之前，別人無法代為同步（油箱不足）。");
    if (interval < DEFAULT_COOLDOWN_SEC) warnings.push(`冷卻 ${interval / 3600} 小時短於預設的 24 小時。`);
  } else {
    warnings.push("沒有開啟自動同步：交易者發新版後部位不會自動調整，要本人（或你的 agent 準備好交易、你簽名）手動同步。");
  }
  if (token.balance < amount) warnings.push(`錢包裡的 ${fmt(token.balance)} 不夠投入 ${fmt(amount)}：先補足，否則跟單會 revert。`);
  const gate = await r.kycGate(follower, latest.allocations.map((al) => al.asset));
  const rwaLegs = latest.allocations.filter((al) => gate.rwa[al.asset] === true).map((al) => symbolOfAssetId(al.asset) ?? al.asset);
  if (rwaLegs.length > 0 && gate.verified === false) {
    warnings.push(`這一版含需要 KYC 的 RWA 資產（${rwaLegs.join("、")}），你尚未通過 KYC：跟單會整筆 revert（NotKycVerified）。先完成 KYC 再送。`);
  } else if (rwaLegs.length > 0 && gate.verified === null) {
    warnings.push(`這一版含需要 KYC 的 RWA 資產（${rwaLegs.join("、")}），讀不到你的 KYC 狀態：未通過時跟單會整筆 revert。`);
  }

  const followData = a.autoSync
    ? TRACKER.encodeFunctionData("followTraderAtVersionWithAutoSync", [trader, amount, latest.versionId, cap, interval, tip, fee])
    : TRACKER.encodeFunctionData("followTraderAtVersion", [trader, amount, latest.versionId]);
  const base = { chainId: r.chainId, from: follower, note: UNSIGNED_NOTE };
  const steps: UnsignedTx[] = [];
  const needApprove = token.allowance < amount;
  if (needApprove) {
    steps.push({
      ...base,
      to: token.token,
      data: ERC20.encodeFunctionData("approve", [r.tracker, amount]),
      value: "0",
      valueEth: "0.0",
      summary: `第 1 步：允許 CopyTracker ${r.tracker} 從你的錢包取用剛好 ${fmt(amount)}（不是無上限授權）`,
      warnings: token.allowance > 0n ? [`目前已授權 ${fmt(token.allowance)}；approve 是「設為」不是「加上」。`] : [],
    });
  }
  steps.push({
    ...base,
    to: r.tracker,
    data: followData,
    value: value.toString(),
    valueEth: eth(value),
    summary:
      `${needApprove ? "第 2 步：" : ""}以 ${fmt(amount)} 跟單 ${trader} 的 ${versionLabel(latest.versionId)}` +
      (a.autoSync
        ? `，並開啟自動同步（槓桿上限 ${cap}×、冷卻 ${interval / 3600} 小時、小費 ${eth(tip)} ETH），附帶 ${eth(value)} ETH` +
          `＝開倉執行費 ${eth(openFee)}＋預存油箱 ${eth(prefund)}` +
          (syncCost > 0n ? `（約可被代為同步 ${(prefund / syncCost).toString()} 次）` : "")
        : `，附帶開倉執行費 ${eth(openFee)} ETH`),
    warnings: [],
  });
  const simulation = needApprove ? null : await r.simulate({ from: follower, to: r.tracker, data: followData, value });
  if (simulation && !simulation.ok) warnings.push(`eth_call 模擬這筆跟單會失敗：${simulation.reason}。先處理再簽名。`);

  const nextIdx = recs.length;
  const nextSteps = [
    ...(needApprove ? ["approve 上鏈後可以再呼叫一次本工具：授權足夠時只剩跟單一筆，並附上 eth_call 模擬結果。"] : []),
    `跟單上鏈後用 copy_sync_status 查看（這筆預計是第 ${nextIdx} 筆，recordIdx=${nextIdx}）。`,
    ...(a.autoSync
      ? [
          `只想讓自己的 agent 代為同步：prepare_copy_sync_tx action=set-executor recordIdx=${nextIdx} executor=<你的 agent 熱錢包>。` +
            "冷卻從跟單當下起算、至少 1 小時，這段時間內沒有人能搶先代為同步。",
        ]
      : [`之後想開啟自動同步：prepare_copy_sync_tx action=enable recordIdx=${nextIdx} maxLeverage=<1–5>。`]),
  ];

  return {
    chainId: r.chainId,
    from: follower,
    steps,
    preview: {
      trader,
      version: versionLabel(latest.versionId),
      versionId: latest.versionId,
      settlementToken: token.token,
      amount: fmt(amount),
      copyFee: fmt(pv.copyFee),
      tradingFeeBuffer: fmt(pv.totalTradingFee),
      marginForPositions: fmt(pv.marginForPositions),
      executionFeePerLegEth: eth(fee),
      legs,
      autoSync: a.autoSync
        ? { maxLeverage: cap, cooldownHours: interval / 3600, tipEth: eth(tip), prefundEth: eth(prefund), perThirdPartySyncEth: eth(syncCost) }
        : null,
    },
    simulation,
    warnings,
    nextSteps,
    note: UNSIGNED_NOTE,
  };
}

// ── 註冊 ─────────────────────────────────────────────────────────────────────

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(jsonSafe(data), null, 2) }] };
}

function fail(err: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${redactSecrets((err as Error).message)}` }] };
}

export function registerCopyTools(server: McpServer, reads: CopyReads): void {
  server.tool(
    "copy_sync_status",
    "查詢跟隨者每筆跟單的自動同步狀態（ADR-024）：跟到第幾版／交易者最新第幾版、自動同步設定（槓桿上限、冷卻、小費）、" +
      "指定的執行者、油箱餘額與還能代為同步幾次、冷卻到期時間、交易所執行費是否仍在跟隨者同意的範圍內，以及下一步建議。唯讀。",
    {
      follower: z.string().describe("跟隨者的鏈上地址 0x…"),
      recordIdx: z.number().int().nonnegative().optional().describe("只看這一筆（getCopyRecords 的索引）；省略＝所有仍在跟隨的"),
    },
    READ_ONLY,
    async ({ follower, recordIdx }) => {
      try {
        return ok(await copySyncStatus(reads, follower, recordIdx));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "prepare_copy_sync_tx",
    "產生跟單自動同步的「未簽名」交易（to／data／value），交給跟隨者自己的錢包簽——這個工具不簽名、不送出、不需要任何私鑰。" +
      "action：resync＝立即同步到交易者最新版（resyncAtVersion，附新版各腿與實際槓桿預覽、釘住版本與執行費）；" +
      "enable／disable＝開關自動同步（enable 必須帶 maxLeverage，預設冷卻 24 小時、小費 0）；" +
      "set-executor＝只讓指定地址（例如自己的 agent 熱錢包）代為同步，省略 executor＝解除；deposit／withdraw＝存提油箱。",
    {
      follower: z.string().describe("跟隨者地址（交易的簽名者）"),
      action: z.enum(PREPARE_ACTIONS),
      recordIdx: z.number().int().nonnegative().optional().describe("跟單索引（deposit／withdraw 以外必填）"),
      maxLeverage: z.number().int().min(1).max(5).optional().describe("enable：同步時的槓桿上限 1–5"),
      cooldownHours: z.number().positive().optional().describe("enable：冷卻小時數，預設 24，至少 1"),
      tipEth: z.string().optional().describe("enable：每次代為同步付給執行者的小費（ETH），預設 0"),
      executor: z.string().optional().describe("set-executor：指定的執行者地址；省略＝解除指定"),
      amountEth: z.string().optional().describe("deposit／withdraw：金額（ETH）"),
    },
    READ_ONLY,
    async (args) => {
      try {
        return ok(await prepareCopyTx(reads, args as PrepareArgs));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.tool(
    "prepare_copy_follow_tx",
    "由 agent 發起跟單：產生「USDC approve（授權不足時）＋跟單」的未簽名交易，交給跟隨者自己的錢包依序簽——這個工具不簽名、" +
      "不送出、不需要任何私鑰。跟單一律釘住交易者鏈上最新版（followTraderAtVersion；autoSync=true 時用 " +
      "followTraderAtVersionWithAutoSync 一筆完成跟單＋開啟自動同步＋預存油箱，並以目前執行費為簽名同意的上限）。" +
      "回傳各腿預覽（資產、方向、權重、實際槓桿＝策略／交易所上限／跟隨者上限三者取小、保證金）、費用、KYC 檢查與 eth_call 模擬結果。",
    {
      follower: z.string().describe("跟隨者地址（交易的簽名者）"),
      trader: z.string().describe("要跟的交易者地址"),
      amountUsdc: z.string().describe("投入金額（結算代幣，十進位字串，例如 \"1000\"）"),
      autoSync: z.boolean().describe("是否一併開啟自動同步（跟隨者的明確同意）"),
      maxLeverage: z.number().int().min(1).max(5).optional().describe("autoSync=true 時必填：槓桿上限 1–5，也套用在這次開倉"),
      cooldownHours: z.number().positive().optional().describe("autoSync：冷卻小時數，預設 24，至少 1"),
      tipEth: z.string().optional().describe("autoSync：每次代為同步付給執行者的小費（ETH），預設 0"),
      prefundEth: z.string().optional().describe("autoSync：預存進油箱的 ETH；省略＝夠別人代為同步 5 次"),
    },
    READ_ONLY,
    async (args) => {
      try {
        return ok(await prepareCopyFollow(reads, args as FollowArgs));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
