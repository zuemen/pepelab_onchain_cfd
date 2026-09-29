// x402 結算 worker：把 ledger.ts 佇列裡「已收款、待分潤」的項目送上鏈。
//
// 優先序 1（x402 硬化）的第二半：app.ts 的付費端點只記帳（推進 Upstash 佇列），
// 不再送任何交易；上鏈這件事全部集中在這支腳本，用單一 signer 依序處理。
//
// 為什麼放在 signal-api/src/ 而不是 agent/keeper/：這支只依賴同目錄的
// settlement.ts / ledger.ts（都是 signal-api 的模組），放進 keeper/ 會變成跨
// workspace 的相對路徑匯入，徒增匯入路徑的脆弱性。**執行模型**沿用
// agent/keeper 的既有 pattern——單一 CLI 腳本、單一 signer、GitHub Actions cron、
// 缺 secret 直接 fail fast、印一行摘要讓 workflow 用門檻判斷成功與否。
//
// 用法：
//   只由 .github/workflows/x402-settlement-worker.yml 執行（GITHUB_ACTIONS=true，否則拒跑）。
//   本機只讀檢視佇列：cd agent && npx tsx signal-api/src/settlement-worker.ts --dry-run
//
// 需要的 env（見 .env.example）：
//   FEE_SETTLEMENT_PRIVATE_KEY  單一 signer
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   佇列
//   PAY_TO / X402_FEE_ROUTER    收款守門（payoutPreflight）
//   SIGNAL_API_URL              （選用）線上 signal-api，比對它公布的 payTo 是否 = signer
//
// 為什麼「單一 signer」就讓 nonce 衝突在設計上消失：送交易的地方只剩這一支 process、
// 由 GitHub Actions cron 觸發、用 concurrency group 防止重疊執行
// （見 .github/workflows/x402-settlement-worker.yml）。這個前提也被下面第 4 點使用：
// 「上一輪留下的佔位」一定不屬於任何還活著的 worker。
//
// 2026-09-29（P0）可靠性：
//   1. 可靠佇列：LMOVE main/retry → processing，完成才 LREM；啟動時先把 processing
//      的遺留項目搬回 main（上一輪崩潰可回收）。
//   2. 冪等：每筆的 idempotencyKey 在上鏈前 `SET settle:<key> NX` 佔位；DONE 的鍵
//      再出現直接跳過。
//   3. 未確定狀態：routeExternalRevenue 先簽、先記 hash / nonce / raw tx、再廣播。
//      等 receipt 逾時 → UNKNOWN，**絕不自動重送**；下一輪用 receipt 對帳：成功 → DONE；
//      revert → 死信；超過 STUCK_AFTER_MS（30 分鐘）仍查不到 → STUCK，job 失敗，交人工
//      （agent/README.md「結算交易卡住」）。UNKNOWN 的項目放進 unconfirmed 佇列，每輪
//      最先對帳；還有未確認的交易時本輪不送新交易。
//   4. 審查修正（原則：任何可能造成雙付的判斷都不自動化，寧可停也不可多付）：
//      - 送出新交易前比對 signer 的 nonce（latest vs pending），mempool 裡有未上鏈的
//        交易就不送；連續 blocked 超過 30 分鐘 → job 失敗。
//      - Redis 租約鎖（x402:settlement:lock，NX EX 1500s）：取不到就不處理任何項目。
//      - PENDING 且沒有 tx hash：只有在「佔位超過 25 分鐘（> job timeout）且本輪持有
//        租約鎖」時才釋放重試。
//      - 處理單筆時的 Redis 例外個別攔截：停止本輪、job 失敗，但不讓 process 崩潰；
//        項目留在 processing，下一輪回收。
//      - claim 前檢查受益 trader：外洩清單 / EIP-7702 委派 → 死信；RPC 查不到 → 停止本輪
//        （不消耗重試次數）。
//      - UNKNOWN 查不到 receipt 時**不**依 nonce 推論「已被替換」而自動重結算：公共節點會
//        回落後狀態，分不出「已上鏈只是查不到」與「被替換」。一律 30 分鐘後 STUCK 交人工，
//        保存 txHash / nonce / rawTx 的狀態絕不刪除。
//   5. 結構收斂（第三次審查）：
//      - **只准在 CI 內執行**（GITHUB_ACTIONS=true）：job 有 20 分鐘 timeout，租約鎖
//        （1500 秒）不會在途中過期；本機的 process 可以跑任意久，鎖過期後第二個 worker
//        就能進來。本機只允許 `--dry-run`（只讀，不佔位、不簽章）。
//      - **出現 STUCK 就全域停機**：設 x402:settlement:halt（不設 TTL），本輪立即停止；
//        之後每一輪看到旗標就拒跑，直到人工確認原交易的最終狀態後手動清除。
//      - blocked 與 trader 檢查 no-data 連續超過 30 分鐘 → job 失敗（計時紀錄每次刷新
//        2 小時 TTL，中斷夠久就自然重新計時）。
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import {
  assessPayoutAddress,
  checkPayoutDenylistEnv,
  type CodeReader,
  type PayoutAssessment,
} from "@pepelab/shared";
import {
  isSettlementEnabled,
  settleRevenue,
  getReceiptStatus,
  getNonceStatus,
  settlementSignerAddress,
  settlementRouterAddress,
  settlementProvider,
  readPlatformTreasury,
  type SettlementResult,
  type SettleHooks,
} from "./settlement.ts";
import {
  isLedgerEnabled,
  claimNext,
  ackProcessing,
  moveProcessingTo,
  recoverProcessing,
  queueDepth,
  getSettleState,
  claimSettleKey,
  setSettleState,
  releaseSettleKey,
  incrLegacyCollisions,
  acquireWorkerLock,
  releaseWorkerLock,
  markCondition,
  clearCondition,
  setHalt,
  getHalt,
  peekQueue,
  readString,
  BLOCKED_SINCE_KEY,
  NONCE_RPC_SINCE_KEY,
  NODATA_SINCE_KEY,
  HALT_KEY,
  WORKER_LOCK_KEY,
  type HaltInfo,
  QUEUE_KEY,
  PROCESSING_KEY,
  RETRY_KEY,
  UNCONFIRMED_KEY,
  DEAD_KEY,
  LEGACY_REVIEW_KEY,
  type LedgerEntry,
  type RetryEntry,
  type SettleState,
} from "./ledger.ts";

