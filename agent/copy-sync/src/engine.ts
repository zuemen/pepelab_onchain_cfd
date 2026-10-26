// 一輪同步：掃事件 → 找出該檢查的 record → 讀鏈上狀態 → 模擬 → 送出 resyncFor → 記錄／通知。
//
// 這個檔案不碰 ethers 與網路，所有鏈上讀寫都經過 ChainReads／Executor 兩個介面（chain.ts 是
// 實作），單元測試用記憶體裡的假合約跑完整流程（engine.test.ts）。
//
// 「要不要同步」永遠由合約決定：執行者在送出前一定先模擬（staticCall），模擬成功才送；
// 模擬被拒就把理由分類、排下一次重試。合約也保證陌生人只能把部位調成交易者鏈上最新版、
// 而且已是最新版時 revert AlreadySynced，所以這裡任何判斷錯誤的最壞結果只是白花 gas。
import { ethers } from "ethers";
import { COPY_TRACKER_ABI, STRATEGY_REGISTRY_ABI } from "./abi.ts";
import { CATEGORY_LABEL, classifyRevert, isRevert, nextRetryAt, type RevertCategory, type RevertInfo } from "./errors.ts";
import { scanLogs, type LogFilter, type LogSource, type RawLog } from "./logs.ts";
import { errText, makeRedactor, type Logger, type Redactor } from "./log.ts";
import type { NotifyKind, Notifier, NotifyPayload } from "./notify.ts";
import { pruneState, recordKey, type CopySyncState, type WatchEntry } from "./state.ts";

// ── 介面 ─────────────────────────────────────────────────────────────────────

export interface CopyRecordView {
  trader: string;
  versionId: bigint;
  active: boolean;
  positionIds: readonly bigint[];
  deployedAmount: bigint;
}

export interface SyncConfigView {
  autoSync: boolean;
  maxLeverage: number;
  minSyncInterval: number;
  tipWei: bigint;
  /** 跟隨者指定的唯一第三方執行者（syncExecutor，小寫）；null = 任何人。 */
  executor: string | null;
}

export interface ResyncedEvent {
  follower: string;
  recordIdx: number;
  trader: string;
  fromVersion: number;
  toVersion: number;
  executor: string;
  redeployedMargin: bigint;
  legs: number;
}

export interface ChainReads extends LogSource {
  blockNumber(): Promise<number>;
  /** 最新區塊的時間戳（秒）。冷卻用鏈上時間判斷，不用本機時鐘（Anvil 可能被快轉）。 */
  blockTimestamp(): Promise<number>;
  copyRecords(follower: string): Promise<CopyRecordView[]>;
  /** followersByTrader 去重後的清單（既有合約會重複 push 同一位跟隨者）。 */
  followersOf(trader: string): Promise<string[]>;
  syncConfig(follower: string, recordIdx: number): Promise<SyncConfigView>;
  /** 第三方最早可以同步的時間（合約 syncReadyAt：上次同步或跟單當下 ＋ minSyncInterval）。 */
  syncReadyAt(follower: string, recordIdx: number): Promise<number>;
  /** 交易者鏈上最新版本；沒有任何策略時回 null。 */
  latestVersion(follower: string, recordIdx: number, trader: string): Promise<bigint | null>;
}

export interface SentTx {
  hash: string;
}

