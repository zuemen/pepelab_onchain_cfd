// marketOperator 休市切換：只測純函式的決策部分（不碰鏈）。
//   cd agent && npx tsx keeper/operator.test.ts
import assert from "node:assert";
import {
  ASSET_MODE,
  DEFAULT_CLOSE_LEAD_SEC,
  LOOSEN_MAX_QUOTE_AGE_SEC,
  TIGHTEN_QUOTE_AGE_SEC,
  classifyProbeError,
  decideAssetMode,
  marketOperatorEnabled,
  modeClassOf,
  switchesMode,
} from "./operator.ts";
import type { MarketSession } from "./market.ts";

const utc = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
const TUE: MarketSession = {
  regularStart: utc(2026, 9, 29, 13, 30),
  regularEnd: utc(2026, 9, 29, 20, 0),
  regularMarketTime: utc(2026, 9, 29, 15, 55),
};
const TUE_MIDDAY = utc(2026, 9, 29, 16, 0);
const TUE_NIGHT = utc(2026, 9, 30, 2, 0); // 週二 22:00 EDT
const SAT_NOON = utc(2026, 10, 3, 15, 0);
const FRI: MarketSession = {
  regularStart: utc(2026, 10, 2, 13, 30),
  regularEnd: utc(2026, 10, 2, 20, 0),
  regularMarketTime: utc(2026, 10, 2, 20, 0),
};
const FRESH = 60;

// ── 哪些資產會被切換 ────────────────────────────────────────────────────
assert.equal(switchesMode("sAAPL"), true);
assert.equal(switchesMode("sICLN"), true, "ETF 也是股票類");
assert.equal(switchesMode("sBTC"), false);
assert.equal(switchesMode("sGOLD"), true, "期貨週末休市也要停開倉（每日 1h 休息不切）");
assert.equal(switchesMode("sNEW"), true, "未分類資產當 equity，要切（審查 L3：fail-safe）");

// ── 收緊階段（寫價前）：休市 → ReduceOnly ─────────────────────────────────
{
  const d = decideAssetMode({ phase: "tighten", symbol: "sAAPL", nowSec: SAT_NOON, currentMode: ASSET_MODE.Active, session: FRI });
  assert.equal(d.action, "set");
  assert.equal(d.action === "set" && d.mode, ASSET_MODE.ReduceOnly);
}
// 平日收盤後也切 ReduceOnly（session 仍是當天，now 已過 end）。
assert.equal(
  decideAssetMode({ phase: "tighten", symbol: "sTSLA", nowSec: TUE_NIGHT, currentMode: ASSET_MODE.Active, session: TUE }).action,
  "set",
);

// ── 放寬階段（寫價後、價格已被接受）：開盤且報價新鮮 → Active ──────────────
{
  const d = decideAssetMode({
    phase: "loosen", symbol: "sAAPL", nowSec: TUE_MIDDAY, currentMode: ASSET_MODE.ReduceOnly, session: TUE, quoteAgeSec: FRESH,
  });
  assert.equal(d.action, "set");
  assert.equal(d.action === "set" && d.mode, ASSET_MODE.Active);
}

// ── 已是目標模式 → 不送交易（冪等） ───────────────────────────────────────
assert.equal(
  decideAssetMode({ phase: "tighten", symbol: "sAAPL", nowSec: SAT_NOON, currentMode: ASSET_MODE.ReduceOnly, session: FRI }).action,
  "skip",
);
assert.equal(
  decideAssetMode({ phase: "tighten", symbol: "sAAPL", nowSec: TUE_MIDDAY, currentMode: ASSET_MODE.Active, session: TUE, quoteAgeSec: FRESH }).action,
  "skip",
);
assert.equal(
  decideAssetMode({ phase: "loosen", symbol: "sAAPL", nowSec: TUE_MIDDAY, currentMode: ASSET_MODE.Active, session: TUE, quoteAgeSec: FRESH }).action,
  "skip",
);

// ── 加密資產永遠不動（兩個階段都是） ─────────────────────────────────────
for (const phase of ["tighten", "loosen"] as const) {
  assert.equal(
    decideAssetMode({ phase, symbol: "sBTC", nowSec: SAT_NOON, currentMode: ASSET_MODE.Active, session: null, quoteAgeSec: 99_999 }).action,
    "skip",
  );
  assert.equal(
    decideAssetMode({ phase, symbol: "sETH", nowSec: SAT_NOON, currentMode: ASSET_MODE.ReduceOnly, session: null, quoteAgeSec: FRESH }).action,
    "skip",
  );
}

