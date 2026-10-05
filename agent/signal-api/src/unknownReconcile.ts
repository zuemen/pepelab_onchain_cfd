// Automatic reconciliation for x402 v2 payments whose settlement result was unknown.
//
// Rows in x402:settlement:unknown are payments whose facilitator /settle call timed out, failed
// or came back pending: the authorization may or may not be on chain. The settlement worker runs
// this every round. This is money code, so the rule is:
//
//   CREDIT ONLY ON AN EXACT ON-CHAIN MATCH. EVERYTHING ELSE GOES TO A HUMAN.
//   Never credit twice, never credit something that did not pay us.
//
// The one condition under which a row is credited (all must hold):
//   1. The row is complete and names the configured settlement token (`asset`) and the current
//      payTo (= the settlement signer, which the worker's payout preflight already checked).
//   2. The asset's `AuthorizationUsed(authorizer=row.payer, nonce=row.nonce)` event is found and
//      the tx that emitted it is taken from the event. The row's own `transaction` field is only
//      used if that tx's receipt really carries the event (a facilitator may report a tx that is
//      later dropped while another tx consumes the nonce).
//   3. In that SAME receipt (status 1), the log right after the AuthorizationUsed log is the
//      asset's `Transfer(from=row.payer, to=payTo, value)` with value >= row.amount. This is how
//      EIP-3009 transferWithAuthorization emits them (mark nonce used, then transfer). A nonce
//      can also be consumed by cancelAuthorization (no AuthorizationUsed at all) or by another
//      authorization the payer signed with the same nonce (Transfer to someone else); both fail
//      here and go to a human.
//   4. The consuming block is at least MIN_AGE_SEC old by chain time, and neither the `tx:<hash>`
//      key nor the `auth:<payer>:<nonce>` key (the success path's fallback form) has settlement
//      state or sits in any settlement queue. A success-path enqueue for that settlement would
//      have happened within its own request, long before MIN_AGE_SEC.
//   Then: credit with idempotency key `tx:<hash>` — the key the success path uses — so the
//   worker's `settle:<key> NX` claim absorbs any overlap. There is no `auth:` credit path.
//
// Other outcomes:
//   - nonce not consumed, chain time past validBefore + grace → closed, nothing was paid.
//   - nonce not consumed, not expired → left for a later round.
//   - anything that does not match exactly, or missing data → manual, with a reason code.
//   - RPC/Redis error → left in place; MAX_ROW_ERRORS in a row → manual ("repeated_errors").
// Rows are walked by rotation (head → tail), so stuck rows never starve the ones behind them.

import { ethers } from "ethers";

import {
  bumpUnknownRowErrors,
  clearUnknownRowErrors,
  creditUnknownSettlement,
  hasSettleState,
  idempotencyKeysInQueues,
  moveUnknownToManual,
  removeUnknownSettlement,
  rotateUnknown,
  unknownHealth,
  unknownLength,
  type LedgerEntry,
} from "./ledger.ts";

/** Leave fresh rows (and freshly consumed nonces) alone so an in-flight request finishes first. */
export const MIN_AGE_SEC = 10 * 60;
/** Allowance before treating an unused authorization as expired (compared to chain time). */
export const EXPIRY_GRACE_SEC = 60;
/** Rows examined per worker round. Each costs RPC. */
export const RECONCILE_BATCH = 50;
/** Consecutive errors on one row before it is handed to a human. */
export const MAX_ROW_ERRORS = 5;
/** Rows older than this go to a human: settlement state (90-day TTL) can no longer be trusted. */
export const STALE_ROW_SEC = 30 * 24 * 60 * 60;
/** How far before the row's timestamp the consuming tx may lie (the settle call started earlier). */
export const SEARCH_LEAD_SEC = 10 * 60;

export interface ChainLog {
  address: string;
  topics: readonly string[];
  data: string;
  /** Position in the block; used to find the log right after AuthorizationUsed. */
  index: number;
}

export interface ChainReceipt {
  hash: string;
  /** 1 = success. */
  status: number | null;
  blockNumber: number;
  /** Unix seconds of the receipt's block. */
  blockTimestamp: number;
  logs: ChainLog[];
}