export interface TxOutcome {
  status: "success" | "reverted";
  resynced: ResyncedEvent | null;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

export interface Executor {
  /** 執行者位址；dry-run 沒有金鑰時是 null（模擬改用零位址當 from）。 */
  address: string | null;
  /**
   * staticCall resyncFor；被拒時丟出含 revert data 的錯誤。`as`：改用這個地址當 from 模擬
   * （dry-run 沒有金鑰、跟隨者指定了執行者時，以那個執行者的身分模擬）。
   */
  simulate(follower: string, recordIdx: number, as?: string): Promise<void>;
  /** 估 gas 與目前的 gas 價格（送出前檢查上限、記錄小費是否划算）。 */
  quote(follower: string, recordIdx: number): Promise<{ gas: bigint; gasPriceWei: bigint }>;
  send(follower: string, recordIdx: number, gas: bigint): Promise<SentTx>;
  /** 等確認；逾時回 null（狀態未知）。 */
  wait(tx: SentTx, timeoutMs: number): Promise<TxOutcome | null>;
  /**
   * 放棄等待一筆狀態未知的交易時呼叫：丟掉本機追蹤的 nonce，下一筆重新向節點對齊。
   * 那筆交易若已從 mempool 消失，不重新對齊的話下一筆會排在一個永遠補不上的 nonce 缺口後面。
   */
  resetNonce?(): void;
}

export interface EngineConfig {
  mode: "public" | "personal";
  /** personal 模式服務的跟隨者（小寫）；public 模式為空。 */
  followers: readonly string[];
  chainId: number;
  copyTracker: string;
  registry: string;
  dryRun: boolean;
  /**
   * 只通知模式（--notify-only，personal 模式）：與 dryRun 一樣不送交易（呼叫端兩者都設 true），
   * 但模擬會成功時也送一次 new-version 通知——沒有人會送出同步、也就不會有 resynced 通知，
   * 本人只能從這裡知道有新版。狀態檔照常寫，通知去重跨執行有效。
   */
  notifyOnly?: boolean;
  /** 只掃到 head − confirmations（避開短暫分叉；事件只是提示，漏掉也有重掃補上）。 */
  confirmations: number;
  /** 第一次執行（狀態檔沒有游標）時從哪一塊開始；null＝往回 lookbackBlocks。 */
  startBlock: number | null;
  lookbackBlocks: number;
  /** 多久全面重掃一次追蹤中的 record（鏈上秒）。 */
  rescanIntervalSec: number;
  /** public 模式：小費低於這個值的 record 不服務（personal 模式不看）。 */
  minTipWei: bigint;
  /** gas 價格上限；超過就延後（null＝不限）。 */
  maxGasPriceWei: bigint | null;
  /** 一輪最多送幾筆交易（避免一次燒光熱錢包）。 */
  maxSendsPerRound: number;
  txTimeoutMs: number;
  chunkSize?: number;
}

export interface EngineDeps {
  cfg: EngineConfig;
  reads: ChainReads;
  exec: Executor;
  state: CopySyncState;
  /** 存檔（dry-run 傳空函式）。每段事件處理完、每筆 record 狀態改變後都會呼叫。 */
  persist: (s: CopySyncState) => void;
  log: Logger;
  notify: Notifier;
  shouldStop?: () => boolean;
  /** 測試用：取代重試等待。 */
  sleep?: (ms: number) => Promise<void>;
  /**
   * 遮蔽秘密（run.ts 傳入含指令列 RPC／webhook 網址的版本）。寫進狀態檔與通知的錯誤文字都先經過它：
   * ethers 的 RPC 錯誤（HTTP 429／503）訊息會帶完整的 requestUrl，含 API 金鑰。預設只遮環境變數裡的秘密。
   */
  redact?: Redactor;
}

export interface RoundReport {
  head: number;
  scannedFrom: number;
  scannedTo: number;
  events: number;
  inspected: number;
  evaluated: number;
  simulatedOk: number;
  sent: number;
  synced: number;
  blocked: number;
  txFailed: number;
  unconfirmed: number;
  rpcErrors: number;
  scanError: string | null;
}

// ── 事件 ─────────────────────────────────────────────────────────────────────

const TRACKER_IFACE = new ethers.Interface(COPY_TRACKER_ABI as unknown as string[]);
const REGISTRY_IFACE = new ethers.Interface(STRATEGY_REGISTRY_ABI as unknown as string[]);
const topicOf = (iface: ethers.Interface, name: string) => iface.getEvent(name)!.topicHash.toLowerCase();

/** CopyTracker 上會讓某位跟隨者「該重新檢查」的事件（topic1 都是 indexed follower）。 */
export const FOLLOWER_EVENT_TOPICS: Record<string, string> = {
  [topicOf(TRACKER_IFACE, "AutoSyncSet")]: "AutoSyncSet",
  [topicOf(TRACKER_IFACE, "Resynced")]: "Resynced",
  [topicOf(TRACKER_IFACE, "SyncGasDeposited")]: "SyncGasDeposited",
  [topicOf(TRACKER_IFACE, "TraderFollowed")]: "TraderFollowed",
  [topicOf(TRACKER_IFACE, "TraderUnfollowed")]: "TraderUnfollowed",
  [topicOf(TRACKER_IFACE, "SyncExecutorSet")]: "SyncExecutorSet",
};
export const STRATEGY_PUBLISHED_TOPIC = topicOf(REGISTRY_IFACE, "StrategyPublished");

/** topic 裡的 32 位元組 → 地址；格式不對回 null。 */
export function addressFromTopic(t: string | undefined): string | null {
  if (!t || !/^0x0{24}[0-9a-fA-F]{40}$/.test(t)) return null;
  return ethers.getAddress(`0x${t.slice(26)}`).toLowerCase();
}

const padTopic = (addr: string) => ethers.zeroPadValue(addr.toLowerCase(), 32).toLowerCase();

/**
 * 這一輪 getLogs 的 filter。personal 模式用 topic1 把範圍縮到自己的跟隨者與他們跟的交易者
 * （同一個 OR 集合；交易者剛好也是某位跟隨者時多掃到的事件無害）。
 */
export function buildFilter(cfg: Pick<EngineConfig, "mode" | "followers" | "copyTracker" | "registry">, traders: readonly string[]): LogFilter {
  const topic0 = [...Object.keys(FOLLOWER_EVENT_TOPICS), STRATEGY_PUBLISHED_TOPIC];
  const address = [cfg.copyTracker, cfg.registry];
  if (cfg.mode === "public") return { address, topics: [topic0] };
  const who = [...new Set([...cfg.followers, ...traders].map((a) => padTopic(a)))];
  return { address, topics: [topic0, who] };
}

// ── 引擎 ─────────────────────────────────────────────────────────────────────

interface PendingWork {
  /** 事件觸發：重設退避、這一輪就檢查。 */
  urgentFollowers: Set<string>;
  /** 定期重掃：更新設定，但被擋的 record 仍照退避時間。 */
  rescanFollowers: Set<string>;
  traders: Set<string>;
}

/** 狀態未知的交易在這段時間內不重送（鏈上秒）。 */
export const UNCONFIRMED_HOLD_SEC = 600;

const NOTIFY_CATEGORIES: ReadonlySet<RevertCategory> = new Set(["gas", "consent", "kyc", "market", "capacity", "trader", "config", "unknown"]);

export class CopySyncEngine {
  private readonly d: EngineDeps;
  private readonly redact: Redactor;
  private recordCache = new Map<string, CopyRecordView[]>();
  private warnedSelf = false;
  /** 這一輪送出的通知；回合結束前全部等完（--once 不會在通知送出前就結束行程）。 */
  private inflight: Promise<void>[] = [];

