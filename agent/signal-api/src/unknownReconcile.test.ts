// x402:settlement:unknown — dedupe, cap/overflow, and automatic reconciliation. Offline.
//   cd agent && npx tsx signal-api/src/unknownReconcile.test.ts
//
// Fake Upstash + a fake chain that serves receipts with real event topics. The rule under test:
// credit only when the AuthorizationUsed(payer, nonce) event and the matching USDC
// Transfer(payer → payTo, value >= amount) are in the same receipt; everything else goes to
// the manual list; nothing is ever credited twice. Also covers ethersReconcileChain against a
// mock provider (getLogs chunk limit).
import assert from "node:assert";
import { ethers } from "ethers";
import { startFakeUpstash } from "./testing/fakeUpstash.ts";

const fake = await startFakeUpstash();
process.env.UPSTASH_REDIS_REST_URL = fake.url;
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

const ledger = await import("./ledger.ts");
const R = await import("./unknownReconcile.ts");
const {
  reconcileUnknownSettlements, ethersReconcileChain, reconcileAnnotations, logChunkFromEnv,
  MIN_AGE_SEC, EXPIRY_GRACE_SEC, MAX_ROW_ERRORS, AUTHORIZATION_USED_TOPIC, TRANSFER_TOPIC,
} = R;
type ChainReceipt = import("./unknownReconcile.ts").ChainReceipt;
const {
  UNKNOWN_SETTLEMENT_KEY, UNKNOWN_MANUAL_KEY, UNKNOWN_OVERFLOW_KEY, UNKNOWN_SEEN_PREFIX,
  QUEUE_KEY, RETRY_KEY, DEAD_KEY, SETTLE_STATE_PREFIX, recordUnknownSettlement,
  moveUnknownToManual, creditUnknownSettlement, unknownRowErrorsKey, authorizationMarkerKey, enqueueSettlementOnce,
} = ledger;

const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0x9999999999999999999999999999999999999999";
const PAYER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x7777777777777777777777777777777777777777";
const TRADER = "0x5555555555555555555555555555555555555555";
const nonce = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0").replace(/^0/, "a");
const TX1 = hash(1);
const TX2 = hash(2);

const NOW = 2_000_000_000;
const OLD = NOW - MIN_AGE_SEC - 1;
const AMOUNT = 10_000n;

function row(over: Record<string, unknown> = {}) {
  return {
    at: OLD, route: "GET /signals/x", network: "eip155:84532", asset: ASSET, payTo: PAY_TO, payer: PAYER,
    nonce: nonce(1), amount: String(AMOUNT), validBefore: String(NOW + 3600), transaction: null, reason: "timeout",
    ledgerEntry: { trader: TRADER, feeUsd: 0.01, source: "signals" },
    ...over,
  };
}

const pad = (a: string) => ethers.zeroPadValue(a, 32);
const u256 = (v: bigint) => ethers.toBeHex(v, 32);

/** Logs exactly as FiatToken's transferWithAuthorization emits them. */
function twaLogs(o: { payer?: string; nonce?: string; to?: string; value?: bigint; asset?: string } = {}) {
  const asset = o.asset ?? ASSET;
  const payer = o.payer ?? PAYER;
  return [
    { address: asset, topics: [AUTHORIZATION_USED_TOPIC, pad(payer), o.nonce ?? nonce(1)], data: "0x", index: 0 },
    { address: asset, topics: [TRANSFER_TOPIC, pad(payer), pad(o.to ?? PAY_TO)], data: u256(o.value ?? AMOUNT), index: 1 },
  ];
}

function receipt(h: string, logs: ChainReceipt["logs"], over: Partial<ChainReceipt> = {}): ChainReceipt {
  return { hash: h, status: 1, blockNumber: 100, blockTimestamp: NOW - 2 * MIN_AGE_SEC, logs, ...over };
}