const BATCH_SIZE = Number(process.env.SETTLEMENT_BATCH_SIZE ?? "25");
export const MAX_RETRY_ATTEMPTS = Number(process.env.SETTLEMENT_MAX_RETRIES ?? "5");
// 部分失敗門檻：沿用 keeper 系列 workflow 的慣例（MAX_FAIL_PCT），失敗率超過
// 這個百分比就讓 CI job 變紅，不要讓「11 筆壞 7 筆」看起來像成功。
const MAX_FAIL_PCT = Number(process.env.SETTLEMENT_MAX_FAIL_PCT ?? "30");
/** 簽出後超過這麼久仍查不到 receipt → STUCK（交人工）。 */
export const STUCK_AFTER_MS = Number(process.env.SETTLEMENT_STUCK_AFTER_MS ?? String(30 * 60 * 1000));
/** PENDING（無 hash）的佔位要超過這麼久（> job timeout 20 分鐘）才可能是遺留的。 */
export const ORPHAN_CLAIM_AFTER_MS = 25 * 60 * 1000;
/** nonce 不一致（blocked）或 trader 檢查 no-data 連續超過這麼久 → job 失敗。 */
export const BLOCKED_ESCALATE_MS = 30 * 60 * 1000;

// ── 收款守門 ─────────────────────────────────────────────────────────────────

export interface PreflightDeps {
  codeReader: CodeReader;
  payTo: string | undefined;
  signerAddress: string | undefined;
  routerAddress: string;
  readPlatformTreasury: () => Promise<string>;
  /**
   * 讀線上 signal-api `GET /` 公布的 payTo。undefined = 未設定 SIGNAL_API_URL
   * （跳過並警告）；丟錯 = 讀不到（fail-closed）。
   */
  fetchPublishedPayTo?: () => Promise<string>;
  /** true（CI：GITHUB_ACTIONS=true）→ 沒有 fetchPublishedPayTo 就算 problem；本機只警告。 */
  requirePublishedPayTo?: boolean;
}

/**
 * P0 收款地址守門（fail-closed）：在碰佇列之前檢查「錢會流過去」的地址。
 *   - PAY_TO（x402 收款）：必須是 EOA，且不是外洩／EIP-7702 委派地址。
 *   - 結算 signer：同上，且**必須等於 PAY_TO**（worker 用 signer 的餘額分潤，
 *     x402 收入必須進同一個帳戶）。
 *   - 線上 signal-api 公布的 payTo 必須 = signer（Vercel 的 PAY_TO 可能跟這裡不同步）。
 *   - FeeRouter.platformTreasury()：20% 平台分潤的去向，不可是外洩／委派地址。
 * 回傳 problems（任何一個 → worker 以非零結束，佇列原封不動）與 warnings。
 */
export async function payoutPreflight(d: PreflightDeps): Promise<{ problems: string[]; warnings: string[] }> {
  const problems: string[] = [];
  const warnings: string[] = [];

  if (checkPayoutDenylistEnv().length) {
    warnings.push("PAYOUT_DENYLIST 有格式錯誤的項目（見上方警告），那些項目沒有生效。");
  }

  if (!d.payTo?.trim()) {
    problems.push("PAY_TO 未設：無法確認 x402 收款地址是否安全（必須 = FEE_SETTLEMENT_PRIVATE_KEY 的 EOA）。");
  } else {
    const a = await assessPayoutAddress(d.codeReader, d.payTo, { requireEoa: true });
    if (!a.safe) problems.push(`PAY_TO unsafe：${a.reason}`);
  }

  if (!d.signerAddress) {
    problems.push("結算 signer 未設定。");
  } else {
    const a = await assessPayoutAddress(d.codeReader, d.signerAddress, { requireEoa: true });
    if (!a.safe) problems.push(`結算 signer unsafe：${a.reason}`);
  }

  if (d.payTo?.trim() && d.signerAddress && d.payTo.trim().toLowerCase() !== d.signerAddress.toLowerCase()) {
    problems.push(
      `PAY_TO(${d.payTo}) ≠ 結算 signer(${d.signerAddress})：x402 收入不會進 signer，` +
        "worker 會拿 signer 自己的餘額分潤。PAY_TO 必須是 FEE_SETTLEMENT_PRIVATE_KEY 的地址。",
    );
  }

  if (!d.fetchPublishedPayTo) {
    if (d.requirePublishedPayTo) {
      problems.push(
        "SIGNAL_API_URL 未設：CI 上必須比對線上 signal-api 公布的 payTo = signer" +
          "（請設 repository variable SIGNAL_API_URL）。",
      );
    } else {
      warnings.push("SIGNAL_API_URL 未設：跳過「線上 signal-api 公布的 payTo = signer」比對。");
    }
  } else if (d.signerAddress) {
    try {
      const published = (await d.fetchPublishedPayTo()).trim();
      if (published.toLowerCase() !== d.signerAddress.toLowerCase()) {
        problems.push(
          `線上 signal-api 公布的 payTo(${published}) ≠ 結算 signer(${d.signerAddress})：` +
            "買方的錢沒有進 signer。請先更新 Vercel 的 PAY_TO。",
        );
      }
    } catch (err) {
      problems.push(`讀不到線上 signal-api 公布的 payTo，fail-closed：${(err as Error).message}`);
    }
  }

  let treasury: string | undefined;
  try {
    treasury = await d.readPlatformTreasury();
  } catch (err) {
    problems.push(
      `讀不到 FeeRouter(${d.routerAddress}).platformTreasury()，fail-closed：${(err as Error).message}`,
    );
  }
  if (treasury) {
    const a = await assessPayoutAddress(d.codeReader, treasury);
    if (!a.safe) {
      problems.push(
        `FeeRouter(${d.routerAddress}).platformTreasury unsafe：${a.reason}` +
          "（platformTreasury 是 immutable，只能重新部署 FeeRouter 並更新 X402_FEE_ROUTER）",
      );
    }
  }
  return { problems, warnings };
}

