// 回放的進度：哪些動作已經送出、每一天落在哪些區塊（#344）。
//
// 公開鏈不能重來：中斷之後重新執行，必須從最後完成的那一天接著跑，而且已經送出的交易不能再送一次。
// 所以每個動作都有一個在排程裡唯一的鍵（例如 "open:13:sBTC"），送出前先查進度、廣播後立刻記下交易雜湊。
// 重新執行時：
//   - 已確認的動作直接跳過（回傳記下的雜湊，呼叫端可以向節點讀回收據）；
//   - 只記到「已送出」的動作先向節點問結果：上鏈了就記成已確認，節點根本不知道這筆就當作沒送過；
//   - 依賴當下鏈上狀態的決定（這一天要平掉哪些部位、開多少保證金）也記在進度裡，續跑時沿用，
//     不會因為一半的交易已經上鏈而算出不同的數字。
// 本機模式用記憶體裡的進度（不寫檔），行為與改版前相同：每個動作恰好執行一次。

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const PROGRESS_SCHEMA = 1;

export type EntryStatus = "sent" | "ok" | "failed";

export interface Entry {
  status: EntryStatus;
  hash?: string;
  nonce?: number;
  from?: string;
}

/** 一個模擬日落在哪些區塊。toTimestamp 是那一天最後一個區塊的時間，分析估值用。 */
export interface DayRange {
  date: string;
  fromBlock: number;
  toBlock: number;
  toTimestamp: number;
}

export interface Stats {
  sent: number;
  failed: number;
  failures: string[];
  skipped: string[];
}

export interface ProgressDoc {
  schemaVersion: number;
  chainId: number;
  /** 排程與部署的指紋：續跑時必須一樣，否則是另一次回放的進度。 */
  identity: Record<string, string>;
  setupFromBlock: number | null;
  setupDone: boolean;
  setup: Record<string, Entry>;
  plans: Record<string, unknown>;
  days: DayRange[];
  current: { date: string; fromBlock: number; entries: Record<string, Entry>; plans: Record<string, unknown> } | null;
  /** 每天結束時的未平倉部位（清算檢查與造市帳號用），續跑時從這裡接回。 */
  open: unknown;
  stats: Stats;
  /** 只記一次的跳過原因（同一個鍵續跑時不會重複記）。 */
  skippedKeys: string[];
}

export function emptyProgress(chainId: number, identity: Record<string, string>): ProgressDoc {
  return {
    schemaVersion: PROGRESS_SCHEMA, chainId, identity,
    setupFromBlock: null, setupDone: false, setup: {}, plans: {},
    days: [], current: null, open: [],
    stats: { sent: 0, failed: 0, failures: [], skipped: [] }, skippedKeys: [],
  };
}

/** 進度存在哪裡：公開鏈寫檔（先寫暫存檔再改名，斷電也不會留下半個 JSON），本機只在記憶體。 */
export interface ProgressStore {
  load(): ProgressDoc | null;
  save(doc: ProgressDoc): void;
}

export const memoryStore = (): ProgressStore => {
  let kept: ProgressDoc | null = null;
  return { load: () => kept, save: (doc) => { kept = doc; } };
};

export const fileStore = (path: string): ProgressStore => ({
  load: () => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ProgressDoc) : null),
  save: (doc) => {
    writeFileSync(`${path}.tmp`, JSON.stringify(doc) + "\n");
    renameSync(`${path}.tmp`, path);
  },
});

/** 已送出、但結果不明的交易向節點問到的答案。 */
export type Resolution = "ok" | "failed" | "pending" | "unknown";

export class Journal {
  readonly doc: ProgressDoc;
  constructor(private readonly store: ProgressStore, chainId: number, identity: Record<string, string>) {
    const loaded = store.load();
    if (loaded) {
      if (loaded.schemaVersion !== PROGRESS_SCHEMA) throw new Error(`progress schema ${loaded.schemaVersion}, expected ${PROGRESS_SCHEMA}`);
      if (loaded.chainId !== chainId) throw new Error(`progress is for chainId ${loaded.chainId}, this node is ${chainId}`);
      for (const [k, v] of Object.entries(identity)) {
        if (loaded.identity[k] !== v) throw new Error(`progress belongs to another replay: ${k} is ${loaded.identity[k]}, now ${v}`);
      }
      this.doc = loaded;
    } else {
      this.doc = emptyProgress(chainId, identity);
    }
  }

  save(): void {
    this.store.save(this.doc);
  }

  /** 目前這一段（初始化或某一天）的動作表。 */
  private get entries(): Record<string, Entry> {
    return this.doc.current ? this.doc.current.entries : this.doc.setup;
  }

  private get plans(): Record<string, unknown> {
    return this.doc.current ? this.doc.current.plans : this.doc.plans;
  }

  entry(key: string): Entry | undefined {
    return this.entries[key];
  }

