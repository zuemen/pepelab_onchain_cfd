// 熔斷時的主動停單（複審 H2；窄複審 1 簡化）—— 只做得到 keeper 權限允許的範圍。
//
// 拒寫＝價格停在舊值。但「價格變舊 → 交易所停單」要等交易所的 maxPriceAge（Base 為
// 6 小時）過了才會發生；在那之前，交易所會以**已知錯誤的舊價**繼續開倉、平倉、清算。
// 所以拒寫某資產時，keeper：
//   (b) 交易所支援 setAssetMode 且 keeper 是 marketOperator → 切 ReduceOnly：
//       停止新開倉；平倉與清算照常（用的仍是舊價）。
//   (c) 開 issue／留言（alert.ts，由 workflow 的告警 step 執行）。
// 做不到的部分必須在 log 與 issue 裡明寫。
//
// 窄複審 1：**移除了 keeper 自動凍結 GuardedOracle（setAssetFrozen）的整條路徑。**
// keeper 本來就沒有 GUARDIAN_ROLE，那段不會執行；而它一旦生效，下一輪 round.ts 會因
// 「Guarded 已凍結」把 Mock 的熔斷門檻從 10% 放寬回 20% —— 保護動作反而開洞。凍結
// 一律由人（guardian）決定。現在 Guarded 凍結時 Mock 也拒寫（round.ts fail-closed）。
//
// 2026-09-29 鏈上事實（唯讀核對）：線上 exchange 沒有 setAssetMode —— (b) 目前做不到，
// 只剩 (c)。要真正關閉這個窗口，需要完成新合約 cutover 後把 keeper 設成 marketOperator。

import type { TxLike } from "./round.ts";

export type ModeOutcome = "done" | "already" | "not-operator" | "unsupported" | "no-exchange" | "dry-run" | "failed";

export interface ProtectionResult {
  symbol: string;
  mode: ModeOutcome;
  detail?: string;
}

/** protectAsset 需要的交易所介面（run.ts 以 ethers 合約接上；測試注入假物件）。 */
export interface ExchangeProtectLike {
  marketOperator: () => Promise<string>;
  assetMode: (assetId: string) => Promise<bigint | number>;
  /** setAssetMode 的 staticCall 預檢。 */
  checkSetAssetMode: (assetId: string, mode: number) => Promise<unknown>;
  setAssetMode: (assetId: string, mode: number) => Promise<TxLike>;
}

/**
 * 對一個被熔斷拒寫的資產嘗試把交易所切 ReduceOnly。每一步都先用 view／staticCall
 * 探測，沒有權限就記錄、不送交易。
 *   isMissingFunction(e) — 舊 exchange 沒有該函式（空 revert）。
 */
export async function protectAsset(a: {
  symbol: string;
  assetId: string;
  exchange: ExchangeProtectLike | null;
  signerAddress: string | null;
  isMissingFunction: (e: unknown) => boolean;
  waitTimeoutMs?: number;
}): Promise<ProtectionResult> {
  const res: ProtectionResult = { symbol: a.symbol, mode: "no-exchange" };
  if (!a.exchange) return res;

  let operator: string;
  try {
    operator = await a.exchange.marketOperator();
  } catch (e) {
    if (a.isMissingFunction(e)) {
      res.mode = "unsupported";
    } else {
      res.mode = "failed";
      res.detail = `marketOperator(): ${(e as Error).message.slice(0, 80)}`;
    }
    return res;
  }

  try {
    const current = Number(await a.exchange.assetMode(a.assetId));
    if (current !== 0) return { ...res, mode: "already" };
    if (!a.signerAddress) return { ...res, mode: "dry-run" };
    if (operator.toLowerCase() !== a.signerAddress.toLowerCase()) return { ...res, mode: "not-operator" };
    await a.exchange.checkSetAssetMode(a.assetId, 1);
    const tx = await a.exchange.setAssetMode(a.assetId, 1);
    await tx.wait(1, a.waitTimeoutMs ?? 120_000);
    return { ...res, mode: "done", detail: `reduce-only tx ${tx.hash}` };
  } catch (e) {
    return { ...res, mode: "failed", detail: `setAssetMode: ${(e as Error).message.slice(0, 80)}` };
  }
}

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
  const notes = [`${r.symbol}：${MODE_TEXT[r.mode]}${r.detail ? `（${r.detail}）` : ""}`];
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
