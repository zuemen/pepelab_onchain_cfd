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
//   cd agent
//   npx tsx signal-api/src/settlement-worker.ts
//
// 需要的 env（見 .env.example）：
//   FEE_SETTLEMENT_PRIVATE_KEY  單一 signer
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   佇列
//   PAY_TO / X402_FEE_ROUTER    收款守門（payoutPreflight）
//
// 為什麼「單一 signer」就讓 nonce 衝突在設計上消失：送交易的地方只剩這一支 process、
// 由 GitHub Actions cron 觸發、用 concurrency group 防止重疊執行
// （見 .github/workflows/x402-settlement-worker.yml）。
//
// 2026-09-29（P0）可靠性：
//   1. 可靠佇列：LMOVE main/retry → processing，完成才 LREM；啟動時先把 processing
//      的遺留項目搬回 main（上一輪崩潰可回收）。
//   2. 冪等：每筆的 idempotencyKey 在上鏈前 `SET settle:<key> NX` 佔位；DONE 的鍵
//      再出現直接跳過。
//   3. 未確定狀態：routeExternalRevenue 先簽、先記 hash、再廣播。等 receipt 逾時 →
//      UNKNOWN，**絕不自動重送**；下一輪用 receipt 對帳：成功 → DONE；revert → 死信；
//      超過 STUCK_AFTER_MS（30 分鐘）仍查不到 → STUCK，job 失敗，交人工處理。
//      UNKNOWN 的項目放進 unconfirmed 佇列，每輪最先對帳；只要還有未確認的交易，
//      本輪就不送任何新交易（後面的 nonce 會卡在它後面，且避免盲目堆疊）。
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { assessPayoutAddress, type CodeReader } from "@pepelab/shared";
import {
  isSettlementEnabled,
  settleRevenue,
  getReceiptStatus,
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
  QUEUE_KEY,
  PROCESSING_KEY,
  RETRY_KEY,
  UNCONFIRMED_KEY,
  DEAD_KEY,
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

export interface PreflightDeps {
  codeReader: CodeReader;
  payTo: string | undefined;
  signerAddress: string | undefined;
  routerAddress: string;
  readPlatformTreasury: () => Promise<string>;
}

/**
 * P0 收款地址守門（fail-closed）：在碰佇列之前檢查三個「錢會流過去」的地址。
 *   - PAY_TO（x402 收款）：必須是 EOA，且不是外洩／EIP-7702 委派地址。
 *   - 結算 signer：同上（它就是要 approve + routeExternalRevenue 的那個 EOA）。
 *   - FeeRouter.platformTreasury()：20% 平台分潤的去向，不可是外洩／委派地址。
 * 回傳 problems（任何一個 → worker 以非零結束，佇列原封不動）與 warnings。
 */
export async function payoutPreflight(d: PreflightDeps): Promise<{ problems: string[]; warnings: string[] }> {
  const problems: string[] = [];
  const warnings: string[] = [];

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

  if (
    d.payTo?.trim() &&
    d.signerAddress &&
    d.payTo.trim().toLowerCase() !== d.signerAddress.toLowerCase()
  ) {
    warnings.push(
      `PAY_TO(${d.payTo}) ≠ 結算 signer(${d.signerAddress})：x402 收入不會進 signer，` +
        "worker 會用 signer 自己的餘額分潤（見 agent/README.md）。",
    );
  }
  return { problems, warnings };
}


// ── 單筆處理 ─────────────────────────────────────────────────────────────────

export type ProcessOutcome =
  | { outcome: "settled"; tx: string }
  | { outcome: "duplicate"; key: string }
  | { outcome: "pending"; tx?: string; error: string }
  | { outcome: "retry" | "dead"; error: string }
  | { outcome: "stuck"; tx?: string; error: string };

/** 可注入的外部依賴——測試用假的 settle / receipt / 時鐘，不碰任何鏈。 */
export interface WorkerDeps {
  settle: (trader: string, feeUsd: number, hooks: SettleHooks) => Promise<SettlementResult>;
  receiptStatus: (txHash: string) => Promise<"success" | "reverted" | null>;
  now: () => number;
}

export const defaultDeps: WorkerDeps = {
  settle: settleRevenue,
  receiptStatus: getReceiptStatus,
  now: () => Date.now(),
};

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
  // 舊資料（2026-09-29 前入列）沒有冪等鍵：以 entry 內容雜湊補上。穩定（重試包裝不影響），
  // 代價是「同一 trader、同金額、同一秒、同端點」的兩筆真付款會被當成同一筆——可接受的邊界。
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

/** 對一個已經簽出過 tx 的鍵做 receipt 對帳。 */
async function reconcile(raw: string, p: Parsed, st: SettleState, deps: WorkerDeps): Promise<ProcessOutcome> {
  const now = deps.now();
  const since = st.sentAt ?? st.claimedAt;
  if (!st.txHash) {
    // PENDING 且沒有 hash：上一輪在「佔位之後、簽出之前」崩潰，或正在簽。簽出前一定
    // 會先記 hash，所以沒有 hash 代表 routeExternalRevenue 應該沒送出——但無法 100%
    // 排除（例如 hash 寫入後 Redis 回應遺失）。保守：未滿時限先放回，超過就交人工。
    if (now - since > STUCK_AFTER_MS) {
      await setSettleState(p.key, { ...st, status: "STUCK", note: "PENDING 無 tx hash 超過時限" });
      await moveProcessingTo(raw, DEAD_KEY, JSON.stringify({ entry: p.entry, attempts: p.attempts, lastError: "STUCK: PENDING without tx hash" }));
      console.error(`::error::STUCK（佔位後無 tx hash）${tag(p.entry, p.key)} —— 請人工確認 signer 的交易紀錄`);
      return { outcome: "stuck", error: "PENDING without tx hash" };
    }
    await moveProcessingTo(raw, UNCONFIRMED_KEY);
    return { outcome: "pending", error: "PENDING（尚未簽出），留待下一輪" };
  }

  let status: "success" | "reverted" | null;
  try {
    status = await deps.receiptStatus(st.txHash);
  } catch (err) {
    // 查不到 receipt 本身失敗（RPC）→ 狀態不變，放回佇列，下一輪再查；不重送。
    await moveProcessingTo(raw, UNCONFIRMED_KEY);
    return { outcome: "pending", tx: st.txHash, error: `receipt 查詢失敗：${(err as Error).message}` };
  }
  if (status === "success") {
    await setSettleState(p.key, { ...st, status: "DONE" });
    await ackProcessing(raw);
    console.log(`reconciled settled ${tag(p.entry, p.key)} tx=${st.txHash}`);
    return { outcome: "settled", tx: st.txHash };
  }
  if (status === "reverted") {
    await setSettleState(p.key, { ...st, status: "FAILED", note: "reverted" });
    await moveProcessingTo(raw, DEAD_KEY, JSON.stringify({ entry: p.entry, attempts: p.attempts + 1, lastError: `reverted tx=${st.txHash}` }));
    console.error(`::error::dead-lettered（對帳：revert）${tag(p.entry, p.key)} tx=${st.txHash}`);
    return { outcome: "dead", error: `reverted tx=${st.txHash}` };
  }
  if (now - since > STUCK_AFTER_MS) {
    await setSettleState(p.key, { ...st, status: "STUCK", note: `${Math.round((now - since) / 60000)} 分鐘仍無 receipt` });
    await moveProcessingTo(raw, DEAD_KEY, JSON.stringify({ entry: p.entry, attempts: p.attempts, lastError: `STUCK tx=${st.txHash}` }));
    console.error(
      `::error::STUCK ${tag(p.entry, p.key)} tx=${st.txHash} —— 簽出超過 ${Math.round(STUCK_AFTER_MS / 60000)} 分鐘仍查不到 receipt，` +
        "不自動重送，請人工確認（交易可能被丟棄、nonce 卡住、或 RPC 不同步）。",
    );
    return { outcome: "stuck", tx: st.txHash, error: "no receipt" };
  }
  await moveProcessingTo(raw, UNCONFIRMED_KEY);
  console.warn(`pending（等待 receipt）${tag(p.entry, p.key)} tx=${st.txHash}`);
  return { outcome: "pending", tx: st.txHash, error: "尚無 receipt" };
}

/**
 * 處理 processing 裡的一筆原始項目。所有結果都會把這筆從 processing 移走
 * （ack / 搬去 retry / dead / 放回 main），不會留在 processing。
 */
export async function processOne(raw: string, deps: WorkerDeps = defaultDeps): Promise<ProcessOutcome> {
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
  if (existing) {
    if (existing.status === "DONE") {
      await ackProcessing(raw);
      console.log(`skip duplicate（已結算）${tag(p.entry, p.key)} tx=${existing.txHash ?? "?"}`);
      return { outcome: "duplicate", key: p.key };
    }
    if (existing.status === "FAILED" || existing.status === "STUCK") {
      await moveProcessingTo(raw, DEAD_KEY, JSON.stringify({ entry: p.entry, attempts: p.attempts, lastError: `duplicate of ${existing.status} key` }));
      console.error(`::error::同一鍵已是 ${existing.status}，重複項目移入死信 ${tag(p.entry, p.key)}`);
      return { outcome: existing.status === "STUCK" ? "stuck" : "dead", error: `key already ${existing.status}` };
    }
    return reconcile(raw, p, existing, deps);
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
    onSigned: async (txHash) => {
      signedHash = txHash;
      await setSettleState(p.key, { status: "UNKNOWN", claimedAt, txHash, sentAt: deps.now() });
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
      if (signedHash) {
        // onSigned 已跑過但 settle 判定「確定沒送出」（節點明確拒絕）→ 可釋放。
        console.warn(`已簽 ${signedHash} 但節點明確拒絕，釋放佔位`);
      }
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
}

/**
 * 跑一輪：
 *   0. 回收 processing 遺留項目（上一輪崩潰）。
 *   1. 對帳 unconfirmed（已簽出、未確認）；還有未確認的 → 本輪不送任何新交易。
 *   2. retry，3. main —— 各自只處理「開始時」已在裡面的項目（以開始時長度為上限），
 *      本輪新放回的項目留給下一輪。
 * 一旦出現新的未確認交易，立刻停止送新交易（後面的 nonce 會卡在它後面）。
 */
export async function runWorker(deps: WorkerDeps = defaultDeps, batchSize = BATCH_SIZE): Promise<RunSummary> {
  const s: RunSummary = { recovered: 0, available: 0, settled: 0, duplicate: 0, pending: 0, retried: 0, dead: 0, stuck: 0, failed: 0 };
  s.recovered = await recoverProcessing();
  if (s.recovered > 0) console.warn(`::warning::回收 processing 遺留項目 ${s.recovered} 筆（上一輪可能中途中止）`);

  const tally = (o: ProcessOutcome) => {
    if (o.outcome === "settled") s.settled += 1;
    else if (o.outcome === "duplicate") s.duplicate += 1;
    else if (o.outcome === "pending") s.pending += 1;
    else if (o.outcome === "retry") (s.retried += 1), (s.failed += 1);
    else if (o.outcome === "dead") (s.dead += 1), (s.failed += 1);
    else if (o.outcome === "stuck") (s.stuck += 1), (s.failed += 1);
  };

  // 1) 對帳：不花 batch 預算（對帳只讀 receipt，不送交易）。
  let halted = false;
  for (let n = await queueDepth(UNCONFIRMED_KEY); n > 0; n -= 1) {
    const raw = await claimNext(UNCONFIRMED_KEY);
    if (raw === null || raw === undefined) break;
    const o = await processOne(raw, deps);
    tally(o);
    if (o.outcome === "pending") halted = true;
  }
  if (halted) {
    console.warn("::warning::仍有已簽出但未確認的交易 —— 本輪不送任何新交易，等它們有結果。");
    return s;
  }

  // 2) 3) 送新交易。
  let budget = batchSize;
  for (const src of [RETRY_KEY, QUEUE_KEY]) {
    let n = Math.min(budget, await queueDepth(src));
    while (n-- > 0 && budget > 0) {
      const raw = await claimNext(src);
      if (raw === null || raw === undefined) break;
      budget -= 1;
      s.available += 1;
      const o = await processOne(raw, deps);
      tally(o);
      if (o.outcome === "pending") {
        console.warn("::warning::出現未確認的交易，本輪停止送出新交易（避免 nonce 堆疊）。");
        return s;
      }
    }
  }
  return s;
}

async function main(): Promise<void> {
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

  // P0：碰佇列之前先確認錢流經的地址都安全；不安全就整批不動，交人工處理。
  const pre = await payoutPreflight({
    codeReader: settlementProvider()!,
    payTo: process.env.PAY_TO,
    signerAddress: settlementSignerAddress(),
    routerAddress: settlementRouterAddress(),
    readPlatformTreasury,
  });
  for (const w of pre.warnings) console.warn(`::warning::${w}`);
  if (pre.problems.length > 0) {
    for (const p of pre.problems) console.error(`::error::${p}`);
    console.error("::error::收款地址守門未通過 —— 佇列原封不動，這次不處理任何項目。");
    process.exit(1);
  }

  const s = await runWorker();
  const [queueRemaining, retryRemaining, unconfirmed, processingRemaining, deadTotal] = await Promise.all([
    queueDepth(QUEUE_KEY),
    queueDepth(RETRY_KEY),
    queueDepth(UNCONFIRMED_KEY),
    queueDepth(PROCESSING_KEY),
    queueDepth(DEAD_KEY),
  ]);

  console.log(
    `recovered=${s.recovered} available=${s.available} settled=${s.settled} duplicate=${s.duplicate} ` +
      `pending=${s.pending} failed=${s.failed} retried=${s.retried} dead=${s.dead} stuck=${s.stuck} ` +
      `queueRemaining=${queueRemaining} retryRemaining=${retryRemaining} unconfirmed=${unconfirmed} ` +
      `processingRemaining=${processingRemaining} deadTotal=${deadTotal}`,
  );

  if (deadTotal > 0) {
    console.warn(
      `::warning::死信佇列（${DEAD_KEY}）目前有 ${deadTotal} 筆（重試用盡／revert／STUCK），需要人工介入。`,
    );
  }
  if (s.stuck > 0) {
    console.error(`::error::${s.stuck} 筆 STUCK（簽出超過 ${Math.round(STUCK_AFTER_MS / 60000)} 分鐘仍無 receipt），交人工處理。`);
    process.exit(1);
  }

  if (s.available === 0) {
    console.log("佇列淨空，這次沒有要處理的項目。");
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
