// Browser side of the v3 AgentDelegationCredential (docs/SSI_AGENT_DELEGATION.md):
// build the signed fields from the on-chain session, hash them (= the value anchored in
// SessionCredentialAnchor), build the ADR-016 revocation list a user signs when revoking,
// and read the x402 spend the signal-api has accumulated for a credential.
//
// Schema = src/contracts/agentDelegation.ts (shared byte-for-byte with the agent verifier).
// Pure helpers + ethers hashing; no wallet access, no React. Display strings live in the
// locale catalogs, so messages thrown here are developer-facing English codes.
import { TypedDataEncoder, getAddress, parseUnits, verifyTypedData } from 'ethers'

import {
  canonicalAssets,
  delegationDomain,
  newAuthNonce,
  DELEGATION_TYPES,
  X402_DEFAULT_ENDPOINTS,
  DEFAULT_X402_PERIOD_SEC,
  buildDelegationTypedValue,
  type DelegationFields,
  type DelegationCredential,
} from 'src/contracts/agentAuth'
import {
  STATUS_LIST_TYPES,
  statusListDomain,
  canonicalRevokedIds,
  isCanonicalRevokedIds,
  buildStatusListTypedValue,
  DEFAULT_STATUS_LIST_VALIDITY_SEC,
  type StatusListFields,
  type CredentialStatusList,
} from 'src/contracts/agentAuthStatus'

/** What SessionsPage knows about a session (raw on-chain values). */
export interface SessionTerms {
  id: number
  agent: string
  maxMarginPerTrade: bigint
  totalMarginBudget: bigint
  maxLeverage: bigint
  expiry: bigint
  allowedAssets: readonly string[]
}

/** The x402 allowance as the form collects it (human USDC). */
export interface X402AllowanceForm {
  perPeriodUsdc: string
  periodHours: string
  totalUsdc: string
  endpoints: readonly string[]
}

export const DEFAULT_X402_FORM: X402AllowanceForm = {
  perPeriodUsdc: '0.10',
  periodHours: String(DEFAULT_X402_PERIOD_SEC / 3600),
  totalUsdc: '1.00',
  endpoints: X402_DEFAULT_ENDPOINTS,
}

/** "0.10" → "100000" (atomic USDC). Throws `bad_usdc` on malformed input. */
export function usdcToAtomic(s: string): string {
  const t = s.trim()
  if (!/^\d+(\.\d{1,6})?$/.test(t)) throw new Error('bad_usdc')
  return parseUnits(t, 6).toString()
}

/** Signed fields for a v3 credential mirroring the on-chain session exactly. */
export function buildFieldsForSession(p: {
  issuer: string
  sessionManager: string
  session: SessionTerms
  x402: X402AllowanceForm
  validityDays: number
  nowSec?: number
  nonce?: string
}): DelegationFields {
  const now = p.nowSec ?? Math.floor(Date.now() / 1000)
  const expiry = Number(p.session.expiry)
  const days = Number.isFinite(p.validityDays) && p.validityDays > 0 ? p.validityDays : 30
  const validUntil = Math.min(now + Math.floor(days * 86400), expiry)
  if (validUntil <= now) throw new Error('session_expired')
  const periodSeconds = Math.round(Number(p.x402.periodHours) * 3600)
  if (!Number.isSafeInteger(periodSeconds) || periodSeconds <= 0) throw new Error('bad_period')
  const maxPerPeriod = usdcToAtomic(p.x402.perPeriodUsdc)
  const maxTotal = usdcToAtomic(p.x402.totalUsdc)
  if (BigInt(maxPerPeriod) > BigInt(maxTotal)) throw new Error('period_over_total')
  if (p.x402.endpoints.length === 0) throw new Error('no_endpoints')
  return {
    issuer: p.issuer,
    agent: p.session.agent,
    sessionManager: p.sessionManager,
    sessionId: p.session.id,
    maxMarginPerTrade: p.session.maxMarginPerTrade.toString(),
    totalMarginBudget: p.session.totalMarginBudget.toString(),
    maxLeverage: Number(p.session.maxLeverage),
    sessionExpiry: expiry,
    allowedAssets: canonicalAssets(p.session.allowedAssets),
    x402: { maxPerPeriod, periodSeconds, maxTotal, endpoints: [...p.x402.endpoints] },
    validFrom: now,
    validUntil,
    nonce: p.nonce ?? newAuthNonce(),
  }
}

