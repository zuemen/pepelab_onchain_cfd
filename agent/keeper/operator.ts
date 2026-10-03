// marketOperator：依市場時段把股票類與期貨資產在休市時切 ReduceOnly、開盤切回 Active。
//
// 為什麼存在：休市期間 Yahoo 只有上一個收盤價，允許新開倉等於讓人對著一個已知
// 過時的價格下注（開盤跳空時由 LP／保險庫買單）。不能靠「讓價格過期」停單：交易所的
// 平倉與清算（_requireFresh）和開倉共用同一個 maxPriceAge，價格一過期，出場也一起被擋。
// 所以 keeper 休市時照常 heartbeat（出場要用），停開倉交給交易所的 per-asset 模式：
// Active=0 可開可平、ReduceOnly=1 只能減倉／清算、Halted=2 全停。marketOperator 只能在
// Active↔ReduceOnly 之間切，永遠碰不到 Halted —— 這個檔案也照同一條規則決策。
//
// 兩個階段（w36）：
//   tighten — 寫價之前、每個資產都跑：只會 Active → ReduceOnly，永遠不放寬。
//             價格來源壞了也照跑（休市與否不靠價格）。
//   loosen  — 寫價之後、只對本輪價格通過所有檢查的資產（round.ts 的 priced）跑：
//             ReduceOnly → Active 需要「市場此刻真的在成交」的證據（時段開盤＋報價新鮮），
//             而且距離收盤還超過提前量。被熔斷拒寫的資產不在 priced 裡，所以熔斷停單
//             **同一輪**不會被解除；之後某一輪價格重新通過所有檢查、且開盤、報價新鮮時，
//             會自動切回 Active。要持續停單，請 guardian 上鎖（guardianLocked），keeper
//             讀到上鎖就不嘗試放寬（run.ts／marketMode.ts）。
//
// 收盤提前量（審查 H1）：keeper 由 GitHub 排程觸發，實測間隔 68–169 分鐘（偶爾更久），
// 「收盤時」不一定有一輪在跑。所以收緊看的是「此刻或 leadSec 之後是否休市」：收盤前
// leadSec 就切 ReduceOnly，放寬也排除這段。代價是收盤前 leadSec 不能開新倉。
//
// 預設啟用（KEEPER_MARKET_OPERATOR=0 才關）。線上舊 exchange 沒有 assetMode／setAssetMode，
// run.ts 會先探測、沒有就略過並以 ::warning:: 說明「休市中仍可開倉」。
//
// 只有純函式，可被單元測試覆蓋；鏈上呼叫在 marketMode.ts（由 run.ts 接上）。
import {
  ASSET_CLASS,
  calendarOpen,
  futureWeekendClosed,
  isSessionOpen,
  type AssetClass,
  type MarketSession,
} from "./market.ts";

export const ASSET_MODE = { Active: 0, ReduceOnly: 1, Halted: 2 } as const;
export type AssetModeValue = (typeof ASSET_MODE)[keyof typeof ASSET_MODE];
const MODE_NAME = ["Active", "ReduceOnly", "Halted"] as const;
export const modeName = (m: number): string => MODE_NAME[m] ?? `unknown(${m})`;

/**
 * 會被切換的資產類別：
 *   • equity（個股＋ETF）— 正規盤以外一律 ReduceOnly。
 *   • future（sGOLD，COMEX）— 只在週末休市（週五 17:00 ET → 週日 18:00 ET）切；每天
 *     17:00–18:00 ET 的一小時休息不切（一天多兩筆交易、價格只舊一小時，不划算）。
 *   • crypto 24/7，沒有休市，永遠不動。
 */
export const MODE_SWITCH_CLASSES: readonly AssetClass[] = ["equity", "future"];

/**
 * 休市切換用的資產類別。審查 L3：未列在 ASSET_CLASS 的資產當 equity（會切換）——
 * 健檢那邊「未分類當 crypto」是最嚴格的預設，但對停開倉而言 crypto 是最寬鬆的
 * （永遠不切）。新資產忘了分類時，寧可夜間被誤切 ReduceOnly，也不要休市照常開倉。
 */
export function modeClassOf(symbol: string): AssetClass {
  return ASSET_CLASS[symbol] ?? "equity";
}

export function switchesMode(symbol: string): boolean {
  return MODE_SWITCH_CLASSES.includes(modeClassOf(symbol));
}

