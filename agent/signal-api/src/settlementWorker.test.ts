// settlement-worker.ts 的可靠佇列 / 冪等 / 未確定狀態，離線測試。
//   cd agent && npx tsx signal-api/src/settlementWorker.test.ts
//
// 用假 Upstash（testing/fakeUpstash.ts）+ 注入假的 settle / receipt / 時鐘，
// 不碰任何鏈、不需要金鑰。涵蓋：
//   - 失敗重試 → 死信（且失敗時釋放冪等佔位）
//   - LMOVE 之後崩潰 → 下一輪回收並只結算一次
//   - 重跑不重複；同一鍵重複入列只結算一次
//   - tx.wait 逾時 → UNKNOWN，不重送；下一輪用 receipt 對帳（成功 / revert / 30 分鐘 STUCK）
//   - 結算完成、ack 前崩潰 → 回收後辨識為重複，不再送
import assert from "node:assert";
import { startFakeUpstash } from "./testing/fakeUpstash.ts";

const fake = await startFakeUpstash();
process.env.UPSTASH_REDIS_REST_URL = fake.url;
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
delete process.env.FEE_SETTLEMENT_PRIVATE_KEY;
process.env.BASE_SEPOLIA_RPC_URL ??= "http://127.0.0.1:1";

const { runWorker, processOne, MAX_RETRY_ATTEMPTS, STUCK_AFTER_MS } = await import("./settlement-worker.ts");
const ledger = await import("./ledger.ts");
const { QUEUE_KEY, PROCESSING_KEY, RETRY_KEY, DEAD_KEY, SETTLE_STATE_PREFIX, enqueueSettlement, claimNext, getSettleState } = ledger;
type SettlementResult = Awaited<ReturnType<(typeof import("./settlement.ts"))["settleRevenue"]>>;
type SettleHooks = NonNullable<Parameters<(typeof import("./settlement.ts"))["settleRevenue"]>[2]>;

const TRADER = "0x5555555555555555555555555555555555555555";
const entry = (key: string) => ({ trader: TRADER, feeUsd: 0.01, at: 1, source: "signals" as const, idempotencyKey: key });

let clock = 1_000_000_000;
let settleCalls = 0;
let receipt: "success" | "reverted" | null = null;
type Mode = "ok" | "fail" | "timeout";
let mode: Mode = "ok";
let hashSeq = 0;

const deps = {
  now: () => clock,
  receiptStatus: async () => receipt,
  settle: async (_t: string, _f: number, hooks: SettleHooks): Promise<SettlementResult> => {
    settleCalls += 1;
    if (mode === "fail") return { status: "failed", error: "boom (fake)" };
    const tx = "0x" + String(++hashSeq).padStart(64, "0");
    await hooks.onSigned?.(tx);
    if (mode === "timeout") return { status: "unknown", tx, error: "timeout (fake)" };
    return { status: "settled", tx };
  },
};

function reset() {
  fake.lists.clear();
  fake.strings.clear();
  settleCalls = 0;
  receipt = null;
  mode = "ok";
}

// ── 1) 失敗重試 → 死信；失敗時釋放佔位 ─────────────────────────────────────
{
  reset();
  mode = "fail";
  await enqueueSettlement(entry("k-fail"));
  for (let i = 1; i <= MAX_RETRY_ATTEMPTS; i += 1) {
    const s = await runWorker(deps);
    assert.equal(s.available, 1, `第 ${i} 輪應處理 1 筆`);
    assert.equal(fake.strings.has(SETTLE_STATE_PREFIX + "k-fail"), false, "確定沒送出 → 佔位要釋放");
    if (i < MAX_RETRY_ATTEMPTS) {
      assert.equal(s.retried, 1);
      const r = JSON.parse(fake.list(RETRY_KEY)[0]!) as { attempts: number; lastError: string };
      assert.equal(r.attempts, i);
      assert.equal(r.lastError, "boom (fake)");
    } else {
      assert.equal(s.dead, 1);
    }
  }
  assert.equal(fake.list(RETRY_KEY).length, 0);
  assert.equal(fake.list(DEAD_KEY).length, 1);
  assert.equal(fake.list(PROCESSING_KEY).length, 0);
  assert.equal(settleCalls, MAX_RETRY_ATTEMPTS);
  console.log(`失敗 ${MAX_RETRY_ATTEMPTS} 次 → 死信；每次失敗都釋放冪等佔位 ✓`);
}