// ── Halted 絕不碰（marketOperator 在合約上也無權） ────────────────────────
for (const phase of ["tighten", "loosen"] as const) {
  for (const now of [SAT_NOON, TUE_MIDDAY]) {
    const d = decideAssetMode({ phase, symbol: "sAAPL", nowSec: now, currentMode: ASSET_MODE.Halted, session: TUE, quoteAgeSec: FRESH });
    assert.equal(d.action, "skip");
    assert.ok(d.reason.includes("Halted"), d.reason);
  }
}
// 讀不到模式／未知模式 → 不動。
assert.equal(decideAssetMode({ phase: "tighten", symbol: "sAAPL", nowSec: SAT_NOON, currentMode: null, session: FRI }).action, "skip");
assert.equal(decideAssetMode({ phase: "tighten", symbol: "sAAPL", nowSec: SAT_NOON, currentMode: 7, session: FRI }).action, "skip");

// ── 沒有 Yahoo 時段：行事曆只准收緊，不准放寬 ─────────────────────────────
{
  const d = decideAssetMode({ phase: "tighten", symbol: "sAAPL", nowSec: SAT_NOON, currentMode: ASSET_MODE.Active, session: null });
  assert.equal(d.action, "set", "行事曆說休市 → 可切 ReduceOnly");
  assert.equal(d.action === "set" && d.mode, ASSET_MODE.ReduceOnly);
}
{
  const d = decideAssetMode({
    phase: "loosen", symbol: "sAAPL", nowSec: TUE_MIDDAY, currentMode: ASSET_MODE.ReduceOnly, session: null, quoteAgeSec: FRESH,
  });
  assert.equal(d.action, "skip", "行事曆不含假日，不能據以切回 Active");
}

// ══ 休市偽新鮮度（w36）：以下每一條在修正前的程式上都會失敗 ════════════════

// (1) 收緊階段絕不放寬。修正前 beforeAsset 每輪都會把 ReduceOnly 切回 Active ——
//     包括熔斷停單（protect.ts）設的 ReduceOnly：下一輪開頭被解除、價格再被拒、
//     再停單，每輪來回兩筆交易，中間那段時間可以對已知錯誤的舊價開倉。
{
  const d = decideAssetMode({
    phase: "tighten", symbol: "sAAPL", nowSec: TUE_MIDDAY, currentMode: ASSET_MODE.ReduceOnly, session: TUE, quoteAgeSec: FRESH,
  });
  assert.equal(d.action, "skip", "寫價前不得解除 ReduceOnly（價格還沒通過檢查）");
}

// (2) 黃金（COMEX 期貨）週末休市：週五 17:00 ET 到週日 18:00 ET 只有週五的收盤價。
//     修正前期貨整類不切換 → 週末可對週五收盤價開倉。
{
  const d = decideAssetMode({ phase: "tighten", symbol: "sGOLD", nowSec: SAT_NOON, currentMode: ASSET_MODE.Active, session: null });
  assert.equal(d.action, "set", "sGOLD 週六 → ReduceOnly");
  assert.equal(d.action === "set" && d.mode, ASSET_MODE.ReduceOnly);
  const fri18 = utc(2026, 10, 2, 22, 0); // 週五 18:00 EDT
  assert.equal(decideAssetMode({ phase: "tighten", symbol: "sGOLD", nowSec: fri18, currentMode: ASSET_MODE.Active }).action, "set");
  const sun17 = utc(2026, 10, 4, 21, 0); // 週日 17:00 EDT（尚未開盤）
  assert.equal(decideAssetMode({ phase: "tighten", symbol: "sGOLD", nowSec: sun17, currentMode: ASSET_MODE.Active }).action, "set");
}
// 期貨每日 17:00–18:00 ET 的一小時休息不切（避免一天多兩筆交易）。
{
  const wed1730 = utc(2026, 9, 30, 21, 30); // 週三 17:30 EDT
  assert.equal(
    decideAssetMode({ phase: "tighten", symbol: "sGOLD", nowSec: wed1730, currentMode: ASSET_MODE.Active, quoteAgeSec: 1800 }).action,
    "skip",
  );
  // 週日 18:00 ET 後開盤、報價新鮮 → 放寬。
  const sun19 = utc(2026, 10, 4, 23, 0);
  const d = decideAssetMode({ phase: "loosen", symbol: "sGOLD", nowSec: sun19, currentMode: ASSET_MODE.ReduceOnly, quoteAgeSec: FRESH });
  assert.equal(d.action === "set" && d.mode, ASSET_MODE.Active);
  // 週六即使有人塞了新鮮報價，週末窗口內也不放寬。
  assert.equal(
    decideAssetMode({ phase: "loosen", symbol: "sGOLD", nowSec: SAT_NOON, currentMode: ASSET_MODE.ReduceOnly, quoteAgeSec: FRESH }).action,
    "skip",
  );
}