export interface ReconcileChain {
  latestBlock(): Promise<{ number: number; timestamp: number }>;
  /** EIP-3009 `authorizationState(authorizer, nonce)` on `asset`. */
  authorizationUsed(asset: string, payer: string, nonce: string): Promise<boolean>;
  /** Hashes of txs whose logs carry `AuthorizationUsed(payer, nonce)` from `asset`, searched in the time window. */
  findAuthorizationUsedTxs(asset: string, payer: string, nonce: string, fromUnix: number, toUnix: number): Promise<string[]>;
  receipt(txHash: string): Promise<ChainReceipt | null>;
}

export interface ReconcileDeps {
  chain: ReconcileChain;
  /** unix seconds (local clock; only used for row age). Expiry uses chain time. */
  now(): number;
  /** The configured settlement token (USDC). */
  asset: string;
  /** The current payTo (= settlement signer, already through payout preflight). */
  payTo: string;
  batch?: number;
  maxRowErrors?: number;
}

export interface ReconcileSummary {
  examined: number;
  credited: number;
  alreadyCredited: number;
  expired: number;
  pending: number;
  tooYoung: number;
  manual: number;
  errors: number;
  /** Manual moves this round, by reason code. */
  manualReasons: Record<string, number>;
  /** After the round: rows left, rows awaiting a human, overflow counter. */
  remaining: number;
  manualTotal: number;
  overflowTotal: number;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^[0-9]{1,78}$/;

export const AUTHORIZATION_USED_TOPIC = ethers.id("AuthorizationUsed(address,bytes32)");
export const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");
const topicAddr = (a: string) => ethers.zeroPadValue(a.toLowerCase(), 32).toLowerCase();

interface Row {
  at: number;
  asset: string;
  payTo: string;
  payer: string;
  nonce: string;
  amount: bigint;
  validBefore: number;
  transaction: string | null;
  ledgerEntry: Pick<LedgerEntry, "trader" | "feeUsd" | "source"> | null;
}

/** Parsed row, or a reason code for the manual list. */
function parseRow(raw: string): Row | string {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "unparseable";
  }
  if (!r || typeof r !== "object") return "unparseable";
  const at = Number(r.at);
  if (!Number.isFinite(at) || at <= 0) return "missing_at";
  if (typeof r.asset !== "string" || !ADDR.test(r.asset)) return "missing_asset";
  if (typeof r.payTo !== "string" || !ADDR.test(r.payTo)) return "missing_payto";
  if (typeof r.payer !== "string" || !ADDR.test(r.payer)) return "missing_payer";
  if (typeof r.nonce !== "string" || !B32.test(r.nonce)) return "missing_nonce";
  if (typeof r.amount !== "string" || !UINT.test(r.amount) || BigInt(r.amount) <= 0n) return "missing_amount";
  if (typeof r.validBefore !== "string" || !UINT.test(r.validBefore) || Number(r.validBefore) <= 0) return "missing_valid_before";
  const le = r.ledgerEntry as Record<string, unknown> | null | undefined;
  const source = le?.source;
  const ledgerEntry: Row["ledgerEntry"] =
    le && typeof le.trader === "string" && ADDR.test(le.trader) &&
    typeof le.feeUsd === "number" && Number.isFinite(le.feeUsd) && le.feeUsd > 0 &&
    (source === "signals" || source === "oracle")
      ? { trader: le.trader, feeUsd: le.feeUsd, source }
      : null;
  return {
    at,
    asset: r.asset.toLowerCase(),
    payTo: r.payTo.toLowerCase(),
    payer: r.payer.toLowerCase(),
    nonce: r.nonce.toLowerCase(),
    amount: BigInt(r.amount),
    validBefore: Number(r.validBefore),
    transaction: typeof r.transaction === "string" && B32.test(r.transaction) ? r.transaction.toLowerCase() : null,
    ledgerEntry,
  };
}

const isAuthUsedLog = (l: ChainLog, asset: string, payer: string, nonce: string) =>
  l.address.toLowerCase() === asset &&
  l.topics.length === 3 &&
  l.topics[0].toLowerCase() === AUTHORIZATION_USED_TOPIC &&
  l.topics[1].toLowerCase() === topicAddr(payer) &&
  l.topics[2].toLowerCase() === nonce;

