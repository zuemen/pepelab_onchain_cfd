// x402-copy-agent 的判斷邏輯與流程（不碰金鑰、不開連線以外的東西，全部可離線測試）。
// 進入點與接線在 x402-copy-agent.ts；說明在 x402-copy-agent.md。
//
// 原則：
//   - webhook 內容不可信（本機任何程式都能 POST）。花錢前一律先讀鏈確認，通知只是「該去看一下」的訊號。
//   - 同步與否由合約決定：模擬與錯誤分類沿用 copy-sync（chain.ts 的 Executor、errors.ts 的 classifyRevert）。
//   - 付費前先做免費的檢查，已知同步不了就不花錢；付費後再檢查一次，因為鏈上狀態可能已經變了。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { dirname } from "node:path";
import { ethers } from "ethers";
import type { ChainReads, Executor } from "../copy-sync/src/engine.ts";
import { versionStep } from "../copy-sync/src/engine.ts";
import { CATEGORY_LABEL, classifyRevert, isRevert, type RevertCategory } from "../copy-sync/src/errors.ts";
import { errText, type Redactor } from "../copy-sync/src/log.ts";
import { formatUsdcAtomic, X402_PAYMENT_HEADERS, type PaymentMeter } from "../shared/src/x402Client.ts";

// ── 通知驗證 ────────────────────────────────────────────────────────────────

export interface AgentConfig {
  chainId: number;
  copyTracker: string;
  /** --followers 白名單（小寫）。 */
  followers: readonly string[];
}

/** 驗證過的 new-version 通知；地址一律小寫。 */
export interface NewVersionNotice {
  chainId: number;
  follower: string;
  recordIdx: number;
  trader: string;
  fromVersion: number | null;
  toVersion: number;
  autoSync: boolean;
}

export interface BlockedNotice {
  follower: string;
  recordIdx: number;
  trader: string;
  category: RevertCategory;
}

export type Admission =
  | { kind: "accept"; notice: NewVersionNotice }
  /** copy-sync 模擬被擋時只送 blocked、不送 new-version：印原因與建議，不付費、不送交易。 */
  | { kind: "blocked"; notice: BlockedNotice }
  /** 形狀正確、但不是要處理的通知種類（resynced…）。 */
  | { kind: "ignore"; reason: string }
  | { kind: "reject"; status: 400 | 403; reason: string };

const OTHER_KINDS = new Set(["resynced", "dropped", "tx-failed", "tx-unconfirmed"]);
const isVersion = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isHexAddress = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isZero = (a: string) => a === ethers.ZeroAddress;

/** 驗證 webhook 的 JSON（notify.ts 的 NotifyPayload）與白名單。回傳的 reason 不含收到的原始內容。 */
export function admitNotification(body: unknown, cfg: AgentConfig): Admission {
  const bad = (reason: string): Admission => ({ kind: "reject", status: 400, reason });
  if (!body || typeof body !== "object" || Array.isArray(body)) return bad("內容不是 JSON 物件");
  const p = body as Record<string, unknown>;
  if (p.source !== "pepefi-copy-sync") return bad("source 不是 pepefi-copy-sync");
  if (typeof p.kind !== "string") return bad("缺 kind");
  if (OTHER_KINDS.has(p.kind)) return { kind: "ignore", reason: "不是新版通知" };
  if (p.kind !== "new-version" && p.kind !== "blocked") return bad("未知的 kind");
  if (!isHexAddress(p.follower) || !isHexAddress(p.trader) || !isHexAddress(p.copyTracker)) return bad("地址欄位格式不對");
  const follower = p.follower.toLowerCase();
  const trader = p.trader.toLowerCase();
  if (isZero(follower) || isZero(trader)) return bad("地址不能是零地址");
  if (!isVersion(p.recordIdx)) return bad("recordIdx 必須是非負整數");
  if (typeof p.chainId !== "number") return bad("chainId 必須是數字");
  if (p.kind === "new-version") {
    if (!isVersion(p.toVersion)) return bad("toVersion 必須是非負整數");
    if (p.fromVersion !== null && !isVersion(p.fromVersion)) return bad("fromVersion 必須是非負整數或 null");
    if (p.fromVersion !== null && p.fromVersion >= p.toVersion) return bad("fromVersion 必須小於 toVersion");
    if (typeof p.autoSync !== "boolean") return bad("autoSync 必須是布林值");
  } else if (typeof p.category !== "string" || !Object.hasOwn(CATEGORY_LABEL, p.category)) {
    return bad("category 不是已知的分類");
  }
  if (p.retryAt !== null && (typeof p.retryAt !== "string" || Number.isNaN(Date.parse(p.retryAt)))) {
    return bad("retryAt 必須是時間字串或 null");
  }
  if (p.chainId !== cfg.chainId) return bad(`chainId 與這個 agent 連的鏈（${cfg.chainId}）不同`);
  if (p.copyTracker.toLowerCase() !== cfg.copyTracker.toLowerCase()) return bad("copyTracker 與這個 agent 連的合約不同");
  if (!cfg.followers.includes(follower)) return { kind: "reject", status: 403, reason: "跟隨者不在 --followers 白名單" };
  if (p.kind === "blocked") {
    return { kind: "blocked", notice: { follower, recordIdx: p.recordIdx, trader, category: p.category as RevertCategory } };
  }
  return {
    kind: "accept",
    notice: {
      chainId: p.chainId, follower, recordIdx: p.recordIdx, trader,
      fromVersion: p.fromVersion as number | null, toVersion: p.toVersion as number, autoSync: p.autoSync as boolean,
    },
  };
}

