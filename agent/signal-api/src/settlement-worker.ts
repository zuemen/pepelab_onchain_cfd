// x402 結算 worker：把 ledger.ts 佇列裡「已收款、待分潤」的項目批次送上鏈。
//
// 優先序 1（x402 硬化）的第二半：app.ts 的付費端點只記帳（推進 Upstash 佇列），
// 不再送任何交易；上鏈這件事全部集中在這支腳本，用單一 signer 依序處理。
//
// 為什麼放在 signal-api/src/ 而不是 agent/keeper/：這支只依賴同目錄的
// settlement.ts / ledger.ts（都是 signal-api 的模組），放進 keeper/ 會變成跨
// workspace 的相對路徑匯入，徒增匯入路徑的脆弱性。**執行模型**沿用
// agent/keeper 的既有 pattern——單一 CLI 腳本、單一 signer、GitHub Actions cron、
// 缺 secret 直接 fail fast、印一行摘要讓 workflow 用門檻判斷成功與否——只是
// 檔案實際放在跟它依賴的程式碼同一個目錄。
//
// 用法：
//   cd agent
//   npx tsx signal-api/src/settlement-worker.ts
//
// 需要的 env（見 .env.example）：
//   FEE_SETTLEMENT_PRIVATE_KEY  單一 signer，跟以前一樣（settlement.ts 沒變）
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   佇列
//
// 為什麼「單一 signer」就讓 nonce 衝突在設計上消失：以前是「每個 Vercel 實例各自
// 在請求路徑裡送交易」，跨實例並發、共用同一把私鑰，nonce 序列互相打架。現在
// 送交易的地方只剩這一支 process、由 GitHub Actions cron 觸發、用 concurrency
// group 防止同一支 workflow 重疊執行（見 .github/workflows/x402-settlement-worker.yml）
// ——任何時刻至多一個 process 持有這把私鑰在送交易，nonce 序列只有一條。
import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { assessPayoutAddress, type CodeReader } from "@pepelab/shared";
import {
  isSettlementEnabled,
  settleRevenue,
  settlementSignerAddress,
  settlementRouterAddress,
  settlementProvider,
  readPlatformTreasury,
} from "./settlement.ts";
import {
  isLedgerEnabled,
  dequeueBatch,
  dequeueRetryBatch,
  pushRetry,
  pushDead,
  queueDepth,
  QUEUE_KEY,
  RETRY_KEY,
  DEAD_KEY,
  type LedgerEntry,
  type RetryEntry,
} from "./ledger.ts";

const BATCH_SIZE = Number(process.env.SETTLEMENT_BATCH_SIZE ?? "25");
export const MAX_RETRY_ATTEMPTS = Number(process.env.SETTLEMENT_MAX_RETRIES ?? "5");
// 部分失敗門檻：沿用 keeper 系列 workflow 的慣例（MAX_FAIL_PCT），失敗率超過
// 這個百分比就讓 CI job 變紅，不要讓「11 筆壞 7 筆」看起來像成功。
const MAX_FAIL_PCT = Number(process.env.SETTLEMENT_MAX_FAIL_PCT ?? "30");

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

export type ProcessOutcome = { outcome: "settled"; tx: string } | { outcome: "retry" | "dead"; error: string };

/**
 * 處理單一筆待結算項目，回傳結果而不是直接改 module 級計數器——讓 main() 之外
 * 的呼叫端（測試）可以直接驅動這個函式並檢查結果，不需要先通過 main() 開頭那段
 * 「沒 signer/沒佇列就直接 exit(1)」的前置檢查。
 */
export async function processOne(entry: LedgerEntry, priorAttempts: number): Promise<ProcessOutcome> {
  const r = await settleRevenue(entry.trader, entry.feeUsd);
  if (r.status === "settled") {
    console.log(
      `settled trader=${entry.trader} feeUsd=${entry.feeUsd} source=${entry.source} tx=${r.tx}`,
    );
    return { outcome: "settled", tx: r.tx! };
  }
  const attempts = priorAttempts + 1;
  const error = r.error ?? "unknown error";
  const retryEntry: RetryEntry = { entry, attempts, lastError: error };
  if (attempts >= MAX_RETRY_ATTEMPTS) {
    await pushDead(retryEntry);
    console.error(
      `::error::dead-lettered trader=${entry.trader} feeUsd=${entry.feeUsd} ` +
        `attempts=${attempts} error=${error}`,
    );
    return { outcome: "dead", error };
  }
  await pushRetry(retryEntry);
  console.warn(
    `retry trader=${entry.trader} feeUsd=${entry.feeUsd} attempts=${attempts} error=${error}`,
  );
  return { outcome: "retry", error };
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

  let settled = 0;
  let retried = 0;
  let dead = 0;
  let failed = 0;

  // 先處理重試佇列：這些已經失敗過至少一次，優先清掉避免無限期卡在佇列尾端。
  const retryBatch = await dequeueRetryBatch(BATCH_SIZE);
  for (const r of retryBatch) {
    const o = await processOne(r.entry, r.attempts);
    if (o.outcome === "settled") settled += 1;
    else {
      failed += 1;
      if (o.outcome === "dead") dead += 1;
      else retried += 1;
    }
  }

  // 剩餘預算才處理新項目；批次上限是「一次 cron 觸發最多處理幾筆」，不是佇列容量。
  const remaining = Math.max(0, BATCH_SIZE - retryBatch.length);
  const mainBatch = remaining > 0 ? await dequeueBatch(QUEUE_KEY, remaining) : [];
  for (const entry of mainBatch) {
    const o = await processOne(entry, 0);
    if (o.outcome === "settled") settled += 1;
    else {
      failed += 1;
      if (o.outcome === "dead") dead += 1;
      else retried += 1;
    }
  }

  const available = retryBatch.length + mainBatch.length;
  const [queueRemaining, retryRemaining, deadTotal] = await Promise.all([
    queueDepth(QUEUE_KEY),
    queueDepth(RETRY_KEY),
    queueDepth(DEAD_KEY),
  ]);

  console.log(
    `available=${available} settled=${settled} failed=${failed} retried=${retried} dead=${dead} ` +
      `queueRemaining=${queueRemaining} retryRemaining=${retryRemaining} deadTotal=${deadTotal}`,
  );

  if (deadTotal > 0) {
    console.warn(
      `::warning::死信佇列（${DEAD_KEY}）目前有 ${deadTotal} 筆，重試 ${MAX_RETRY_ATTEMPTS} 次仍失敗，需要人工介入。`,
    );
  }

  if (available === 0) {
    console.log("佇列淨空，這次沒有要處理的項目。");
    return;
  }

  if (failed > 0) {
    const pct = Math.round((failed / available) * 100);
    console.log(`失敗率 ${pct}%（門檻 ${MAX_FAIL_PCT}%）`);
    if (pct > MAX_FAIL_PCT) {
      console.error(
        `::error::${available} 筆中有 ${failed} 筆失敗（${pct}% > ${MAX_FAIL_PCT}%），不要當成成功。`,
      );
      process.exit(1);
    }
  }
}

// 只有直接跑這支腳本（`npx tsx signal-api/src/settlement-worker.ts`）才自動執行
// main()；被 import 時不執行（settlement-worker.test.ts 要 import processOne，
// 不能一 import 就因為測試環境沒有 signer/佇列而 process.exit(1)）。
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (isMain) {
  await main();
}
