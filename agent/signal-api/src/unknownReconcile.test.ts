// x402:settlement:unknown — dedupe, cap, and automatic reconciliation. Offline.
//   cd agent && npx tsx signal-api/src/unknownReconcile.test.ts
//
// Fake Upstash + an injected fake chain. The cases that matter most are the double-credit
// guards: a payment that was ALSO credited through the normal path (under either key form)
// must not be credited a second time by reconciliation.
import assert from "node:assert";
import { startFakeUpstash } from "./testing/fakeUpstash.ts";

const fake = await startFakeUpstash();
process.env.UPSTASH_REDIS_REST_URL = fake.url;
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";

const ledger = await import("./ledger.ts");
const { reconcileUnknownSettlements, MIN_AGE_SEC, EXPIRY_GRACE_SEC } = await import("./unknownReconcile.ts");
const {
  UNKNOWN_SETTLEMENT_KEY, UNKNOWN_MANUAL_KEY, UNKNOWN_OVERFLOW_KEY, UNKNOWN_SEEN_PREFIX,
  QUEUE_KEY, DEAD_KEY, SETTLE_STATE_PREFIX, recordUnknownSettlement,
} = ledger;

const ASSET = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYER = "0x1111111111111111111111111111111111111111";
const TRADER = "0x5555555555555555555555555555555555555555";
const nonce = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const TX = "0x" + "ab".repeat(32);

const NOW = 2_000_000_000;
const OLD = NOW - MIN_AGE_SEC - 1;

function row(over: Record<string, unknown> = {}) {
  return {
    at: OLD, route: "GET /signals/x", network: "eip155:84532", asset: ASSET, payTo: "0x9", payer: PAYER,
    nonce: nonce(1), amount: "10000", validBefore: String(NOW + 3600), transaction: null, reason: "timeout",
    ledgerEntry: { trader: TRADER, feeUsd: 0.01, source: "signals" },
    ...over,
  };
}

function reset() {
  fake.lists.clear();
  fake.strings.clear();
}

/** A fake chain whose answers each test sets. Records calls so tests can assert on them. */
function chain(opts: { used?: boolean; tx?: string | null; throws?: boolean } = {}) {
  const calls = { used: 0, find: 0 };
  return {
    calls,
    deps: {
      now: () => NOW,
      chain: {
        async authorizationUsed() {
          calls.used += 1;
          if (opts.throws) throw new Error("rpc down");
          return opts.used ?? false;
        },
        async findSettlementTx() {
          calls.find += 1;
          return opts.tx === undefined ? TX : opts.tx;
        },
      },
    },
  };
}

const pushRaw = (r: object) => fake.list(UNKNOWN_SETTLEMENT_KEY).push(JSON.stringify(r));

// ── recordUnknownSettlement: dedupe + cap ───────────────────────────────────

reset();
{
  assert.equal(await recordUnknownSettlement(row()), "recorded");
  // Same authorization, different casing, resent during the outage → not a second row.
  assert.equal(await recordUnknownSettlement(row({ payer: PAYER.toUpperCase().replace("0X", "0x"), nonce: nonce(1).toUpperCase().replace("0X", "0x") })), "duplicate");
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 1);
  console.log("✓ the same authorization resent is recorded once");
}

reset();
{
  // A row that cannot identify its authorization is still kept (it just cannot be deduped).
  await recordUnknownSettlement(row({ payer: null, nonce: null }));
  await recordUnknownSettlement(row({ payer: null, nonce: null }));
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 2);
  console.log("✓ rows without payer/nonce are kept, not silently dropped");
}

reset();
{
  await recordUnknownSettlement(row({ nonce: nonce(1) }), 2);
  await recordUnknownSettlement(row({ nonce: nonce(2) }), 2);
  await assert.rejects(() => recordUnknownSettlement(row({ nonce: nonce(3) }), 2), /full/);
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 2, "cap holds");
  assert.equal(fake.strings.get(UNKNOWN_OVERFLOW_KEY), "1", "refusal counted for monitoring");
  // The refused authorization must NOT be remembered as seen — otherwise its next resend
  // would be mistaken for a duplicate and the payment lost for good.
  assert.equal(fake.strings.has(`${UNKNOWN_SEEN_PREFIX}${PAYER.toLowerCase()}:${nonce(3)}`), false);
  fake.list(UNKNOWN_SETTLEMENT_KEY).shift();
  assert.equal(await recordUnknownSettlement(row({ nonce: nonce(3) }), 2), "recorded", "recorded once there is room");
  console.log("✓ cap refuses loudly, counts it, and lets the same payment in later");
}

// ── reconciliation ───────────────────────────────────────────────────────────

reset();
{
  pushRaw(row({ at: NOW - 5 }));
  const c = chain({ used: true });
  const s = await reconcileUnknownSettlements(c.deps);
  assert.equal(s.tooYoung, 1);
  assert.equal(c.calls.used, 0, "a fresh row is not even looked up");
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 1);
  console.log("✓ rows younger than MIN_AGE_SEC are left alone (in-flight resend can finish)");
}

