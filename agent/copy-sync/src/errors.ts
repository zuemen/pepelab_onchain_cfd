// resyncFor 的 revert 解碼與分類：決定「這筆 record 什麼時候再試」以及「要不要通知本人」。
//
// 原則：合約是唯一的真相。執行者不自己判斷「應不應該同步」，只把合約拒絕的理由翻成人話、
// 排好下一次重試的時間。分類只看錯誤名稱（abi.ts 的說明），參數只用來寫日誌。
import { ethers } from "ethers";
import { REVERT_DECODE_ABI } from "./abi.ts";

const IFACE = new ethers.Interface(REVERT_DECODE_ABI as unknown as string[]);

export type RevertCategory =
  /** 已經是最新版（別人先同步了、或交易者沒有新版）：不必再試。 */
  | "synced"
  /** 自動同步已關閉、跟隨者指定了別的執行者、record 已結束或不存在：停止追蹤，等下一次 AutoSyncSet／SyncExecutorSet。 */
  | "dropped"
  /** 冷卻中（minSyncInterval）：在冷卻結束時再試。 */
  | "cooldown"
  /** 跟隨者的油箱不夠付執行費＋小費：通知本人存入，之後再試。 */
  | "gas"
  /**
   * 交易所 owner 調高了 executionFee，高於跟隨者開啟自動同步時簽名同意的費率（syncExecFeeCap）：
   * 第三方不能代為同步，要本人看過新費率、帶入新上限重新呼叫 setAutoSync（或費率調回來）。通知本人。
   */
  | "consent"
  /** 新版裡有 RWA 資產而跟隨者尚未通過 KYC：整筆 revert，部位維持舊版。 */
  | "kyc"
  /** 市場暫停、ReduceOnly／Halted、報價過期或寬限期：開盤或恢復後再試。 */
  | "market"
  /** 未平倉量上限、保證金不足等容量問題。 */
  | "capacity"
  /** 交易者資格（質押不足）或策略不存在。 */
  | "trader"
  /** tracker 沒有交易所授權（例如尚未 setCopyTracker）或部位代理不符：需要擁有者處理。 */
  | "config"
  /** 解得開但沒有分類的錯誤，或解不開的 revert。 */
  | "unknown";

export interface RevertInfo {
  category: RevertCategory;
  /** 錯誤名稱（解不開時是 selector 或 "revert"）。 */
  name: string;
  /** 寫進日誌與通知的一行說明（繁中，不含任何秘密）。 */
  detail: string;
  /** SyncCooldown 帶的冷卻結束時間（秒）；其他錯誤為 undefined。 */
  readyAt?: number;
}

const CATEGORY_BY_NAME: Record<string, RevertCategory> = {
  AlreadySynced: "synced",
  AutoSyncDisabled: "dropped",
  // 跟隨者指定了另一個執行者（personal 模式）：本執行者不能代為同步，等下一次 SyncExecutorSet 再看。
  NotSyncExecutor: "dropped",
  RecordAlreadyInactive: "dropped",
  InvalidRecordIndex: "dropped",
  SyncCooldown: "cooldown",
  InsufficientSyncGas: "gas",
  ExecutionFeeAboveCap: "consent",
  NotKycVerified: "kyc",
  AssetNotActive: "market",
  AssetHalted: "market",
  EnforcedPause: "market",
  StalePrice: "market",
  InvalidPrice: "market",
  GracePeriodActive: "market",
  // 同步時「關不掉舊腿」也多半是市場暫停或報價過期造成的，與開不起新腿同一類處理。
  PositionStillOpen: "market",
  // 平倉時壞帳觸發 ADL、連帶平掉跟隨者的其他部位：等清算處理完再同步。
  SyncDisturbedOtherPositions: "market",
  OpenInterestCapExceeded: "capacity",
  InsufficientFreeMargin: "capacity",
  MarginTooLow: "capacity",
  TradingFeeExceedsMargin: "capacity",
  InvalidLeverage: "capacity",
  // 所有舊腿都已不在（被清算／ADL），沒有保證金可以重新部署：跟隨者需要自己處理這筆跟單。
  NothingToRedeploy: "capacity",
  TraderNotEligible: "trader",
  NoStrategyPublished: "trader",
  NotCopyTracker: "config",
  CopyTrackerNotSet: "config",
  NotPositionAgent: "config",
  CopiedFromNotAllowed: "config",
  NotPositionOwner: "config",
  // 付小費給 msg.sender 失敗：執行者是不收 ETH 的合約。
  EthTransferFailed: "config",
  InvalidSyncConfig: "config",
  PositionAlreadyClosed: "unknown",
};