/** 讀 `${baseUrl}/` 的 payTo 欄位（10 秒逾時；被限流回 429 時重試 2 次、間隔 5 秒）。 */
export async function fetchPublishedPayTo(
  baseUrl: string,
  opts: { retries?: number; delayMs?: number } = {},
): Promise<string> {
  const retries = opts.retries ?? 2;
  const delayMs = opts.delayMs ?? 5_000;
  let res: Response | undefined;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    res = await fetch(`${baseUrl.replace(/\/$/, "")}/`, { signal: AbortSignal.timeout(10_000) });
    if (res.status !== 429 || attempt === retries) break;
    await res.arrayBuffer().catch(() => undefined);
    console.warn(`GET ${baseUrl}/ 被限流（429），${delayMs / 1000} 秒後重試（${attempt + 1}/${retries}）`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  if (!res!.ok) throw new Error(`GET / 回 ${res!.status}`);
  res = res!;
  const j = (await res.json()) as { payTo?: unknown };
  if (typeof j.payTo !== "string") throw new Error("GET / 回應沒有 payTo 欄位");
  return j.payTo;
}

// ── 單筆處理 ─────────────────────────────────────────────────────────────────

export type ProcessOutcome =
  | { outcome: "settled"; tx: string }
  | { outcome: "duplicate"; key: string }
  | { outcome: "pending"; tx?: string; error: string }
  | { outcome: "retry" | "dead"; error: string }
  | { outcome: "stuck"; tx?: string; error: string }
  | { outcome: "blocked"; error: string; kind: "nonce_mismatch" | "rpc" }
  | { outcome: "halted"; error: string }
  | { outcome: "review"; key: string };

/** 可注入的外部依賴——測試用假的 settle / receipt / 時鐘，不碰任何鏈。 */
export interface WorkerDeps {
  settle: (trader: string, feeUsd: number, hooks: SettleHooks) => Promise<SettlementResult>;
  receiptStatus: (txHash: string) => Promise<"success" | "reverted" | null>;
  now: () => number;
  /** 受益 trader 的安全檢查（外洩清單 / EIP-7702 委派）。 */
  assessTrader: (trader: string) => Promise<PayoutAssessment>;
  /** signer 的 nonce（latest / pending）。 */
  nonceStatus: () => Promise<{ latest: number; pending: number }>;
}

export const defaultDeps: WorkerDeps = {
  settle: settleRevenue,
  receiptStatus: getReceiptStatus,
  now: () => Date.now(),
  assessTrader: (t) => assessPayoutAddress(settlementProvider()!, t),
  nonceStatus: getNonceStatus,
};

export interface RunContext {
  /** 本輪開始時間（ms）。 */
  runStartedAt: number;
  /** 本輪是否持有 Redis 租約鎖。沒有鎖時不釋放任何佔位。 */
  lockHeld: boolean;
  /** 本輪是否有一次 nonce 檢查通過（latest == pending）。 */
  nonceCheckPassed?: boolean;
  /** 本輪是否有一次成功查到 nonce（不論是否一致）。 */
  nonceQueried?: boolean;
  /** 本輪是否有一次 trader 檢查拿到確定結果（非 no-data）。 */
  traderCheckPassed?: boolean;
}

/** 轉 STUCK 時設全域停機旗標。 */
async function haltFor(p: Parsed, st: SettleState | undefined, reason: string, deps: WorkerDeps): Promise<void> {
  const info: HaltInfo = {
    reason,
    key: p.key,
    txHash: st?.txHash,
    nonce: st?.nonce,
    at: new Date(deps.now()).toISOString(),
  };
  await setHalt(info);
  console.error(
    `::error::已設定全域停機旗標 ${HALT_KEY}（${JSON.stringify(info)}）。之後每一輪都會拒跑，` +
      "直到人工到 explorer 確認原交易的最終狀態後手動清除（agent/README.md「結算交易卡住」）。",
  );
}

interface Parsed {
  entry: LedgerEntry;
  attempts: number;
  key: string;
  legacyKey: boolean;
}

/** processing 裡的原始字串可能是 LedgerEntry（來自 main）或 RetryEntry（來自 retry）。 */
export function parseItem(raw: string): Parsed {
  const obj = JSON.parse(raw) as LedgerEntry | RetryEntry;
  const isRetry = typeof (obj as RetryEntry).entry === "object" && (obj as RetryEntry).entry !== null;
  const entry = isRetry ? (obj as RetryEntry).entry : (obj as LedgerEntry);
  const attempts = isRetry ? (obj as RetryEntry).attempts ?? 0 : 0;
  if (entry.idempotencyKey) return { entry, attempts, key: entry.idempotencyKey, legacyKey: false };
  // 舊資料（2026-09-29 前入列）沒有冪等鍵：以 entry 內容雜湊補上。穩定（重試包裝不影響）。
  // 同一雜湊已結算過又出現 → 無法分辨是重複還是另一筆真付款 → 進 legacy_review 交人工。
  const legacy = createHash("sha256")
    .update(JSON.stringify([entry.trader.toLowerCase(), entry.feeUsd, entry.at, entry.source]))
    .digest("hex");
  return { entry, attempts, key: `legacy:${legacy}`, legacyKey: true };
}

const tag = (e: LedgerEntry, key: string) =>
  `trader=${e.trader} feeUsd=${e.feeUsd} source=${e.source} key=${key}`;

async function failOrRetry(raw: string, p: Parsed, error: string): Promise<ProcessOutcome> {
  const attempts = p.attempts + 1;
  const retryEntry: RetryEntry = { entry: p.entry, attempts, lastError: error };
  if (attempts >= MAX_RETRY_ATTEMPTS) {
    await moveProcessingTo(raw, DEAD_KEY, JSON.stringify(retryEntry));
    console.error(`::error::dead-lettered ${tag(p.entry, p.key)} attempts=${attempts} error=${error}`);
    return { outcome: "dead", error };
  }
  await moveProcessingTo(raw, RETRY_KEY, JSON.stringify(retryEntry));
  console.warn(`retry ${tag(p.entry, p.key)} attempts=${attempts} error=${error}`);
  return { outcome: "retry", error };
}

const deadLetter = (p: Parsed, lastError: string) =>
  JSON.stringify({ entry: p.entry, attempts: p.attempts, lastError });

/** 對一個已經簽出過 tx 的鍵做 receipt 對帳。 */
async function reconcile(raw: string, p: Parsed, st: SettleState, deps: WorkerDeps): Promise<ProcessOutcome> {
  const now = deps.now();
  const since = st.sentAt ?? st.claimedAt;
  const nonceNote = st.nonce !== undefined ? ` nonce=${st.nonce}` : "";

  let status: "success" | "reverted" | null;
  try {
    status = await deps.receiptStatus(st.txHash!);
  } catch (err) {
    // 查不到 receipt 本身失敗（RPC）→ 狀態不變，放回佇列，下一輪再查；不重送。
    await moveProcessingTo(raw, UNCONFIRMED_KEY);
    return { outcome: "pending", tx: st.txHash, error: `receipt 查詢失敗：${(err as Error).message}` };
  }
  if (status === "success") {
    await setSettleState(p.key, { ...st, status: "DONE" });
    await ackProcessing(raw);
    console.log(`reconciled settled ${tag(p.entry, p.key)} tx=${st.txHash}`);
    return { outcome: "settled", tx: st.txHash! };
  }
  if (status === "reverted") {
    await setSettleState(p.key, { ...st, status: "FAILED", note: "reverted" });
    await moveProcessingTo(raw, DEAD_KEY, deadLetter(p, `reverted tx=${st.txHash}`));
    console.error(`::error::dead-lettered（對帳：revert）${tag(p.entry, p.key)} tx=${st.txHash}`);
    return { outcome: "dead", error: `reverted tx=${st.txHash}` };
  }

  // 查不到 receipt。**不**根據 signer 的 nonce 推論「已被替換」：公共節點會回落後
  // 狀態，「已上鏈只是查不到 receipt」與「被別的交易替換」在這裡分不出來，猜錯就是
  // 雙付。一律維持 UNKNOWN，逾時轉 STUCK 交人工（agent/README.md「結算交易卡住」）。
  if (now - since > STUCK_AFTER_MS) {
    // 先設全域停機旗標、再寫 STUCK：旗標那次寫入失敗時，狀態仍是 UNKNOWN、項目留在
    // processing，下一輪（回收項目最先處理）會再走到這裡——不會有「已 STUCK 卻沒停機」。
    await haltFor(p, st, `STUCK：簽出超過 ${Math.round(STUCK_AFTER_MS / 60000)} 分鐘仍查不到 receipt`, deps);
    await setSettleState(p.key, { ...st, status: "STUCK", note: `${Math.round((now - since) / 60000)} 分鐘仍無 receipt` });
    await moveProcessingTo(raw, DEAD_KEY, deadLetter(p, `STUCK tx=${st.txHash}${nonceNote}`));
    console.error(
      `::error::STUCK ${tag(p.entry, p.key)} tx=${st.txHash}${nonceNote} —— 簽出超過 ` +
        `${Math.round(STUCK_AFTER_MS / 60000)} 分鐘仍查不到 receipt，不自動重送。請依 agent/README.md` +
        "「結算交易卡住」用同一個 nonce 重播或取消。",
    );
    return { outcome: "stuck", tx: st.txHash, error: "no receipt" };
  }
  await moveProcessingTo(raw, UNCONFIRMED_KEY);
  console.warn(`pending（等待 receipt）${tag(p.entry, p.key)} tx=${st.txHash}${nonceNote}`);
  return { outcome: "pending", tx: st.txHash, error: "尚無 receipt" };
}

/**
 * 處理 processing 裡的一筆原始項目。正常結果都會把這筆從 processing 移走
 * （ack / 搬去 retry / dead / review / 放回 main 或 unconfirmed）。Redis 例外會往外丟，
 * 由 runWorker 攔截——此時項目留在 processing，下一輪回收。
 */
export async function processOne(
  raw: string,
  deps: WorkerDeps = defaultDeps,
  ctx: RunContext = { runStartedAt: deps.now(), lockHeld: false },
  source?: string,
): Promise<ProcessOutcome> {
  let p: Parsed;
  try {
    p = parseItem(raw);
  } catch (err) {
    await moveProcessingTo(raw, DEAD_KEY, JSON.stringify({ raw, attempts: 0, lastError: `unparseable: ${(err as Error).message}` }));
    console.error(`::error::無法解析的佇列項目已移入死信：${raw.slice(0, 200)}`);
    return { outcome: "dead", error: "unparseable" };
  }
  if (p.legacyKey) console.warn(`legacy entry（無 idempotencyKey）→ 以內容雜湊作鍵 ${p.key}`);

  const existing = await getSettleState(p.key);
  if (!existing && source === UNCONFIRMED_KEY) {
    // unconfirmed 的項目一定簽出過交易；狀態不見了（例如 halt 超過 90 天、冪等狀態過期）
    // 就無法對帳——重新結算可能雙付。一律死信交人工。
    await moveProcessingTo(raw, DEAD_KEY, deadLetter(p, "unconfirmed item without settle state"));
    console.error(`::error::unconfirmed 項目缺少結算狀態，無法對帳，移入死信（不重新結算）${tag(p.entry, p.key)}`);
    return { outcome: "dead", error: "unconfirmed without state" };
  }
  if (existing) {
    if (existing.status === "DONE") {
      if (p.legacyKey) {
        // 舊格式：同一雜湊已結算過。可能是重複，也可能是另一筆真實付款——交人工。
        const total = await incrLegacyCollisions();
        await moveProcessingTo(raw, LEGACY_REVIEW_KEY);
        console.warn(
          `::warning::legacy 雜湊衝突（累計 ${total} 筆）${tag(p.entry, p.key)} —— 不結算、不丟棄，` +
            `已移入 ${LEGACY_REVIEW_KEY} 交人工核對是否為另一筆真實付款。`,
        );
        return { outcome: "review", key: p.key };
      }
      await ackProcessing(raw);
      console.log(`skip duplicate（已結算）${tag(p.entry, p.key)} tx=${existing.txHash ?? "?"}`);
      return { outcome: "duplicate", key: p.key };
    }
    if (existing.status === "FAILED" || existing.status === "STUCK") {
      if (existing.status === "STUCK") await haltFor(p, existing, "重複項目指向 STUCK 的鍵", deps);
      await moveProcessingTo(raw, DEAD_KEY, deadLetter(p, `duplicate of ${existing.status} key`));
      console.error(`::error::同一鍵已是 ${existing.status}，重複項目移入死信 ${tag(p.entry, p.key)}`);
      return { outcome: existing.status === "STUCK" ? "stuck" : "dead", error: `key already ${existing.status}` };
    }
    if (existing.txHash) return reconcile(raw, p, existing, deps);
    // PENDING 且沒有 hash。簽出前一定先記 hash，所以沒有 hash = 還沒簽。但佔位的
    // worker 可能還活著（例如 concurrency group 失效時的並行 worker）——只有佔位超過
    // ORPHAN_CLAIM_AFTER_MS（> job timeout）且本輪持有租約鎖時，才確定它已經結束。
    if (ctx.lockHeld && deps.now() - existing.claimedAt > ORPHAN_CLAIM_AFTER_MS) {
      console.warn(`釋放遺留的佔位（PENDING、無 tx hash、超過 25 分鐘）${tag(p.entry, p.key)}`);
      await releaseSettleKey(p.key);
    } else {
      await moveProcessingTo(raw, QUEUE_KEY);
      return { outcome: "pending", error: "已有佔位（PENDING、無 hash）且未逾時，留待之後處理" };
    }
  }

  // claim 前檢查受益 trader（審查 High-2）：舊項目的受益人可能是外洩地址。
  const ta = await deps.assessTrader(p.entry.trader);
  if (ta.source !== "no-data") ctx.traderCheckPassed = true;
  if (!ta.safe) {
    if (ta.source === "no-data") {
      // 暫時查不到（RPC）→ 不能判定。不消耗重試次數：放回佇列、停止本輪。
      await moveProcessingTo(raw, QUEUE_KEY);
      return { outcome: "halted", error: `trader 安全檢查暫時無法完成：${ta.reason}` };
    }
    await moveProcessingTo(raw, DEAD_KEY, deadLetter(p, `trader_unsafe: ${ta.reason}`));
    console.error(`::error::受益 trader 不安全，不結算、移入死信 ${tag(p.entry, p.key)}：${ta.reason}`);
    return { outcome: "dead", error: `trader_unsafe: ${ta.reason}` };
  }

  // 送新交易前確認 mempool 裡沒有這個 signer 未上鏈的交易（審查 Medium-5）。
  let n: { latest: number; pending: number };
  try {
    n = await deps.nonceStatus();
  } catch (err) {
    await moveProcessingTo(raw, QUEUE_KEY);
    return { outcome: "blocked", kind: "rpc", error: `nonce 查詢失敗（RPC），不送新交易：${(err as Error).message}` };
  }
  ctx.nonceQueried = true;
  if (n.pending === n.latest) ctx.nonceCheckPassed = true;
  if (n.pending !== n.latest) {
    await moveProcessingTo(raw, QUEUE_KEY);
    return {
      outcome: "blocked",
      kind: "nonce_mismatch",
      error:
        `signer 有未上鏈的交易（nonce latest=${n.latest} pending=${n.pending}）——不送新交易，` +
        "等它上鏈或依 agent/README.md「結算交易卡住」處理。",
    };
  }

  const claimedAt = deps.now();
  const claimed = await claimSettleKey(p.key, { status: "PENDING", claimedAt });
  if (!claimed) {
    // 另一個 process 剛佔走（理論上 concurrency group 下不會發生）→ 放回，下一輪看狀態。
    await moveProcessingTo(raw, QUEUE_KEY);
    return { outcome: "pending", error: "冪等鍵已被佔用" };
  }

  let signedHash: string | undefined;
  const r = await deps.settle(p.entry.trader, p.entry.feeUsd, {
    onSigned: async ({ txHash, nonce, rawTx }) => {
      signedHash = txHash;
      await setSettleState(p.key, { status: "UNKNOWN", claimedAt, txHash, nonce, rawTx, sentAt: deps.now() });
    },
  });

  switch (r.status) {
    case "settled":
      await setSettleState(p.key, { status: "DONE", claimedAt, txHash: r.tx, sentAt: claimedAt });
      await ackProcessing(raw);
      console.log(`settled ${tag(p.entry, p.key)} tx=${r.tx}`);
      return { outcome: "settled", tx: r.tx };
    case "reverted":
      await setSettleState(p.key, { status: "FAILED", claimedAt, txHash: r.tx, note: r.error });
      await moveProcessingTo(raw, DEAD_KEY, JSON.stringify({ entry: p.entry, attempts: p.attempts + 1, lastError: `${r.error} tx=${r.tx}` }));
      console.error(`::error::dead-lettered（revert）${tag(p.entry, p.key)} tx=${r.tx}`);
      return { outcome: "dead", error: r.error };
    case "unknown":
      // 狀態已在 onSigned 寫成 UNKNOWN + hash；項目進 unconfirmed，下一輪最先對帳。
      await moveProcessingTo(raw, UNCONFIRMED_KEY);
      console.warn(`::warning::UNKNOWN ${tag(p.entry, p.key)} tx=${r.tx} —— ${r.error}；不重送，下一輪對帳`);
      return { outcome: "pending", tx: r.tx, error: r.error };
    case "failed":
      // failed 只會出現在「未廣播」：簽出前失敗，或 onSigned 記錄失敗（此時不廣播）。
      // 簽出並嘗試廣播之後的任何錯誤都是 unknown，不會走到這裡。
      if (signedHash) console.warn(`已簽 ${signedHash} 但 onSigned 記錄失敗、未廣播，釋放佔位`);
      await releaseSettleKey(p.key);
      return failOrRetry(raw, p, r.error);
  }
}

// ── 一輪 ─────────────────────────────────────────────────────────────────────

export interface RunSummary {
  recovered: number;
  available: number;
  settled: number;
  duplicate: number;
  pending: number;
  retried: number;
  dead: number;
  stuck: number;
  failed: number;
  review: number;
  /** 因 nonce 不一致（或查不到）而沒有送新交易。 */
  blocked: number;
  /** 其中：nonce 查詢本身失敗（RPC）。 */
  blockedRpc: number;
  /** 處理單筆時遇到的 Redis / 未預期例外（本輪因此提前停止）。 */
  errors: number;
  /** trader 檢查的 RPC 暫時失敗等原因而提前停止（不算失敗）。 */
  halted: number;
  /** 另一個 worker 持有租約鎖 → 本輪完全沒處理。 */
  skippedLocked: boolean;
  /** nonce 不一致已連續超過 BLOCKED_ESCALATE_MS。 */
  blockedTooLong: boolean;
  /** 第一次 blocked 的時間（ms），沒有則 undefined。 */
  blockedSince?: number;
  /** nonce 查詢（RPC）連續失敗已超過 BLOCKED_ESCALATE_MS。 */
  nonceRpcTooLong: boolean;
  nonceRpcSince?: number;
  /** trader 檢查 no-data 已連續超過 BLOCKED_ESCALATE_MS。 */
  nodataTooLong: boolean;
  nodataSince?: number;
  /** 全域停機旗標（本輪開始時已存在，或本輪有項目轉 STUCK）。 */
  globalHalt?: HaltInfo;
}

/**
 * 跑一輪：
 *   0. 回收 processing 遺留項目（上一輪崩潰）。
 *   1. 對帳 unconfirmed（已簽出、未確認）；還有未確認的 → 本輪不送任何新交易。
 *   2. retry，3. main —— 各自只處理「開始時」已在裡面的項目（以開始時長度為上限），
 *      本輪新放回的項目留給下一輪。
 * 出現新的未確認交易、nonce 不一致、或單筆處理丟出例外 → 立刻停止本輪。
 */
export async function runWorker(deps: WorkerDeps = defaultDeps, batchSize = BATCH_SIZE): Promise<RunSummary> {
  const s: RunSummary = {
    recovered: 0, available: 0, settled: 0, duplicate: 0, pending: 0, retried: 0,
    dead: 0, stuck: 0, failed: 0, review: 0, blocked: 0, blockedRpc: 0, errors: 0, halted: 0,
    skippedLocked: false, blockedTooLong: false, nonceRpcTooLong: false, nodataTooLong: false,
  };
  // 租約鎖（第二道防線）：另一個 worker 還在跑 → 什麼都不做。
  const token = randomUUID();
  if (!(await acquireWorkerLock(token))) {
    s.skippedLocked = true;
    console.warn("::warning::另一個結算 worker 持有租約鎖（x402:settlement:lock），本輪不處理任何項目。");
    return s;
  }
  try {
    // 全域停機旗標：STUCK 之後交人工，清除前一律不處理。
    const halt = await getHalt();
    if (halt) {
      s.globalHalt = halt;
      console.error(`::error::全域停機旗標 ${HALT_KEY} 存在（${JSON.stringify(halt)}），本輪不處理任何項目。`);
      return s;
    }
    const ctx: RunContext = { runStartedAt: deps.now(), lockHeld: true };
    await runLocked(deps, batchSize, s, ctx);
    if (s.stuck > 0) s.globalHalt = (await getHalt()) ?? undefined;
    // 持續狀態計時：看到就記錄／刷新；確定恢復就清除。
    try {
      // 兩種 blocked 分開計時：「nonce 不一致」要處理的是 mempool 裡的交易；「nonce 查詢
      // 失敗」要處理的是 RPC。混在一起會讓處理方向錯誤。
      if (s.blocked - s.blockedRpc > 0) {
        s.blockedSince = await markCondition(BLOCKED_SINCE_KEY, deps.now());
        s.blockedTooLong = deps.now() - s.blockedSince > BLOCKED_ESCALATE_MS;
      } else if (ctx.nonceCheckPassed) {
        await clearCondition(BLOCKED_SINCE_KEY);
      }
      if (s.blockedRpc > 0) {
        s.nonceRpcSince = await markCondition(NONCE_RPC_SINCE_KEY, deps.now());
        s.nonceRpcTooLong = deps.now() - s.nonceRpcSince > BLOCKED_ESCALATE_MS;
      } else if (ctx.nonceQueried) {
        await clearCondition(NONCE_RPC_SINCE_KEY);
      }
      if (s.halted > 0) {
        s.nodataSince = await markCondition(NODATA_SINCE_KEY, deps.now());
        s.nodataTooLong = deps.now() - s.nodataSince > BLOCKED_ESCALATE_MS;
      } else if (ctx.traderCheckPassed) {
        await clearCondition(NODATA_SINCE_KEY);
      }
    } catch (err) {
      s.errors += 1;
      console.error(`::error::記錄持續狀態失敗：${(err as Error).message}`);
    }
    return s;
  } finally {
    await releaseWorkerLock(token).catch((err) =>
      console.warn(`釋放租約鎖失敗（1500 秒後自動過期）：${(err as Error).message}`),
    );
  }
}

async function runLocked(deps: WorkerDeps, batchSize: number, s: RunSummary, ctx: RunContext): Promise<RunSummary> {
  s.recovered = await recoverProcessing();
  if (s.recovered > 0) console.warn(`::warning::回收 processing 遺留項目 ${s.recovered} 筆（上一輪可能中途中止）`);

  const tally = (o: ProcessOutcome) => {
    if (o.outcome === "settled") s.settled += 1;
    else if (o.outcome === "duplicate") s.duplicate += 1;
    else if (o.outcome === "pending") s.pending += 1;
    else if (o.outcome === "review") s.review += 1;
    else if (o.outcome === "blocked") (s.blocked += 1), (s.blockedRpc += o.kind === "rpc" ? 1 : 0);
    else if (o.outcome === "halted") s.halted += 1;
    else if (o.outcome === "retry") (s.retried += 1), (s.failed += 1);
    else if (o.outcome === "dead") (s.dead += 1), (s.failed += 1);
    else if (o.outcome === "stuck") (s.stuck += 1), (s.failed += 1);
  };

  /** 單筆處理；例外（多半是 Redis 暫時故障）攔下來，回 null 代表要停止本輪。 */
  const safeProcess = async (raw: string, source?: string): Promise<ProcessOutcome | null> => {
    try {
      return await processOne(raw, deps, ctx, source);
    } catch (err) {
      s.errors += 1;
      console.error(
        `::error::處理佇列項目時發生例外（多半是 Redis 暫時故障），停止本輪；項目留在 processing，` +
          `下一輪回收：${(err as Error).message}`,
      );
      return null;
    }
  };

  // 1) 對帳：不花 batch 預算（對帳只讀 receipt，不送交易）。
  let halted = false;
  for (let n = await queueDepth(UNCONFIRMED_KEY); n > 0; n -= 1) {
    const raw = await claimNext(UNCONFIRMED_KEY);
    if (raw === null || raw === undefined) break;
    const o = await safeProcess(raw, UNCONFIRMED_KEY);
    if (!o) return s;
    tally(o);
    if (o.outcome === "stuck") {
      console.error("::error::出現 STUCK —— 本輪立即停止，不進入送交易階段。");
      return s;
    }
    if (o.outcome === "pending" || o.outcome === "blocked" || o.outcome === "halted") halted = true;
  }
  if (halted) {
    console.warn("::warning::仍有已簽出但未確認的交易 —— 本輪不送任何新交易，等它們有結果。");
    return s;
  }

  // 2) 回收的項目（已在 main 最前面）最先處理：它們可能是上一輪中途中止、狀態已是
  //    UNKNOWN 待轉 STUCK 的項目，必須在任何新交易之前先處理（例如設停機旗標）。
  // 3) retry，4) main —— 送新交易。
  let budget = batchSize;
  const phases: Array<[string, number]> = [
    [QUEUE_KEY, s.recovered],
    [RETRY_KEY, Number.POSITIVE_INFINITY],
    [QUEUE_KEY, Number.POSITIVE_INFINITY],
  ];
  for (const [src, cap] of phases) {
    let n = Math.min(budget, cap, await queueDepth(src));
    while (n-- > 0 && budget > 0) {
      const raw = await claimNext(src);
      if (raw === null || raw === undefined) break;
      budget -= 1;
      s.available += 1;
      const o = await safeProcess(raw);
      if (!o) return s;
      tally(o);
      if (o.outcome === "stuck") {
        console.error("::error::出現 STUCK —— 本輪立即停止。");
        return s;
      }
      if (o.outcome === "blocked" || o.outcome === "halted") {
        console.warn(`::warning::${o.error}`);
        return s;
      }
      if (o.outcome === "pending" && "tx" in o && o.tx) {
        console.warn("::warning::出現未確認的交易，本輪停止送出新交易（避免 nonce 堆疊）。");
        return s;
      }
    }
  }
  return s;
}

/** --dry-run：只讀。不取鎖、不佔位、不簽章、不動任何佇列。 */
async function dryRun(): Promise<void> {
  if (!isLedgerEnabled()) {
    console.error("::error::UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 未設 —— 沒有佇列可以讀。");
    process.exit(1);
  }
  console.log("── dry-run（只讀：不取鎖、不佔位、不簽章）──");
  const halt = await getHalt().catch((err) => {
    console.error(`::error::讀不到全域停機旗標 ${HALT_KEY}：${(err as Error).message}`);
    process.exit(1);
  });
  console.log(`全域停機旗標 ${HALT_KEY}：${halt ? JSON.stringify(halt) : "（無）"}`);
  for (const k of [WORKER_LOCK_KEY, BLOCKED_SINCE_KEY, NONCE_RPC_SINCE_KEY, NODATA_SINCE_KEY]) {
    const v = await readString(k);
    const shown = v && /^\d{12,}$/.test(v) ? `${v}（${new Date(Number(v)).toISOString()}）` : v;
    console.log(`${k}：${shown ?? "（無）"}`);
  }
  for (const key of [UNCONFIRMED_KEY, PROCESSING_KEY, RETRY_KEY, QUEUE_KEY, DEAD_KEY, LEGACY_REVIEW_KEY]) {
    const depth = await queueDepth(key);
    console.log(`${key}：${depth} 筆`);
    for (const raw of await peekQueue(key, 5)) {
      try {
        const p = parseItem(raw);
        const st = await getSettleState(p.key);
        console.log(`  - ${tag(p.entry, p.key)} attempts=${p.attempts} state=${st ? JSON.stringify({ status: st.status, txHash: st.txHash, nonce: st.nonce }) : "（無）"}`);
      } catch {
        console.log(`  - （無法解析）${raw.slice(0, 120)}`);
      }
    }
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--dry-run")) {
    await dryRun();
    return;
  }
  // 只准在 CI 內執行：GitHub Actions job 有 20 分鐘 timeout，租約鎖（1500 秒）不會在
  // 途中過期；本機 process 可以跑任意久（例如卡在 RPC），鎖過期後第二個 worker 就能進來。
  if (process.env.GITHUB_ACTIONS !== "true") {
    console.error(
      "::error::settlement-worker 只准在 GitHub Actions 內執行（GITHUB_ACTIONS=true）：CI job 有 20 分鐘 " +
        "timeout，租約鎖（1500 秒）不會在途中過期；本機執行無此保證，可能與 CI 的 worker 並行而雙付。" +
        "本機請用 `--dry-run` 只讀檢視佇列。",
    );
    process.exit(1);
  }
  if (!isSettlementEnabled()) {
    console.error("::error::FEE_SETTLEMENT_PRIVATE_KEY 未設 —— worker 沒有 signer 可以送交易。");
    process.exit(1);
  }
  if (!isLedgerEnabled()) {
    console.error(
      "::error::UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN 未設 —— 沒有佇列可以讀。",
    );
    process.exit(1);
  }

  // STUCK 之後的全域停機：清除前一律拒跑（runWorker 取鎖後會再檢查一次）。
  const halt = await getHalt().catch((err) => {
    console.error(`::error::讀不到全域停機旗標，fail-closed：${(err as Error).message}`);
    process.exit(1);
  });
  if (halt) {
    console.error(
      `::error::全域停機旗標 ${HALT_KEY} 存在：${JSON.stringify(halt)}。請到 explorer 確認原交易的最終狀態，` +
        "依 agent/README.md「結算交易卡住」處理後手動清除，否則可能雙付。",
    );
    process.exit(1);
  }

  // P0：碰佇列之前先確認錢流經的地址都安全；不安全就整批不動，交人工處理。
  const apiUrl = process.env.SIGNAL_API_URL?.trim();
  const pre = await payoutPreflight({
    codeReader: settlementProvider()!,
    payTo: process.env.PAY_TO,
    signerAddress: settlementSignerAddress(),
    routerAddress: settlementRouterAddress(),
    readPlatformTreasury,
    fetchPublishedPayTo: apiUrl ? () => fetchPublishedPayTo(apiUrl) : undefined,
    requirePublishedPayTo: process.env.GITHUB_ACTIONS === "true",
  });
  for (const w of pre.warnings) console.warn(`::warning::${w}`);
  if (pre.problems.length > 0) {
    for (const p of pre.problems) console.error(`::error::${p}`);
    console.error("::error::收款地址守門未通過 —— 佇列原封不動，這次不處理任何項目。");
    process.exit(1);
  }

  let s: RunSummary;
  try {
    s = await runWorker();
  } catch (err) {
    // recoverProcessing / queueDepth 等整輪層級的 Redis 失敗：不崩潰、明確失敗。
    console.error(`::error::本輪無法開始或中途失敗（Redis？）：${(err as Error).message}`);
    process.exit(1);
  }
  if (s.skippedLocked) return; // 另一個 worker 在跑：exit 0
  if (s.globalHalt && s.available + s.pending + s.stuck === 0) {
    console.error(`::error::全域停機旗標存在，本輪未處理任何項目。`);
    process.exit(1);
  }
  const [queueRemaining, retryRemaining, unconfirmed, processingRemaining, deadTotal, reviewTotal] = await Promise.all([
    queueDepth(QUEUE_KEY),
    queueDepth(RETRY_KEY),
    queueDepth(UNCONFIRMED_KEY),
    queueDepth(PROCESSING_KEY),
    queueDepth(DEAD_KEY),
    queueDepth(LEGACY_REVIEW_KEY),
  ]).catch(() => [-1, -1, -1, -1, -1, -1]);

  console.log(
    `recovered=${s.recovered} available=${s.available} settled=${s.settled} duplicate=${s.duplicate} ` +
      `pending=${s.pending} blocked=${s.blocked} review=${s.review} failed=${s.failed} retried=${s.retried} ` +
      `dead=${s.dead} stuck=${s.stuck} errors=${s.errors} halted=${s.halted} ` +
      `queueRemaining=${queueRemaining} retryRemaining=${retryRemaining} unconfirmed=${unconfirmed} ` +
      `processingRemaining=${processingRemaining} deadTotal=${deadTotal} legacyReview=${reviewTotal}`,
  );

  if (deadTotal > 0) {
    console.warn(
      `::warning::死信佇列（${DEAD_KEY}）目前有 ${deadTotal} 筆（重試用盡／revert／STUCK／trader 不安全），需要人工介入。`,
    );
  }
  if (reviewTotal > 0) {
    console.warn(`::warning::${LEGACY_REVIEW_KEY} 有 ${reviewTotal} 筆舊格式雜湊衝突待人工核對。`);
  }
  if (s.errors > 0) {
    console.error(`::error::本輪有 ${s.errors} 次處理例外（見上方），提前停止。`);
    process.exit(1);
  }
  if (s.blockedTooLong) {
    console.error(
      `::error::signer 的 nonce 不一致（mempool 有未上鏈交易）已持續 ` +
        `${Math.round((Date.now() - (s.blockedSince ?? Date.now())) / 60000)} 分鐘，結算停擺。` +
        "請依 agent/README.md「結算交易卡住」處理。",
    );
    process.exit(1);
  }
  if (s.nonceRpcTooLong) {
    console.error(
      `::error::查詢 signer nonce 的 RPC 已連續失敗 ` +
        `${Math.round((Date.now() - (s.nonceRpcSince ?? Date.now())) / 60000)} 分鐘，結算停擺。` +
        "這是 RPC 問題（檢查 BASE_SEPOLIA_RPC_URL / 供應商狀態），不是 mempool 裡有交易卡住。",
    );
    process.exit(1);
  }
  if (s.nodataTooLong) {
    console.error(
      `::error::trader 安全檢查查不到資料（RPC）已持續 ` +
        `${Math.round((Date.now() - (s.nodataSince ?? Date.now())) / 60000)} 分鐘，結算停擺。`,
    );
    process.exit(1);
  }
  if (s.stuck > 0) {
    console.error(`::error::${s.stuck} 筆 STUCK（簽出超過 ${Math.round(STUCK_AFTER_MS / 60000)} 分鐘仍無 receipt），交人工處理。`);
    process.exit(1);
  }

  if (s.available === 0) {
    console.log("這次沒有送出新交易的項目。");
    return;
  }

  if (s.failed > 0) {
    const pct = Math.round((s.failed / s.available) * 100);
    console.log(`失敗率 ${pct}%（門檻 ${MAX_FAIL_PCT}%）`);
    if (pct > MAX_FAIL_PCT) {
      console.error(
        `::error::${s.available} 筆中有 ${s.failed} 筆失敗（${pct}% > ${MAX_FAIL_PCT}%），不要當成成功。`,
      );
      process.exit(1);
    }
  }
}

// 只有直接跑這支腳本（`npx tsx signal-api/src/settlement-worker.ts`）才自動執行
// main()；被 import 時不執行（測試要 import processOne / runWorker）。
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (isMain) {
  await main();
}