/**
 * Check one receipt against the crediting rule (points 2–3 in the header). Returns null when it
 * matches, else a reason code.
 */
export function verifyReceipt(
  rc: ChainReceipt,
  want: { asset: string; payer: string; nonce: string; payTo: string; amount: bigint },
): string | null {
  const asset = want.asset.toLowerCase();
  const payer = want.payer.toLowerCase();
  const nonce = want.nonce.toLowerCase();
  if (rc.status !== 1) return "receipt_not_success";
  const logs = [...rc.logs].sort((a, b) => a.index - b.index);
  const i = logs.findIndex((l) => isAuthUsedLog(l, asset, payer, nonce));
  if (i < 0) return "receipt_without_event";
  const t = logs[i + 1];
  if (
    !t ||
    t.address.toLowerCase() !== asset ||
    t.topics.length !== 3 ||
    t.topics[0].toLowerCase() !== TRANSFER_TOPIC ||
    t.topics[1].toLowerCase() !== topicAddr(payer)
  ) {
    return "no_transfer_with_event";
  }
  if (t.topics[2].toLowerCase() !== topicAddr(want.payTo)) return "transfer_not_to_payto";
  let value: bigint;
  try {
    value = BigInt(t.data);
  } catch {
    return "transfer_value_unreadable";
  }
  if (value < want.amount) return "amount_short";
  return null;
}

type Outcome =
  | { kind: "credited" | "alreadyCredited" | "expired" | "pending" | "tooYoung" }
  | { kind: "manual"; reason: string; extra?: Record<string, unknown> };

