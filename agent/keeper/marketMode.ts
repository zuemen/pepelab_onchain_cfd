// marketOperator 休市切換的鏈上編排（從 run.ts 抽出，審查 L6）：交易所介面、時鐘、Yahoo
// 時段都由呼叫端注入，所以收緊／放寬的順序、guardian 鎖、非 operator、舊合約、保護中
// 資產的分類，都能在不碰鏈的情況下測試。決策本身在 operator.ts（純函式）。
//
// 一輪的順序（run.ts）：
//   prepare()                     — 讀 marketOperator()：舊合約／不是自己 → 整輪略過
//   tighten(symbol, …)            — round.ts 的 beforeAsset，寫價前，只會切 ReduceOnly
//   （寫價、熔斷停單 protect.ts）
//   loosenPass(round.priced)      — 只對價格通過檢查的資產，每個資產重新取時間
//   classifyProtected()           — 報告用：休市造成的 ReduceOnly 不算「保護中」
import type { TxLike } from "./round.ts";
import type { MarketSession } from "./market.ts";
import {
  ASSET_MODE,
  classifyProbeError,
  decideAssetMode,
  modeClassOf,
  modeName,
  switchesMode,
  type ProbeResult,
} from "./operator.ts";

export interface ExchangeModeLike {
  marketOperator: () => Promise<string>;
  assetMode: (assetId: string) => Promise<bigint | number>;
  guardianLocked: (assetId: string) => Promise<boolean>;
  /** setAssetMode 的 staticCall 預檢（以 keeper 為 from）。 */
  checkSetAssetMode: (assetId: string, mode: number) => Promise<unknown>;
  setAssetMode: (assetId: string, mode: number) => Promise<TxLike>;
}