/** Arguments for `signer.signTypedData(domain, types, value)` (ethers v6). */
export function delegationTypedData(fields: DelegationFields, chainId: number) {
  return {
    domain: delegationDomain(chainId, fields.sessionManager),
    types: DELEGATION_TYPES,
    value: buildDelegationTypedValue(fields),
  }
}

/** credentialHash = EIP-712 digest (what the user anchors on chain). */
export function credentialHash(fields: DelegationFields, chainId: number): string {
  const td = delegationTypedData(fields, chainId)
  return TypedDataEncoder.hash(td.domain, td.types, td.value).toLowerCase()
}

/**
 * The next ADR-016 status list that revokes `jti`, carrying over every revocation of the
 * previous list (lists must be cumulative and the sequence strictly increasing).
 */
export function revocationListFields(p: {
  issuer: string
  jti: string
  previous?: Pick<CredentialStatusList, 'sequence' | 'revoked' | 'revokedBefore'> | null
  nowSec?: number
}): StatusListFields {
  const now = p.nowSec ?? Math.floor(Date.now() / 1000)
  const prev = p.previous ?? null
  return {
    issuer: p.issuer,
    sequence: (prev?.sequence ?? 0) + 1,
    issuedAt: now,
    validUntil: now + DEFAULT_STATUS_LIST_VALIDITY_SEC,
    revokedBefore: prev?.revokedBefore ?? 0,
    revoked: canonicalRevokedIds([...(prev?.revoked ?? []), p.jti]),
  }
}

/** Arguments for `signer.signTypedData` for a status list. */
export function statusListTypedData(fields: StatusListFields, sessionManager: string) {
  return { domain: statusListDomain(sessionManager), types: STATUS_LIST_TYPES, value: buildStatusListTypedValue(fields) }
}

/**
 * Check a status list the way the agent verifier does (agent/shared/src/vcStatus.ts): signed by
 * `issuer` over this deployment's domain, canonical ids. Returns an English error code or null.
 * Expiry is not checked: an expired list is still the right base to carry revocations over from.
 */
export function statusListProblem(list: unknown, issuer: string, sessionManager: string): string | null {
  const l = list as Partial<CredentialStatusList> | null
  if (!l || typeof l !== 'object' || !l.proof?.proofValue) return 'malformed'
  if (!Number.isSafeInteger(l.sequence) || (l.sequence as number) < 1) return 'malformed'
  if (!isCanonicalRevokedIds(l.revoked)) return 'malformed'
  if (String(l.proof.eip712Domain?.verifyingContract ?? '').toLowerCase() !== sessionManager.toLowerCase()) return 'wrong_contract'
  const fields: StatusListFields = {
    issuer: getAddress(issuer),
    sequence: l.sequence as number,
    issuedAt: Number(l.issuedAt),
    validUntil: Number(l.validUntil),
    revokedBefore: Number(l.revokedBefore),
    revoked: l.revoked,
  }
  const td = statusListTypedData(fields, sessionManager)
  try {
    if (getAddress(verifyTypedData(td.domain, td.types, td.value, l.proof.proofValue)) !== getAddress(issuer)) return 'bad_signature'
  } catch {
    return 'bad_signature'
  }
  return null
}

/** The issuer's currently published list: `<base>/<issuer lowercase>.json` (same layout the agent reads). */
export type PublishedStatusList =
  | { kind: 'list'; list: CredentialStatusList }
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string }