export async function reconcileUnknownSettlements(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const s: ReconcileSummary = {
    examined: 0, credited: 0, alreadyCredited: 0, expired: 0, pending: 0, tooYoung: 0, manual: 0, errors: 0,
    manualReasons: {}, remaining: 0, manualTotal: 0, overflowTotal: 0,
  };
  if (!ADDR.test(deps.asset) || !ADDR.test(deps.payTo)) throw new Error("reconcile: asset / payTo not configured");
  const cfgAsset = deps.asset.toLowerCase();
  const cfgPayTo = deps.payTo.toLowerCase();
  const maxErrors = deps.maxRowErrors ?? MAX_ROW_ERRORS;
  const now = deps.now();

  // Per-round caches: one latest block, one snapshot of queued keys (both read lazily).
  let latest: { number: number; timestamp: number } | null = null;
  const chainNow = async () => (latest ??= await deps.chain.latestBlock());
  let queued: Set<string> | null = null;

  const decide = async (raw: string): Promise<Outcome> => {
    const row = parseRow(raw);
    if (typeof row === "string") return { kind: "manual", reason: row };
    if (now - row.at < MIN_AGE_SEC) return { kind: "tooYoung" };
    if (now - row.at > STALE_ROW_SEC) return { kind: "manual", reason: "stale_row" };
    if (row.asset !== cfgAsset) return { kind: "manual", reason: "asset_mismatch" };
    if (row.payTo !== cfgPayTo) return { kind: "manual", reason: "payto_mismatch" };

    const used = await deps.chain.authorizationUsed(row.asset, row.payer, row.nonce);
    if (!used) {
      const tip = await chainNow();
      // Past validBefore by chain time the contract rejects it: it can never be consumed.
      return tip.timestamp > row.validBefore + EXPIRY_GRACE_SEC ? { kind: "expired" } : { kind: "pending" };
    }

    // Consumed. Locate the consuming tx from the event — never trust the row's tx by itself.
    const want = { asset: row.asset, payer: row.payer, nonce: row.nonce, payTo: cfgPayTo, amount: row.amount };
    let rc: ChainReceipt | null = null;
    if (row.transaction) {
      const r = await deps.chain.receipt(row.transaction);
      if (r && r.status === 1 && r.logs.some((l) => isAuthUsedLog(l, row.asset, row.payer, row.nonce))) rc = r;
    }
    if (!rc) {
      const txs = await deps.chain.findAuthorizationUsedTxs(
        row.asset, row.payer, row.nonce, row.at - SEARCH_LEAD_SEC, row.validBefore + EXPIRY_GRACE_SEC,
      );
      const uniq = [...new Set(txs.map((t) => t.toLowerCase()))];
      // Consumed but no AuthorizationUsed: cancelAuthorization, or outside the search window.
      if (uniq.length === 0) return { kind: "manual", reason: "consumed_without_event" };
      if (uniq.length > 1) return { kind: "manual", reason: "multiple_events", extra: { transactions: uniq } };
      rc = await deps.chain.receipt(uniq[0]);
      if (!rc) throw new Error(`no receipt for ${uniq[0]}`);
    }
    const tx = rc.hash.toLowerCase();
    const bad = verifyReceipt(rc, want);
    if (bad) return { kind: "manual", reason: bad, extra: { transaction: tx } };

    const tip = await chainNow();
    if (tip.timestamp - rc.blockTimestamp < MIN_AGE_SEC) return { kind: "pending" };

    const keys = [`tx:${tx}`, `auth:${row.payer}:${row.nonce}`];
    queued ??= await idempotencyKeysInQueues();
    if (keys.some((k) => queued!.has(k)) || (await hasSettleState(keys))) {
      await removeUnknownSettlement(raw);
      return { kind: "alreadyCredited" };
    }
    if (!row.ledgerEntry) return { kind: "manual", reason: "no_ledger_entry", extra: { transaction: tx } };

    const entry: LedgerEntry = { ...row.ledgerEntry, at: row.at, idempotencyKey: keys[0] };
    // Atomic: the revenue row is pushed only if this call removed the unknown row.
    if (!(await creditUnknownSettlement(raw, entry))) return { kind: "pending" };
    queued.add(keys[0]);
    console.log(`[reconcile] credited ${entry.idempotencyKey} → ${entry.trader} $${entry.feeUsd}`);
    return { kind: "credited" };
  };

  const n = Math.min(deps.batch ?? RECONCILE_BATCH, await unknownLength());
  for (let i = 0; i < n; i += 1) {
    const raw = await rotateUnknown();
    if (raw === null) break;
    s.examined += 1;
    let o: Outcome;
    try {
      o = await decide(raw);
    } catch (err) {
      // RPC or Redis hiccup: the row stays (already rotated to the tail). Count it; after
      // maxErrors consecutive failures the row goes to a human instead of spinning forever.
      s.errors += 1;
      const msg = (err as Error).message;
      console.error(`[reconcile] row left for next round: ${msg}`);
      try {
        const count = await bumpUnknownRowErrors(raw);
        if (count < maxErrors) continue;
        o = { kind: "manual", reason: "repeated_errors", extra: { lastError: msg.slice(0, 200) } };
      } catch {
        continue;
      }
    }
    try {
      if (o.kind === "manual") {
        await moveUnknownToManual(raw, o.reason, o.extra ?? {});
        s.manual += 1;
        s.manualReasons[o.reason] = (s.manualReasons[o.reason] ?? 0) + 1;
        console.warn(`[reconcile] → manual (${o.reason})`);
      } else {
        if (o.kind === "expired") {
          await removeUnknownSettlement(raw);
          console.log("[reconcile] closed: authorization expired unused");
        }
        s[o.kind] += 1;
      }
      if (o.kind !== "tooYoung") await clearUnknownRowErrors(raw);
    } catch (err) {
      s.errors += 1;
      console.error(`[reconcile] could not finish row: ${(err as Error).message}`);
    }
  }

  const h = await unknownHealth();
  s.remaining = h.remaining;
  s.manualTotal = h.manualTotal;
  s.overflowTotal = h.overflowTotal;
  return s;
}