// (3) 放寬要有「市場此刻真的在成交」的證據：報價必須新鮮。美股假日或來源凍結時，
//     Yahoo 時段與行事曆可能都說開盤，但報價停在上一個交易日 —— 不得切回 Active。
//     修正前只看時段 → 假日早上就切回 Active，對前一天收盤價開倉。
{
  const holidayLike = { phase: "loosen" as const, symbol: "sAAPL", nowSec: TUE_MIDDAY, currentMode: ASSET_MODE.ReduceOnly, session: TUE };
  assert.equal(decideAssetMode({ ...holidayLike, quoteAgeSec: 20 * 3600 }).action, "skip", "報價 20h 前 → 不放寬");
  assert.equal(decideAssetMode({ ...holidayLike, quoteAgeSec: LOOSEN_MAX_QUOTE_AGE_SEC + 1 }).action, "skip");
  assert.equal(decideAssetMode({ ...holidayLike }).action, "skip", "報價年齡不明 → 不放寬");
  assert.equal(decideAssetMode({ ...holidayLike, quoteAgeSec: LOOSEN_MAX_QUOTE_AGE_SEC }).action, "set");
}

// (4) 盤中但報價停滯超過 TIGHTEN_QUOTE_AGE_SEC（提早收盤而 Yahoo 時段沒反映、來源凍結）→ 收緊。
//     與放寬門檻（1h）之間留遲滯，報價在 1–2h 之間不來回切。
{
  const base = { phase: "tighten" as const, symbol: "sAAPL", nowSec: TUE_MIDDAY, currentMode: ASSET_MODE.Active, session: TUE };
  assert.ok(TIGHTEN_QUOTE_AGE_SEC > LOOSEN_MAX_QUOTE_AGE_SEC, "要有遲滯");
  const d = decideAssetMode({ ...base, quoteAgeSec: TIGHTEN_QUOTE_AGE_SEC + 1 });
  assert.equal(d.action === "set" && d.mode, ASSET_MODE.ReduceOnly);
  assert.equal(decideAssetMode({ ...base, quoteAgeSec: TIGHTEN_QUOTE_AGE_SEC - 1 }).action, "skip");
  assert.equal(decideAssetMode({ ...base }).action, "skip", "報價年齡不明（來源壞了）不據以收緊盤中資產");
}

// (5) 預設啟用：保護不能靠「cutover 時記得設 KEEPER_MARKET_OPERATOR=1」。
//     修正前預設關閉，workflow 也沒開 → 線上一直沒有休市切換。
assert.equal(marketOperatorEnabled({}), true, "未設 → 啟用");
assert.equal(marketOperatorEnabled({ KEEPER_MARKET_OPERATOR: "1" }), true);
for (const off of ["0", "false", "off", " OFF "]) {
  assert.equal(marketOperatorEnabled({ KEEPER_MARKET_OPERATOR: off }), false, `明確關閉：${off}`);
}

// ══ PR #232 審查（w36r）══════════════════════════════════════════════════

