// Automatic reconciliation for x402 v2 payments whose settlement result was unknown.
//
// Before this, rows in x402:settlement:unknown were for humans only (ADR-010): look the
// authorization up on chain, and if it landed and nothing was credited yet, add a revenue-split
// row by hand. Every step of that is mechanical, so the worker now does it each round.
//
// The deciding fact is on the asset contract itself. x402 v2 "exact" pays with EIP-3009
// transferWithAuthorization, and USDC records every consumed (authorizer, nonce) pair:
// `authorizationState(payer, nonce)` is true once the payment has landed, and it can only land
// before `validBefore`. So each row resolves to one of three states:
//
//   consumed            → the money arrived. Credit it, unless it was already credited.
//   unused, expired     → it can never land. Close the row; nothing was paid.
//   unused, not expired → still undecided. Leave it for a later round.
//
// THE ONE THING THAT MUST NOT GO WRONG: double crediting.
// The normal success path keys a revenue row `tx:<settlement tx>` (or `auth:<payer>:<nonce>` when
// the facilitator's response carried no tx). A resend of the same authorization can succeed after
// the first attempt went unknown, and be credited that way. So before crediting we:
//   1. key the reconciled row by the tx that actually consumed the nonce (from the asset's
//      AuthorizationUsed event) — the same `tx:` key the success path would have used, so the
//      worker's existing `settle:<key> NX` idempotency absorbs any overlap; and
//   2. refuse to credit if either key form already has settlement state or sits in any queue.
// Rows younger than MIN_AGE_SEC are not touched at all, so a resend that is still in flight
// finishes and enqueues before we look.

import { ethers } from "ethers";

import {
  enqueueSettlement,
  isIdempotencyKeyKnown,
  listUnknownSettlements,
  moveUnknownToManual,
  removeUnknownSettlement,
  type LedgerEntry,
} from "./ledger.ts";

/** Leave fresh rows alone so an in-flight resend can finish crediting through the normal path. */
export const MIN_AGE_SEC = 10 * 60;
/** Clock skew allowance before treating an unused authorization as expired. */
export const EXPIRY_GRACE_SEC = 60;
/** Rows examined per worker round. Reconciliation is read-only on chain, but each row costs RPC. */
export const RECONCILE_BATCH = 50;

export interface ReconcileChain {
  /** EIP-3009 `authorizationState(authorizer, nonce)` on `asset`. */
  authorizationUsed(asset: string, payer: string, nonce: string): Promise<boolean>;
  /**
   * Hash of the tx that emitted `AuthorizationUsed(payer, nonce)` on `asset`, searched in the
   * window the authorization could have been consumed in. null when not found.
   */
  findSettlementTx(asset: string, payer: string, nonce: string, fromUnix: number, toUnix: number): Promise<string | null>;
}

