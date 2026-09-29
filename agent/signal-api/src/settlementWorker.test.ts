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

/** 所有 processing 清單（各來源 + 舊的單一清單）的總筆數。 */
const procLen = () =>
  [PROCESSING_KEY, ...Object.values(ledger.PROCESSING_KEYS)].reduce((n, k) => n + fake.list(k).length, 0);

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
  assert.equal(procLen(), 0);
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
  assert.equal(procLen(), 1, "項目在 processing，沒有遺失");

  const s = await runWorker(deps);
  assert.equal(s.recovered, 1);
  assert.equal(s.settled, 1);
  assert.equal(settleCalls, 1);
  assert.equal(procLen(), 0);
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
  assert.equal(fake.list(QUEUE_KEY).length + procLen(), 0);
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
  assert.equal(procLen(), 0);
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
  mode = "ok";
  chain.latest = chain.pending; // 讓 nonce 檢查不擋：驗證的是「STUCK 本身」讓本輪停止
  await enqueueSettlement(entry("k-after-stuck")); // 同一輪若進 phase 2 就會被送出
  const s = await runWorker(deps);
  assert.equal(s.stuck, 1);
  assert.equal((await getSettleState("k-stuck"))?.status, "STUCK");
  assert.equal(fake.list(DEAD_KEY).length, 1);
  assert.equal(settleCalls, 1, "STUCK 後同一輪不可再送任何交易");
  assert.equal(s.available, 0, "不進入送交易階段");
  const halt = JSON.parse(fake.strings.get(ledger.HALT_KEY) ?? "null") as { txHash?: string; nonce?: number } | null;
  assert.ok(halt?.txHash && halt.nonce === 0, "停機旗標記錄 hash 與 nonce");
  // 旗標存在：下一輪拒跑
  const s2 = await runWorker(deps);
  assert.ok(s2.globalHalt, "旗標存在 → 拒跑");
  assert.equal(s2.available + s2.recovered, 0);
  assert.equal(settleCalls, 1);
  assert.equal(fake.list(QUEUE_KEY).length, 1, "待結算項目原封不動");
  // 人工確認後清除旗標 → 恢復
  fake.strings.delete(ledger.HALT_KEY);
  const s3 = await runWorker(deps);
  assert.equal(s3.globalHalt, undefined);
  assert.equal(s3.settled, 1);
  assert.equal(settleCalls, 2);
  console.log("STUCK → 同輪停止、設全域停機旗標；旗標在就拒跑；人工清除後恢復 ✓");
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
  assert.equal(procLen(), 1, "項目仍在 processing");
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

// ── 13) 「佔位後、簽出前」中止的遺留佔位：25 分鐘內不釋放，超過且持有鎖才釋放 ───
{
  reset();
  await enqueueSettlement(entry("k-orphan"));
  await claimNext(QUEUE_KEY);
  await ledger.claimSettleKey("k-orphan", { status: "PENDING", claimedAt: clock }); // 佔位後就死了
  clock += 60_000;
  const s = await runWorker(deps);
  assert.equal(s.recovered, 1);
  assert.equal(s.settled, 0, "25 分鐘內不釋放（佔位的 worker 可能還活著）");
  assert.equal(settleCalls, 0);
  assert.equal((await getSettleState("k-orphan"))?.status, "PENDING");
  clock += 25 * 60_000;
  const s2 = await runWorker(deps);
  assert.equal(s2.settled, 1, "超過 25 分鐘、持有租約鎖 → 釋放後結算");
  assert.equal(s2.stuck, 0);
  assert.equal(settleCalls, 1);
  console.log("PENDING 無 hash：25 分鐘內不動；超過且持有鎖 → 釋放、結算一次 ✓");
}

// ── 14) processOne 內 Redis 故障（GET）→ 攔截，不崩潰，項目留在 processing ────
{
  reset();
  await enqueueSettlement(entry("k-redis"));
  fake.failNext("GET", 1); // 第 1 個 GET 是停機旗標；第 2 個是 processOne 讀冪等狀態
  const s = await runWorker(deps);
  assert.equal(s.errors, 1);
  assert.equal(settleCalls, 0);
  assert.equal(procLen(), 1);
  const s2 = await runWorker(deps);
  assert.equal(s2.settled, 1);
  assert.equal(settleCalls, 1);
  console.log("Redis 暫時故障 → 例外攔下、下一輪回收結算 ✓");
}