  private track(p: Promise<void>): void {
    this.inflight.push(p);
  }

  constructor(d: EngineDeps) {
    this.d = d;
    this.redact = d.redact ?? makeRedactor([]);
  }

  get state(): CopySyncState {
    return this.d.state;
  }

  private get q(): { followers: string[]; traders: string[] } {
    const s = this.d.state;
    if (!s.queue) s.queue = { followers: [], traders: [] };
    return s.queue;
  }

  private save(): void {
    this.d.persist(this.d.state);
  }

  private isMine(follower: string): boolean {
    return this.d.cfg.mode === "public" || this.d.cfg.followers.includes(follower.toLowerCase());
  }

  private isSelf(follower: string): boolean {
    const me = this.d.exec.address;
    return !!me && me.toLowerCase() === follower.toLowerCase();
  }

  /**
   * 本執行者不能代為同步這筆跟單的理由（合約會拒絕的那兩種）；可以就回 null。
   *  - 自動同步關閉：合約只讓跟隨者本人同步；
   *  - 跟隨者指定了別的執行者（syncExecutor）：合約只讓那個地址同步。
   * dry-run 沒有金鑰（address = null）時，personal 模式把指定的執行者當成自己（模擬改用它當 from），
   * public 模式則一律視為別人的。
   */
  private unserviceable(sc: SyncConfigView): string | null {
    if (!sc.autoSync) return "自動同步未開啟";
    if (sc.executor === null) return null;
    const me = this.d.exec.address?.toLowerCase() ?? null;
    if (me === null) return this.d.cfg.mode === "personal" ? null : `跟隨者指定了其他執行者 ${sc.executor}`;
    return sc.executor === me ? null : `跟隨者指定的執行者是 ${sc.executor}，不是本執行者`;
  }