// H1：收盤提前量（預設 DEFAULT_CLOSE_LEAD_SEC = 3h）。收盤後到下一輪 keeper 之間不能是 Active。
{
  assert.equal(DEFAULT_CLOSE_LEAD_SEC, 3 * 3600);
  const at = (h: number, m = 0, s = 0) => utc(2026, 9, 29, h, m, s); // 週二（EDT = UTC−4）
  const SESS: MarketSession = { regularStart: at(13, 30), regularEnd: at(20, 0), regularMarketTime: at(16, 50) };
  const t = (nowSec: number, extra: object = {}) =>
    decideAssetMode({ phase: "tighten", symbol: "sAAPL", nowSec, currentMode: ASSET_MODE.Active, session: SESS, quoteAgeSec: 30, ...extra }).action;
  const l = (nowSec: number, extra: object = {}) =>
    decideAssetMode({ phase: "loosen", symbol: "sAAPL", nowSec, currentMode: ASSET_MODE.ReduceOnly, session: SESS, quoteAgeSec: 30, ...extra }).action;
  assert.equal(t(at(19, 59, 59)), "set", "15:59:59 ET（收盤前 1 秒）必須已收緊");
  assert.equal(t(at(16, 59, 59)), "skip", "12:59:59 ET 還在提前量之外");
  assert.equal(t(at(17, 0)), "set", "13:00 ET 進入提前量");
  assert.equal(t(at(17, 0), { session: null }), "set", "沒有 Yahoo 時段時行事曆也會提前收緊");
  assert.equal(l(at(14, 0)), "set", "10:00 ET 開盤、報價新鮮 → 放寬");
  assert.equal(l(at(17, 30)), "skip", "13:30 ET 已在提前量內 → 不放寬（避免放寬後又收緊）");
  assert.equal(l(at(19, 58)), "skip", "15:58 ET 不放寬（審查 C1）");
  // 提早收盤（Yahoo 時段 13:00 ET 結束）：10:00 ET 起就在提前量內。
  const EARLY: MarketSession = { ...SESS, regularEnd: at(17, 0) };
  assert.equal(t(at(14, 0), { session: EARLY }), "set");
  // leadSec=0 → 回到「此刻」邊界。
  assert.equal(t(at(19, 59, 59), { leadSec: 0 }), "skip");
  assert.equal(t(at(20, 0), { leadSec: 0 }), "set");
  // 黃金：週五 14:00 ET 起提前收緊（17:00 進入週末休市）。
  const fri = (h: number) => utc(2026, 10, 2, h);
  assert.equal(decideAssetMode({ phase: "tighten", symbol: "sGOLD", nowSec: fri(17), currentMode: 0, quoteAgeSec: 30 }).action, "skip", "週五 13:00 ET");
  assert.equal(decideAssetMode({ phase: "tighten", symbol: "sGOLD", nowSec: fri(18), currentMode: 0, quoteAgeSec: 30 }).action, "set", "週五 14:00 ET");
  assert.equal(decideAssetMode({ phase: "loosen", symbol: "sGOLD", nowSec: fri(19), currentMode: 1, quoteAgeSec: 30 }).action, "skip");
  // 週三黃金：每日休息前 3h 不收緊（只看週末窗口）。
  assert.equal(decideAssetMode({ phase: "tighten", symbol: "sGOLD", nowSec: utc(2026, 9, 30, 19), currentMode: 0, quoteAgeSec: 30 }).action, "skip");
}

// L3：未分類資產當 equity（fail-safe），週六收緊。
assert.equal(modeClassOf("sNEW"), "equity");
assert.equal(decideAssetMode({ phase: "tighten", symbol: "sNEW", nowSec: SAT_NOON, currentMode: 0, session: null }).action, "set");

// L4：黃金平日來源無效（可能是 CME 假日）→ 收緊；股票盤中來源無效不收緊（時段與行事曆已涵蓋）。
{
  const WED = utc(2026, 9, 30, 15, 0);
  assert.equal(decideAssetMode({ phase: "tighten", symbol: "sGOLD", nowSec: WED, currentMode: 0, sourceOk: false }).action, "set");
  assert.equal(decideAssetMode({ phase: "tighten", symbol: "sGOLD", nowSec: WED, currentMode: 0, sourceOk: true }).action, "skip");
  assert.equal(
    decideAssetMode({ phase: "tighten", symbol: "sAAPL", nowSec: TUE_MIDDAY, currentMode: 0, session: TUE, sourceOk: false }).action,
    "skip",
  );
}

// ── 探測錯誤分類：舊 exchange 沒有函式 → missing，略過 ────────────────────
assert.equal(classifyProbeError({ code: "CALL_EXCEPTION", data: "0x" }), "missing");
assert.equal(classifyProbeError({ code: "CALL_EXCEPTION", data: null }), "missing");
assert.equal(classifyProbeError({ code: "CALL_EXCEPTION" }), "missing");
// AssetModeChangeNotAllowed(...) 之類的 custom error → 函式存在但被拒。
assert.equal(classifyProbeError({ code: "CALL_EXCEPTION", data: "0x1234abcd0000" }), "denied");
// assetMode() 已讀成功後，setAssetMode 的空 revert → denied（記 failed），不是 missing。
assert.equal(classifyProbeError({ code: "CALL_EXCEPTION", data: "0x" }, { functionExists: true }), "denied");
assert.equal(classifyProbeError({ code: "CALL_EXCEPTION" }, { functionExists: true }), "denied");
assert.equal(classifyProbeError({ code: "TIMEOUT" }, { functionExists: true }), "error");
// 網路／逾時 → 不下結論。
assert.equal(classifyProbeError({ code: "TIMEOUT" }), "error");
assert.equal(classifyProbeError({ code: "SERVER_ERROR", data: "0x" }), "error");
assert.equal(classifyProbeError(null), "error");

console.log("operator.test.ts ✓ all assertions passed");