// ── 15) UNKNOWN 查不到 receipt、signer nonce 已前進（latest > nonce）→ **不**重結算 ──
//        公共節點會回落後狀態，分不出「已上鏈只是查不到」與「被替換」。一律交人工。
{
  reset();
  mode = "timeout";
  await enqueueSettlement(entry("k-replaced"));
  await runWorker(deps); // 簽出 nonce 0，結果不明
  assert.equal(fake.list(UNCONFIRMED_KEY).length, 1);
  chain.latest = chain.pending = 5; // latest > 0：可能已上鏈、也可能被替換——分不出來
  receipt = null;
  mode = "ok";
  for (const dt of [6, 10, 10]) {
    clock += dt * 60_000;
    const s = await runWorker(deps);
    assert.equal(s.settled + s.retried, 0, "絕不因 nonce 前進而重結算");
    assert.equal(settleCalls, 1, "settleCalls 不可增加");
    const st = await getSettleState("k-replaced");
    assert.ok(st?.txHash && st.nonce === 0 && st.rawTx, "txHash / nonce / rawTx 必須保留");
  }
  clock += 10 * 60_000; // 累計 > 30 分鐘
  const s = await runWorker(deps);
  assert.equal(s.stuck, 1, "逾時轉 STUCK 交人工");
  const st = await getSettleState("k-replaced");
  assert.equal(st?.status, "STUCK");
  assert.ok(st?.txHash && st.nonce === 0 && st.rawTx, "STUCK 仍保留 txHash / nonce / rawTx");
  assert.equal(settleCalls, 1);
  console.log("UNKNOWN + latest > nonce → 不重結算、狀態保留，30 分鐘後 STUCK ✓");
}

// ── 16) 並行 worker：租約鎖讓第二個 worker 什麼都不做 ─────────────────────────
{
  reset();
  await enqueueSettlement(entry("k-par-1"));
  await enqueueSettlement(entry("k-par-2"));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slowDeps = {
    ...deps,
    settle: async (t: string, f: number, h: SettleHooks) => {
      await gate; // 第一個 worker 卡在送交易
      return deps.settle(t, f, h);
    },
  };
  const first = runWorker(slowDeps);
  await new Promise((r) => setTimeout(r, 200));
  const second = await runWorker(deps);
  assert.equal(second.skippedLocked, true, "第二個 worker 取不到租約鎖");
  assert.equal(second.available, 0);
  release();
  const s1 = await first;
  assert.equal(s1.settled, 2);
  assert.equal(settleCalls, 2, "每筆只結算一次");
  assert.equal(fake.strings.has(ledger.WORKER_LOCK_KEY), false, "結束時釋放自己的鎖");
  // 鎖被別人持有時，結束時不可刪別人的鎖
  fake.strings.set(ledger.WORKER_LOCK_KEY, "someone-else");
  assert.equal(await ledger.releaseWorkerLock("my-token"), false);
  assert.equal(fake.strings.get(ledger.WORKER_LOCK_KEY), "someone-else");
  console.log("並行 worker：租約鎖 → 第二個不處理、不雙付；只刪自己的鎖 ✓");
}

// ── 17) blocked 連續超過 30 分鐘 → blockedTooLong；恢復後清除 ──────────────────
{
  reset();
  chain.latest = 1;
  chain.pending = 2;
  await enqueueSettlement(entry("k-blk"));
  const a = await runWorker(deps);
  assert.equal(a.blocked, 1);
  assert.equal(a.blockedTooLong, false);
  clock += 20 * 60_000;
  const b = await runWorker(deps);
  assert.equal(b.blockedTooLong, false, "20 分鐘還不到門檻");
  clock += 11 * 60_000;
  const c = await runWorker(deps);
  assert.equal(c.blockedTooLong, true, "連續 31 分鐘 → job 應失敗");
  chain.latest = 2; // 恢復
  const d = await runWorker(deps);
  assert.equal(d.settled, 1);
  assert.equal(fake.strings.has(ledger.BLOCKED_SINCE_KEY), false, "恢復正常時清除紀錄");
  chain.pending = 4; // 再次 blocked：重新計時
  await enqueueSettlement(entry("k-blk2"));
  const e = await runWorker(deps);
  assert.equal(e.blocked, 1);
  assert.equal(e.blockedTooLong, false, "新的一次 blocked 從頭計時");
  console.log("blocked 多輪：31 分鐘 → blockedTooLong；恢復清除、再發生重新計時 ✓");
}