export const CATEGORY_LABEL: Record<RevertCategory, string> = {
  synced: "已是最新版",
  dropped: "自動同步未開啟、指定了其他執行者或跟單已結束",
  cooldown: "冷卻中",
  gas: "油箱餘額不足",
  consent: "交易所執行費高於跟隨者同意的費率，需本人重新確認自動同步設定",
  kyc: "新版含 RWA 資產，跟隨者尚未通過 KYC",
  market: "市場暫停、休市或報價過期",
  capacity: "未平倉量上限或保證金不足",
  trader: "交易者目前不符資格",
  config: "合約授權設定異常（需擁有者處理）",
  unknown: "未分類的拒絕",
};

/**
 * 從 ethers 的錯誤物件找出 revert data。ethers v6 的 CallExceptionError 放在 `data`；
 * 經過某些節點／包裝時在 `info.error.data` 或 `error.data`。找不到回 null。
 */
export function revertDataOf(e: unknown): string | null {
  const seen = new Set<unknown>();
  const visit = (x: unknown, depth: number): string | null => {
    if (!x || typeof x !== "object" || depth > 5 || seen.has(x)) return null;
    seen.add(x);
    const o = x as Record<string, unknown>;
    const d = o.data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]*$/.test(d) && d.length >= 10) return d;
    if (d && typeof d === "object") {
      const inner = visit(d, depth + 1);
      if (inner) return inner;
    }
    return visit(o.info, depth + 1) ?? visit(o.error, depth + 1) ?? visit(o.cause, depth + 1);
  };
  return visit(e, 0);
}

/** 這個錯誤是不是「合約 revert」（相對於 RPC 連線、逾時等基礎設施錯誤）。 */
export function isRevert(e: unknown): boolean {
  if (revertDataOf(e)) return true;
  const code = (e as { code?: unknown } | null)?.code;
  return code === "CALL_EXCEPTION";
}

function fmtArg(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return String(v);
  return String(v);
}

/** 解碼並分類一個 revert。`e` 可以是錯誤物件或 revert data 字串。 */
export function classifyRevert(e: unknown): RevertInfo {
  const data = typeof e === "string" ? e : revertDataOf(e);
  if (!data || data === "0x") {
    const reason = (e as { reason?: unknown } | null)?.reason;
    return {
      category: "unknown",
      name: "revert",
      detail: typeof reason === "string" && reason ? `revert：${reason}` : "revert（沒有錯誤資料）",
    };
  }
  let parsed: ethers.ErrorDescription | null = null;
  try {
    parsed = IFACE.parseError(data);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return { category: "unknown", name: data.slice(0, 10), detail: `無法解碼的錯誤 selector ${data.slice(0, 10)}` };
  }
  const name = parsed.name;
  const args = parsed.fragment.inputs.map((p, i) => `${p.name || `arg${i}`}=${fmtArg(parsed!.args[i])}`);
  // Error(string)／Panic(uint256) 是 ethers 內建：require 字串（例如 registry 的 "no strategies"）走這裡。
  const category: RevertCategory =
    CATEGORY_BY_NAME[name] ??
    (name === "Error" && /no strateg/i.test(String(parsed.args[0])) ? "trader" : "unknown");
  const out: RevertInfo = {
    category,
    name,
    detail: `${name}${args.length ? `(${args.join(", ")})` : ""}：${CATEGORY_LABEL[category]}`,
  };
  if (name === "SyncCooldown") {
    const readyAt = Number(parsed.args[0]);
    if (Number.isFinite(readyAt) && readyAt > 0) out.readyAt = readyAt;
  }
  return out;
}

/** 每一類的基本重試間隔（秒）。實際間隔＝基本間隔 × 2^min(連續失敗次數, 5)，上限 MAX_RETRY_SEC。 */
export const RETRY_BASE_SEC: Record<Exclude<RevertCategory, "synced" | "dropped">, number> = {
  cooldown: 0, // 用 readyAt
  gas: 30 * 60,
  consent: 60 * 60,
  kyc: 60 * 60,
  market: 10 * 60,
  capacity: 30 * 60,
  trader: 60 * 60,
  config: 60 * 60,
  unknown: 5 * 60,
};

export const MAX_RETRY_SEC = 6 * 3600;

/**
 * 下一次重試的時間（鏈上秒）。`attempts` 是這一類已經連續失敗幾次（含這一次，≥1）。
 * cooldown 有 readyAt 時就用它（+1 秒，避開同一個區塊時間戳的邊界）。
 */
export function nextRetryAt(info: Pick<RevertInfo, "category" | "readyAt">, nowSec: number, attempts: number): number {
  if (info.category === "synced" || info.category === "dropped") return Number.POSITIVE_INFINITY;
  if (info.category === "cooldown") {
    if (info.readyAt !== undefined && info.readyAt > nowSec) return info.readyAt + 1;
    return nowSec + 60;
  }
  const base = RETRY_BASE_SEC[info.category];
  const n = Math.max(0, Math.min(attempts - 1, 5));
  return nowSec + Math.min(base * 2 ** n, MAX_RETRY_SEC);
}