reset();
{
  pushRaw(row({ validBefore: String(NOW - EXPIRY_GRACE_SEC - 1) }));
  const s = await reconcileUnknownSettlements(chain({ used: false }).deps);
  assert.equal(s.expired, 1);
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 0);
  assert.equal(fake.list(QUEUE_KEY).length, 0, "nothing credited — nothing was paid");
  console.log("✓ unused + past validBefore → closed, nothing credited");
}

reset();
{
  pushRaw(row());
  const s = await reconcileUnknownSettlements(chain({ used: false }).deps);
  assert.equal(s.pending, 1);
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 1);
  console.log("✓ unused + not yet expired → kept for a later round");
}

reset();
{
  pushRaw(row());
  const c = chain({ used: true });
  const s = await reconcileUnknownSettlements(c.deps);
  assert.equal(s.credited, 1);
  const q = fake.list(QUEUE_KEY).map((r) => JSON.parse(r));
  assert.equal(q.length, 1);
  assert.equal(q[0].idempotencyKey, `tx:${TX}`, "keyed by the consuming tx — same key the success path uses");
  assert.equal(q[0].trader, TRADER);
  assert.equal(q[0].feeUsd, 0.01);
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 0);

  // Second round: row is gone, nothing more is credited.
  await reconcileUnknownSettlements(c.deps);
  assert.equal(fake.list(QUEUE_KEY).length, 1);
  console.log("✓ consumed on chain → credited once, keyed tx:<consuming tx>");
}

reset();
{
  // The double-credit case: a resend succeeded and was queued by the normal path under the
  // auth: key form (facilitator response carried no tx). Reconciliation must not credit again.
  pushRaw(row());
  fake.list(QUEUE_KEY).push(JSON.stringify({
    trader: TRADER, feeUsd: 0.01, at: OLD, source: "signals",
    idempotencyKey: `auth:${PAYER.toLowerCase()}:${nonce(1)}`,
  }));
  const s = await reconcileUnknownSettlements(chain({ used: true }).deps);
  assert.equal(s.alreadyCredited, 1);
  assert.equal(fake.list(QUEUE_KEY).length, 1, "no second revenue row");
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 0);
  console.log("✓ already queued under auth: key → closed without crediting again");
}

reset();
{
  pushRaw(row());
  fake.strings.set(`${SETTLE_STATE_PREFIX}tx:${TX}`, JSON.stringify({ status: "settled" }));
  const s = await reconcileUnknownSettlements(chain({ used: true }).deps);
  assert.equal(s.alreadyCredited, 1);
  assert.equal(fake.list(QUEUE_KEY).length, 0);
  console.log("✓ already settled under tx: key → closed without crediting again");
}

reset();
{
  // Dead rows wrap the entry as { raw, attempts, lastError } — the key is one level down.
  pushRaw(row());
  fake.list(DEAD_KEY).push(JSON.stringify({
    raw: JSON.stringify({ trader: TRADER, feeUsd: 0.01, at: OLD, source: "signals", idempotencyKey: `tx:${TX}` }),
    attempts: 5, lastError: "boom",
  }));
  const s = await reconcileUnknownSettlements(chain({ used: true }).deps);
  assert.equal(s.alreadyCredited, 1);
  assert.equal(fake.list(QUEUE_KEY).length, 0, "retrying the dead row later must not be a second credit");
  console.log("✓ entry sitting in the dead queue counts as already credited");
}

reset();
{
  pushRaw(row({ ledgerEntry: undefined }));
  const s = await reconcileUnknownSettlements(chain({ used: true }).deps);
  assert.equal(s.manual, 1);
  assert.equal(fake.list(QUEUE_KEY).length, 0);
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 0);
  const m = JSON.parse(fake.list(UNKNOWN_MANUAL_KEY)[0]);
  assert.match(m.reason, /no ledgerEntry/);
  assert.equal(m.transaction, TX, "the human gets the tx to look at");
  console.log("✓ consumed but no ledgerEntry (pre-existing row) → handed to a human, not guessed");
}

reset();
{
  pushRaw(row({ transaction: "0x" + "cd".repeat(32) }));
  const c = chain({ used: true });
  await reconcileUnknownSettlements(c.deps);
  assert.equal(c.calls.find, 0, "row already names its tx — no log search");
  assert.equal(JSON.parse(fake.list(QUEUE_KEY)[0]).idempotencyKey, `tx:0x${"cd".repeat(32)}`);
  console.log("✓ a row that already carries the tx hash skips the log search");
}

reset();
{
  pushRaw(row());
  const s = await reconcileUnknownSettlements(chain({ throws: true }).deps);
  assert.equal(s.errors, 1);
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 1, "left exactly where it was");
  console.log("✓ RPC failure leaves the row for the next round");
}

reset();
{
  fake.list(UNKNOWN_SETTLEMENT_KEY).push("{not json");
  pushRaw({ at: OLD, asset: ASSET, payer: PAYER }); // no nonce
  const s = await reconcileUnknownSettlements(chain({ used: true }).deps);
  assert.equal(s.manual, 2);
  assert.equal(fake.list(UNKNOWN_SETTLEMENT_KEY).length, 0);
  assert.equal(fake.list(UNKNOWN_MANUAL_KEY).length, 2, "kept, not dropped");
  console.log("✓ malformed rows go to the manual list instead of being dropped");
}

await fake.close();
console.log("\n✅ unknownReconcile.test.ts 全過");