// ── 去重紀錄（寫檔，重啟後不重複付款）────────────────────────────────────────

export interface SignalEntry {
  /** paying：付款前先寫入；行程若在這時中斷，重啟後當作付款狀態不明，不重付。 */
  status: "paying" | "paid" | "mismatch" | "uncertain";
  tx: string | null;
  paidAtomic: string;
  version: number | null;
}

export interface SyncEntry {
  status: "synced" | "unconfirmed";
  tx: string;
}

export interface Ledger {
  v: 1;
  /** 鍵：trader:toVersion。同一版訊號只付一次，多位跟隨者共用。 */
  signals: Record<string, SignalEntry>;
  /** 鍵：follower:recordIdx:toVersion。 */
  syncs: Record<string, SyncEntry>;
}

export const emptyLedger = (): Ledger => ({ v: 1, signals: {}, syncs: {} });
export const signalKey = (n: Pick<NewVersionNotice, "trader" | "toVersion">) => `${n.trader}:${n.toVersion}`;
export const syncKey = (n: Pick<NewVersionNotice, "follower" | "recordIdx" | "toVersion">) => `${n.follower}:${n.recordIdx}:${n.toVersion}`;

export function parseLedger(text: string): Ledger {
  const j = JSON.parse(text) as Partial<Ledger>;
  if (j?.v !== 1 || !j.signals || typeof j.signals !== "object" || !j.syncs || typeof j.syncs !== "object") {
    throw new Error("不是 x402-copy-agent 的狀態檔");
  }
  return j as Ledger;
}

export function loadLedger(path: string): Ledger {
  return existsSync(path) ? parseLedger(readFileSync(path, "utf8")) : emptyLedger();
}