/** GitHub Actions annotations for one reconciliation round (or its failure). */
export function reconcileAnnotations(r: ReconcileSummary | { failed: string }): string[] {
  if ("failed" in r) return [`::error::unknown-settlement reconciliation failed this round: ${r.failed}`];
  const out: string[] = [];
  if (r.overflowTotal > 0) {
    out.push(
      `::error::x402:settlement:unknown overflowed ${r.overflowTotal} time(s): those rows are in ` +
        "x402:settlement:unknown:manual (reason overflow). Handle them, then reset x402:settlement:unknown:overflow.",
    );
  }
  if (r.errors > 0) {
    out.push(`::warning::unknown-settlement reconciliation: ${r.errors} row error(s) this round (rows kept; ${MAX_ROW_ERRORS} in a row → manual)`);
  }
  if (r.manual > 0) {
    out.push(`::warning::${r.manual} unknown-settlement row(s) moved to x402:settlement:unknown:manual: ${JSON.stringify(r.manualReasons)}`);
  }
  if (r.manualTotal > 0) {
    out.push(`::warning::x402:settlement:unknown:manual holds ${r.manualTotal} row(s) awaiting a human`);
  }
  return out;
}

// ── Default chain reads (ethers) ─────────────────────────────────────────────

/** Public RPCs commonly cap eth_getLogs at 1,000 blocks per call. */
export const LOG_CHUNK_MAX = 1000;
/** Upper bound on blocks searched per row (validBefore may be set far in the future). */
export const MAX_LOG_BLOCKS_DEFAULT = 20_000;

export function logChunkFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.X402_RECONCILE_LOG_CHUNK);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, LOG_CHUNK_MAX) : LOG_CHUNK_MAX;
}

const EIP3009 = new ethers.Interface(["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"]);

export type ReconcileProvider = Pick<ethers.Provider, "getBlock" | "getLogs" | "getTransactionReceipt" | "call">;

export function ethersReconcileChain(
  provider: ReconcileProvider,
  opts: { logChunk?: number; maxLogBlocks?: number } = {},
): ReconcileChain {
  const chunk = Math.max(1, Math.min(opts.logChunk ?? logChunkFromEnv(), LOG_CHUNK_MAX));
  const maxBlocks = opts.maxLogBlocks ?? MAX_LOG_BLOCKS_DEFAULT;

  const latestBlock = async () => {
    const b = await provider.getBlock("latest");
    if (!b) throw new Error("latest block unavailable");
    return { number: b.number, timestamp: b.timestamp };
  };

  return {
    latestBlock,

    async authorizationUsed(asset, payer, nonce) {
      const data = EIP3009.encodeFunctionData("authorizationState", [payer, nonce]);
      const out = await provider.call({ to: asset, data });
      return Boolean(EIP3009.decodeFunctionResult("authorizationState", out)[0]);
    },

    async findAuthorizationUsedTxs(asset, payer, nonce, fromUnix, toUnix) {
      // Estimate the block window from timestamps; a generous margin covers drift. If the
      // estimate misses, nothing is found and the row goes to a human — never credited.
      const latest = await latestBlock();
      const back = Math.min(1_000, latest.number);
      const sample = back > 0 ? await provider.getBlock(latest.number - back) : null;
      const span = sample ? latest.timestamp - sample.timestamp : 0;
      const secPerBlock = sample && span > 0 ? span / (latest.number - sample.number) : 2;
      const blockAt = (t: number) => Math.round(latest.number - (latest.timestamp - t) / secPerBlock);
      const margin = 600;
      const from = Math.max(0, blockAt(fromUnix) - margin);
      const to = Math.min(latest.number, blockAt(toUnix) + margin, from + maxBlocks - 1);
      const topics = [AUTHORIZATION_USED_TOPIC, topicAddr(payer), nonce.toLowerCase()];
      const found = new Set<string>();
      for (let start = from; start <= to; start += chunk) {
        const end = Math.min(to, start + chunk - 1);
        const logs = await provider.getLogs({ address: asset, topics, fromBlock: start, toBlock: end });
        for (const l of logs) found.add(l.transactionHash.toLowerCase());
        if (found.size > 0) break; // a nonce is consumed at most once
      }
      return [...found];
    },

    async receipt(txHash) {
      const r = await provider.getTransactionReceipt(txHash);
      if (!r) return null;
      const b = await provider.getBlock(r.blockNumber);
      if (!b) throw new Error(`block ${r.blockNumber} unavailable`);
      return {
        hash: r.hash,
        status: r.status,
        blockNumber: r.blockNumber,
        blockTimestamp: b.timestamp,
        logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data, index: l.index })),
      };
    },
  };
}