export async function fetchPublishedStatusList(
  baseUrl: string | undefined,
  issuer: string,
  sessionManager: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishedStatusList> {
  const base = baseUrl?.trim().replace(/\/+$/, '')
  if (!base || !/^https?:\/\//i.test(base)) return { kind: 'unavailable', reason: 'status_source_unset' }
  try {
    const r = await fetchImpl(`${base}/${getAddress(issuer).toLowerCase()}.json`, { redirect: 'error', cache: 'no-store' })
    if (r.status === 404) {
      // "No list" only counts when the directory marker confirms this really is the status directory.
      const idx = await fetchImpl(`${base}/index.json`, { redirect: 'error', cache: 'no-store' })
      const j = idx.ok ? ((await idx.json()) as { type?: unknown }) : null
      return j?.type === 'AgentCredentialStatusDirectory' ? { kind: 'none' } : { kind: 'unavailable', reason: 'status_directory_unconfirmed' }
    }
    if (!r.ok) return { kind: 'unavailable', reason: `status_http_${r.status}` }
    const list = (await r.json()) as CredentialStatusList
    const problem = statusListProblem(list, issuer, sessionManager)
    return problem ? { kind: 'unavailable', reason: `status_list_${problem}` } : { kind: 'list', list }
  } catch {
    return { kind: 'unavailable', reason: 'status_fetch_failed' }
  }
}

/**
 * The list a new revocation must build on. Lists are cumulative with a strictly increasing
 * sequence, so signing on top of a stale base makes verifiers reject the new list (replay /
 * equivocation) — the revocation would silently not take effect. Base = the published list, or
 * a local list that is newer AND already contains every published revocation (signed earlier,
 * not yet installed). Unknown published state (`unavailable`) → no base; the caller must refuse.
 */
export function revocationBase(
  published: PublishedStatusList,
  local: CredentialStatusList | null,
): { ok: true; previous: CredentialStatusList | null } | { ok: false; reason: string } {
  if (published.kind === 'unavailable') return { ok: false, reason: published.reason }
  const pub = published.kind === 'list' ? published.list : null
  if (local && (!pub || (local.sequence > pub.sequence && pub.revoked.every((id) => local.revoked.includes(id))))) {
    return { ok: true, previous: local }
  }
  return { ok: true, previous: pub }
}

/** The spend the signal-api tracks for a credential (`GET /kya/spend/:hash`). */
export interface KyaSpend {
  totalAtomic: bigint
  periodAtomic: bigint
}

export async function fetchKyaSpend(
  apiBase: string,
  hash: string,
  periodSeconds: number,
  fetchImpl: typeof fetch = fetch,
): Promise<KyaSpend | null> {
  try {
    const r = await fetchImpl(`${apiBase.replace(/\/+$/, '')}/kya/spend/${hash}?period=${periodSeconds}`)
    if (!r.ok) return null
    const j = (await r.json()) as { totalAtomic?: string; periodAtomic?: string }
    return { totalAtomic: BigInt(j.totalAtomic ?? '0'), periodAtomic: BigInt(j.periodAtomic ?? '0') }
  } catch {
    return null
  }
}

/** 0..100 progress, clamped. */
export function spendPercent(spent: bigint, cap: bigint): number {
  if (cap <= 0n) return 100
  const pct = Number((spent * 10000n) / cap) / 100
  return Math.max(0, Math.min(100, pct))
}

/** Local persistence key for issued v3 credentials (per chain + manager + user). */
export function delegationStorageKey(chainId: number | null, sessionManager: string, user: string | null): string | null {
  if (chainId === null || !user) return null
  return `pepelab:delegation-v3:${chainId}:${sessionManager.toLowerCase()}:${user.toLowerCase()}`
}

export interface StoredDelegation {
  credential: DelegationCredential
  credentialHash: string
  anchoredTx?: string
  /** True only once the revocation is confirmed published (verifiers can see it). */
  revoked?: boolean
  /** A revocation list was signed but not confirmed published yet — the credential is still live. */
  revocationPending?: { sequence: number }
}

/** Local persistence key for the last status list this user signed (ADR-016 lists are cumulative). */
export function statusListStorageKey(sessionManager: string, user: string): string {
  return `pepelab:vc-status-list:${sessionManager.toLowerCase()}:${user.toLowerCase()}`
}
