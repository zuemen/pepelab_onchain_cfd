// marketOperator：依市場時段把股票類資產在休市時切 ReduceOnly、開盤切回 Active。
//
// 為什麼存在：休市期間 Yahoo 只有上一個收盤價，允許新開倉等於讓人對著一個已知
// 過時的價格下注（開盤跳空時由 LP／保險庫買單）。合約端（contracts/p1-guardian-
// market-modes，尚未部署）新增 per-asset 模式：Active=0 可開可平、ReduceOnly=1
// 只能減倉／清算、Halted=2 全停。marketOperator 只能在 Active↔ReduceOnly 之間切，
// 永遠碰不到 Halted —— 這個檔案也照同一條規則決策。
//
// 預設關閉（KEEPER_MARKET_OPERATOR=1 才啟用），workflow 不開。線上舊 exchange
// 沒有 assetMode／setAssetMode，run.ts 會先探測、沒有就略過並記錄。
//
// 只有純函式，可被單元測試覆蓋；鏈上呼叫在 run.ts。
import { assetClassOf, calendarOpen, isSessionOpen, type AssetClass, type MarketSession } from "./market.ts";

export const ASSET_MODE = { Active: 0, ReduceOnly: 1, Halted: 2 } as const;
export type AssetModeValue = (typeof ASSET_MODE)[keyof typeof ASSET_MODE];
const MODE_NAME = ["Active", "ReduceOnly", "Halted"] as const;
export const modeName = (m: number): string => MODE_NAME[m] ?? `unknown(${m})`;

/**
 * 會被切換的資產類別。只含 equity（個股＋ETF）：
 *   • crypto 24/7，沒有休市。
 *   • future（sGOLD，COMEX）幾乎 24/5，每天 17:00–18:00 ET 休息一小時；照時段切
 *     會一天多送兩筆交易、讓部位在那一小時只能減倉，得不償失。週末休市仍由健檢
 *     （market.ts）放寬處理。要納入就在這裡加上 "future"。
 */
export const MODE_SWITCH_CLASSES: readonly AssetClass[] = ["equity"];

export function switchesMode(symbol: string): boolean {
  return MODE_SWITCH_CLASSES.includes(assetClassOf(symbol));
}

export type ModeDecision =
  | { action: "set"; mode: AssetModeValue; reason: string }
  | { action: "skip"; reason: string };

/**
 * 決定這一輪要不要切換 `symbol` 的模式。
 *
 *   currentMode — 鏈上 assetMode(asset)；null = 讀不到（舊合約／RPC 失敗）→ 不動。
 *   session     — Yahoo 正規盤時段；null 時退回行事曆，但只允許「收緊」：
 *                 行事曆說休市 → 可切 ReduceOnly（保守方向）；
 *                 行事曆說開盤 → 不切回 Active（行事曆不含假日，不能拿它放寬）。
 */
export function decideAssetMode(a: {
  symbol: string;
  nowSec: number;
  currentMode: number | null;
  session?: MarketSession | null;
}): ModeDecision {
  const cls = assetClassOf(a.symbol);
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

  let open: boolean;
  let basis: string;
  if (a.session) {
    open = isSessionOpen(a.session, a.nowSec);
    basis = "Yahoo 時段";
  } else {
    open = calendarOpen(cls, a.nowSec);
    basis = "行事曆後備";
    if (open) {
      return { action: "skip", reason: "沒有 Yahoo 時段，行事曆不含假日，不據以切回 Active" };
    }
  }

  const want: AssetModeValue = open ? ASSET_MODE.Active : ASSET_MODE.ReduceOnly;
  if (want === a.currentMode) {
    return { action: "skip", reason: `已是 ${modeName(want)}（${open ? "開盤" : "休市"}，${basis}）` };
  }
  return {
    action: "set",
    mode: want,
    reason: `${open ? "開盤" : "休市"}（${basis}）：${modeName(a.currentMode)} → ${modeName(want)}`,
  };
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
export function classifyProbeError(e: { code?: unknown; data?: unknown } | null | undefined): ProbeResult {
  if (!e || e.code !== "CALL_EXCEPTION") return "error";
  const d = e.data;
  if (d === undefined || d === null || d === "" || d === "0x") return "missing";
  return "denied";
}
