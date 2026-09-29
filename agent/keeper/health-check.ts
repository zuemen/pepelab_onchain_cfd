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
  const fallbackTolerated: string[] = [];
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
    if (v.tolerated && v.viaFallback) fallbackTolerated.push(tag);
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
    fallbackTolerated,
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

// ── funding 結算延遲（窄複審 5）────────────────────────────────────────────
// keeper 的 crank 會跳過被熔斷拒寫的資產、清單不存在時整輪不 crank。這兩個都是正確的
// 保守行為，但如果一直持續，funding 就會無聲地停住。這裡用同一套 alert：
// lastFundingUpdateAt 超過 2 × FUNDING_INTERVAL 就開 issue。

export interface FundingDeps {
  chain: string;
  symbols: readonly string[];
  nowSec: number;
  intervalSec: number;
  /** 讀 exchange.lastFundingUpdateAt(asset)；RPC 失敗會丟例外。 */
  lastFundingAt: (symbol: string) => Promise<number>;
  log?: (line: string) => void;
}

export async function checkFunding(d: FundingDeps): Promise<HealthReport> {
  const limit = 2 * d.intervalSec;
  const stale: string[] = [];
  const unreadable: string[] = [];
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    (d.log ?? console.log)(line);
  };
  for (const symbol of d.symbols) {
    let last: number;
    try {
      last = await d.lastFundingAt(symbol);
    } catch (e) {
      unreadable.push(symbol);
      log(`UNRD  ${symbol.padEnd(6)} 讀不到 lastFundingUpdateAt：${(e as Error).message.slice(0, 80)}`);
      continue;
    }
    if (last <= 0) {
      // 從未初始化（此資產還沒有任何部位觸發過 funding）：不是延遲。
      log(`  n/a ${symbol.padEnd(6)} lastFundingUpdateAt=0（未初始化）`);
      continue;
    }
    const lag = d.nowSec - last;
    const bad = lag > limit;
    if (bad) stale.push(`${symbol}(${(lag / 3600).toFixed(1)}h)`);
    log(`${bad ? "STALE" : "  ok "} ${symbol.padEnd(6)} funding 上次結算 ${(lag / 3600).toFixed(1)}h 前（上限 ${(limit / 3600).toFixed(1)}h）`);
  }
  const base = {
    kind: "funding" as const,
    chain: d.chain,
    checkedAtSec: d.nowSec,
    maxAgeSec: limit,
    stale,
    unreadable,
    lines,
  };
  if (isMajorityUnreadable(unreadable.length, d.symbols.length)) {
    return { ...base, status: "error", error: `${unreadable.length}/${d.symbols.length} 個資產讀不到 lastFundingUpdateAt` };
  }
  return { ...base, status: stale.length > 0 ? "stale" : "ok" };
}