/** 原子寫入，比照 copy-sync/src/state.ts 的 saveState。 */
export function saveLedger(path: string, l: Ledger): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(l, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const MANUAL_RETRY = "確認要再付一次的話，換一個 --state-file 重啟再重新觸發";

export type DedupeDecision =
  | { action: "skip"; reason: string }
  | { action: "process"; payment: "pay" | "reuse" };

/** 同一 trader＋toVersion 不重複付款；同一筆跟單的同一版不重複同步。 */
export function dedupeDecision(ledger: Ledger, n: NewVersionNotice): DedupeDecision {
  const sync = ledger.syncs[syncKey(n)];
  if (sync?.status === "synced") return { action: "skip", reason: `這一版已同步過（tx ${sync.tx}）` };
  if (sync?.status === "unconfirmed") {
    return { action: "skip", reason: `上次的同步交易還沒確認（tx ${sync.tx}），請先到區塊瀏覽器查；沒上鏈的話本人到投資組合按「立即同步」` };
  }
  const sig = ledger.signals[signalKey(n)];
  if (!sig) return { action: "process", payment: "pay" };
  if (sig.status === "paid") return { action: "process", payment: "reuse" };
  if (sig.status === "mismatch") {
    return { action: "skip", reason: `這一版先前付費後版號不符（訊號 ${sig.version ?? "無"}、通知 ${n.toVersion}），不重複付款也不同步。${MANUAL_RETRY}` };
  }
  return { action: "skip", reason: `這一版的付款狀態不明（曾送出授權但沒看到結算結果），不重複付款；請先查付款錢包的 USDC 紀錄。${MANUAL_RETRY}` };
}

// ── 閘門：同步前的鏈上條件 ───────────────────────────────────────────────────

export interface ChainSnapshot {
  record: { trader: string; versionId: bigint; active: boolean } | undefined;
  latest: bigint | null;
  autoSync: boolean;
  /** 跟隨者指定的執行者（小寫）；null＝任何人。 */
  executor: string | null;
  readyAt: number;
  now: number;
}

export interface Blocked {
  code: "no-record" | "trader-mismatch" | "stale" | "already-synced" | "auto-sync-off" | "executor" | "cooldown" | `sim-${RevertCategory}`;
  reason: string;
  /** 冷卻中：還要幾秒（鏈上時間）才可以同步；agent 會在那之後自動再試一次。 */
  retryInSec?: number;
  /** 本人該怎麼做。 */
  action: string;
}

const RETRIGGER = "處理好後重新觸發通知（x402-copy-agent.md「重新觸發」）";

/** 付費前、送交易前都會跑一次。回傳 null 表示可以往下（接著模擬）。`me` 是執行者位址；dry-run 為 null。 */
export function gateDecision(n: NewVersionNotice, s: ChainSnapshot, me: string | null): Blocked | null {
  if (!s.record || !s.record.active) {
    return { code: "no-record", reason: "鏈上沒有這筆進行中的跟單", action: "不需處理；要繼續跟單請重新跟單" };
  }
  if (s.record.trader.toLowerCase() !== n.trader) {
    return { code: "trader-mismatch", reason: "通知的交易者與鏈上跟單紀錄不符", action: "這則通知不可信，請確認是誰送的" };
  }
  if (s.record.versionId >= BigInt(n.toVersion)) {
    return { code: "already-synced", reason: `跟單已在 versionId ${s.record.versionId}，不需要同步`, action: "不需處理" };
  }
  if (s.latest === null || s.latest !== BigInt(n.toVersion)) {
    return {
      code: "stale",
      reason: `鏈上最新是 versionId ${s.latest ?? "無"}，不是通知的 ${n.toVersion}`,
      action: "resyncFor 只會同步到鏈上最新版，這則通知不算數；等下一則通知",
    };
  }
  if (!n.autoSync || !s.autoSync) {
    return {
      code: "auto-sync-off",
      reason: "自動同步沒有開啟",
      action: `本人到投資組合檢視新版後按「立即同步」；或開啟自動同步（setAutoSync），${RETRIGGER}`,
    };
  }
  if (s.executor !== null && me !== null && s.executor !== me.toLowerCase()) {
    return {
      code: "executor",
      reason: `跟隨者指定的執行者是 ${s.executor}，不是這把熱錢包`,
      action: `本人到投資組合把「只讓這個地址代為同步」改成這把熱錢包（setSyncExecutor），${RETRIGGER}；或自己按「立即同步」`,
    };
  }
  if (s.now < s.readyAt) {
    return {
      code: "cooldown",
      reason: `冷卻中，到 ${new Date(s.readyAt * 1000).toISOString()}`,
      action: `agent 開著的話，冷卻結束後會自動再試一次（不必重新觸發）；急的話本人到投資組合按「立即同步」（本人不受冷卻）`,
      retryInSec: s.readyAt - s.now,
    };
  }
  return null;
}

const ADVICE: Record<RevertCategory, string> = {
  synced: "不需處理",
  dropped: "本人到投資組合確認自動同步已開啟、指定的執行者是這把熱錢包，或自己按「立即同步」",
  cooldown: `冷卻結束後重新觸發通知；急的話本人到投資組合按「立即同步」`,
  gas: `本人到投資組合存入同步油箱（depositSyncGas），${RETRIGGER}`,
  consent: `執行費被調高了：本人到投資組合重新確認自動同步設定，${RETRIGGER}`,
  kyc: `本人先完成 KYC，${RETRIGGER}`,
  market: `等開盤或市場恢復，${RETRIGGER}`,
  capacity: "本人到投資組合檢視保證金與未平倉量，必要時自己處理這筆跟單",
  trader: "交易者目前不符資格，等他恢復；本人可到投資組合檢視這筆跟單",
  config: "合約授權設定異常，需要合約擁有者處理",
  unknown: "本人到投資組合檢視，或自己按「立即同步」看合約回應什麼",
};

/** copy-sync 分類過的模擬拒絕 → 給本人的建議。 */
export function adviceFor(category: RevertCategory): string {
  return ADVICE[category];
}

// ── 訊號與付款結果 ───────────────────────────────────────────────────────────

export type SignalCheck = { ok: true; version: number } | { ok: false; version: number | null; reason: string };

/** `/signals/:trader` 的回傳：`{ ok, settled, data: { trader, strategyVersion, … } }`。 */
export function checkSignal(body: unknown, n: Pick<NewVersionNotice, "trader" | "toVersion">): SignalCheck {
  const b = (body ?? {}) as { ok?: unknown; data?: { trader?: unknown; strategyVersion?: unknown } };
  if (b.ok !== true || !b.data || typeof b.data !== "object") return { ok: false, version: null, reason: "訊號回應不是預期的格式" };
  const v = b.data.strategyVersion;
  const version = isVersion(v) ? v : null;
  if (typeof b.data.trader !== "string" || b.data.trader.toLowerCase() !== n.trader) {
    return { ok: false, version, reason: "訊號的交易者與通知不符" };
  }
  if (version === null) return { ok: false, version: null, reason: "訊號沒有 strategyVersion" };
  if (version !== n.toVersion) return { ok: false, version, reason: `訊號是 versionId ${version}，通知是 ${n.toVersion}` };
  return { ok: true, version };
}

/** 送給伺服器的 EIP-3009 授權（從付款 header 解出）。用來在伺服器回 402 後核對有沒有被結算。 */
export interface SentAuthorization {
  from: string;
  nonce: string;
  /** 秒（unix）。過了這個時間授權就不能再被結算。 */
  validBefore: number;
}

/** 解 v1 X-PAYMENT／v2 PAYMENT-SIGNATURE（base64 JSON，payload.authorization）。解不開回 null。 */
export function parseAuthorization(header: string | null | undefined): SentAuthorization | null {
  if (!header) return null;
  try {
    const a = (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      payload?: { authorization?: { from?: unknown; nonce?: unknown; validBefore?: unknown } };
    })?.payload?.authorization;
    if (!a || typeof a.from !== "string" || !ethers.isAddress(a.from)) return null;
    if (typeof a.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return null;
    const vb = typeof a.validBefore === "string" && /^\d+$/.test(a.validBefore) ? Number(a.validBefore) : typeof a.validBefore === "number" ? a.validBefore : NaN;
    if (!Number.isSafeInteger(vb)) return null;
    return { from: ethers.getAddress(a.from), nonce: a.nonce.toLowerCase(), validBefore: vb };
  } catch {
    return null;
  }
}

/**
 * 包在 meteredFetch 底下，記下每一張送出去的授權。
 * 解不開的付款 header 也要記（標成 null），這樣呼叫端知道「有送出但無法核對」。
 */
export function captureAuthorizations(base: typeof globalThis.fetch = globalThis.fetch) {
  let sent: (SentAuthorization | null)[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const inputHeaders =
      typeof input === "object" && input !== null && "headers" in input
        ? (input as { headers?: ConstructorParameters<typeof Headers>[0] }).headers
        : undefined;
    const headers = new Headers(init?.headers ?? inputHeaders);
    for (const h of X402_PAYMENT_HEADERS) {
      const raw = headers.get(h);
      if (raw) sent.push(parseAuthorization(raw));
    }
    return base(input, init);
  }) as typeof globalThis.fetch;
  return {
    fetch,
    /** 取出並清空目前記下的授權。 */
    drain(): (SentAuthorization | null)[] {
      const out = sent;
      sent = [];
      return out;
    },
  };
}