  async runRound(): Promise<RoundReport> {
    const { cfg, reads, log } = this.d;
    this.recordCache.clear();
    const r: RoundReport = {
      head: 0, scannedFrom: 0, scannedTo: 0, events: 0, inspected: 0, evaluated: 0, simulatedOk: 0,
      sent: 0, synced: 0, blocked: 0, txFailed: 0, unconfirmed: 0, rpcErrors: 0, scanError: null,
    };
    const head = await reads.blockNumber();
    const now = await reads.blockTimestamp();
    r.head = head;
    const safeHead = Math.max(0, head - cfg.confirmations);
    const st = this.d.state;

    if (st.lastBlock < 0) {
      const from = cfg.startBlock ?? Math.max(0, safeHead - cfg.lookbackBlocks);
      st.lastBlock = from - 1;
      log.info(`第一次執行：從區塊 ${from} 開始掃描（head ${head}）`);
      // 第一次執行一定做一次全面檢查（personal 模式會直接讀自己的跟隨紀錄）。
      st.lastRescanAt = 0;
    }

    // 1) 掃事件。每段處理完就把待辦存進狀態檔、推進游標。
    r.scannedFrom = st.lastBlock + 1;
    r.scannedTo = st.lastBlock;
    if (st.lastBlock < safeHead) {
      const traders = cfg.mode === "personal" ? this.watchedTraders() : [];
      const res = await scanLogs(
        reads,
        buildFilter(cfg, traders),
        st.lastBlock + 1,
        safeHead,
        (logs, _a, b) => {
          for (const l of logs) this.enqueueFromLog(l);
          r.events += logs.length;
          st.lastBlock = b;
          this.save();
        },
        { chunkSize: cfg.chunkSize, shouldStop: this.d.shouldStop, sleep: this.d.sleep },
      );
      r.scannedTo = res.scannedTo;
      if (res.error !== undefined) {
        r.scanError = `區塊 ${res.scannedTo + 1} 之後的事件讀取失敗：${errText(res.error, this.redact, 300)}`;
        log.warn(`${r.scanError}（游標停在 ${res.scannedTo}，下一輪從這裡繼續）`);
      }
    }

    // 2) 交易者發了新版 → 找出跟隨者。
    const work: PendingWork = { urgentFollowers: new Set(), rescanFollowers: new Set(), traders: new Set() };
    for (const f of this.q.followers) work.urgentFollowers.add(f);
    for (const t of this.q.traders) work.traders.add(t);
    for (const trader of [...work.traders]) {
      if (this.d.shouldStop?.()) break;
      try {
        const fs = cfg.mode === "personal" ? [] : await reads.followersOf(trader);
        for (const f of fs) work.urgentFollowers.add(f.toLowerCase());
        // personal 模式不必掃 followersByTrader：直接看自己的跟隨者裡誰跟這位交易者。
        for (const e of Object.values(st.records)) {
          if (e.trader.toLowerCase() === trader && e.status !== "dropped") work.urgentFollowers.add(e.follower.toLowerCase());
        }
        if (cfg.mode === "personal") for (const f of cfg.followers) work.urgentFollowers.add(f);
        this.q.traders = this.q.traders.filter((x) => x !== trader);
        this.save();
      } catch (e) {
        r.rpcErrors += 1;
        log.warn(`讀不到交易者 ${trader} 的跟隨者清單，下一輪再試：${(e as Error).message}`);
      }
    }

    // 3) 定期全面重掃。
    if (now - st.lastRescanAt >= cfg.rescanIntervalSec) {
      if (cfg.mode === "personal") for (const f of cfg.followers) work.rescanFollowers.add(f);
      for (const e of Object.values(st.records)) if (e.status !== "dropped") work.rescanFollowers.add(e.follower.toLowerCase());
      st.lastRescanAt = now;
    }

    // 4) 讀跟隨紀錄與設定，更新追蹤清單。
    const all = new Set([...work.urgentFollowers, ...work.rescanFollowers]);
    for (const f of all) {
      if (this.d.shouldStop?.()) break;
      if (!this.isMine(f)) continue;
      try {
        await this.inspectFollower(f, work.urgentFollowers.has(f), now);
        r.inspected += 1;
        this.q.followers = this.q.followers.filter((x) => x !== f);
        this.save();
      } catch (e) {
        r.rpcErrors += 1;
        log.warn(`讀不到跟隨者 ${f} 的跟單紀錄，下一輪再試：${(e as Error).message}`);
      }
    }

    // 5) 檢查到期的 record（含 personal 模式只通知、不送交易的 manual）。
    const due = Object.values(st.records)
      .filter((e) => e.status !== "dropped" && e.nextCheckAt <= now)
      .sort((a, b) => a.nextCheckAt - b.nextCheckAt);
    for (const e of due) {
      if (this.d.shouldStop?.()) break;
      r.evaluated += 1;
      await this.evaluate(e, now, r);
      this.save();
    }

    pruneState(st, now);
    this.save();
    await Promise.allSettled(this.inflight);
    this.inflight = [];
    return r;
  }

  /** 追蹤中的 record 跟的交易者（personal 模式的 topic 過濾用）。 */
  private watchedTraders(): string[] {
    return [...new Set(Object.values(this.d.state.records).filter((e) => e.status !== "dropped").map((e) => e.trader.toLowerCase()))];
  }

  private enqueueFromLog(l: RawLog): void {
    const t0 = (l.topics[0] ?? "").toLowerCase();
    const who = addressFromTopic(l.topics[1]);
    if (!who) return;
    const addr = l.address.toLowerCase();
    if (t0 === STRATEGY_PUBLISHED_TOPIC && addr === this.d.cfg.registry.toLowerCase()) {
      if (!this.q.traders.includes(who)) this.q.traders.push(who);
      return;
    }
    if (FOLLOWER_EVENT_TOPICS[t0] && addr === this.d.cfg.copyTracker.toLowerCase()) {
      if (!this.isMine(who)) return;
      if (!this.q.followers.includes(who)) this.q.followers.push(who);
    }
  }

  private async records(follower: string): Promise<CopyRecordView[]> {
    const k = follower.toLowerCase();
    const hit = this.recordCache.get(k);
    if (hit) return hit;
    const recs = await this.d.reads.copyRecords(follower);
    this.recordCache.set(k, recs);
    return recs;
  }