// ── 2) LMOVE 之後崩潰 → 下一輪回收，只結算一次 ────────────────────────────
{
  reset();
  await enqueueSettlement(entry("k-crash"));
  const raw = await claimNext(QUEUE_KEY); // 模擬：搬進 processing 後 process 就死了
  assert.ok(raw);
  assert.equal(fake.list(QUEUE_KEY).length, 0);
  assert.equal(fake.list(PROCESSING_KEY).length, 1, "項目在 processing，沒有遺失");

  const s = await runWorker(deps);
  assert.equal(s.recovered, 1);
  assert.equal(s.settled, 1);
  assert.equal(settleCalls, 1);
  assert.equal(fake.list(PROCESSING_KEY).length, 0);
  assert.equal((await getSettleState("k-crash"))?.status, "DONE");
  console.log("LMOVE 後崩潰 → 下一輪回收並結算一次 ✓");

  // ── 3) 重跑不重複；同一鍵再入列只會被當成重複 ───────────────────────────
  const again = await runWorker(deps);
  assert.equal(again.available, 0);
  await enqueueSettlement(entry("k-crash"));
  const dup = await runWorker(deps);
  assert.equal(dup.duplicate, 1);
  assert.equal(dup.settled, 0);
  assert.equal(settleCalls, 1, "已完成的鍵不可再送");
  console.log("重跑不重複；已完成的鍵再入列 → duplicate，不送交易 ✓");
}

// ── 4) 同一鍵在同一輪重複入列 → 只結算一次 ──────────────────────────────────
{
  reset();
  await enqueueSettlement(entry("k-twice"));
  await enqueueSettlement(entry("k-twice"));
  const s = await runWorker(deps);
  assert.equal(s.settled, 1);
  assert.equal(s.duplicate, 1);
  assert.equal(settleCalls, 1);
  assert.equal(fake.list(QUEUE_KEY).length + fake.list(PROCESSING_KEY).length, 0);
  console.log("同一鍵重複入列兩次 → 只結算一次 ✓");
}

// ── 5) tx.wait 逾時 → UNKNOWN、不重送；下一輪 receipt 成功 → DONE ───────────
{
  reset();
  mode = "timeout";
  await enqueueSettlement(entry("k-timeout"));
  await enqueueSettlement(entry("k-after")); // 第二筆：本輪應該被擋下，不送
  const s1 = await runWorker(deps);
  assert.equal(s1.pending, 1);
  assert.equal(settleCalls, 1, "出現 UNKNOWN 後本輪停止送新交易");
  const st = await getSettleState("k-timeout");
  assert.equal(st?.status, "UNKNOWN");
  assert.ok(st?.txHash, "UNKNOWN 必須記下 tx hash");
  assert.equal(fake.list(PROCESSING_KEY).length, 0);
  assert.equal(fake.list(QUEUE_KEY).length, 1, "第二筆仍在主佇列（沒有遺失）");
  assert.equal(fake.list(ledger.UNCONFIRMED_KEY).length, 1, "UNKNOWN 那筆進 unconfirmed");

  // 下一輪：receipt 仍查不到（5 分鐘後）→ 仍 pending，**不重送**
  mode = "ok";
  clock += 5 * 60 * 1000;
  receipt = null;
  const s2 = await runWorker(deps);
  assert.equal(settleCalls, 1, "UNKNOWN 的鍵絕不能再送一次");
  assert.equal(s2.pending, 1);

  // 再下一輪：receipt 成功 → DONE；第二筆此時才正常結算
  clock += 60 * 1000;
  receipt = "success";
  const s3 = await runWorker(deps);
  assert.equal((await getSettleState("k-timeout"))?.status, "DONE");
  assert.equal((await getSettleState("k-timeout"))?.txHash, st!.txHash, "對帳後保留原 hash");
  assert.ok(s3.settled >= 1);
  assert.equal(settleCalls, 2, "只有第二筆送了新交易");
  console.log("wait 逾時 → UNKNOWN 記 hash、不重送；對帳成功 → DONE ✓");
}