  /** 第一次算出來的決定記下來；續跑時沿用，不重算。 */
  plan<T>(key: string, compute: () => Promise<T>, encode: (v: T) => unknown, decode: (raw: unknown) => T): Promise<T> {
    if (key in this.plans) return Promise.resolve(decode(this.plans[key]));
    return compute().then((value) => {
      this.plans[key] = encode(value);
      this.save();
      return value;
    });
  }

  markSent(key: string, hash: string, from: string, nonce?: number): void {
    this.entries[key] = { status: "sent", hash, from, ...(nonce === undefined ? {} : { nonce }) };
    this.doc.stats.sent += 1;
    this.save();
  }

  /** 連廣播都沒成功（估 gas 就 revert）：也算一筆送出、一筆失敗，與改版前的計數相同。 */
  markRejected(key: string, label: string, message: string): void {
    this.entries[key] = { status: "failed" };
    this.doc.stats.sent += 1;
    this.fail(label, message);
  }

  markResult(key: string, ok: boolean, label: string, message = ""): void {
    const e = this.entries[key];
    if (!e) throw new Error(`markResult before markSent: ${key}`);
    e.status = ok ? "ok" : "failed";
    if (!ok) this.fail(label, message);
    else this.save();
  }

  private fail(label: string, message: string): void {
    this.doc.stats.failed += 1;
    if (this.doc.stats.failures.length < 50) this.doc.stats.failures.push(`${label}: ${message.slice(0, 160)}`);
    this.save();
  }

  /** 跳過的動作只記一次。 */
  skip(key: string, message: string): void {
    if (this.doc.skippedKeys.includes(key)) return;
    this.doc.skippedKeys.push(key);
    this.doc.stats.skipped.push(message);
    this.save();
  }

  /** 續跑前：把只記到「已送出」的動作問清楚。unknown（節點不知道這筆）就刪掉，讓它重送。 */
  async resolvePending(resolve: (e: Entry) => Promise<Resolution>): Promise<{ resolved: number; dropped: number }> {
    let resolved = 0;
    let dropped = 0;
    for (const [key, e] of Object.entries(this.entries)) {
      if (e.status !== "sent") continue;
      let r = await resolve(e);
      while (r === "pending") {
        await new Promise((ok) => setTimeout(ok, 2000));
        r = await resolve(e);
      }
      if (r === "unknown") {
        delete this.entries[key];
        this.doc.stats.sent -= 1;
        dropped += 1;
      } else {
        e.status = r;
        if (r === "failed") this.fail(key, `reverted: ${e.hash}`);
        resolved += 1;
      }
    }
    this.save();
    return { resolved, dropped };
  }

  // ── 初始化與逐日 ──────────────────────────────────────────────────────────

  startSetup(fromBlock: number): void {
    if (this.doc.setupFromBlock === null) {
      this.doc.setupFromBlock = fromBlock;
      this.save();
    }
  }

  finishSetup(): void {
    this.doc.setupDone = true;
    this.save();
  }

  /** 第一個還沒完成的模擬日（全部完成時等於 dates.length）。 */
  nextDay(dates: readonly string[]): number {
    const done = this.doc.days.length;
    for (let i = 0; i < done; i++) {
      if (this.doc.days[i].date !== dates[i]) throw new Error(`progress day ${i} is ${this.doc.days[i].date}, schedule says ${dates[i]}`);
    }
    if (this.doc.current && this.doc.current.date !== dates[done]) {
      throw new Error(`progress has ${this.doc.current.date} in flight, schedule's next day is ${dates[done]}`);
    }
    return done;
  }

  /** 開始（或接續）一天。接續時沿用第一次開始時記下的起始區塊。 */
  startDay(date: string, fromBlock: number): { resumed: boolean } {
    if (this.doc.current) {
      if (this.doc.current.date !== date) throw new Error(`startDay(${date}) while ${this.doc.current.date} is in flight`);
      return { resumed: true };
    }
    this.doc.current = { date, fromBlock, entries: {}, plans: {} };
    this.save();
    return { resumed: false };
  }

  /** 這一天的動作全部做完：記下區塊範圍與當下的未平倉部位，清掉這一天的動作表。 */
  finishDay(toBlock: number, toTimestamp: number, open: unknown): DayRange {
    const c = this.doc.current;
    if (!c) throw new Error("finishDay without startDay");
    const range = { date: c.date, fromBlock: c.fromBlock, toBlock, toTimestamp };
    this.doc.days.push(range);
    this.doc.open = open;
    this.doc.current = null;
    this.save();
    return range;
  }

  /** 這一段已記下的交易（依記錄順序），續跑時讀回收據、接回未平倉部位。 */
  sentHashes(): string[] {
    return Object.values(this.entries).filter((e) => e.hash && e.status !== "sent").map((e) => e.hash!);
  }
}

/** 區塊 → 模擬日。不在任何一天的範圍裡就是 null（例如初始化階段的交易）。 */
export function dayOfBlock(days: readonly DayRange[], block: number): string | null {
  let lo = 0;
  let hi = days.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (block < days[mid].fromBlock) hi = mid - 1;
    else if (block > days[mid].toBlock) lo = mid + 1;
    else return days[mid].date;
  }
  return null;
}