  /**
   * 讀一位跟隨者的所有 record：本執行者能代為同步的加入追蹤；結束的標成 dropped。不能代為同步的
   * （自動同步關閉、指定了別的執行者）：public 模式標成 dropped；personal 模式標成 manual——不送交易，
   * 只在交易者發布新版時通知本人（跟隨者自己的 agent 的本分）。
   */
  private async inspectFollower(follower: string, urgent: boolean, now: number): Promise<void> {
    const { reads, state } = this.d;
    const recs = await this.records(follower);
    for (let i = 0; i < recs.length; i++) {
      const rec = recs[i];
      const key = recordKey(follower, i);
      const existing = state.records[key];
      if (!rec.active) {
        if (existing && existing.status !== "dropped") this.drop(existing, "跟單已結束", now);
        continue;
      }
      const cfg = await reads.syncConfig(follower, i);
      const why = this.unserviceable(cfg);
      if (why && this.d.cfg.mode !== "personal") {
        if (existing && existing.status !== "dropped") this.drop(existing, why, now);
        continue;
      }
      const e: WatchEntry = existing ?? {
        follower: follower.toLowerCase(),
        recordIdx: i,
        trader: rec.trader.toLowerCase(),
        autoSync: cfg.autoSync,
        tipWei: "0",
        syncedVersion: null,
        latestVersion: null,
        status: why ? "manual" : "pending",
        nextCheckAt: 0,
        attempts: 0,
        updatedAt: now,
      };
      e.trader = rec.trader.toLowerCase();
      e.autoSync = cfg.autoSync;
      e.tipWei = cfg.tipWei.toString();
      e.syncedVersion = Number(rec.versionId);
      if (why) {
        if (e.status !== "manual") {
          e.status = "manual";
          e.category = undefined;
          e.attempts = 0;
        }
        e.lastReason = why;
        e.nextCheckAt = urgent ? 0 : Math.min(e.nextCheckAt, now);
        e.updatedAt = now;
        state.records[key] = e;
        continue;
      }
      if (e.status === "dropped" || e.status === "manual") {
        e.status = "pending";
        e.attempts = 0;
        e.lastNotified = undefined;
        e.lastReason = undefined;
      }
      // 事件觸發（新版、存入油箱、重新開啟）→ 不管退避，這一輪就檢查。
      // 定期重掃 → 被合約擋下的照原本的重試時間；其他的這一輪檢查一次有沒有新版。
      if (urgent) {
        e.nextCheckAt = 0;
        if (e.status === "blocked" && e.category !== "cooldown") e.attempts = 0;
      } else if (e.status !== "blocked") {
        e.nextCheckAt = Math.min(e.nextCheckAt, now);
      }
      e.updatedAt = now;
      state.records[key] = e;
    }
  }

  private drop(e: WatchEntry, reason: string, now: number): void {
    e.status = "dropped";
    e.autoSync = false;
    e.lastReason = reason;
    e.category = undefined;
    e.nextCheckAt = Number.MAX_SAFE_INTEGER;
    e.updatedAt = now;
    this.d.log.info(`${tag(e)} 停止追蹤：${reason}`);
  }

  private block(e: WatchEntry, info: RevertInfo, now: number, r: RoundReport): void {
    if (info.category === "synced") return this.markSynced(e, now);
    if (info.category === "dropped") return this.drop(e, info.detail, now);
    e.attempts = e.category === info.category ? e.attempts + 1 : 1;
    e.category = info.category;
    e.status = "blocked";
    e.lastReason = info.detail;
    e.nextCheckAt = nextRetryAt(info, now, e.attempts);
    e.updatedAt = now;
    r.blocked += 1;
    const when = new Date(e.nextCheckAt * 1000).toISOString();
    this.d.log.info(`${tag(e)} 暫時無法同步：${info.detail}；下次 ${when}`);
    if (NOTIFY_CATEGORIES.has(info.category)) this.track(this.emit(e, "blocked", info.detail, null, e.nextCheckAt));
  }

  /**
   * personal 模式、本執行者不代為同步的跟單（自動同步關閉，或跟隨者指定了別的執行者）：不送交易，
   * 交易者有新版時通知本人（每一版一次），由本人到投資組合檢視新版內容後手動同步。
   */
  private manual(e: WatchEntry, rec: CopyRecordView, latest: bigint | null, why: string, now: number): void {
    e.status = "manual";
    e.category = undefined;
    e.attempts = 0;
    e.lastReason = why;
    // 下一個 StrategyPublished／AutoSyncSet／SyncExecutorSet 會立刻喚醒；否則等定期重掃。
    e.nextCheckAt = now + this.d.cfg.rescanIntervalSec;
    e.updatedAt = now;
    if (latest !== null && latest > rec.versionId) this.announce(e, Number(latest), null, why);
  }

  /**
   * 交易者發布了新版（只在 personal 模式；同一版只通知一次）。`why` 為 null：自動同步已開啟、正在冷卻，
   * 本執行者會在 `retryAt`（冷卻結束）之後代為同步；否則說明為什麼不代為同步、請本人手動處理。
   */
  private announce(e: WatchEntry, latest: number, retryAt: number | null, why: string | null): void {
    if (e.notifiedVersion !== undefined && e.notifiedVersion >= latest) return;
    e.notifiedVersion = latest;
    const step = versionStep(e.syncedVersion ?? latest, latest);
    // dry-run／只通知模式不送交易：不能說「本執行者會代為同步」。
    const passive = `（本程式${this.d.cfg.notifyOnly ? "是只通知模式" : "是 dry-run"}，不送交易；也可以到投資組合檢視新版內容後按「立即同步」）`;
    const msg = why !== null
      ? `交易者發布了新版：${step}。${why}，本執行者不代為同步；請到投資組合檢視新版內容後按「立即同步」`
      : !this.d.cfg.dryRun
        ? `交易者發布了新版：${step}。自動同步已開啟，本執行者會在冷卻結束後代為同步`
        : retryAt !== null
          ? `交易者發布了新版：${step}。自動同步已開啟，冷卻結束後執行者才能代為同步${passive}`
          : `交易者發布了新版：${step}。自動同步已開啟、模擬同步會成功，等執行者代為同步${passive}`;
    this.track(this.emit(e, "new-version", msg, null, retryAt, e.syncedVersion, latest));
  }

