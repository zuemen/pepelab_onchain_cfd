// 熔斷時的主動停單（複審 H2）—— 只做得到 keeper 權限允許的範圍。
//
// 拒寫＝價格停在舊值。但「價格變舊 → 交易所停單」要等交易所的 maxPriceAge（Base 為
// 6 小時）過了才會發生；在那之前，交易所會以**已知錯誤的舊價**繼續開倉、平倉、清算。
// 所以拒寫某資產時，keeper 依序嘗試：
//   (a) keeper 對 GuardedOracle 有 GUARDIAN_ROLE → setAssetFrozen(asset, true)：
//       金庫（AssetVaultV2 讀 Guarded）立刻 fail-closed。**不影響交易所**（交易所讀 Mock）。
//   (b) 交易所支援 setAssetMode 且 keeper 是 marketOperator → 切 ReduceOnly：
//       停止新開倉；平倉與清算照常（用的仍是舊價）。
//   (c) 開 issue／留言（alert.ts，由 workflow 的告警 step 執行）。
// 做不到的部分必須在 log 與 issue 裡明寫。
//
// 2026-09-29 鏈上事實（唯讀核對）：Base 的 keeper 在 GuardedOracle 只有 KEEPER_ROLE、
// 線上 exchange 沒有 setAssetMode —— 也就是 (a)(b) 目前都做不到，只剩 (c)。要真正關閉
// 這個窗口，需要使用者授予 keeper GUARDIAN_ROLE，或完成新合約 cutover 後把 keeper
// 設成 marketOperator。見 docs/RUNBOOK_KEEPER.md「價格熔斷」。
//
// 這個檔案只有純函式；鏈上呼叫在 run.ts 的 protectAsset。

export type FreezeOutcome = "done" | "already" | "no-role" | "no-guarded" | "dry-run" | "failed";
export type ModeOutcome = "done" | "already" | "not-operator" | "unsupported" | "no-exchange" | "dry-run" | "failed";

export interface ProtectionResult {
  symbol: string;
  freeze: FreezeOutcome;
  mode: ModeOutcome;
  detail?: string;
}

const FREEZE_TEXT: Record<FreezeOutcome, string> = {
  done: "GuardedOracle 已凍結此資產（金庫 fail-closed）",
  already: "GuardedOracle 此資產原本就已凍結",
  "no-role": "keeper 沒有 GuardedOracle 的 GUARDIAN_ROLE，無法凍結金庫價格",
  "no-guarded": "未設定 GuardedOracle",
  "dry-run": "DRY_RUN：未凍結",
  failed: "凍結 GuardedOracle 失敗",
};
const MODE_TEXT: Record<ModeOutcome, string> = {
  done: "交易所已切 ReduceOnly（停止新開倉）",
  already: "交易所此資產原本就不是 Active",
  "not-operator": "keeper 不是交易所的 marketOperator，無法切 ReduceOnly",
  unsupported: "線上交易所沒有 setAssetMode（舊合約），無法切 ReduceOnly",
  "no-exchange": "未設定交易所位址",
  "dry-run": "DRY_RUN：未切換",
  failed: "切 ReduceOnly 失敗",
};

export function formatAge(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec <= 0) return "maxPriceAge";
  return sec % 3600 === 0 ? `${sec / 3600}h` : `${(sec / 3600).toFixed(1)}h`;
}

/**
 * 把保護動作的結果寫成人讀的說明。exchangeStillTrading=true 代表交易所仍會以舊價
 * 開新倉 —— 必須明寫「需人工處置」。
 */
export function describeProtection(
  r: ProtectionResult,
  exchangeMaxPriceAgeSec: number | null,
): { notes: string[]; exchangeStillTrading: boolean } {
  const notes = [
    `${r.symbol}：${FREEZE_TEXT[r.freeze]}；${MODE_TEXT[r.mode]}${r.detail ? `（${r.detail}）` : ""}`,
  ];
  const exchangeStillTrading = r.mode !== "done" && r.mode !== "already";
  const age = formatAge(exchangeMaxPriceAgeSec);
  if (exchangeStillTrading) {
    notes.push(`${r.symbol}：交易所將以舊價繼續成交，直到 maxPriceAge（${age}）；需人工處置`);
  } else {
    // ReduceOnly 只擋新開倉；平倉與清算仍用這個舊價。
    notes.push(`${r.symbol}：交易所已停止新開倉，但平倉與清算仍以舊價執行，直到 maxPriceAge（${age}）；需人工確認`);
  }
  return { notes, exchangeStillTrading };
}