/** A fake chain whose state each test sets. Records calls. */
function world() {
  const w = {
    used: new Map<string, boolean>(),
    events: new Map<string, string[]>(),
    receipts: new Map<string, ChainReceipt>(),
    latest: { number: 10_000, timestamp: NOW },
    throws: false,
    calls: { used: 0, find: 0, receipt: 0 },
  };
  const k = (p: string, n: string) => `${p.toLowerCase()}:${n.toLowerCase()}`;
  const chain = {
    async latestBlock() {
      return w.latest;
    },
    async authorizationUsed(_a: string, p: string, n: string, _tag: number) {
      w.calls.used += 1;
      if (w.throws) throw new Error("rpc down");
      return w.used.get(k(p, n)) ?? false;
    },
    async findAuthorizationUsedTxs(_a: string, p: string, n: string) {
      w.calls.find += 1;
      return w.events.get(k(p, n)) ?? [];
    },
    async receipt(h: string) {
      w.calls.receipt += 1;
      return w.receipts.get(h.toLowerCase()) ?? null;
    },
  };
  /** The nonce was consumed by `h` with these logs. */
  const consume = (h: string, logs: ChainReceipt["logs"] = twaLogs(), opts: { payer?: string; nonce?: string } = {}) => {
    const key = k(opts.payer ?? PAYER, opts.nonce ?? nonce(1));
    w.used.set(key, true);
    w.events.set(key, [...(w.events.get(key) ?? []), h]);
    w.receipts.set(h.toLowerCase(), receipt(h, logs));
  };
  const deps = (over: Record<string, unknown> = {}) => ({ chain, now: () => NOW, asset: ASSET, payTo: PAY_TO, ...over });
  return { w, chain, consume, deps };
}

function reset() {
  fake.lists.clear();
  fake.strings.clear();
  fake.log.length = 0;
}
const pushRaw = (r: object) => fake.list(UNKNOWN_SETTLEMENT_KEY).push(JSON.stringify(r));
const queue = () => fake.list(QUEUE_KEY).map((r) => JSON.parse(r));
const manual = () => fake.list(UNKNOWN_MANUAL_KEY).map((r) => JSON.parse(r));

// ── recordUnknownSettlement: dedupe + cap ───────────────────────────────────

reset();
{
  assert.equal(await recordUnknownSettlement(row()), "recorded");
  assert.equal(await recordUnknownSettlement(row({ payer: PAYER.toUpperCase().replace("0X", "0x"), nonce: nonce(1).toUpperCase().replace("0X", "0x") })), "duplicate");
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 1);
  console.log("✓ the same authorization resent is recorded once");
}

reset();
{
  await recordUnknownSettlement(row({ payer: null, nonce: null }));
  await recordUnknownSettlement(row({ payer: null, nonce: null }));
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 2);
  console.log("✓ rows without payer/nonce are kept, not silently dropped");
}

reset();
{
  // 5) Overflow is persisted, not just logged.
  await recordUnknownSettlement(row({ nonce: nonce(1) }), 2);
  await recordUnknownSettlement(row({ nonce: nonce(2) }), 2);
  fake.log.length = 0;
  assert.equal(await recordUnknownSettlement(row({ nonce: nonce(3) }), 2), "overflow");
  assert.deepEqual(fake.log, ["SET", "EVAL"], "cap check + push is one atomic EVAL (no separate LLEN/RPUSH)");
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 2, "cap holds");
  assert.equal(fake.strings.get(UNKNOWN_OVERFLOW_KEY), "1", "overflow counted");
  const m = manual();
  assert.equal(m.length, 1, "the refused record is persisted to the manual list");
  assert.equal(m[0].reason, "overflow");
  assert.deepEqual(JSON.parse(m[0].raw), row({ nonce: nonce(3) }), "full record kept, incl. ledgerEntry");
  // Persisted, so a resend is a duplicate — not a second manual row.
  assert.equal(await recordUnknownSettlement(row({ nonce: nonce(3) }), 2), "duplicate");
  assert.equal(manual().length, 1);
  console.log("✓ overflow: record persisted to manual (reason overflow), counted, atomic");
}

reset();
{
  fake.failNext("EVAL");
  await assert.rejects(() => recordUnknownSettlement(row({ nonce: nonce(4) })));
  assert.equal(fake.strings.has(`${UNKNOWN_SEEN_PREFIX}${PAYER.toLowerCase()}:${nonce(4)}`), false, "nothing persisted → marker dropped");
  assert.equal(await recordUnknownSettlement(row({ nonce: nonce(4) })), "recorded", "next resend recorded");
  console.log("✓ Redis failure while recording leaves no dedup marker behind");
}