export interface PayAttempt {
  /** 這次送出的授權；null 表示有送出但解不開。沒接 captureAuthorizations 時為 undefined。 */
  authorizations?: (SentAuthorization | null)[];
  /** HTTP 狀態；連線錯誤或拒絕簽署時為 null。 */
  status: number | null;
  body: unknown;
  sentAtomic: bigint;
  paidAtomic: bigint;
  unsettledAtomic: bigint;
  tx: string | null;
  error?: string;
}

/**
 * paid：拿到 2xx 且送過授權。free：拿到 2xx 但伺服器沒要求付款。
 * not-charged：沒有送出任何授權（例如超過單筆上限被拒簽）；可以重試。
 * rejected：送出授權後伺服器回 402。多半是沒扣款（例如 USDC 不足、facilitator 暫時失敗），
 *   但 402 不能證明授權沒被用掉——要等授權到期、在鏈上查過沒被使用，才可以當作沒付（見 resolveRejected）。
 * uncertain：授權已交出但沒拿到明確結果（5xx、斷線）；授權有效期內仍可能被結算，不自動重付。
 */
export function classifyPayment(a: Pick<PayAttempt, "status" | "sentAtomic">): "paid" | "free" | "not-charged" | "rejected" | "uncertain" {
  const ok = a.status !== null && a.status >= 200 && a.status < 300;
  if (ok) return a.sentAtomic > 0n ? "paid" : "free";
  if (a.sentAtomic === 0n) return "not-charged";
  return a.status === 402 ? "rejected" : "uncertain";
}

/** 等授權到期的上限（秒）。簽章守門把付款視窗限制在 300 秒內，正常不會碰到。 */
export const MAX_AUTH_WAIT_SEC = 600;

/**
 * 伺服器回 402 之後，核對送出的授權有沒有被結算：
 *   等到鏈上時間超過 validBefore（之後誰都不能再結算），再查 USDC 的 authorizationState。
 *   全部沒被使用 → not-charged（可以安全重試）；任何一張被用掉、解不開、或查不了 → uncertain（不自動重付）。
 */