/**
 * 收盤提前量預設 3 小時（KEEPER_CLOSE_LEAD_SEC 可改，範圍見 CLOSE_LEAD_RANGE）。
 * 依據：workflow 實測的白天排程間隔是 68–169 分鐘，3 小時涵蓋這個範圍；9/25（五）
 * 收盤前後兩輪的實際間隔是 13:23 → 16:35 ET（3.2 小時），13:23 那一輪落在 13:00 之後，
 * 會提前收緊。外部觸發 Worker（每 20 分鐘）部署後可調低到約 45 分鐘。
 */
export const DEFAULT_CLOSE_LEAD_SEC = 3 * 3_600;
/** 0（不提前）到 6.5 小時（整個正規盤）。 */
export const CLOSE_LEAD_RANGE = [0, 23_400] as const;

/** 放寬（切回 Active）時報價年齡上限：證明市場此刻在成交。假日 Yahoo 時段可能仍顯示開盤。 */
export const LOOSEN_MAX_QUOTE_AGE_SEC = 3_600;
/**
 * 時段內報價停滯超過這個年齡就收緊（提早收盤而時段沒反映、來源凍結）。
 * 刻意大於 LOOSEN_MAX_QUOTE_AGE_SEC：報價年齡在兩者之間時不來回切。
 */
export const TIGHTEN_QUOTE_AGE_SEC = 2 * 3_600;