reset();
{
  // 7) manual / credit moves are idempotent (atomic LREM-then-push).
  const raw = JSON.stringify(row());
  fake.list(UNKNOWN_SETTLEMENT_KEY).push(raw);
  assert.equal(await moveUnknownToManual(raw, "x"), true);
  assert.equal(await moveUnknownToManual(raw, "x"), false, "second call (e.g. retry after lost reply) is a no-op");
  assert.equal(manual().length, 1);
  fake.list(UNKNOWN_SETTLEMENT_KEY).push(raw);
  const e = { trader: TRADER, feeUsd: 0.01, at: OLD, source: "signals" as const, idempotencyKey: `tx:${TX1}` };
  const mk = authorizationMarkerKey(row())!;
  assert.equal(await creditUnknownSettlement(raw, e, mk), "credited");
  assert.equal(await creditUnknownSettlement(raw, e, mk), "already_credited");
  assert.equal(await creditUnknownSettlement(raw, e, mk + "x"), "gone");
  assert.equal(queue().length, 1, "one revenue row");
  assert.equal(fake.strings.get(mk), `tx:${TX1}`, "authorization marker set with the credit");
  console.log("✓ manual and credit moves happen at most once per row");
}

// ── reconciliation: basic states ─────────────────────────────────────────────

reset();
{
  pushRaw(row({ at: NOW - 5 }));
  const { w, deps } = world();
  const s = await reconcileUnknownSettlements(deps());
  assert.equal(s.tooYoung, 1);
  assert.equal(w.calls.used, 0, "a fresh row is not even looked up");
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 1);
  console.log("✓ rows younger than MIN_AGE_SEC are left alone");
}

reset();
{
  // Expiry is judged by chain time, not the local clock.
  const vb = NOW - EXPIRY_GRACE_SEC - 100;
  pushRaw(row({ validBefore: String(vb) }));
  const { w, deps } = world();
  w.latest = { number: 10_000, timestamp: vb }; // chain lags: not past validBefore yet
  let s = await reconcileUnknownSettlements(deps());
  assert.equal(s.pending, 1, "local clock says expired, chain does not → still pending");
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 1);
  w.latest = { number: 10_100, timestamp: vb + EXPIRY_GRACE_SEC + 1 };
  s = await reconcileUnknownSettlements(deps());
  assert.equal(s.expired, 1);
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 0);
  assert.equal(queue().length, 0, "nothing credited — nothing was paid");
  console.log("✓ unused + past validBefore by CHAIN time → closed, nothing credited");
}

reset();
{
  pushRaw(row());
  const s = await reconcileUnknownSettlements(world().deps());
  assert.equal(s.pending, 1);
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 1);
  console.log("✓ unused + not yet expired → kept for a later round");
}

// ── 1) the only crediting path ───────────────────────────────────────────────

reset();
{
  pushRaw(row());
  const { consume, deps } = world();
  consume(TX1);
  const s = await reconcileUnknownSettlements(deps());
  assert.equal(s.credited, 1);
  const q = queue();
  assert.equal(q.length, 1);
  assert.equal(q[0].idempotencyKey, `tx:${TX1}`, "keyed by the consuming tx — the success path's key");
  assert.equal(q[0].trader, TRADER);
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 0);
  await reconcileUnknownSettlements(deps());
  assert.equal(queue().length, 1);
  console.log("✓ exact match (event + Transfer to payTo, same receipt) → credited once as tx:<hash>");
}

reset();
{
  // High-1: the success path already queued this payment as tx:<hash>. No second credit.
  pushRaw(row());
  fake.list(QUEUE_KEY).push(JSON.stringify({ trader: TRADER, feeUsd: 0.01, at: OLD, source: "signals", idempotencyKey: `tx:${TX1}` }));
  const { consume, deps } = world();
  consume(TX1);
  const s = await reconcileUnknownSettlements(deps());
  assert.equal(s.alreadyCredited, 1);
  assert.equal(queue().length, 1, "no second revenue row");
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 0);
  console.log("✓ success path already queued tx:<hash> → closed without crediting again");
}

