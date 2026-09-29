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
  /** 以 signer 對 updatePrice 做 staticCall 預檢（paused／role／cap／reference 一次涵蓋）。 */
  checkUpdate: (assetId: string, price8: bigint) => Promise<unknown>;
  updatePrice: (assetId: string, price8: bigint) => Promise<TxLike>;
}

const fmt8 = (p: bigint): string => `$${(Number(p) / 1e8).toFixed(2)}`;

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
    let mockPrice8 = 0n;
    let lastUpdated = 0;
    try {
      const [raw, at] = await ctx.oracle.getPrice(assetId);
      mockPrice8 = raw;
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

    // Guarded 的現況要在判斷之前讀：兩顆要嘛都寫、要嘛都不寫，且不一致時要補寫。
    // 窄複審 2：Guarded 被凍結或讀不到 → Mock 也拒寫（fail-closed）。凍結是 guardian
    // 的人工決定，keeper 不能把它當成「少一道限制、Mock 可以照寫」。
    let guardedState: { price8: bigint; exists: boolean } | null = null;
    if (ctx.guarded) {
      try {
        const [gp, , exists, frozen] = await ctx.guarded.peek(assetId);
        if (exists && frozen) {
          refuse(symbol, assetId, "GuardedOracle 此資產已凍結（guardian 決定）—— fail-closed，MockOracle 也不寫");
          continue;
        }
        guardedState = { price8: gp, exists };
      } catch (e) {
        r.failed += 1;
        r.skippedSymbols.push(symbol);
        error(
          `::error::${symbol} 讀不到 GuardedOracle（${(e as Error).message.slice(0, 100)}）` +
            `—— fail-closed，兩顆都不寫`,
        );
        continue;
      }
    }

    // 窄複審 3：兩顆不一致（例如上一輪 Guarded 寫成功、Mock 失敗）時，即使 planUpdate
    // 說不用寫也要走補寫，讓兩顆收斂。
    const diverged = !!guardedState?.exists && mockPrice8 > 0n && guardedState.price8 !== mockPrice8;
    if (!plan.write && !diverged) continue;
    if (diverged) {
      log(`::warning::${symbol} 兩顆 oracle 不一致（Guarded ${fmt8(guardedState!.price8)} ≠ Mock ${fmt8(mockPrice8)}），本輪補寫`);
    }

    // 有效熔斷門檻 = min(KEEPER_BREAKER_DEVIATION, Guarded 在這個方向的上限)。
    // 窄複審 2：只要有設定 Guarded 就一律套用，不看資產狀態 —— 門檻不能因任何狀態放寬。
    const up = feed.value > current;
    const breaker = ctx.guarded
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
    if (guardedState?.exists) {
      mirrorPlan = planMirror(guardedState.price8, price8, ctx.guardedCap);
      if (mirrorPlan.action === "reject") {
        // 多源確認通過也一樣：Guarded 會拒絕的價格，Mock 也不寫。reject 訊息區分兩種成因。
        const why =
          guardedState.price8 !== mockPrice8
            ? `兩顆已不一致（Guarded ${fmt8(guardedState.price8)} ≠ Mock ${fmt8(mockPrice8)}）：` +
              `完整價格 ${fmt8(price8)} 超出 Guarded 相對其自身價格的上限 ${ctx.guardedCap} bps`
            : `變動超過 GuardedOracle 上限 ${ctx.guardedCap} bps（${fmt8(guardedState.price8)} → ${fmt8(price8)}）`;
        refuse(symbol, assetId, `${why} —— 不寫部分步進，兩顆都不寫`);
        continue;
      }
    }
    if (guard.confirmed) {
      r.confirmed += 1;
      log(`::warning::${symbol} ${guard.reason}`);
    }

    if (ctx.dryRun) {
      if (mirrorPlan?.action === "write") log(`  → (DRY_RUN) GuardedOracle 預檢略過（沒有 signer）`);
      continue;
    }

    // 窄複審 3：先以 signer 對 Guarded 做 staticCall 預檢，一次涵蓋 paused、role、cap、
    // reference 等所有 revert 條件；預檢失敗就兩顆都不寫。
    if (ctx.guarded && mirrorPlan?.action === "write") {
      try {
        await ctx.guarded.checkUpdate(assetId, mirrorPlan.value);
      } catch (e) {
        refuse(
          symbol,
          assetId,
          `GuardedOracle.updatePrice 預檢 revert（paused／role／cap／reference…）：` +
            `${(e as Error).message.slice(0, 120)} —— 兩顆都不寫`,
        );
        continue;
      }
      // 預檢通過後**先寫 Guarded**，成功才寫 Mock。Guarded 有上限、Mock 沒有：
      // Mock 失敗時下一輪的「不一致補寫」會自然補上；反過來則會把 Mock 寫成 Guarded
      // 接受不了的價格。
      try {
        const tx = await ctx.guarded.updatePrice(assetId, mirrorPlan.value);
        await tx.wait();
        log(`  → GuardedOracle ✓ ${tx.hash}`);
      } catch (e) {
        r.failed += 1;
        error(`::error::${symbol} GuardedOracle 寫入失敗（MockOracle 未寫，兩顆仍一致）：${(e as Error).message.slice(0, 120)}`);
        continue;
      }
    } else if (mirrorPlan?.action === "skip") {
      log(`  → GuardedOracle ${mirrorPlan.reason}`);
    }

    if (mockPrice8 === price8) {
      log(`  → MockOracle 已是目標值`);
      r.wrote += 1;
      continue;
    }
    try {
      const tx = await ctx.oracle.updatePrice(assetId, price8);
      await tx.wait();
      r.wrote += 1;
      log(`  → MockOracle ✓ ${tx.hash}`);
    } catch (e) {
      r.failed += 1;
      error(
        `::error::${symbol} MockOracle 寫入失敗（GuardedOracle 已寫，下一輪會補寫收斂）：` +
          `${(e as Error).message.slice(0, 140)}`,
      );
    }
  }
  return r;
}