/** KEEPER_MARKET_OPERATOR：預設啟用，只有明確寫 0／false／off 才關。 */
export function marketOperatorEnabled(env: Record<string, string | undefined>): boolean {
  const v = (env.KEEPER_MARKET_OPERATOR ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

export type ModeDecision =
  | { action: "set"; mode: AssetModeValue; reason: string }
  | { action: "skip"; reason: string };

/**
 * 決定這一輪要不要切換 `symbol` 的模式。
 *
 *   phase       — "tighten"（寫價前，只收緊）或 "loosen"（寫價後、價格已被接受，只放寬）。
 *   currentMode — 鏈上 assetMode(asset)；null = 讀不到（舊合約／RPC 失敗）→ 不動。
 *   session     — Yahoo 正規盤時段（只用於 equity）。
 *   quoteAgeSec — 本輪來源報價的年齡；不明時收緊不據以判斷、放寬一律不放。
 *
 * 收緊（fail-closed，任一成立即休市）：
 *   equity — 行事曆說休市、或 Yahoo 時段說休市、或報價停滯 > TIGHTEN_QUOTE_AGE_SEC。
 *   future — 週末休市窗口、或報價停滯 > TIGHTEN_QUOTE_AGE_SEC。
 * 放寬（全部成立才開盤）：
 *   equity — 有 Yahoo 時段且開盤、行事曆也開盤（行事曆不含假日，不能單獨據以放寬）。
 *   future — 不在週末窗口、行事曆開盤（不在每日休息）。
 *   兩者都要求 quoteAgeSec ≤ LOOSEN_MAX_QUOTE_AGE_SEC。
 */
export function decideAssetMode(a: {
  phase: "tighten" | "loosen";
  symbol: string;
  nowSec: number;
  currentMode: number | null;
  session?: MarketSession | null;
  quoteAgeSec?: number;
  /** 收盤提前量（秒），預設 DEFAULT_CLOSE_LEAD_SEC。 */
  leadSec?: number;
  /** 本輪來源是否給出價格；期貨來源無效時收緊（審查 L4，fail-closed）。預設 true。 */
  sourceOk?: boolean;
}): ModeDecision {
  const cls = modeClassOf(a.symbol);
  const lead = Math.max(0, a.leadSec ?? DEFAULT_CLOSE_LEAD_SEC);
  const soon = a.nowSec + lead;
  if (!switchesMode(a.symbol)) {
    return { action: "skip", reason: `${cls} 不做休市切換` };
  }
  if (a.currentMode === null) return { action: "skip", reason: "讀不到鏈上 assetMode" };
  if (a.currentMode === ASSET_MODE.Halted) {
    return { action: "skip", reason: "Halted 由 owner／guardian 處置，marketOperator 不碰" };
  }
  if (a.currentMode !== ASSET_MODE.Active && a.currentMode !== ASSET_MODE.ReduceOnly) {
    return { action: "skip", reason: `未知模式 ${a.currentMode}` };
  }
  const age = typeof a.quoteAgeSec === "number" && Number.isFinite(a.quoteAgeSec) ? a.quoteAgeSec : null;
  const h = (s: number) => `${(s / 3600).toFixed(1)}h`;

  if (a.phase === "tighten") {
    if (a.currentMode !== ASSET_MODE.Active) {
      return { action: "skip", reason: `已是 ${modeName(a.currentMode)}（收緊階段不放寬）` };
    }
    let why: string | null = null;
    if (cls === "equity") {
      if (!calendarOpen(cls, a.nowSec)) why = "行事曆休市";
      else if (a.session && !isSessionOpen(a.session, a.nowSec)) why = "Yahoo 時段休市";
      else if (!calendarOpen(cls, soon)) why = `行事曆 ${h(lead)} 內收盤（提前收緊）`;
      else if (a.session && soon >= a.session.regularEnd) why = `Yahoo 時段 ${h(lead)} 內收盤（提前收緊）`;
    } else if (futureWeekendClosed(a.nowSec)) {
      why = "期貨週末休市";
    } else if (futureWeekendClosed(soon)) {
      why = `期貨 ${h(lead)} 內進入週末休市（提前收緊）`;
    } else if (a.sourceOk === false) {
      why = "期貨來源無效（可能是交易所假日），fail-closed";
    }
    if (!why && age !== null && age > TIGHTEN_QUOTE_AGE_SEC) {
      why = `報價停滯 ${h(age)} > ${h(TIGHTEN_QUOTE_AGE_SEC)}`;
    }
    if (!why) return { action: "skip", reason: "已是 Active（開盤）" };
    return { action: "set", mode: ASSET_MODE.ReduceOnly, reason: `${why}：Active → ReduceOnly` };
  }

  // loosen
  if (a.currentMode !== ASSET_MODE.ReduceOnly) {
    return { action: "skip", reason: `已是 ${modeName(a.currentMode)}` };
  }
  if (cls === "equity") {
    if (!a.session) return { action: "skip", reason: "沒有 Yahoo 時段，行事曆不含假日，不據以切回 Active" };
    if (!isSessionOpen(a.session, a.nowSec) || !calendarOpen(cls, a.nowSec)) {
      return { action: "skip", reason: "休市中，維持 ReduceOnly" };
    }
    if (!calendarOpen(cls, soon) || soon >= a.session.regularEnd) {
      return { action: "skip", reason: `${h(lead)} 內收盤（提前量內），維持 ReduceOnly` };
    }
  } else if (futureWeekendClosed(a.nowSec) || !calendarOpen(cls, a.nowSec)) {
    return { action: "skip", reason: "期貨休市中，維持 ReduceOnly" };
  } else if (futureWeekendClosed(soon)) {
    return { action: "skip", reason: `期貨 ${h(lead)} 內進入週末休市，維持 ReduceOnly` };
  }
  if (age === null || age > LOOSEN_MAX_QUOTE_AGE_SEC) {
    return {
      action: "skip",
      reason: `時段開盤但報價${age === null ? "年齡不明" : `是 ${h(age)} 前`}（假日或來源凍結？），維持 ReduceOnly`,
    };
  }
  return { action: "set", mode: ASSET_MODE.Active, reason: `開盤且報價 ${Math.round(age / 60)} 分鐘內：ReduceOnly → Active` };
}

export type ProbeResult = "missing" | "denied" | "error";

/**
 * 解讀對 exchange 的探測呼叫（assetMode view、setAssetMode staticCall）失敗的原因。
 *
 *   missing — CALL_EXCEPTION 且沒有 revert data：函式選擇器不存在（舊 exchange
 *             沒有 fallback，未知選擇器會空 revert）。略過並記錄，不算失敗。
 *   denied  — 有 revert data（例如 AssetModeChangeNotAllowed）：函式存在但這把
 *             金鑰不是 marketOperator，或模式轉換不被允許。
 *   error   — 其他（網路、逾時、RPC 限流）：這輪不確定，不下結論。
 */
export function classifyProbeError(
  e: { code?: unknown; data?: unknown } | null | undefined,
  opts: { functionExists?: boolean } = {},
): ProbeResult {
  if (!e || e.code !== "CALL_EXCEPTION") return "error";
  const d = e.data;
  const empty = d === undefined || d === null || d === "" || d === "0x";
  // assetMode() 已讀成功 = 這是新 exchange，setAssetMode 一定存在；此時的空 revert
  // 不能解讀成「舊合約沒有函式」而靜默略過（審查 Low），一律算被拒 → 呼叫端記 failed。
  if (empty) return opts.functionExists ? "denied" : "missing";
  return "denied";
}