reset();
{
  // High-1 (the reported PoC): consumed, but the event cannot be found. The old code fell back
  // to an auth: key; now there is no such path.
  pushRaw(row());
  const { w, deps } = world();
  w.used.set(`${PAYER.toLowerCase()}:${nonce(1)}`, true);
  const s = await reconcileUnknownSettlements(deps());
  assert.equal(s.manual, 1);
  assert.equal(queue().length, 0, "never credited under an auth: key");
  assert.equal(manual()[0].reason, "consumed_without_event");
  console.log("✓ consumed but no AuthorizationUsed event (e.g. cancelAuthorization) → manual, no credit");
}

for (const [label, seed] of [
  ["settle state tx:", () => fake.strings.set(`${SETTLE_STATE_PREFIX}tx:${TX1}`, JSON.stringify({ status: "DONE" }))],
  ["settle state auth:", () => fake.strings.set(`${SETTLE_STATE_PREFIX}auth:${PAYER.toLowerCase()}:${nonce(1)}`, JSON.stringify({ status: "DONE" }))],
  ["queue auth:", () => fake.list(QUEUE_KEY).push(JSON.stringify({ trader: TRADER, feeUsd: 0.01, at: OLD, source: "signals", idempotencyKey: `auth:${PAYER.toLowerCase()}:${nonce(1)}` }))],
  ["retry wrapper", () => fake.list(RETRY_KEY).push(JSON.stringify({ entry: { trader: TRADER, feeUsd: 0.01, at: OLD, source: "signals", idempotencyKey: `tx:${TX1}` }, attempts: 1, lastError: "x" }))],
  ["dead raw wrapper", () => fake.list(DEAD_KEY).push(JSON.stringify({ raw: JSON.stringify({ idempotencyKey: `tx:${TX1}` }), attempts: 0, lastError: "x" }))],
] as const) {
  reset();
  pushRaw(row());
  seed();
  const { consume, deps } = world();
  consume(TX1);
  const s = await reconcileUnknownSettlements(deps());
  assert.equal(s.alreadyCredited, 1, label);
  assert.equal(queue().filter((q) => q.idempotencyKey === `tx:${TX1}`).length, 0, label);
  assert.equal(s.credited, 0, label);
}
console.log("✓ already credited under tx:/auth: in settle state, queue, retry or dead → no second credit");

// ── 2) the row's transaction is not trusted ──────────────────────────────────

reset();
{
  // High-2: the facilitator reported tx1, which was dropped; tx2 consumed the nonce and the
  // success path credited tx:tx2. Reconciliation must find tx2 and see it is already credited.
  pushRaw(row({ transaction: TX1 }));
  fake.strings.set(`${SETTLE_STATE_PREFIX}tx:${TX2}`, JSON.stringify({ status: "DONE" }));
  const { w, consume, deps } = world();
  consume(TX2); // no receipt for TX1
  const s = await reconcileUnknownSettlements(deps());
  assert.equal(s.alreadyCredited, 1);
  assert.equal(queue().length, 0, "no tx:tx1 credit");
  assert.ok(w.calls.find >= 1, "located via the event, not the row");
  console.log("✓ row says tx1 (dropped), chain says tx2 already credited → no second credit");
}

reset();
{
  pushRaw(row({ transaction: TX1 }));
  const { w, consume, deps } = world();
  consume(TX2);
  w.receipts.set(TX1, receipt(TX1, [])); // tx1 mined but did something else
  const s = await reconcileUnknownSettlements(deps());
  assert.equal(s.credited, 1);
  assert.equal(queue()[0].idempotencyKey, `tx:${TX2}`, "credited under the event's tx, never the row's");
  console.log("✓ row's tx without the event is ignored; credit goes to the event's tx");
}

reset();
{
  pushRaw(row({ transaction: TX1 }));
  const { w, consume, deps } = world();
  consume(TX1);
  const s = await reconcileUnknownSettlements(deps());
  assert.equal(s.credited, 1);
  assert.equal(w.calls.find, 0, "row's tx verified by its receipt → no log search");
  assert.equal(queue()[0].idempotencyKey, `tx:${TX1}`);
  console.log("✓ row's tx is used only when its receipt carries the event");
}

