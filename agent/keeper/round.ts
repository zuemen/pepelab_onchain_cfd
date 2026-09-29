// keeper 一輪的主迴圈（從 run.ts 抽出）：取價 → 判斷 → 兩顆 oracle 一起寫或一起不寫。
//
// 為什麼抽出來：審查要求「run.ts 層級」的測試 —— 把合約 mock 掉，驗證 12% 變動時
// 兩顆都不寫、8% 變動時兩顆都寫。run.ts 只負責把 ethers 合約接成這裡的介面。
//
// 兩顆 oracle 必須一致（審查 H1）：Base 的 GuardedOracle 沒有 referenceSource，每次
// 寫入都受 maxDeviationBps 限制（向上 10%、向下 9.09%）。舊流程先寫 MockOracle 再
// 鏡射，Guarded 拒絕時 Mock 已經寫了 → 交易所（讀 Mock）與金庫（讀 Guarded）看到
// 兩個不同的價格。現在寫 Mock 之前先用 planMirror 確認 Guarded 會接受完整價格；
// 不接受就兩顆都不寫（熔斷），由呼叫端的 onRefuse 做停單與告警（審查 H2）。
import {
  toPrice8,
  planUpdate,
  guardDeviation,
  planMirror,
  effectiveBreaker,
  type MirrorPlan,
  type ParsedFeed,
  type SourceQuote,
} from "./core.ts";
import type { QuoteMeta } from "./feeds.ts";

export type Feed = ParsedFeed & QuoteMeta & { source: string };
export interface TxLike {
  hash: string;
  /** ethers v6：wait(confirms, timeoutMs)，逾時丟 code=TIMEOUT。 */
  wait: (confirms?: number, timeoutMs?: number) => Promise<unknown>;
}
export interface OracleLike {
  getPrice: (assetId: string) => Promise<[bigint, bigint]>;
  updatePrice: (assetId: string, price8: bigint) => Promise<TxLike>;
}
export interface GuardedLike {
  peek: (assetId: string) => Promise<[bigint, bigint, boolean, boolean]>;
  updatePrice: (assetId: string, price8: bigint) => Promise<TxLike>;
}

export interface RefusedAsset {
  symbol: string;
  assetId: string;
  reason: string;
}