export async function resolveRejected(
  d: Pick<AgentDeps, "reads" | "authUsed" | "sleep" | "print" | "clock">,
  a: Pick<PayAttempt, "authorizations">,
): Promise<{ cls: "not-charged" | "uncertain"; why: string }> {
  const auths = a.authorizations;
  if (!d.authUsed || !auths || auths.length === 0) return { cls: "uncertain", why: "沒有可核對的授權紀錄" };
  if (auths.some((x) => x === null)) return { cls: "uncertain", why: "有一張授權解不開，無法核對" };
  const list = auths as SentAuthorization[];
  const until = Math.max(...list.map((x) => x.validBefore));
  const deadline = (d.clock ?? Date.now)() + (MAX_AUTH_WAIT_SEC + 60) * 1000; // RPC 卡在舊區塊時也不會無限等
  let now = await d.reads.blockTimestamp();
  if (until - now > MAX_AUTH_WAIT_SEC) return { cls: "uncertain", why: `授權要到 ${new Date(until * 1000).toISOString()} 才到期，太久了` };
  if (now <= until) d.print(`   伺服器回 402：等授權到期（約 ${until - now + 1} 秒）再到鏈上核對有沒有被扣款`);
  for (let i = 0; now <= until && i < 100 && (d.clock ?? Date.now)() < deadline; i++) {
    await (d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(Math.min(until - now + 2, 30) * 1000);
    now = await d.reads.blockTimestamp();
  }
  if (now <= until) return { cls: "uncertain", why: "等不到授權到期" };
  for (const x of list) {
    if (await d.authUsed(x.from, x.nonce)) return { cls: "uncertain", why: "授權已在鏈上被使用（扣了款但沒拿到訊號）" };
  }
  return { cls: "not-charged", why: "授權已過期且沒被使用，確定沒扣款" };
}

/** 從結算證明 header（v1 X-PAYMENT-RESPONSE／v2 PAYMENT-RESPONSE，base64 JSON）取 tx hash。 */
export function paymentTxFromHeaders(headers: Headers): string | null {
  for (const name of ["X-PAYMENT-RESPONSE", "PAYMENT-RESPONSE"]) {
    const raw = headers.get(name);
    if (!raw) continue;
    try {
      const tx = (JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { transaction?: unknown }).transaction;
      if (typeof tx === "string" && /^0x[0-9a-fA-F]{64}$/.test(tx)) return tx;
    } catch {
      /* 解不開就當作沒有 */
    }
  }
  return null;
}

/** 付費買訊號。`payFetch` 必須是包在 `meter.fetch` 外層的 wrapFetchWithPayment。 */
export function makeSignalPayer(a: {
  api: string;
  payFetch: typeof fetch;
  meter: PaymentMeter;
  redact: Redactor;
  /** captureAuthorizations().drain：有接才能在 402 後核對授權。 */
  drainAuthorizations?: () => (SentAuthorization | null)[];
}): (trader: string) => Promise<PayAttempt> {
  return async (trader) => {
    a.drainAuthorizations?.(); // 清掉先前殘留的，只留這次的
    const sent0 = a.meter.totalSentAtomic();
    const paid0 = a.meter.totalPaidAtomic();
    const unsettled0 = a.meter.unsettledAtomic();
    const delta = () => ({
      ...(a.drainAuthorizations ? { authorizations: a.drainAuthorizations() } : {}),
      sentAtomic: a.meter.totalSentAtomic() - sent0,
      paidAtomic: a.meter.totalPaidAtomic() - paid0,
      unsettledAtomic: a.meter.unsettledAtomic() - unsettled0,
    });
    try {
      // init 不可省略：x402-fetch 在 402 重送時需要它。
      const res = await a.payFetch(`${a.api}/signals/${ethers.getAddress(trader)}`, { method: "GET" });
      const body = await res.json().catch(() => null);
      return { status: res.status, body, tx: paymentTxFromHeaders(res.headers), ...delta() };
    } catch (e) {
      return { status: null, body: null, tx: null, error: errText(e, a.redact), ...delta() };
    }
  };
}

// ── 流程 ────────────────────────────────────────────────────────────────────

export type ChainView = Pick<ChainReads, "copyRecords" | "syncConfig" | "syncReadyAt" | "latestVersion" | "blockTimestamp">;

export interface AgentDeps {
  reads: ChainView;
  exec: Executor;
  pay: (trader: string) => Promise<PayAttempt>;
  ledger: Ledger;
  persist: (l: Ledger) => void;
  print: (line: string) => void;
  redact: Redactor;
  txLink: (hash: string) => string;
  dryRun: boolean;
  txTimeoutMs: number;
  /** USDC authorizationState(from, nonce)：授權是否已被使用。沒有時，402 一律當作狀態不明。 */
  authUsed?: (from: string, nonce: string) => Promise<boolean>;
  /** 測試用；預設 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  /** 測試用；預設 Date.now。等授權到期的牆鐘上限用它。 */
  clock?: () => number;
}

export interface Outcome {
  result: "synced" | "blocked" | "duplicate" | "mismatch" | "payment-failed" | "dry-run" | "unconfirmed" | "tx-failed" | "error";
  code?: string;
  /** 冷卻中：幾秒後可以再試（呼叫端排程重試）。 */
  retryInSec?: number;
  paidAtomic: bigint;
  paymentTx: string | null;
  syncTx: string | null;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export async function readSnapshot(reads: ChainView, n: NewVersionNotice): Promise<ChainSnapshot> {
  const now = await reads.blockTimestamp();
  const record = (await reads.copyRecords(n.follower))[n.recordIdx];
  if (!record || !record.active) return { record, latest: null, autoSync: false, executor: null, readyAt: 0, now };
  const [sc, latest, readyAt] = await Promise.all([
    reads.syncConfig(n.follower, n.recordIdx),
    reads.latestVersion(n.follower, n.recordIdx, record.trader),
    reads.syncReadyAt(n.follower, n.recordIdx),
  ]);
  return { record, latest, autoSync: sc.autoSync, executor: sc.executor, readyAt, now };
}

/** 讀鏈＋閘門＋模擬。RPC 故障往外丟（呼叫端記錯誤，不當作合約拒絕）。 */
async function evaluate(d: AgentDeps, n: NewVersionNotice): Promise<Blocked | null> {
  const snap = await readSnapshot(d.reads, n);
  const blocked = gateDecision(n, snap, d.exec.address);
  if (blocked) return blocked;
  // dry-run 沒有金鑰、跟隨者指定了執行者：以那個執行者的身分模擬（同 engine.ts）。
  const simulateAs = d.exec.address === null && snap.executor !== null ? snap.executor : undefined;
  try {
    await d.exec.simulate(n.follower, n.recordIdx, simulateAs);
    return null;
  } catch (e) {
    if (!isRevert(e)) throw e;
    const info = classifyRevert(e);
    return { code: `sim-${info.category}`, reason: info.detail, action: adviceFor(info.category) };
  }
}

/** 處理一則已通過驗證的通知。除了 persist 失敗之外不丟例外。 */
export async function processNotice(d: AgentDeps, n: NewVersionNotice): Promise<Outcome> {
  const sigKey = signalKey(n);
  let paidAtomic = 0n;
  let unsettledAtomic = 0n;
  let paymentTx: string | null = null;
  const done = (result: Outcome["result"], extra: { code?: string; syncTx?: string | null; retryInSec?: number } = {}): Outcome => ({
    result, code: extra.code, paidAtomic, paymentTx, syncTx: extra.syncTx ?? null,
    ...(extra.retryInSec !== undefined ? { retryInSec: extra.retryInSec } : {}),
  });
  const fee = () => {
    if (paidAtomic > 0n) d.print(`   費用：本次已付 ${formatUsdcAtomic(paidAtomic)} USDC${paymentTx ? `（tx ${paymentTx}）` : "（沒拿到 tx）"}`);
    else if (unsettledAtomic === 0n) {
      const prior = d.ledger.signals[sigKey];
      d.print(prior?.status === "paid" ? `   費用：本次未付費（這一版訊號先前已付 ${formatUsdcAtomic(BigInt(prior.paidAtomic))} USDC）` : "   費用：本次未付費");
    }
    if (unsettledAtomic > 0n) d.print(`   費用：${formatUsdcAtomic(unsettledAtomic)} USDC 的授權已送出、沒看到結算（有效期內仍可能被結算）`);
  };
  const stop = (b: Blocked): Outcome => {
    d.print(`   不同步：${b.reason}`);
    d.print(`   本人：${b.action}`);
    fee();
    return done("blocked", { code: b.code, retryInSec: b.retryInSec });
  };
  const failure = (what: string, e: unknown): Outcome => {
    d.print(`   ${what}：${errText(e, d.redact)}`);
    d.print("   本人：確認 RPC 正常後重新觸發通知");
    fee();
    return done("error");
  };

  d.print(`① 收到新版通知  交易者 ${short(n.trader)}  ${versionStep(n.fromVersion ?? n.toVersion, n.toVersion)}  跟隨者 ${short(n.follower)}#${n.recordIdx}`);

  const dedupe = dedupeDecision(d.ledger, n);
  if (dedupe.action === "skip") {
    d.print(`   重複通知，略過：${dedupe.reason}`);
    return done("duplicate");
  }

  // 免費的檢查先做：已知同步不了就不花錢。
  try {
    const blocked = await evaluate(d, n);
    if (blocked) return stop(blocked);
  } catch (e) {
    return failure("讀鏈失敗，這次不付費也不同步", e);
  }

  if (d.dryRun) {
    d.print(`② [dry-run] 模擬同步會成功；本來會付費買 /signals、確認 versionId ${n.toVersion} 後送出 resyncFor。沒有付款，也沒有送交易`);
    return done("dry-run");
  }

  // ② 付費（同一版只付一次）
  if (dedupe.payment === "reuse") {
    const prior = d.ledger.signals[sigKey];
    d.print(`② x402 這一版訊號已付過，不重複付款（${formatUsdcAtomic(BigInt(prior.paidAtomic))} USDC，tx ${prior.tx ?? "無"}）`);
    d.print(`③ 確認版號  先前的訊號 versionId ${n.toVersion} = 通知 versionId ${n.toVersion}`);
  } else {
    // 先記再付：行程在付款途中被砍，重啟後不會再付一次。
    d.ledger.signals[sigKey] = { status: "paying", tx: null, paidAtomic: "0", version: null };
    d.persist(d.ledger);
    const a = await d.pay(n.trader);
    paidAtomic = a.paidAtomic;
    unsettledAtomic = a.unsettledAtomic;
    paymentTx = a.tx;
    let cls = classifyPayment(a);
    let why = "";
    if (cls === "rejected") {
      try {
        ({ cls, why } = await resolveRejected(d, a));
      } catch (e) {
        cls = "uncertain";
        why = `核對授權時讀鏈失敗：${errText(e, d.redact)}`;
      }
      if (cls === "not-charged") unsettledAtomic = 0n; // 已確認授權過期且沒被使用
    }
    if (cls === "not-charged") {
      delete d.ledger.signals[sigKey];
      d.persist(d.ledger);
      d.print(`② x402 沒有付款：${a.error ?? `HTTP ${a.status}`}${why ? `（${why}）` : ""}`);
      d.print("   本人：確認 X402_API_URL、X402_MAX_PAYMENT_USDC 與付款錢包的 USDC，再重新觸發通知");
      fee();
      return done("payment-failed");
    }
    if (cls === "uncertain") {
      d.ledger.signals[sigKey] = { status: "uncertain", tx: a.tx, paidAtomic: a.paidAtomic.toString(), version: null };
      d.persist(d.ledger);
      d.print(`② x402 買訊號失敗：${a.error ?? `HTTP ${a.status}`}${why ? `（${why}）` : ""}。不同步，這一版也不會自動重付`);
      d.print(`   本人：查付款錢包的 USDC 紀錄；要同步請到投資組合按「立即同步」。${MANUAL_RETRY}`);
      fee();
      return done("payment-failed");
    }
    d.print(cls === "paid"
      ? `② x402 付費買訊號  ${formatUsdcAtomic(a.paidAtomic)} USDC  tx ${a.tx ?? "（回應沒有結算 tx）"}${a.tx ? `\n   ${d.txLink(a.tx)}` : ""}`
      : "② x402 伺服器沒有要求付款（免費回應），照常檢查版號");

    const check = checkSignal(a.body, n);
    if (!check.ok) {
      d.ledger.signals[sigKey] = { status: "mismatch", tx: a.tx, paidAtomic: a.paidAtomic.toString(), version: check.version };
      d.persist(d.ledger);
      d.print(`③ 版號不符：${check.reason}。不同步`);
      d.print("   本人：確認 X402_API_URL 指向與這條鏈相同的部署；要同步請到投資組合檢視新版後按「立即同步」");
      fee();
      return done("mismatch", { code: "version-mismatch" });
    }
    d.ledger.signals[sigKey] = { status: "paid", tx: a.tx, paidAtomic: a.paidAtomic.toString(), version: check.version };
    d.persist(d.ledger);
    d.print(`③ 確認版號  訊號 versionId ${check.version} = 通知 versionId ${n.toVersion}`);
  }

  // ④ 付費前後鏈上可能變了：送之前再檢查、再模擬一次。
  try {
    const blocked = await evaluate(d, n);
    if (blocked) return stop(blocked);
  } catch (e) {
    return failure("讀鏈失敗，這次不同步", e);
  }

  let gasLimit: bigint;
  try {
    const quote = await d.exec.quote(n.follower, n.recordIdx);
    gasLimit = (quote.gas * 12n) / 10n; // 同 engine.ts：多留兩成
  } catch (e) {
    if (isRevert(e)) {
      const info = classifyRevert(e);
      return stop({ code: `sim-${info.category}`, reason: info.detail, action: adviceFor(info.category) });
    }
    return failure("估算 gas 失敗，這次不同步", e);
  }

  let hash: string;
  try {
    hash = (await d.exec.send(n.follower, n.recordIdx, gasLimit)).hash;
  } catch (e) {
    d.print(`④ 同步交易送不出去：${errText(e, d.redact)}`);
    d.print("   本人：確認執行者熱錢包有 gas ETH，再重新觸發通知");
    fee();
    return done("tx-failed");
  }

  const outcome = await d.exec.wait({ hash }, d.txTimeoutMs).catch(() => null);
  if (!outcome) {
    d.ledger.syncs[syncKey(n)] = { status: "unconfirmed", tx: hash };
    d.exec.resetNonce?.(); // 交易若被丟棄，本機 nonce 會留下缺口：下一筆重新向節點對齊
    d.persist(d.ledger);
    d.print(`④ 同步交易已送出，還沒等到確認  tx ${hash}\n   ${d.txLink(hash)}`);
    fee();
    return done("unconfirmed", { syncTx: hash });
  }
  if (outcome.status === "reverted") {
    d.print(`④ 同步交易上鏈但 revert  tx ${hash}（模擬後狀態被改變，部位維持舊版）`);
    d.print("   本人：到投資組合檢視，或重新觸發通知");
    fee();
    return done("tx-failed", { syncTx: hash });
  }
  d.ledger.syncs[syncKey(n)] = { status: "synced", tx: hash };
  d.persist(d.ledger);
  const ev = outcome.resynced;
  // resyncFor 沒有版本參數，一律到鏈上最新版；交易者若搶在這之間又發版，照實印出實際到哪一版。
  const raced = ev && ev.toVersion !== n.toVersion ? `  注意：實際同步到 versionId ${ev.toVersion}，不是確認過的 ${n.toVersion}（交易者剛好又發版）` : "";
  const detail = ev ? `${versionStep(ev.fromVersion, ev.toVersion)}，${ev.legs} 條腿` : versionStep(n.fromVersion ?? n.toVersion, n.toVersion);
  d.print(`④ 同步  ${detail}  tx ${hash}\n   ${d.txLink(hash)}${raced}`);
  return done("synced", { syncTx: hash });
}

/** 只用驗證過的欄位與自己的文字，不印通知裡的 message（webhook 內容不可信）。 */
export function blockedLines(b: BlockedNotice): string[] {
  return [
    `① 收到被擋通知  交易者 ${short(b.trader)}  跟隨者 ${short(b.follower)}#${b.recordIdx}`,
    `   不同步：${CATEGORY_LABEL[b.category]}`,
    `   本人：${adviceFor(b.category)}`,
    "   費用：本次未付費",
  ];
}

// ── webhook 伺服器 ───────────────────────────────────────────────────────────

export const MAX_BODY_BYTES = 16 * 1024;

export interface WebhookRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  rawBody: string;
}

export interface WebhookResponse {
  status: number;
  message: string;
  notice?: NewVersionNotice;
  blocked?: BlockedNotice;
}

/**
 * 只綁 127.0.0.1 還不夠：使用者瀏覽器裡的網頁也能打本機。
 * 瀏覽器的 POST 都帶 Origin；DNS rebinding 的 Host 不會是本機名稱；text/plain 的「簡單請求」被 content-type 擋下。
 */
export function routeWebhook(req: WebhookRequest, cfg: AgentConfig): WebhookResponse {
  if ((req.url ?? "").split("?")[0] !== "/webhook") return { status: 404, message: "not found" };
  if (req.method !== "POST") return { status: 405, message: "只接受 POST" };
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (host !== "127.0.0.1" && host !== "localhost") return { status: 403, message: "Host 不是本機" };
  if (req.headers.origin !== undefined) return { status: 403, message: "不接受瀏覽器來源的請求" };
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return { status: 415, message: "content-type 必須是 application/json" };
  let body: unknown;
  try {
    body = JSON.parse(req.rawBody);
  } catch {
    return { status: 400, message: "不是合法的 JSON" };
  }
  const a = admitNotification(body, cfg);
  if (a.kind === "reject") return { status: a.status, message: a.reason };
  if (a.kind === "ignore") return { status: 200, message: `略過：${a.reason}` };
  if (a.kind === "blocked") return { status: 200, message: "已記錄", blocked: a.notice };
  return { status: 202, message: "已排入處理", notice: a.notice };
}

/** readyAt 是鏈上時間，本機時鐘可能差一點：多等這麼久再試。 */
export const RETRY_MARGIN_SEC = 30;
/** 單次排程最長等多久；更久的冷卻到時會再被擋一次、再排一次。 */
export const MAX_RETRY_DELAY_SEC = 24 * 3600;

/**
 * 冷卻中的通知：冷卻結束後自動重新排入佇列（同一筆跟單的同一版只排一次）。
 * 重試時照常從頭檢查：交易者若又發了新版，這則舊通知會被判定過期而停下。
 */
export function makeRetryScheduler(
  push: (n: NewVersionNotice) => void,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (t: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
) {
  const pending = new Map<string, unknown>();
  let closed = false;
  return {
    /** 回傳實際等待秒數；已經排過或已關閉回傳 null。 */
    schedule(n: NewVersionNotice, inSec: number): number | null {
      const k = syncKey(n);
      if (closed || pending.has(k)) return null;
      const delay = Math.min(Math.max(0, Math.ceil(inSec)) + RETRY_MARGIN_SEC, MAX_RETRY_DELAY_SEC);
      pending.set(k, timers.set(() => {
        pending.delete(k);
        if (!closed) push(n);
      }, delay * 1000));
      return delay;
    },
    size: () => pending.size,
    /** 關閉：清掉計時器，之後不再排程（agent 停止時呼叫）。 */
    cancelAll(): void {
      closed = true;
      for (const t of pending.values()) timers.clear(t);
      pending.clear();
    },
  };
}

/** 依序處理通知（付款與 nonce 都不該並行）。佇列滿了回傳 false。 */
export function makeSerialQueue<T>(work: (item: T) => Promise<void>, onError: (e: unknown) => void, maxPending = 32) {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return {
    push(item: T): boolean {
      if (pending >= maxPending) return false;
      pending += 1;
      tail = tail
        .then(() => work(item))
        .catch(onError)
        .finally(() => {
          pending -= 1;
        });
      return true;
    },
    idle: () => tail,
  };
}

/** copy-sync 的通知 5 秒逾時，付費可能更久：驗證通過就先回 202，流程在佇列裡跑。 */
export function createWebhookServer(
  cfg: AgentConfig,
  enqueue: (n: NewVersionNotice) => boolean,
  onRejected: (r: WebhookResponse) => void = () => {},
  onBlocked: (b: BlockedNotice) => void = () => {},
): Server {
  return createServer((req, res) => {
    const reply = (status: number, message: string) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status < 300, message }));
    };
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(c);
    });
    req.on("error", () => res.destroy());
    req.on("end", () => {
      if (tooLarge) return reply(413, "內容太大");
      const r = routeWebhook({ method: req.method, url: req.url, headers: req.headers, rawBody: Buffer.concat(chunks).toString("utf8") }, cfg);
      if (r.status >= 400) onRejected(r);
      if (r.blocked) onBlocked(r.blocked);
      if (r.notice && !enqueue(r.notice)) return reply(429, "佇列已滿");
      reply(r.status, r.message);
    });
  });
}
