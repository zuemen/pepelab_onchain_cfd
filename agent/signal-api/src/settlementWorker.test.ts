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
const { QUEUE_KEY, PROCESSING_KEY, RETRY_KEY, DEAD_KEY, SETTLE_STATE_PREFIX, LEGACY_REVIEW_KEY, UNCONFIRMED_KEY, enqueueSettlement, claimNext, getSettleState } = ledger;
const { assessPayoutAddress, clearPayoutSafetyCache } = await import("@pepelab/shared");
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

// 假鏈上 nonce：latest = 已上鏈，pending = 含 mempool。
const chain = { latest: 0, pending: 0 };
const LEAKED = "0xE80A81360608C1342e66743F70a00f75d792Eb93";
const DELEGATED = "0x2222222222222222222222222222222222222222";
const fakeCode: Record<string, string> = { [DELEGATED.toLowerCase()]: "0xef0100" + "ab".repeat(20) };

const deps = {
  now: () => clock,
  receiptStatus: async () => {
    if (receipt === "success") chain.latest = chain.pending; // 上鏈了
    return receipt;
  },
  assessTrader: (t: string) =>
    assessPayoutAddress({ getCode: async (a: string) => fakeCode[a.toLowerCase()] ?? "0x" }, t),
  nonceStatus: async () => ({ ...chain }),
  settle: async (_t: string, _f: number, hooks: SettleHooks): Promise<SettlementResult> => {
    settleCalls += 1;
    if (mode === "fail") return { status: "failed", error: "boom (fake)" };
    const tx = "0x" + String(++hashSeq).padStart(64, "0");
    const nonce = chain.pending;
    await hooks.onSigned?.({ txHash: tx, nonce, rawTx: "0x02raw" });
    chain.pending += 1;
    if (mode === "timeout") return { status: "unknown", tx, error: "timeout (fake)" };
    chain.latest = chain.pending;
    return { status: "settled", tx };
  },
};

function reset() {
  fake.lists.clear();
  fake.strings.clear();
  clearPayoutSafetyCache();
  settleCalls = 0;
  receipt = null;
  mode = "ok";
  chain.latest = chain.pending = 0;
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
  assert.equal(st?.nonce, 0, "UNKNOWN 必須記下 nonce");
  assert.equal(st?.rawTx, "0x02raw", "UNKNOWN 必須記下已簽 raw tx（人工可重播）");
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
  fake.failNext("LREM"); // ack 那一步 Redis 連線中斷
  const s0 = await runWorker(deps); // 例外被攔下，不讓 process 崩潰
  assert.equal(s0.errors, 1);
  assert.equal(settleCalls, 1);
  assert.equal(fake.list(PROCESSING_KEY).length, 1, "項目仍在 processing");
  const s = await runWorker(deps);
  assert.equal(s.recovered, 1);
  assert.equal(s.duplicate, 1);
  assert.equal(settleCalls, 1, "回收後不可再送");
  console.log("結算後、ack 前 Redis 故障 → 例外被攔下（errors=1）；回收後視為重複，不重送 ✓");
}

// ── 9) 舊資料（無 idempotencyKey）與重試包裝 → 以內容雜湊作穩定的鍵 ───────────
{
  reset();
  const legacy = { trader: TRADER, feeUsd: 0.01, at: 42, source: "oracle" as const };
  await enqueueSettlement(legacy);
  fake.list(RETRY_KEY).push(JSON.stringify({ entry: legacy, attempts: 1, lastError: "x" }));
  const s = await runWorker(deps);
  assert.equal(s.settled, 1);
  assert.equal(s.review, 1, "同一雜湊第二次出現：不結算、不丟棄，交人工");
  assert.equal(settleCalls, 1);
  assert.equal(fake.list(LEGACY_REVIEW_KEY).length, 1);
  assert.equal(fake.strings.get(ledger.LEGACY_COLLISIONS_KEY), "1", "衝突筆數要累計");
  console.log("legacy entry 以內容雜湊作鍵；雜湊衝突 → legacy_review + 計數，不重複結算 ✓");
}