export interface RoundCtx {
  symbols: readonly string[];
  nowSec: number;
  dryRun: boolean;
  deviationThreshold: number;
  heartbeatSec: number;
  breakerDeviation: number;
  confirmTolerance: number;
  oracle: OracleLike;
  guarded: GuardedLike | null;
  guardedCap: bigint;
  assetIdOf: (symbol: string) => string;
  fetchRelay: (assetId: string) => Promise<{ price: number; updatedAt: number } | null>;
  fetchPrice: (symbol: string) => Promise<Feed>;
  fetchSecondary: (symbol: string) => Promise<Feed>;
  /** 鏈上 getPrice 丟的錯是否是「資產不存在」（可 seed）；其他錯誤不寫。 */
  isAssetNotFound?: (e: unknown) => boolean;
  /** 每個資產取價後呼叫（marketOperator 休市切換）；回 "failed" 計入 failed。 */
  beforeAsset?: (symbol: string, assetId: string) => Promise<"ok" | "failed" | "stop">;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

export interface RoundResult {
  available: number;
  skipped: number;
  rejected: number;
  confirmed: number;
  wrote: number;
  failed: number;
  refused: RefusedAsset[];
  skippedSymbols: string[];
}

export async function runRound(ctx: RoundCtx): Promise<RoundResult> {
  const log = ctx.log ?? console.log;
  const error = ctx.error ?? console.error;
  const r: RoundResult = {
    available: 0, skipped: 0, rejected: 0, confirmed: 0, wrote: 0, failed: 0,
    refused: [], skippedSymbols: [],
  };
  let beforeAsset = ctx.beforeAsset;
  const refuse = (symbol: string, assetId: string, reason: string) => {
    r.rejected += 1;
    r.refused.push({ symbol, assetId, reason });
    error(`::error::${symbol} ${reason}`);
  };

  for (const symbol of ctx.symbols) {
    const assetId = ctx.assetIdOf(symbol);

    // 優先中繼鏈上的去中心化聚合價；聚合器沒有這個資產的 feed（測試網上多數股票
    // 都是如此）或自報過期時，才退回外部 API。
    const relayed = await ctx.fetchRelay(assetId);
    const feed: Feed =
      relayed !== null
        ? {
            value: relayed.price,
            reason: "ok",
            source: "chainlink/pyth relay",
            quoteAgeSec: Math.max(0, ctx.nowSec - relayed.updatedAt),
          }
        : await ctx.fetchPrice(symbol);

    // 休市切換放在價格判斷之前：價格來源壞了不影響「現在是不是休市」。
    if (beforeAsset) {
      const b = await beforeAsset(symbol, assetId);
      if (b === "failed") r.failed += 1;
      if (b === "stop") beforeAsset = undefined; // 例如舊 exchange：整輪不再探測
    }

    if (feed.value === null) {
      // 拒絕而不是夾擠：夾擠出來的價格讀者無法分辨真假。
      log(`${symbol.padEnd(6)} 來源無效，跳過 (${feed.source}: ${feed.reason})`);
      r.skipped += 1;
      r.skippedSymbols.push(symbol);
      continue;
    }
    r.available += 1;

    let current = 0;
    let lastUpdated = 0;
    try {
      const [raw, at] = await ctx.oracle.getPrice(assetId);
      current = Number(raw) / 1e8;
      lastUpdated = Number(at);
    } catch (e) {
      // 只有明確的 AssetNotFound revert（資產還沒 addAsset）才當 seed。429、逾時、
      // RPC 故障時 current 未知 —— 當成 0 會跳過所有熔斷檢查直接寫入，必須不寫。
      if (!ctx.isAssetNotFound?.(e)) {
        r.failed += 1;
        r.skippedSymbols.push(symbol);
        error(`::error::${symbol} 讀不到鏈上價格（${(e as Error).message.slice(0, 100)}）—— 不是 AssetNotFound，不寫入`);
        continue;
      }
      log(`  ${symbol} 鏈上尚無此資產（AssetNotFound），視為 seed`);
    }

    const plan = planUpdate({
      target: feed.value,
      current,
      lastUpdatedSec: lastUpdated,
      nowSec: ctx.nowSec,
      deviationThreshold: ctx.deviationThreshold,
      heartbeatSec: ctx.heartbeatSec,
    });

    const ageMin = lastUpdated > 0 ? ((ctx.nowSec - lastUpdated) / 60).toFixed(1) : "n/a";
    const quoteAge =
      typeof feed.quoteAgeSec === "number" ? ` quote=${(feed.quoteAgeSec / 3600).toFixed(1)}h` : "";
    log(
      `${symbol.padEnd(6)} [${feed.source.padEnd(20)}] live=$${feed.value.toFixed(2).padStart(10)} ` +
        `chain=$${current.toFixed(2).padStart(10)} age=${ageMin}m${quoteAge} → ${plan.write ? "WRITE" : "skip"} (${plan.reason})`,
    );
    // 偽新鮮度：報價本身很舊（週末收盤價/來源凍結），寫上鏈會讓 updatedAt 看起來
    // 新鮮但價格是好幾天前的。價格照寫（否則週末會全部跳過），但必須說出來。
    if (feed.quoteStale) {
      log(
        `::warning::${symbol} 來源報價已 ${((feed.quoteAgeSec ?? 0) / 3600).toFixed(1)} 小時未更新` +
          `（可能是週末/假日收盤價）—— 鏈上 updatedAt 會顯示新鮮，但價格並非即時。`,
      );
    }
    if (!plan.write) continue;

    // Guarded 的現況要在寫 Mock 之前讀：兩顆要嘛都寫、要嘛都不寫。
    let guardedState: { price8: bigint; active: boolean } | null = null;
    if (ctx.guarded) {
      try {
        const [gp, , exists, frozen] = await ctx.guarded.peek(assetId);
        guardedState = { price8: gp, active: exists && !frozen };
        if (exists && frozen) log(`  → GuardedOracle 已凍結，這一輪只寫 MockOracle`);
      } catch (e) {
        r.failed += 1;
        error(
          `::error::${symbol} 讀不到 GuardedOracle（${(e as Error).message.slice(0, 100)}）` +
            `—— 無法確認兩顆會一致，兩顆都不寫`,
        );
        continue;
      }
    }

    // 有效熔斷門檻 = min(KEEPER_BREAKER_DEVIATION, Guarded 在這個方向的上限)。
    const up = feed.value > current;
    const breaker =
      guardedState?.active && ctx.guardedCap > 0n
        ? effectiveBreaker(ctx.breakerDeviation, ctx.guardedCap, up)
        : ctx.breakerDeviation;

    // A-5：價格熔斷。偏離超過有效門檻時才去湊第二個獨立來源（正常路徑不多打請求）。
    // 每一票都帶報價年齡；年齡不明或過舊的票在 confirmLargeMove 裡不算數。
    const asQuote = (f: Feed, source: string): SourceQuote => ({
      source,
      value: f.value as number,
      ageSec: f.quoteAgeSec,
      stale: f.quoteStale === true,
    });
    const quotes: SourceQuote[] = [asQuote(feed, feed.source)];
    if (current > 0 && Math.abs(feed.value - current) / current > breaker) {
      if (relayed !== null) {
        const api = await ctx.fetchPrice(symbol);
        if (api.value !== null) quotes.push(asQuote(api, api.source));
      }
      const second = await ctx.fetchSecondary(symbol);
      if (second.value !== null) quotes.push(asQuote(second, `${second.source}(secondary)`));
      log(
        `  多源確認：${quotes
          .map((q) => `${q.source}=$${q.value.toFixed(2)}(age ${q.ageSec ?? "?"}s${q.stale ? ",stale" : ""})`)
          .join(", ")}`,
      );
    }
    const guard = guardDeviation({
      target: feed.value,
      current,
      breakerDeviation: breaker,
      quotes,
      confirmTolerance: ctx.confirmTolerance,
    });
    if (!guard.write) {
      refuse(symbol, assetId, `${guard.reason}（MockOracle 與 GuardedOracle 都不寫）`);
      continue;
    }

    const price8 = toPrice8(guard.value);
    let mirrorPlan: MirrorPlan | null = null;
    if (guardedState?.active) {
      mirrorPlan = planMirror(guardedState.price8, price8, ctx.guardedCap);
      if (mirrorPlan.action === "reject") {
        // 多源確認通過也一樣：Guarded 會拒絕的價格，Mock 也不寫。
        refuse(symbol, assetId, `${mirrorPlan.reason} —— 兩顆 oracle 必須一致，MockOracle 也不寫`);
        continue;
      }
    }
    if (guard.confirmed) {
      r.confirmed += 1;
      log(`::warning::${symbol} ${guard.reason}`);
    }

    if (ctx.dryRun) continue;

    try {
      const tx = await ctx.oracle.updatePrice(assetId, price8);
      await tx.wait();
      r.wrote += 1;
      log(`  → MockOracle ✓ ${tx.hash}`);
    } catch (e) {
      r.failed += 1;
      error(`::error::${symbol} MockOracle 寫入失敗：${(e as Error).message.slice(0, 140)}`);
      continue;
    }

    if (ctx.guarded && mirrorPlan?.action === "write") {
      try {
        const tx = await ctx.guarded.updatePrice(assetId, mirrorPlan.value);
        await tx.wait();
        log(`  → GuardedOracle ✓ ${mirrorPlan.value}`);
      } catch (e) {
        // 預檢已確認會被接受，到這裡多半是 RPC／nonce／權限。兩顆此刻不一致，必須大聲。
        r.failed += 1;
        error(
          `::error::${symbol} GuardedOracle 寫入失敗（MockOracle 已寫，兩顆暫時不一致）：` +
            `${(e as Error).message.slice(0, 120)}`,
        );
      }
    } else if (mirrorPlan?.action === "skip") {
      log(`  → GuardedOracle ${mirrorPlan.reason}`);
    }
  }
  return r;
}
