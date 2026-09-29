// 健檢的核心迴圈：讀每個資產的鏈上價格，判斷 ok／stale／unreadable，組成報告。
//
// 從 health.ts 抽出來，讓「RPC 故障」這條路徑可以被測試真正走一次
// （health-check.test.ts 用一個回 503 的本機 JSON-RPC 伺服器）。
//
// 審查 Medium 2：RPC 讀取失敗與價格過期是兩種事故，不能混在一起。
//   • 讀取失敗記為 unreadable，不算 stale（不會開「價格過期」issue）。
//   • 全部或多數資產讀不到 → status=error：不動 issue、job 失敗。
//   • 少數讀不到 → 依其餘資產判 ok／stale，但報告帶 unreadable，告警端不會據此關閉 issue。
import type { HealthReport } from "./alert.ts";
import { assetClassOf, judgeStaleness, type MarketSession } from "./market.ts";

export interface HealthDeps {
  chain: string;
  symbols: readonly string[];
  nowSec: number;
  maxAgeSec: number;
  /** 讀鏈上 (price, updatedAt)；RPC 失敗會丟例外。 */
  getPrice: (symbol: string) => Promise<[bigint, bigint]>;
  /** Yahoo 市場時段；拿不到回 null。 */
  fetchSession: (symbol: string) => Promise<MarketSession | null>;
  log?: (line: string) => void;
}

export function isMajorityUnreadable(unreadable: number, total: number): boolean {
  return total > 0 && unreadable * 2 > total;
}

export async function checkHealth(d: HealthDeps): Promise<HealthReport> {
  const stale: string[] = [];
  const closed: string[] = [];
  const unreadable: string[] = [];
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    (d.log ?? console.log)(line);
  };

  for (const symbol of d.symbols) {
    let price: bigint;
    let at: bigint;
    try {
      [price, at] = await d.getPrice(symbol);
    } catch (e) {
      unreadable.push(symbol);
      log(`UNRD  ${symbol.padEnd(6)} 讀取失敗（RPC，不是價格過期）：${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    const age = d.nowSec - Number(at);
    // 股票／ETF／期貨只在「照一般門檻已超齡」時才去問 Yahoo 是否休市，
    // 正常情況一個外部請求都不多打；加密資產永遠嚴格，不問。
    const session =
      age > d.maxAgeSec && assetClassOf(symbol) !== "crypto" ? await d.fetchSession(symbol) : null;
    const v = judgeStaleness({ symbol, updatedAtSec: Number(at), nowSec: d.nowSec, maxAgeSec: d.maxAgeSec, session });
    const tag = `${symbol}(${(age / 3600).toFixed(1)}h)`;
    if (v.stale) stale.push(tag);
    if (v.tolerated) closed.push(tag);
    log(
      `${v.stale ? "STALE" : v.tolerated ? "closd" : "  ok "} ${symbol.padEnd(6)} ` +
        `$${(Number(price) / 1e8).toFixed(2).padStart(10)} age=${(age / 3600).toFixed(1)}h` +
        (v.stale || v.tolerated ? `  ${v.reason}` : ""),
    );
  }

  const base = {
    chain: d.chain,
    checkedAtSec: d.nowSec,
    maxAgeSec: d.maxAgeSec,
    stale,
    closed,
    unreadable,
    lines,
  };
  if (isMajorityUnreadable(unreadable.length, d.symbols.length)) {
    return {
      ...base,
      status: "error",
      error: `${unreadable.length}/${d.symbols.length} 個資產讀不到（RPC 故障？），無法判斷價格是否過期`,
    };
  }
  return { ...base, status: stale.length > 0 ? "stale" : "ok" };
}