// ── 3) receipt must show the money arriving ──────────────────────────────────

const manualCase = async (label: string, logs: ChainReceipt["logs"], reason: string, rowOver: Record<string, unknown> = {}, rcOver: Partial<ChainReceipt> = {}) => {
  reset();
  pushRaw(row(rowOver));
  const { w, consume, deps } = world();
  consume(TX1, logs);
  Object.assign(w.receipts.get(TX1)!, rcOver);
  const s = await reconcileUnknownSettlements(deps());
  assert.equal(s.manual, 1, label);
  assert.equal(s.credited, 0, label);
  assert.equal(queue().length, 0, `${label}: nothing credited`);
  assert.equal(manual()[0].reason, reason, label);
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 0, label);
  console.log(`✓ ${label} → manual (${reason})`);
};

await manualCase("same nonce, payer transferred to self", twaLogs({ to: PAYER }), "transfer_not_to_payto");
await manualCase("Transfer to another address", twaLogs({ to: OTHER }), "transfer_not_to_payto");
await manualCase("amount short", twaLogs({ value: AMOUNT - 1n }), "amount_short");
await manualCase("event without Transfer", [twaLogs()[0]], "no_transfer_with_event");
await manualCase("Transfer from another token", [twaLogs()[0], { ...twaLogs()[1], address: OTHER }], "no_transfer_with_event");
await manualCase("Transfer from someone else", [twaLogs()[0], { ...twaLogs()[1], topics: [TRANSFER_TOPIC, pad(OTHER), pad(PAY_TO)] }], "no_transfer_with_event");
await manualCase("receipt not success", twaLogs(), "receipt_not_success", {}, { status: 0 });
await manualCase("consumed but row has no ledgerEntry", twaLogs(), "no_ledger_entry", { ledgerEntry: undefined });

reset();
{
  pushRaw(row({ payTo: OTHER }));
  pushRaw(row({ nonce: nonce(2), asset: OTHER }));
  const { w, consume, deps } = world();
  consume(TX1);
  const s = await reconcileUnknownSettlements(deps());
  assert.equal(s.manual, 2);
  assert.deepEqual(manual().map((m) => m.reason).sort(), ["asset_mismatch", "payto_mismatch"]);
  assert.equal(w.calls.used, 0, "not even looked up on chain");
  assert.equal(queue().length, 0);
  console.log("✓ payTo / asset not the configured ones → manual");
}

reset();
{
  pushRaw(row());
  const { w, consume, deps } = world();
  consume(TX1);
  w.receipts.get(TX1)!.blockTimestamp = NOW - 30; // consumed 30s ago by chain time
  const s = await reconcileUnknownSettlements(deps());
  assert.equal(s.pending, 1, "too fresh: the success path may still be enqueuing");
  assert.equal(queue().length, 0);
  console.log("✓ consuming block younger than MIN_AGE_SEC (chain time) → wait");
}

reset();
{
  fake.list(UNKNOWN_SETTLEMENT_KEY).push("{not json");
  pushRaw({ ...row(), amount: null });
  pushRaw({ ...row({ nonce: nonce(2) }), validBefore: null });
  pushRaw({ ...row({ nonce: nonce(3) }), payTo: undefined });
  const s = await reconcileUnknownSettlements(world().deps());
  assert.equal(s.manual, 4);
  assert.deepEqual(manual().map((m) => m.reason).sort(), ["missing_amount", "missing_payto", "missing_valid_before", "unparseable"]);
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 0);
  console.log("✓ malformed / incomplete rows → manual with a reason code");
}

// ── 4) errors, rotation ──────────────────────────────────────────────────────

reset();
{
  pushRaw(row());
  const raw = fake.list(UNKNOWN_SETTLEMENT_KEY)[0];
  const { w, deps } = world();
  w.throws = true;
  for (let i = 1; i < MAX_ROW_ERRORS; i += 1) {
    const s = await reconcileUnknownSettlements(deps());
    assert.equal(s.errors, 1);
    assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 1, "left in place");
    assert.equal(fake.strings.get(unknownRowErrorsKey(raw)), String(i));
  }
  const s = await reconcileUnknownSettlements(deps());
  assert.equal(s.manual, 1);
  assert.equal(manual()[0].reason, "repeated_errors");
  assert.match(manual()[0].lastError, /rpc down/);
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 0);
  console.log(`✓ ${MAX_ROW_ERRORS} consecutive errors on a row → manual (repeated_errors)`);
}