  private markSynced(e: WatchEntry, now: number): void {
    e.status = "synced";
    e.category = undefined;
    e.attempts = 0;
    e.lastReason = undefined;
    e.lastNotified = undefined;
    // 已是最新版：等下一個 StrategyPublished 事件，或定期重掃。
    e.nextCheckAt = now + this.d.cfg.rescanIntervalSec;
    e.updatedAt = now;
  }

  private async evaluate(e: WatchEntry, now: number, r: RoundReport): Promise<void> {
    const { cfg, reads, exec, log } = this.d;
    if (this.isSelf(e.follower)) {
      if (!this.warnedSelf) {
        log.warn(`執行者位址就是跟隨者 ${e.follower}：執行者必須是獨立的熱錢包，略過這位跟隨者的 record`);
        this.warnedSelf = true;
      }
      e.nextCheckAt = Number.MAX_SAFE_INTEGER;
      return;
    }
    // 上一輪送出但沒等到確認的交易：先看它有沒有上鏈，十分鐘內不重送（重送也安全，只是浪費 gas）。
    if (e.status === "unconfirmed" && e.lastTx) {
      const prev = await exec.wait({ hash: e.lastTx }, 1_000).catch(() => null);
      if (prev?.status === "success") {
        r.synced += 1;
        this.markSynced(e, now);
        if (prev.resynced) e.syncedVersion = prev.resynced.toVersion;
        log.info(`${tag(e)} ✓ 上一輪的交易 ${e.lastTx} 已上鏈`);
        return;
      }
      if (!prev && now - e.updatedAt < UNCONFIRMED_HOLD_SEC) {
        e.nextCheckAt = now + 60;
        return;
      }
      if (!prev) {
        log.warn(`${tag(e)} 交易 ${e.lastTx} 超過 ${UNCONFIRMED_HOLD_SEC} 秒仍查不到收據：重新向節點對齊 nonce 後照常判斷`);
        exec.resetNonce?.();
      }
    }
    let rec: CopyRecordView | undefined;
    let sc: SyncConfigView;
    let latest: bigint | null;
    let readyAt: number;
    try {
      rec = (await this.records(e.follower))[e.recordIdx];
      if (!rec || !rec.active) return this.drop(e, "跟單已結束", now);
      sc = await reads.syncConfig(e.follower, e.recordIdx);
      const why = this.unserviceable(sc);
      if (why && cfg.mode !== "personal") return this.drop(e, why, now);
      e.autoSync = sc.autoSync;
      e.tipWei = sc.tipWei.toString();
      latest = await reads.latestVersion(e.follower, e.recordIdx, rec.trader);
      e.syncedVersion = Number(rec.versionId);
      e.latestVersion = latest === null ? null : Number(latest);
      if (why) return this.manual(e, rec, latest, why, now);
      if (latest === null) {
        return this.block(e, { category: "trader", name: "NoStrategyPublished", detail: `交易者尚未發布策略：${CATEGORY_LABEL.trader}` }, now, r);
      }
      if (latest <= rec.versionId) return this.markSynced(e, now);
      readyAt = await reads.syncReadyAt(e.follower, e.recordIdx);
    } catch (err) {
      r.rpcErrors += 1;
      e.nextCheckAt = now + 60;
      log.warn(`${tag(e)} 讀取鏈上狀態失敗，稍後再試：${(err as Error).message}`);
      return;
    }

    // 冷卻（minSyncInterval）：合約也會擋，這裡先問好時間，避免每輪白白模擬。
    if (now < readyAt) {
      // personal 模式：新版要等冷卻結束才會同步——先告訴本人有新版、預計什麼時候同步（每一版一次）。
      // 立刻同步得了的就不另外通知（接著就是 resynced），被合約擋下的走 blocked。
      if (cfg.mode === "personal") this.announce(e, Number(latest), readyAt, null);
      return this.block(e, { category: "cooldown", name: "SyncCooldown", detail: `冷卻中（${CATEGORY_LABEL.cooldown}，到 ${new Date(readyAt * 1000).toISOString()}）`, readyAt }, now, r);
    }
    if (cfg.mode === "public" && sc.tipWei < cfg.minTipWei) {
      // 執行者自己的商業選擇，不是合約拒絕：不通知（其他執行者或本人的 agent 仍可服務）。
      e.status = "blocked";
      e.category = undefined;
      e.lastReason = `小費 ${sc.tipWei} wei 低於本執行者門檻 ${cfg.minTipWei} wei`;
      e.nextCheckAt = now + cfg.rescanIntervalSec;
      e.updatedAt = now;
      log.info(`${tag(e)} 略過：${e.lastReason}`);
      return;
    }

    // dry-run 沒有金鑰、跟隨者指定了執行者（personal 模式）：以那個執行者的身分模擬。
    const simulateAs = exec.address === null && sc.executor !== null ? sc.executor : undefined;
    try {
      await exec.simulate(e.follower, e.recordIdx, simulateAs);
    } catch (err) {
      if (isRevert(err)) return this.block(e, classifyRevert(err), now, r);
      r.rpcErrors += 1;
      e.nextCheckAt = now + 60;
      log.warn(`${tag(e)} 模擬時 RPC 失敗，稍後再試：${(err as Error).message}`);
      return;
    }
    r.simulatedOk += 1;
    const from = Number(rec.versionId);
    const to = Number(latest);

    if (!cfg.dryRun && r.sent >= cfg.maxSendsPerRound) {
      // 本輪的送出額度用完：模擬會成功的留到下一輪（不算失敗、不退避）。
      e.status = "pending";
      e.nextCheckAt = now;
      e.updatedAt = now;
      log.info(`${tag(e)} 本輪已送出 ${r.sent} 筆（--max-sends-per-round 上限），下一輪再送`);
      return;
    }

    if (cfg.dryRun) {
      if (cfg.notifyOnly) {
        log.info(`${tag(e)} [notify-only] 模擬成功：${versionStep(from, to)}，等執行者代為同步（本程式不送交易）`);
        if (cfg.mode === "personal") this.announce(e, to, null, null);
      } else {
        log.info(`${tag(e)} [dry-run] 模擬成功：${versionStep(from, to)}，本來會送出 resyncFor（小費 ${sc.tipWei} wei）`);
      }
      e.status = "pending";
      e.nextCheckAt = now + cfg.rescanIntervalSec;
      e.updatedAt = now;
      return;
    }

    let quote: { gas: bigint; gasPriceWei: bigint };
    try {
      quote = await exec.quote(e.follower, e.recordIdx);
    } catch (err) {
      if (isRevert(err)) return this.block(e, classifyRevert(err), now, r);
      r.rpcErrors += 1;
      e.nextCheckAt = now + 60;
      log.warn(`${tag(e)} 估算 gas 失敗，稍後再試：${(err as Error).message}`);
      return;
    }
    if (cfg.maxGasPriceWei !== null && quote.gasPriceWei > cfg.maxGasPriceWei) {
      e.status = "pending";
      e.lastReason = `gas 價格 ${quote.gasPriceWei} wei 高於上限 ${cfg.maxGasPriceWei} wei`;
      e.nextCheckAt = now + 60;
      e.updatedAt = now;
      log.info(`${tag(e)} 延後：${e.lastReason}`);
      return;
    }
    const gasCost = quote.gas * quote.gasPriceWei;
    log.info(
      `${tag(e)} 送出 resyncFor：${versionStep(from, to)}（預估 gas 成本 ${ethers.formatEther(gasCost)} ETH，` +
        `小費 ${ethers.formatEther(sc.tipWei)} ETH）`,
    );
    // gas 上限多留兩成：模擬與上鏈之間價格或狀態的小幅差異不該讓交易 out-of-gas。
    const gasLimit = (quote.gas * 12n) / 10n;
    let sent: SentTx;
    try {
      sent = await exec.send(e.follower, e.recordIdx, gasLimit);
    } catch (err) {
      r.txFailed += 1;
      e.attempts += 1;
      e.status = "pending";
      // 不能存原始訊息：ethers 的 RPC 錯誤（HTTP 4xx／5xx）會帶含 API 金鑰的 requestUrl，狀態檔可能被
      // 別的帳號或 CI cache 讀到。先遮蔽、截斷。
      e.lastReason = `送出失敗：${errText(err, this.redact)}`;
      e.nextCheckAt = now + Math.min(60 * 2 ** Math.min(e.attempts, 6), 3600);
      e.updatedAt = now;
      log.warn(`${tag(e)} ${e.lastReason}`);
      return;
    }
    r.sent += 1;
    e.lastTx = sent.hash;
    // 送出後換了部位：這位跟隨者的 record 快取作廢。
    this.recordCache.delete(e.follower.toLowerCase());
    const outcome = await exec.wait(sent, cfg.txTimeoutMs).catch((err: unknown) => {
      log.warn(`${tag(e)} 查詢收據失敗：${(err as Error).message}`);
      return null;
    });
    if (!outcome) {
      r.unconfirmed += 1;
      e.status = "unconfirmed";
      e.lastReason = `交易 ${sent.hash} 等確認逾時，狀態未知`;
      e.nextCheckAt = now + 60;
      e.updatedAt = now;
      log.warn(`${tag(e)} ${e.lastReason}（下一輪重新讀鏈上狀態；重送也安全：已是最新版時合約 revert AlreadySynced）`);
      this.track(this.emit(e, "tx-unconfirmed", e.lastReason, sent.hash, e.nextCheckAt));
      return;
    }
    if (outcome.status === "reverted") {
      r.txFailed += 1;
      e.attempts += 1;
      e.status = "pending";
      e.lastReason = `交易 ${sent.hash} 上鏈但 revert（模擬後狀態被改變，例如交易者又發版或市場剛停）`;
      e.nextCheckAt = now + Math.min(60 * 2 ** Math.min(e.attempts, 6), 3600);
      e.updatedAt = now;
      log.warn(`${tag(e)} ${e.lastReason}`);
      this.track(this.emit(e, "tx-failed", e.lastReason, sent.hash, e.nextCheckAt));
      return;
    }
    r.synced += 1;
    const ev = outcome.resynced;
    const toV = ev ? ev.toVersion : to;
    this.markSynced(e, now);
    e.syncedVersion = toV;
    e.latestVersion = Math.max(e.latestVersion ?? toV, toV);
    const spent = outcome.gasUsed * outcome.effectiveGasPrice;
    const detail = ev
      ? `已同步 ${versionStep(ev.fromVersion, ev.toVersion)}：${ev.legs} 條腿，重新部署保證金 ${ethers.formatEther(ev.redeployedMargin)}`
      : `已同步 ${versionStep(from, to)}（收據裡沒有解到 Resynced 事件）`;
    log.info(`${tag(e)} ✓ ${detail}；tx ${sent.hash}，gas 花費 ${ethers.formatEther(spent)} ETH`);
    this.track(this.emit(e, "resynced", detail, sent.hash, null, ev ? ev.fromVersion : from, toV));
  }