export interface MarketModeDeps {
  exchange: ExchangeModeLike;
  /** keeper 地址；DRY_RUN（沒有 signer）時為 null，只做決策不送交易。 */
  signerAddress: string | null;
  /** 當下時間（秒）。每次決策都重新取，不用整輪開頭的時間（審查 H1）。 */
  now: () => number;
  fetchSession: (symbol: string) => Promise<MarketSession | null>;
  leadSec: number;
  /** 允許切換的資產（租戶只切自己註冊的資產，審查 L2）；null = 不限。 */
  allowed: ReadonlySet<string> | null;
  /** 把 ethers 錯誤轉成 { code, data } 給 classifyProbeError。 */
  revertInfo: (e: unknown) => { code?: unknown; data?: unknown };
  isTimeout: (e: unknown) => boolean;
  waitTimeoutMs?: number;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

/** prepare() 的結果。只有 "ready" 才會做切換。 */
export type OperatorState = "ready" | "missing" | "not-operator" | "error";
export type ModeResult = "ok" | "failed" | "unknown";

export function createMarketMode(d: MarketModeDeps) {
  const log = d.log ?? console.log;
  const error = d.error ?? console.error;
  let state: OperatorState | null = null;

  const canSwitch = (symbol: string) => switchesMode(symbol) && (d.allowed === null || d.allowed.has(symbol));

  /**
   * 每輪一次：讀 marketOperator()。
   *   missing      — 舊 exchange 沒有這個函式 → 整輪略過，呼叫端印「休市仍可開倉」警告。
   *   not-operator — 不是這把 keeper（租戶設定或部署時覆寫）→ 一條 ::warning::、整輪略過，
   *                  不逐檔記 failed（審查 L2）。DRY_RUN 沒有 signer，無從比對，視為 ready。
   *   error        — RPC 問題：記一次 failed，本輪略過。
   */
  async function prepare(): Promise<OperatorState> {
    try {
      const op = await d.exchange.marketOperator();
      if (d.signerAddress && op.toLowerCase() !== d.signerAddress.toLowerCase()) {
        log(
          `::warning::keeper（${d.signerAddress}）不是交易所的 marketOperator（${op}），本輪不做休市切換 ——` +
            ` 休市中仍可對收盤價開倉。由 owner setMarketOperator，或設 KEEPER_MARKET_OPERATOR=0 關閉`,
        );
        state = "not-operator";
      } else {
        state = "ready";
      }
    } catch (e) {
      const kind: ProbeResult = classifyProbeError(d.revertInfo(e));
      if (kind === "missing") {
        log(`  → marketOperator：exchange 沒有 marketOperator()（舊合約），本輪略過休市切換`);
        state = "missing";
      } else {
        error(`::error::讀 marketOperator() 失敗（${kind}）：${(e as Error).message.slice(0, 100)} —— 本輪略過休市切換`);
        state = "error";
      }
    }
    return state;
  }

  async function apply(
    symbol: string,
    assetId: string,
    phase: "tighten" | "loosen",
    feed: { quoteAgeSec?: number; sourceOk?: boolean },
  ): Promise<ModeResult> {
    if (state !== "ready" || !canSwitch(symbol)) return "ok";

    let current: number;
    try {
      current = Number(await d.exchange.assetMode(assetId));
    } catch (e) {
      // marketOperator() 已讀成功 = 新合約；讀不到模式是 RPC 問題，這輪不動。
      log(`::warning::${symbol} 讀 assetMode 失敗：${(e as Error).message.slice(0, 100)}`);
      return "ok";
    }

    // 審查 M1：guardian 上鎖的資產，marketOperator 在合約上不能放寬。不讀就會每輪預檢被拒、
    // 記 failed、盤中每一輪 job 都紅。上鎖是人的決定：略過並記錄，不算失敗。
    if (phase === "loosen" && current === ASSET_MODE.ReduceOnly) {
      try {
        if (await d.exchange.guardianLocked(assetId)) {
          log(`  → marketOperator ${symbol}: skip（guardian 已上鎖，解除由 owner 處理，keeper 不嘗試放寬）`);
          return "ok";
        }
      } catch (e) {
        log(`::warning::${symbol} 讀 guardianLocked 失敗，本輪不放寬：${(e as Error).message.slice(0, 100)}`);
        return "ok";
      }
    }

    // 市場時段獨立取得（不依賴價格來源）。只有 equity 用得到，且只在可能切換時才打 Yahoo。
    const needSession =
      modeClassOf(symbol) === "equity" &&
      (phase === "tighten" ? current === ASSET_MODE.Active : current === ASSET_MODE.ReduceOnly);
    const session = needSession ? await d.fetchSession(symbol) : null;

    const dec = decideAssetMode({
      phase,
      symbol,
      nowSec: d.now(),
      currentMode: current,
      session,
      quoteAgeSec: feed.quoteAgeSec,
      sourceOk: feed.sourceOk,
      leadSec: d.leadSec,
    });
    if (dec.action === "skip") {
      log(`  → marketOperator ${symbol}: skip（${dec.reason}）`);
      return "ok";
    }

    try {
      await d.exchange.checkSetAssetMode(assetId, dec.mode);
    } catch (e) {
      const kind = classifyProbeError(d.revertInfo(e), { functionExists: true });
      if (!d.signerAddress && kind === "denied") {
        log(`  → marketOperator ${symbol}: 會 ${dec.reason}（DRY_RUN，權限未驗證）`);
        return "ok";
      }
      error(`::error::${symbol} setAssetMode(${modeName(dec.mode)}) 預檢失敗（${kind}）：${(e as Error).message.slice(0, 140)}`);
      return "failed";
    }
    if (!d.signerAddress) {
      log(`  → marketOperator ${symbol}: 會 ${dec.reason}（DRY_RUN）`);
      return "ok";
    }
    try {
      const tx = await d.exchange.setAssetMode(assetId, dec.mode);
      await tx.wait(1, d.waitTimeoutMs ?? 120_000);
      log(`  → marketOperator ${symbol}: ${dec.reason} ✓ ${tx.hash}`);
      return "ok";
    } catch (e) {
      if (d.isTimeout(e)) {
        error(`::error::${symbol} setAssetMode(${modeName(dec.mode)}) 等確認逾時，狀態未知`);
        return "unknown";
      }
      error(`::error::${symbol} setAssetMode(${modeName(dec.mode)}) 失敗：${(e as Error).message.slice(0, 140)}`);
      return "failed";
    }
  }

  /** 收緊（round.ts 的 beforeAsset）。 */
  const tighten = (symbol: string, assetId: string, feed: { value: number | null; quoteAgeSec?: number }) =>
    apply(symbol, assetId, "tighten", { quoteAgeSec: feed.quoteAgeSec, sourceOk: feed.value !== null });

  /** 放寬：只對 priced；逾時就停（nonce 狀態未知）。回傳要加進 failed 的次數。 */
  async function loosenPass(priced: readonly { symbol: string; assetId: string; quoteAgeSec?: number }[]): Promise<number> {
    let failed = 0;
    for (const p of priced) {
      const r = await apply(p.symbol, p.assetId, "loosen", { quoteAgeSec: p.quoteAgeSec });
      if (r !== "ok") failed += 1;
      if (r === "unknown") break;
    }
    return failed;
  }

  return {
    prepare,
    tighten,
    loosenPass,
    get state() {
      return state;
    },
  };
}

/**
 * 此刻（含收盤提前量）依收緊規則屬休市、應該是 ReduceOnly 的資產。只看行事曆（不打 Yahoo），
 * 用於警告文字與保護中資產的分類。
 */
export function closedForTrading(symbols: readonly string[], nowSec: number, leadSec: number): string[] {
  return symbols.filter(
    (s) =>
      decideAssetMode({ phase: "tighten", symbol: s, nowSec, currentMode: ASSET_MODE.Active, session: null, leadSec })
        .action === "set",
  );
}

/**
 * 審查 M2：交易所非 Active 的資產分兩類。
 *   protected — 熔斷或 guardian 造成的保護（Halted、guardian 上鎖、或此刻不是休市卻 ReduceOnly）：
 *               擋住熔斷 issue 自動關閉。
 *   closed    — 休市造成的 ReduceOnly（可切換資產、此刻休市、沒上鎖）：開盤後 keeper 會自動
 *               放寬，不算保護中。
 * 舊 exchange 沒有 assetMode → 兩者都空。單一資產讀失敗時保守地列為 protected "(unknown)"。
 */
export async function classifyProtected(a: {
  symbols: readonly string[];
  exchange: Pick<ExchangeModeLike, "assetMode" | "guardianLocked">;
  assetIdOf: (symbol: string) => string;
  nowSec: number;
  leadSec: number;
  revertInfo: (e: unknown) => { code?: unknown; data?: unknown };
}): Promise<{ protected: string[]; closed: string[] }> {
  const out = { protected: [] as string[], closed: [] as string[] };
  const closedNow = new Set(closedForTrading(a.symbols, a.nowSec, a.leadSec));
  for (const symbol of a.symbols) {
    const id = a.assetIdOf(symbol);
    let m: number;
    try {
      m = Number(await a.exchange.assetMode(id));
    } catch (e) {
      if (classifyProbeError(a.revertInfo(e)) === "missing") return { protected: [], closed: [] };
      out.protected.push(`${symbol}(unknown)`);
      continue;
    }
    if (m === ASSET_MODE.Active) continue;
    if (m === ASSET_MODE.ReduceOnly && closedNow.has(symbol)) {
      let locked = true;
      try {
        locked = await a.exchange.guardianLocked(id);
      } catch {
        locked = true; // 讀不到就當上鎖（保守：擋住自動關閉）
      }
      if (!locked) {
        out.closed.push(`${symbol}(休市)`);
        continue;
      }
      out.protected.push(`${symbol}(ReduceOnly,guardian 上鎖)`);
      continue;
    }
    out.protected.push(`${symbol}(${modeName(m)})`);
  }
  return out;
}