reset();
{
  pushRaw(row());
  const raw = fake.list(UNKNOWN_SETTLEMENT_KEY)[0];
  const { w, deps } = world();
  w.throws = true;
  await reconcileUnknownSettlements(deps());
  w.throws = false;
  await reconcileUnknownSettlements(deps()); // pending, no error
  assert.equal(fake.strings.has(unknownRowErrorsKey(raw)), false, "a clean pass resets the count");
  console.log("✓ error count is consecutive (reset by a clean pass)");
}

reset();
{
  // Stuck rows at the head must not block the rows behind them.
  pushRaw(row({ nonce: nonce(7) }));
  pushRaw(row({ nonce: nonce(8) }));
  pushRaw(row({ nonce: nonce(1) }));
  const { w, consume, deps } = world();
  const realUsed = w.used;
  consume(TX1);
  const chain = deps().chain;
  const flaky = {
    ...chain,
    async authorizationUsed(a: string, p: string, n: string) {
      if (n === nonce(7) || n === nonce(8)) throw new Error("rpc stuck");
      return realUsed.get(`${p.toLowerCase()}:${n}`) ?? false;
    },
  };
  const s1 = await reconcileUnknownSettlements(deps({ chain: flaky, batch: 2 }));
  assert.equal(s1.errors, 2);
  const s2 = await reconcileUnknownSettlements(deps({ chain: flaky, batch: 2 }));
  assert.equal(s2.credited, 1, "the third row is reached on the next round");
  assert.equal(queue()[0].idempotencyKey, `tx:${TX1}`);
  console.log("✓ rotation: errored rows go to the back; later rows are not starved");
}

reset();
{
  // 6) one snapshot of the settlement lists per round, not one per row.
  for (let i = 1; i <= 3; i += 1) pushRaw(row({ nonce: nonce(i) }));
  const { consume, deps } = world();
  for (let i = 1; i <= 3; i += 1) consume(hash(10 + i), twaLogs({ nonce: nonce(i) }), { nonce: nonce(i) });
  fake.log.length = 0;
  const s = await reconcileUnknownSettlements(deps());
  assert.equal(s.credited, 3);
  assert.equal(fake.log.filter((c) => c === "LRANGE").length, 8, "8 lists read once for the whole round");
  console.log("✓ queued-key snapshot taken once per round");
}

// ── annotations ──────────────────────────────────────────────────────────────

{
  const base = await (async () => {
    reset();
    return reconcileUnknownSettlements(world().deps());
  })();
  assert.deepEqual(reconcileAnnotations(base), []);
  const a = reconcileAnnotations({ ...base, overflowTotal: 2, errors: 1, manual: 1, manualReasons: { amount_short: 1 }, manualTotal: 3 });
  assert.ok(a.some((l) => l.startsWith("::error::") && /overflowed 2/.test(l)));
  assert.ok(a.some((l) => l.startsWith("::warning::") && /1 row error/.test(l)));
  assert.ok(a.some((l) => /amount_short/.test(l)));
  assert.ok(a.some((l) => /holds 3/.test(l)));
  assert.match(reconcileAnnotations({ failed: "boom" })[0], /^::error::.*boom/);

  reset();
  fake.strings.set(UNKNOWN_OVERFLOW_KEY, "4");
  fake.list(UNKNOWN_MANUAL_KEY).push("{}");
  const s = await reconcileUnknownSettlements(world().deps());
  assert.equal(s.overflowTotal, 4);
  assert.equal(s.manualTotal, 1);
  console.log("✓ annotations: overflow → ::error::, errors/manual → ::warning::");
}

// ── ethersReconcileChain against a mock provider ─────────────────────────────