export interface ReconcileDeps {
  chain: ReconcileChain;
  /** unix seconds */
  now(): number;
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
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
const TX = /^0x[0-9a-fA-F]{64}$/;

interface Row {
  at: number;
  asset: string;
  payer: string;
  nonce: string;
  validBefore: number | null;
  transaction: string | null;
  ledgerEntry: Pick<LedgerEntry, "trader" | "feeUsd" | "source"> | null;
}

function parseRow(raw: string): Row | string {
  let r: Record<string, unknown>;
  try {
    r = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return "unparseable row";
  }
  const at = Number(r.at);
  if (!Number.isFinite(at)) return "row has no timestamp";
  if (typeof r.asset !== "string" || !ADDR.test(r.asset)) return "row has no asset address";
  if (typeof r.payer !== "string" || !ADDR.test(r.payer)) return "row has no payer";
  if (typeof r.nonce !== "string" || !B32.test(r.nonce)) return "row has no EIP-3009 nonce";
  const vb = Number(r.validBefore);
  const le = r.ledgerEntry as Record<string, unknown> | null | undefined;
  const source = le?.source;
  const ledgerEntry: Row["ledgerEntry"] =
    le && typeof le.trader === "string" && typeof le.feeUsd === "number" && (source === "signals" || source === "oracle")
      ? { trader: le.trader, feeUsd: le.feeUsd, source }
      : null;
  return {
    at,
    asset: r.asset,
    payer: r.payer,
    nonce: r.nonce,
    validBefore: Number.isFinite(vb) && vb > 0 ? vb : null,
    transaction: typeof r.transaction === "string" && TX.test(r.transaction) ? r.transaction.toLowerCase() : null,
    ledgerEntry,
  };
}

export async function reconcileUnknownSettlements(
  deps: ReconcileDeps,
  batch: number = RECONCILE_BATCH,
): Promise<ReconcileSummary> {
  const s: ReconcileSummary = {
    examined: 0, credited: 0, alreadyCredited: 0, expired: 0, pending: 0, tooYoung: 0, manual: 0, errors: 0,
  };
  const now = deps.now();

  for (const raw of await listUnknownSettlements(batch)) {
    s.examined += 1;
    const row = parseRow(raw);
    if (typeof row === "string") {
      await moveUnknownToManual(raw, row);
      s.manual += 1;
      continue;
    }
    if (now - row.at < MIN_AGE_SEC) {
      s.tooYoung += 1;
      continue;
    }

    try {
      const used = await deps.chain.authorizationUsed(row.asset, row.payer, row.nonce);

      if (!used) {
        if (row.validBefore !== null && now > row.validBefore + EXPIRY_GRACE_SEC) {
          // Can never be consumed now — the contract rejects it past validBefore. Nothing was paid.
          console.log(`[reconcile] closed: authorization expired unused (payer ${row.payer}, nonce ${row.nonce})`);
          await removeUnknownSettlement(raw);
          s.expired += 1;
        } else {
          s.pending += 1;
        }
        continue;
      }

      // Consumed: the money arrived. Find the tx that consumed it, for the canonical key.
      const toUnix = row.validBefore !== null ? Math.min(now, row.validBefore + EXPIRY_GRACE_SEC) : now;
      const tx = row.transaction ?? (await deps.chain.findSettlementTx(row.asset, row.payer, row.nonce, row.at - 600, toUnix));
      const authKey = `auth:${row.payer.toLowerCase()}:${row.nonce.toLowerCase()}`;
      const keys = tx ? [`tx:${tx}`, authKey] : [authKey];

      if (await isIdempotencyKeyKnown(keys)) {
        await removeUnknownSettlement(raw);
        s.alreadyCredited += 1;
        continue;
      }
      if (!row.ledgerEntry) {
        // Landed, not yet credited, but the row predates ledgerEntry capture — the beneficiary
        // and fee are not knowable from the row alone. A human finishes this one.
        await moveUnknownToManual(raw, "authorization consumed on chain but row has no ledgerEntry", tx ? { transaction: tx } : {});
        s.manual += 1;
        continue;
      }

      const entry: LedgerEntry = { ...row.ledgerEntry, at: row.at, idempotencyKey: keys[0] };
      await enqueueSettlement(entry);
      await removeUnknownSettlement(raw);
      console.log(`[reconcile] credited ${entry.idempotencyKey} → ${entry.trader} $${entry.feeUsd}`);
      s.credited += 1;
    } catch (err) {
      // RPC or Redis hiccup: leave the row exactly where it is for the next round.
      s.errors += 1;
      console.error(`[reconcile] row left for next round: ${(err as Error).message}`);
    }
  }
  return s;
}

// ── Default chain reads (ethers) ─────────────────────────────────────────────

const EIP3009_ABI = ["function authorizationState(address authorizer, bytes32 nonce) view returns (bool)"];
/** keccak256("AuthorizationUsed(address,bytes32)") — FiatTokenV2 / EIP-3009. */
const AUTHORIZATION_USED_TOPIC = ethers.id("AuthorizationUsed(address,bytes32)");
/** Public RPCs commonly cap eth_getLogs ranges near 10k blocks. */
const LOG_CHUNK = 9_000;

export function ethersReconcileChain(provider: ethers.Provider): ReconcileChain {
  return {
    async authorizationUsed(asset, payer, nonce) {
      const c = new ethers.Contract(asset, EIP3009_ABI, provider);
      return Boolean(await c.authorizationState(payer, nonce));
    },

    async findSettlementTx(asset, payer, nonce, fromUnix, toUnix) {
      // Estimate the block window from timestamps. The authorization can only be consumed
      // between when it was presented and validBefore, so the window is short (minutes);
      // a generous margin covers block-time drift.
      const latest = await provider.getBlock("latest");
      if (!latest) return null;
      const sample = await provider.getBlock(Math.max(0, latest.number - 1_000));
      const span = sample ? latest.timestamp - sample.timestamp : 0;
      const secPerBlock = span > 0 ? span / (latest.number - sample!.number) : 2;
      const blockAt = (t: number) => Math.round(latest.number - (latest.timestamp - t) / secPerBlock);
      const margin = 600;
      const from = Math.max(0, blockAt(fromUnix) - margin);
      const to = Math.min(latest.number, blockAt(toUnix) + margin);
      const topics = [AUTHORIZATION_USED_TOPIC, ethers.zeroPadValue(payer, 32), nonce];
      for (let start = from; start <= to; start += LOG_CHUNK) {
        const end = Math.min(to, start + LOG_CHUNK - 1);
        const logs = await provider.getLogs({ address: asset, topics, fromBlock: start, toBlock: end });
        if (logs.length > 0) return logs[0].transactionHash.toLowerCase();
      }
      return null;
    },
  };
}