  private async emit(
    e: WatchEntry,
    kind: NotifyKind,
    message: string,
    txHash: string | null,
    retryAt: number | null,
    fromVersion: number | null = e.syncedVersion,
    toVersion: number | null = e.latestVersion,
  ): Promise<void> {
    // new-version 由 announce 以版本號去重，不佔用 lastNotified（否則會把「被擋原因」的去重洗掉）。
    if (kind !== "new-version") {
      const sig = `${kind}:${e.category ?? ""}:${kind === "resynced" ? txHash : ""}`;
      if (kind !== "resynced" && e.lastNotified === sig) return;
      e.lastNotified = sig;
    }
    const p: NotifyPayload = {
      source: "pepefi-copy-sync",
      kind,
      chainId: this.d.cfg.chainId,
      copyTracker: this.d.cfg.copyTracker,
      follower: ethers.getAddress(e.follower),
      recordIdx: e.recordIdx,
      trader: ethers.getAddress(e.trader),
      fromVersion,
      toVersion,
      category: kind === "new-version" ? null : e.category ?? null,
      autoSync: e.autoSync,
      message: this.redact(message),
      txHash,
      executor: this.d.exec.address,
      retryAt: retryAt !== null && Number.isFinite(retryAt) && retryAt < Number.MAX_SAFE_INTEGER ? new Date(retryAt * 1000).toISOString() : null,
      at: new Date().toISOString(),
    };
    try {
      await this.d.notify(p);
    } catch {
      /* notifier 自己會記錄失敗 */
    }
  }
}

/**
 * 給人看的版本號：與前端（Portfolio「已同步到 vN」、動態牆「第 N 版」）一致從 1 起算；括號裡是合約的
 * versionId（從 0 起算），方便對照 cast／事件。通知 JSON 的 fromVersion／toVersion 仍是 versionId。
 */
export function versionStep(fromVersionId: number, toVersionId: number): string {
  return `v${fromVersionId + 1} → v${toVersionId + 1}（versionId ${fromVersionId} → ${toVersionId}）`;
}

function tag(e: WatchEntry): string {
  return `[${e.follower.slice(0, 8)}…#${e.recordIdx} ← ${e.trader.slice(0, 8)}…]`;
}

/** 一輪的摘要（一行）。 */
export function summarize(r: RoundReport): string {
  return (
    `head=${r.head} scanned=${r.scannedFrom}..${r.scannedTo} events=${r.events} inspected=${r.inspected} ` +
    `evaluated=${r.evaluated} simulatedOk=${r.simulatedOk} sent=${r.sent} synced=${r.synced} blocked=${r.blocked} ` +
    `txFailed=${r.txFailed} unconfirmed=${r.unconfirmed} rpcErrors=${r.rpcErrors}`
  );
}

/** --once 的結束碼：讀取失敗、交易失敗或狀態未知 → 1（讓 cron／CI 變紅）；被合約擋下不算錯。 */
export function exitCodeOf(r: RoundReport): number {
  return r.scanError || r.rpcErrors > 0 || r.txFailed > 0 || r.unconfirmed > 0 ? 1 : 0;
}