function mockProvider(o: { latest: number; logAt?: number; maxRange?: number; receipts?: Record<string, unknown>; consumedAtBlock?: number }) {
  const ranges: [number, number][] = [];
  const calls: string[] = [];
  const callTags: unknown[] = [];
  const blockTs = (n: number) => NOW - (o.latest - n) * 2;
  const iface = new ethers.Interface(["function authorizationState(address,bytes32) view returns (bool)"]);
  const p = {
    ranges,
    calls,
    callTags,
    async getBlock(tag: number | string) {
      const n = tag === "latest" ? o.latest : Number(tag);
      return { number: n, timestamp: blockTs(n) };
    },
    async getLogs(f: { address: string; topics: string[]; fromBlock: number; toBlock: number }) {
      ranges.push([f.fromBlock, f.toBlock]);
      if (o.maxRange && f.toBlock - f.fromBlock + 1 > o.maxRange) throw new Error("block range too large");
      assert.equal(f.topics[0], AUTHORIZATION_USED_TOPIC);
      assert.equal(f.topics[1], pad(PAYER).toLowerCase());
      if (o.logAt !== undefined && f.fromBlock <= o.logAt && o.logAt <= f.toBlock) {
        return [{ transactionHash: TX1.toUpperCase().replace("0X", "0x") }];
      }
      return [];
    },
    async getTransactionReceipt(h: string) {
      return (o.receipts?.[h] as never) ?? null;
    },
    async call(tx: { to: string; data: string; blockTag?: unknown }) {
      calls.push(tx.to);
      callTags.push(tx.blockTag);
      const [, n] = iface.decodeFunctionData("authorizationState", tx.data);
      if (o.consumedAtBlock !== undefined) {
        // A load-balanced node that lags: "latest" (no blockTag) is behind the consumption.
        const used = typeof tx.blockTag === "number" && tx.blockTag >= o.consumedAtBlock;
        return iface.encodeFunctionResult("authorizationState", [used && n === nonce(1)]);
      }
      return iface.encodeFunctionResult("authorizationState", [n === nonce(1)]);
    },
  };
  return p;
}

{
  assert.equal(logChunkFromEnv({}), 1000, "default 1000");
  assert.equal(logChunkFromEnv({ X402_RECONCILE_LOG_CHUNK: "5000" }), 1000, "never above 1000");
  assert.equal(logChunkFromEnv({ X402_RECONCILE_LOG_CHUNK: "200" }), 200);
  assert.equal(logChunkFromEnv({ X402_RECONCILE_LOG_CHUNK: "x" }), 1000);

  // A public RPC that rejects ranges over 1,000 blocks; the log sits near the end of the window.
  const p = mockProvider({ latest: 50_000, maxRange: 1000, logAt: 49_990 });
  const c = ethersReconcileChain(p as never);
  const found = await c.findAuthorizationUsedTxs(ASSET, PAYER, nonce(1), NOW - 3 * 3600, NOW);
  assert.deepEqual(found, [TX1], "found across chunks, lowercased");
  assert.ok(p.ranges.length > 1);
  assert.ok(p.ranges.every(([a, b]) => b - a + 1 <= 1000), "every getLogs range ≤ 1000 blocks");
  for (let i = 1; i < p.ranges.length; i += 1) assert.equal(p.ranges[i][0], p.ranges[i - 1][1] + 1, "contiguous, no gaps");

  const small = mockProvider({ latest: 50_000 });
  await ethersReconcileChain(small as never, { logChunk: 200 }).findAuthorizationUsedTxs(ASSET, PAYER, nonce(1), NOW - 3600, NOW);
  assert.ok(small.ranges.every(([a, b]) => b - a + 1 <= 200));

  const capped = mockProvider({ latest: 500_000 });
  await ethersReconcileChain(capped as never, { maxLogBlocks: 5_000 }).findAuthorizationUsedTxs(ASSET, PAYER, nonce(1), NOW - 30 * 86400, NOW);
  const searched = capped.ranges.reduce((n, [a, b]) => n + b - a + 1, 0);
  assert.ok(searched <= 5_000, `search capped (${searched})`);

  assert.equal(await c.authorizationUsed(ASSET, PAYER, nonce(1), 50_000), true);
  assert.equal(await c.authorizationUsed(ASSET, PAYER, nonce(2), 50_000), false);
  assert.equal(p.calls[0], ASSET);
  assert.deepEqual(p.callTags, [50_000, 50_000], "eth_call pinned to the given block");
  assert.equal(await c.receipt(TX2), null);
  console.log("✓ ethersReconcileChain: getLogs ≤ 1000 blocks/call (env-tunable, capped), authorizationState via eth_call");
}