// ── 18) trader 安全檢查 RPC 查不到（no-data）→ 停止本輪，不消耗重試次數 ──────────
{
  reset();
  await enqueueSettlement(entry("k-nodata"));
  const noData = {
    ...deps,
    assessTrader: (t: string) =>
      assessPayoutAddress({ getCode: async () => { throw new Error("rpc down"); } }, t),
  };
  const s = await runWorker(noData);
  assert.equal(s.halted, 1);
  assert.equal(s.retried + s.failed, 0, "不算失敗、不消耗重試");
  assert.equal(fake.list(RETRY_KEY).length, 0);
  assert.equal(fake.list(QUEUE_KEY).length, 1, "項目原樣放回佇列");
  assert.equal(settleCalls, 0);
  assert.equal(s.nodataTooLong, false);
  clock += 20 * 60_000;
  assert.equal((await runWorker(noData)).nodataTooLong, false);
  clock += 11 * 60_000;
  assert.equal((await runWorker(noData)).nodataTooLong, true, "no-data 連續 31 分鐘 → job 應失敗");
  clearPayoutSafetyCache();
  const s2 = await runWorker(deps);
  assert.equal(s2.settled, 1);
  assert.equal(fake.strings.has(ledger.NODATA_SINCE_KEY), false, "恢復後清除計時");
  console.log("trader 檢查 no-data → halt、不消耗重試；連續 31 分鐘 → 失敗；恢復後清除並結算 ✓");
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

// ── 20) setHalt 那次寫入失敗 → 狀態仍是 UNKNOWN；下一輪先處理回收項目、設旗標，不送任何交易 ──
{
  reset();
  mode = "timeout";
  await enqueueSettlement(entry("k-haltfail"));
  await runWorker(deps); // UNKNOWN
  mode = "ok";
  chain.latest = chain.pending; // nonce 檢查不擋：驗證的是順序本身
  fake.list(RETRY_KEY).push(JSON.stringify({ entry: entry("k-other"), attempts: 1, lastError: "x" }));
  clock += STUCK_AFTER_MS + 60_000;
  fake.failNext("SET", 1); // 第 1 個 SET 是租約鎖；第 2 個是停機旗標
  const s1 = await runWorker(deps);
  assert.equal(s1.errors, 1);
  assert.equal(fake.strings.has(ledger.HALT_KEY), false, "旗標沒寫進去");
  assert.equal((await getSettleState("k-haltfail"))?.status, "UNKNOWN", "先設旗標再寫 STUCK：狀態未被改成 STUCK");
  assert.equal(settleCalls, 1);
  const s2 = await runWorker(deps);
  assert.equal(s2.recovered, 1);
  assert.equal(s2.stuck, 1, "回收項目最先處理 → 轉 STUCK");
  assert.ok(fake.strings.has(ledger.HALT_KEY), "這次旗標寫入成功");
  assert.equal(settleCalls, 1, "retry 裡的項目不可在 STUCK 之前被送出");
  const s3 = await runWorker(deps);
  assert.ok(s3.globalHalt);
  assert.equal(settleCalls, 1, "旗標存在 → 不送任何交易");
  console.log("setHalt 寫入失敗 → 狀態仍 UNKNOWN；下一輪先處理回收項目設旗標，全程不送交易 ✓");
}

// ── 21) 停機旗標是空字串也算「有旗標」──────────────────────────────────────────
{
  reset();
  await enqueueSettlement(entry("k-empty-halt"));
  fake.strings.set(ledger.HALT_KEY, "");
  const s = await runWorker(deps);
  assert.ok(s.globalHalt, "空字串也要拒跑");
  assert.equal(settleCalls, 0);
  console.log("停機旗標為空字串 → 仍視為有旗標、拒跑 ✓");
}

// ── 22) nonce 查詢 RPC 失敗與 nonce 不一致分開計時 ──────────────────────────────
{
  reset();
  await enqueueSettlement(entry("k-rpc"));
  const rpcDown = { ...deps, nonceStatus: async () => { throw new Error("rpc down"); } };
  const a = await runWorker(rpcDown);
  assert.equal(a.blockedRpc, 1);
  assert.ok(fake.strings.has(ledger.NONCE_RPC_SINCE_KEY));
  assert.equal(fake.strings.has(ledger.BLOCKED_SINCE_KEY), false, "RPC 失敗不可記成 nonce 不一致");
  clock += 31 * 60_000;
  const b = await runWorker(rpcDown);
  assert.equal(b.nonceRpcTooLong, true);
  assert.equal(b.blockedTooLong, false);
  const c = await runWorker(deps); // RPC 恢復
  assert.equal(c.settled, 1);
  assert.equal(fake.strings.has(ledger.NONCE_RPC_SINCE_KEY), false, "查得到 nonce 就清除 RPC 計時");
  console.log("nonce RPC 失敗 / nonce 不一致：兩個計時鍵分開、訊息分開 ✓");
}

// ── 23) unconfirmed 項目缺少狀態 → 死信，不重新結算 ─────────────────────────────
{
  reset();
  fake.list(UNCONFIRMED_KEY).push(JSON.stringify(entry("k-nostate")));
  const s = await runWorker(deps);
  assert.equal(s.dead, 1);
  assert.equal(settleCalls, 0, "無法對帳就不可重新結算");
  assert.ok(fake.list(DEAD_KEY)[0]!.includes("without settle state"));
  console.log("unconfirmed 缺少狀態 → 死信、不重新結算 ✓");
}

// ── 24) 回收的 UNKNOWN 一律走 phase 1 對帳；retry 項目不可搶先送出 ─────────────────
//        含「回收當輪 phase 1 因 STUCK 提早 return、隔一輪（清旗標後）才處理」的情況。
{
  reset();
  mode = "timeout";
  await enqueueSettlement(entry("k-s")); // 會先轉 STUCK 的那筆
  await runWorker(deps); // k-s UNKNOWN（sentAt = t0）
  clock += 10 * 60_000;
  chain.latest = chain.pending; // nonce 檢查不擋：驗證的是分流與順序本身
  await enqueueSettlement(entry("k-r"));
  receipt = null;
  // 手動造出「k-r 已簽出、狀態 UNKNOWN、卡在 processing:main」（上一輪簽出後就中止）
  await claimNext(QUEUE_KEY);
  await ledger.setSettleState("k-r", { status: "UNKNOWN", claimedAt: clock, txHash: "0x" + "ee".repeat(32), nonce: 9, rawTx: "0x02", sentAt: clock });
  fake.list(RETRY_KEY).push(JSON.stringify({ entry: entry("k-x"), attempts: 1, lastError: "x" }));
  mode = "ok";
  clock += 21 * 60_000; // k-s 超過 30 分鐘；k-r 才 21 分鐘
  const s1 = await runWorker(deps);
  assert.equal(s1.recovered, 1);
  assert.equal(s1.stuck, 1, "phase 1 先遇到 k-s → STUCK → 提早 return");
  assert.equal(fake.list(UNCONFIRMED_KEY).length, 1, "回收的 k-r 進了 unconfirmed，本輪未處理");
  assert.equal(settleCalls, 1, "retry 的 k-x 不可被送出");
  fake.strings.delete(ledger.HALT_KEY); // 人工確認後清旗標
  const s2 = await runWorker(deps);
  assert.equal(s2.pending, 1, "隔一輪 k-r 在 phase 1 對帳（仍無 receipt）");
  assert.equal(settleCalls, 1, "phase 1 仍有未確認交易 → retry 項目照樣不送");
  receipt = "success";
  const s3 = await runWorker(deps);
  assert.equal((await getSettleState("k-r"))?.status, "DONE");
  assert.equal(s3.settled, 2, "k-r 對帳成功、k-x 之後才送出");
  assert.equal(settleCalls, 2, "k-r 從未重送");
  console.log("回收的 UNKNOWN 走 phase 1；STUCK 提早 return 時隔輪才處理；retry 不搶先 ✓");
}

// ── 25) 從 processing:unconfirmed 回收、狀態已過期（不存在）→ 死信 ────────────────
{
  reset();
  fake.list(ledger.PROCESSING_KEYS.unconfirmed).push(JSON.stringify(entry("k-expired")));
  const s = await runWorker(deps);
  assert.equal(s.recovered, 1);
  assert.equal(settleCalls, 0, "不可重新結算");
  assert.equal(fake.list(DEAD_KEY).length, 1);
  assert.ok(fake.list(DEAD_KEY)[0]!.includes("recovered unconfirmed item without state"));
  console.log("processing:unconfirmed 回收、狀態過期 → 死信、不重新結算 ✓");
}

// ── 26) 舊的單一 processing 清單：第一次執行時依狀態分流，來源不明且無狀態 → 死信 ──
{
  reset();
  const legacy = fake.list(PROCESSING_KEY);
  legacy.push(JSON.stringify(entry("m-done")));
  legacy.push(JSON.stringify(entry("m-unknown")));
  legacy.push(JSON.stringify(entry("m-nostate")));
  await ledger.setSettleState("m-done", { status: "DONE", claimedAt: clock, txHash: "0x" + "aa".repeat(32) });
  await ledger.setSettleState("m-unknown", { status: "UNKNOWN", claimedAt: clock, txHash: "0x" + "bb".repeat(32), nonce: 3, sentAt: clock });
  receipt = "success";
  const s = await runWorker(deps);
  assert.equal(s.recovered, 3);
  assert.equal(fake.list(PROCESSING_KEY).length, 0, "舊清單清空");
  assert.equal(s.duplicate, 1, "DONE → ack");
  assert.equal((await getSettleState("m-unknown"))?.status, "DONE", "有 hash → unconfirmed 對帳");
  assert.equal(fake.list(DEAD_KEY).length, 1, "來源不明且無狀態 → 死信");
  assert.ok(fake.list(DEAD_KEY)[0]!.includes("legacy processing list"));
  assert.equal(settleCalls, 0, "遷移過程不送任何新交易");
  console.log("舊單一 processing 清單遷移：DONE→ack、有 hash→對帳、無狀態→死信 ✓");
}

// ── 27) halt 旗標的值不是物件（"null"、"0"、"false"、數字、字串）→ 仍視為有旗標 ────
{
  for (const v of ["null", "0", "false", "42", '"stop"', "[]"]) {
    reset();
    await enqueueSettlement(entry("k-halt-" + v));
    fake.strings.set(ledger.HALT_KEY, v);
    const s = await runWorker(deps);
    assert.ok(s.globalHalt, `旗標值 ${v} 也要拒跑`);
    assert.equal(s.globalHalt?.reason, v);
    assert.equal(settleCalls, 0);
  }
  console.log("halt 旗標值為 null/0/false/數字/字串/陣列 → 仍拒跑 ✓");
}

// ── 19) 只准在 CI 內執行；本機只能 --dry-run（只讀）─────────────────────────────
{
  reset();
  await enqueueSettlement(entry("k-dry"));
  const { fileURLToPath } = await import("node:url");
  const worker = fileURLToPath(new URL("./settlement-worker.ts", import.meta.url));
  const env: NodeJS.ProcessEnv = { ...process.env, UPSTASH_REDIS_REST_URL: fake.url, UPSTASH_REDIS_REST_TOKEN: "t" };
  delete env.GITHUB_ACTIONS;
  delete env.FEE_SETTLEMENT_PRIVATE_KEY;
  const run = (args: string[]) =>
    new Promise<{ status: number | null; out: string }>((resolve) => {
      // 非同步執行：子行程要連回本 process 的假 Upstash，同步執行會卡住事件迴圈。
      import("node:child_process").then(({ spawn }) => {
        const c = spawn(process.execPath, ["--import", "tsx", worker, ...args], { env });
        let out = "";
        c.stdout.on("data", (d) => (out += d));
        c.stderr.on("data", (d) => (out += d));
        c.on("close", (status) => resolve({ status, out }));
      });
    });
  const refused = await run([]);
  assert.equal(refused.status, 1, "本機（無 GITHUB_ACTIONS）必須拒跑");
  assert.match(refused.out, /只准在 GitHub Actions 內執行/);
  const logStart = fake.log.length;
  const dry = await run(["--dry-run"]);
  assert.equal(dry.status, 0, dry.out);
  const cmds = new Set(fake.log.slice(logStart));
  for (const c of cmds) assert.ok(["GET", "LLEN", "LRANGE"].includes(c), `dry-run 只准讀取指令，卻送了 ${c}`);
  assert.match(dry.out, /dry-run/);
  assert.match(dry.out, /k-dry/);
  assert.equal(fake.list(QUEUE_KEY).length, 1, "dry-run 不動佇列");
  assert.equal(fake.strings.has(SETTLE_STATE_PREFIX + "k-dry"), false, "dry-run 不佔位");
  assert.equal(fake.strings.has(ledger.WORKER_LOCK_KEY), false, "dry-run 不取鎖");
  // 讀停機旗標的第一個 GET 失敗 → exit 1（不可當成「沒有旗標」繼續）
  fake.failNext("GET");
  const dryFail = await run(["--dry-run"]);
  assert.equal(dryFail.status, 1, dryFail.out);
  assert.match(dryFail.out, /讀不到全域停機旗標/);
  console.log("本機無 GITHUB_ACTIONS → 拒跑；--dry-run 只送 GET/LLEN/LRANGE、不佔位不取鎖；讀旗標失敗 → exit 1 ✓");
}

await fake.close();
console.log("settlementWorker.test.ts ✓ all assertions passed");