// ── 6) UNKNOWN 超過 30 分鐘仍查不到 → STUCK、進死信、job 失敗訊號 ─────────────
{
  reset();
  mode = "timeout";
  await enqueueSettlement(entry("k-stuck"));
  await runWorker(deps);
  clock += STUCK_AFTER_MS + 60_000;
  receipt = null;
  const s = await runWorker(deps);
  assert.equal(s.stuck, 1);
  assert.equal((await getSettleState("k-stuck"))?.status, "STUCK");
  assert.equal(fake.list(DEAD_KEY).length, 1);
  assert.equal(settleCalls, 1);
  console.log("UNKNOWN 超過 30 分鐘 → STUCK（死信 + stuck 計數讓 job 失敗）、不重送 ✓");
}

// ── 7) UNKNOWN 對帳發現 revert → 死信 ───────────────────────────────────────
{
  reset();
  mode = "timeout";
  await enqueueSettlement(entry("k-revert"));
  await runWorker(deps);
  receipt = "reverted";
  const s = await runWorker(deps);
  assert.equal(s.dead, 1);
  assert.equal((await getSettleState("k-revert"))?.status, "FAILED");
  assert.equal(settleCalls, 1);
  console.log("對帳 revert → 死信、不重送 ✓");
}

// ── 8) 已上鏈、ack 前崩潰 → 回收後辨識為重複 ────────────────────────────────
{
  reset();
  await enqueueSettlement(entry("k-ack"));
  fake.failNext("LREM"); // ack 那一步連線中斷 = process 在結算後、移除前死掉
  await assert.rejects(runWorker(deps));
  assert.equal(settleCalls, 1);
  assert.equal(fake.list(PROCESSING_KEY).length, 1, "項目仍在 processing");
  const s = await runWorker(deps);
  assert.equal(s.recovered, 1);
  assert.equal(s.duplicate, 1);
  assert.equal(settleCalls, 1, "回收後不可再送");
  console.log("結算後、ack 前崩潰 → 回收後視為重複，不重送 ✓");
}

// ── 9) 舊資料（無 idempotencyKey）與重試包裝 → 以內容雜湊作穩定的鍵 ───────────
{
  reset();
  const legacy = { trader: TRADER, feeUsd: 0.01, at: 42, source: "oracle" as const };
  await enqueueSettlement(legacy);
  fake.list(RETRY_KEY).push(JSON.stringify({ entry: legacy, attempts: 1, lastError: "x" }));
  const s = await runWorker(deps);
  assert.equal(s.settled, 1);
  assert.equal(s.duplicate, 1, "同一筆 legacy entry 的重試包裝要被認成同一鍵");
  assert.equal(settleCalls, 1);
  console.log("legacy entry 以內容雜湊作鍵，重試包裝不改變鍵 ✓");
}

// ── 10) 無法解析的項目 → 死信，不卡住佇列 ───────────────────────────────────
{
  reset();
  fake.list(PROCESSING_KEY).push("not json");
  const raw = fake.list(PROCESSING_KEY)[0]!;
  const o = await processOne(raw, deps);
  assert.equal(o.outcome, "dead");
  assert.equal(fake.list(PROCESSING_KEY).length, 0);
  console.log("無法解析的項目 → 死信 ✓");
}

await fake.close();
console.log("settlementWorker.test.ts ✓ all assertions passed");