// ── 11) 受益 trader 是外洩地址 / EIP-7702 委派 → 死信，不送交易 ───────────────
{
  reset();
  await enqueueSettlement({ ...entry("k-leak"), trader: LEAKED });
  await enqueueSettlement({ ...entry("k-7702"), trader: DELEGATED });
  const s = await runWorker(deps);
  assert.equal(s.dead, 2);
  assert.equal(settleCalls, 0, "不安全的受益人一筆都不能送");
  assert.equal(fake.list(DEAD_KEY).length, 2);
  assert.ok(fake.list(DEAD_KEY).every((d) => d.includes("trader_unsafe")));
  assert.equal(await getSettleState("k-leak"), null, "不佔位");
  console.log("受益 trader 外洩 / 7702 委派 → 死信、不送交易 ✓");
}

// ── 12) signer 有未上鏈交易（pending ≠ latest）→ 不送新交易 ───────────────────
{
  reset();
  chain.latest = 3;
  chain.pending = 4;
  await enqueueSettlement(entry("k-gap"));
  const s = await runWorker(deps);
  assert.equal(s.blocked, 1);
  assert.equal(settleCalls, 0);
  assert.equal(fake.list(QUEUE_KEY).length, 1, "項目放回佇列，沒有遺失");
  assert.equal(await getSettleState("k-gap"), null);
  chain.latest = 4;
  const s2 = await runWorker(deps);
  assert.equal(s2.settled, 1);
  console.log("nonce latest ≠ pending → 不送新交易；恢復後照常結算 ✓");
}

// ── 13) 上一輪「佔位後、簽出前」中止 → 下一輪釋放佔位重試，不停擺、不判 STUCK ──
{
  reset();
  await enqueueSettlement(entry("k-orphan"));
  const raw = await claimNext(QUEUE_KEY);
  await ledger.claimSettleKey("k-orphan", { status: "PENDING", claimedAt: clock }); // 佔位後就死了
  void raw;
  clock += 60_000;
  const s = await runWorker(deps);
  assert.equal(s.recovered, 1);
  assert.equal(s.settled, 1, "直接釋放後重試，不必等 30 分鐘");
  assert.equal(s.stuck, 0);
  assert.equal(settleCalls, 1);
  console.log("PENDING 無 hash（上一輪遺留）→ 釋放佔位、本輪即結算 ✓");
}

// ── 14) processOne 內 Redis 故障（GET）→ 攔截，不崩潰，項目留在 processing ────
{
  reset();
  await enqueueSettlement(entry("k-redis"));
  fake.failNext("GET");
  const s = await runWorker(deps);
  assert.equal(s.errors, 1);
  assert.equal(settleCalls, 0);
  assert.equal(fake.list(PROCESSING_KEY).length, 1);
  const s2 = await runWorker(deps);
  assert.equal(s2.settled, 1);
  assert.equal(settleCalls, 1);
  console.log("Redis 暫時故障 → 例外攔下、下一輪回收結算 ✓");
}

// ── 15) UNKNOWN 交易的 nonce 已被別的交易用掉（人工取消）→ 釋放並重新結算 ────
{
  reset();
  mode = "timeout";
  await enqueueSettlement(entry("k-replaced"));
  await runWorker(deps); // 簽出 nonce 0，卡在 mempool
  assert.equal(fake.list(UNCONFIRMED_KEY).length, 1);
  chain.latest = chain.pending; // 人工用同 nonce 送了取消交易並上鏈
  receipt = null; // 原交易永遠查不到 receipt
  clock += 6 * 60_000;
  mode = "ok";
  const s = await runWorker(deps);
  assert.equal(s.retried, 1, "原交易已不可能上鏈 → 釋放並排入重試");
  assert.equal(s.settled, 1, "同一輪的 retry 階段（nonce 已一致）重新結算");
  assert.equal((await getSettleState("k-replaced"))?.status, "DONE");
  assert.equal(settleCalls, 2, "只在確定原交易不可能上鏈後才重送一次");
  const s2 = await runWorker(deps);
  assert.equal(s2.available + s2.pending, 0);
  console.log("nonce 已被替換交易用掉 → 釋放佔位、重新結算一次 ✓");
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