reset();
{
  // End to end through ethersReconcileChain with real-shaped receipts.
  const logs = twaLogs().map((l) => ({ ...l, address: l.address }));
  const p = mockProvider({
    latest: 50_000,
    logAt: 49_000,
    receipts: { [TX1]: { hash: TX1, status: 1, blockNumber: 49_000, logs } },
  });
  pushRaw(row());
  const s = await reconcileUnknownSettlements({ chain: ethersReconcileChain(p as never), now: () => NOW, asset: ASSET, payTo: PAY_TO });
  assert.equal(s.credited, 1);
  assert.equal(queue()[0].idempotencyKey, `tx:${TX1}`);

  reset();
  const p2 = mockProvider({
    latest: 50_000,
    logAt: 49_000,
    receipts: { [TX1]: { hash: TX1, status: 1, blockNumber: 49_000, logs: twaLogs({ to: PAYER }) } },
  });
  pushRaw(row());
  const s2 = await reconcileUnknownSettlements({ chain: ethersReconcileChain(p2 as never), now: () => NOW, asset: ASSET, payTo: PAY_TO });
  assert.equal(s2.manual, 1);
  assert.equal(queue().length, 0);
  console.log("✓ ethersReconcileChain end to end: match → credited; Transfer to payer → manual");
}

reset();
{
  // authorizationState and expiry time come from the SAME block. The row looks expired by the
  // latest block's time; a lagging node would answer "unused" for latest. Pinned to the tip's
  // number, the call sees the consumption and the payment is credited, not closed.
  const vb = NOW - 3600;
  const p = mockProvider({
    latest: 50_000,
    logAt: 48_000,
    consumedAtBlock: 48_000,
    receipts: { [TX1]: { hash: TX1, status: 1, blockNumber: 48_000, logs: twaLogs() } },
  });
  pushRaw(row({ at: vb - 120, validBefore: String(vb) }));
  const s = await reconcileUnknownSettlements({ chain: ethersReconcileChain(p as never), now: () => NOW, asset: ASSET, payTo: PAY_TO });
  assert.equal(s.expired, 0, "not closed as expired");
  assert.equal(s.credited, 1);
  assert.ok(p.callTags.length > 0 && p.callTags.every((t) => t === 50_000), "authorizationState read at the tip block used for time");
  console.log("✓ authorizationState and expiry use the same blockTag (lagging node cannot close a landed payment)");
}

reset();
{
  // Success path credited this authorization as tx:A (the hash the facilitator reported); the
  // event later shows tx:B consumed the nonce. Same authorization → no second credit.
  const A = hash(0xa);
  const mk = authorizationMarkerKey(row())!;
  const e = { trader: TRADER, feeUsd: 0.01, at: OLD, source: "signals" as const, idempotencyKey: `tx:${A}` };
  assert.equal(await enqueueSettlementOnce(e, mk), "queued");
  assert.equal(await enqueueSettlementOnce({ ...e, idempotencyKey: `tx:${TX2}` }, mk), "already_credited", "same authorization never queued twice");
  // The worker settles it and the queue row is gone; only settle:tx:A and the marker remain.
  fake.list(QUEUE_KEY).length = 0;
  fake.strings.set(`${SETTLE_STATE_PREFIX}tx:${A}`, JSON.stringify({ status: "DONE" }));
  pushRaw(row());
  const { consume, deps } = world();
  consume(TX2);
  const s = await reconcileUnknownSettlements(deps());
  assert.equal(s.alreadyCredited, 1);
  assert.equal(s.credited, 0);
  assert.equal(queue().length, 0, "no tx:B revenue row");
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 0);
  console.log("✓ success path credited tx:A, chain shows tx:B → authorization marker blocks a second credit");
}

await fake.close();
console.log("\n✅ unknownReconcile.test.ts 全過");
