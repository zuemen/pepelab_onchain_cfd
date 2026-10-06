import { Wallet, getAddress, id as keccakId, verifyTypedData, TypedDataEncoder } from 'ethers'
import { it, expect, describe } from 'vitest'

import {
  canonicalAssets,
  decodeHeaderJson,
  encodeHeaderJson,
  matchX402Endpoint,
  isDelegationCredential,
  assembleDelegationCredential,
  delegationFieldsFromCredential,
} from 'src/contracts/agentAuth'
import { assembleStatusList } from 'src/contracts/agentAuthStatus'
import {
  sessionAnchorProblem,
  getSessionAnchorAddress,
  isSessionAnchorDeployed,
  sessionAnchorOverrideChainId,
} from 'src/contracts/sessionCredentialAnchor'

import {
  spendPercent,
  usdcToAtomic,
  fetchKyaSpend,
  credentialHash,
  DEFAULT_X402_FORM,
  delegationTypedData,
  statusListTypedData,
  buildFieldsForSession,
  revocationBase,
  statusListProblem,
  revocationListFields,
  delegationStorageKey,
  fetchPublishedStatusList,
} from './delegationCredential'

const MGR = '0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e'
const NOW = 1_790_000_000
const BTC = keccakId('sBTC')
const ETH = keccakId('sETH')

function session(agent: string) {
  return {
    id: 4,
    agent,
    maxMarginPerTrade: 50n * 10n ** 18n,
    totalMarginBudget: 1000n * 10n ** 18n,
    maxLeverage: 5n,
    expiry: BigInt(NOW + 7 * 86400),
    allowedAssets: [ETH, BTC],
  }
}

describe('v3 delegation credential (SessionsPage issuance)', () => {
  it('mirrors the on-chain session in raw units and signs a verifiable W3C VC 2.0', async () => {
    const user = Wallet.createRandom()
    const agent = Wallet.createRandom()
    const fields = buildFieldsForSession({
      issuer: user.address, sessionManager: MGR, session: session(agent.address),
      x402: DEFAULT_X402_FORM, validityDays: 30, nowSec: NOW,
    })
    expect(fields.maxMarginPerTrade).toBe('50000000000000000000')
    expect(fields.validUntil).toBe(NOW + 7 * 86400) // capped at session expiry
    expect(fields.allowedAssets).toEqual(canonicalAssets([BTC, ETH]))
    expect(fields.x402).toMatchObject({ maxPerPeriod: '100000', maxTotal: '1000000', periodSeconds: 86400 })

    const td = delegationTypedData(fields, 84532)
    const signature = await user.signTypedData(td.domain, td.types, td.value)
    expect(verifyTypedData(td.domain, td.types, td.value, signature)).toBe(user.address)
    const vc = assembleDelegationCredential({ fields, chainId: 84532, signature })
    expect(isDelegationCredential(vc)).toBe(true)
    expect(vc['@context'][0]).toBe('https://www.w3.org/ns/credentials/v2')
    expect(vc.type).toEqual(['VerifiableCredential', 'AgentDelegationCredential'])
    expect(vc.credentialSubject.id).toBe(`did:pkh:eip155:84532:${agent.address}`)
    expect(vc.credentialStatus.statusListIndex).toBe(fields.nonce.toLowerCase())

    // JSON round trip → same fields → same hash (what the user anchors).
    const back = delegationFieldsFromCredential(JSON.parse(JSON.stringify(vc)))
    expect(back.chainId).toBe(84532)
    expect(credentialHash(back.fields, 84532)).toBe(credentialHash(fields, 84532))
    expect(credentialHash(fields, 84532)).toBe(TypedDataEncoder.hash(td.domain, td.types, td.value).toLowerCase())
    // A different chain is a different credential.
    expect(credentialHash(fields, 31337)).not.toBe(credentialHash(fields, 84532))
  })

  it('rejects inconsistent x402 caps and expired sessions with stable codes', () => {
    const base = { issuer: Wallet.createRandom().address, sessionManager: MGR, session: session(Wallet.createRandom().address), validityDays: 30, nowSec: NOW }
    expect(() => buildFieldsForSession({ ...base, x402: { ...DEFAULT_X402_FORM, perPeriodUsdc: '2', totalUsdc: '1' } })).toThrow('period_over_total')
    expect(() => buildFieldsForSession({ ...base, x402: { ...DEFAULT_X402_FORM, perPeriodUsdc: '0.1234567' } })).toThrow('bad_usdc')
    expect(() => buildFieldsForSession({ ...base, x402: { ...DEFAULT_X402_FORM, periodHours: '0' } })).toThrow('bad_period')
    expect(() => buildFieldsForSession({ ...base, x402: { ...DEFAULT_X402_FORM, endpoints: [] } })).toThrow('no_endpoints')
    expect(() => buildFieldsForSession({ ...base, x402: DEFAULT_X402_FORM, nowSec: NOW + 8 * 86400 })).toThrow('session_expired')
    expect(usdcToAtomic('0.01')).toBe('10000')
  })

  it('builds a cumulative, strictly increasing revocation list signed in the v2/status domain', async () => {
    const user = Wallet.createRandom()
    const jti1 = '0x' + '11'.repeat(32)
    const jti2 = '0x' + '22'.repeat(32)
    const first = revocationListFields({ issuer: user.address, jti: jti1, nowSec: NOW })
    expect(first.sequence).toBe(1)
    expect(first.revoked).toEqual([jti1])
    const second = revocationListFields({ issuer: user.address, jti: jti2, previous: { sequence: 1, revoked: [jti1], revokedBefore: 0 }, nowSec: NOW + 1 })
    expect(second.sequence).toBe(2)
    expect(second.revoked).toEqual([jti1, jti2])
    const td = statusListTypedData(second, MGR)
    const sig = await user.signTypedData(td.domain, td.types, td.value)
    expect(verifyTypedData(td.domain, td.types, td.value, sig)).toBe(user.address)
  })

  it('reads x402 spend from signal-api and clamps progress', async () => {
    const fake = (async () => new Response(JSON.stringify({ ok: true, totalAtomic: '20000', periodAtomic: '10000' }))) as typeof fetch
    expect(await fetchKyaSpend('http://x/', '0x' + 'ab'.repeat(32), 3600, fake)).toEqual({ totalAtomic: 20000n, periodAtomic: 10000n })
    const down = (async () => new Response('{}', { status: 404 })) as typeof fetch
    expect(await fetchKyaSpend('http://x', '0x' + 'ab'.repeat(32), 3600, down)).toBeNull()
    expect(spendPercent(5n, 10n)).toBe(50)
    expect(spendPercent(50n, 10n)).toBe(100)
    expect(spendPercent(1n, 0n)).toBe(100)
  })

  it('matches x402 endpoint scopes one segment per wildcard', () => {
    expect(matchX402Endpoint(['GET /signals/*'], 'GET', '/signals/0xabc')).toBe('GET /signals/*')
    expect(matchX402Endpoint(['GET /signals/*'], 'GET', '/oracle/sBTC')).toBeNull()
    expect(matchX402Endpoint(['GET /oracle/sBTC'], 'GET', '/oracle/sETH')).toBeNull()
  })

  it('encodes presentation headers as base64url JSON', () => {
    const obj = { a: 'é', b: [1, 2] }
    const h = encodeHeaderJson(obj)
    expect(h).not.toMatch(/[+/=]/)
    expect(decodeHeaderJson(h)).toEqual(obj)
  })

  it('resolves the anchor address from env override (one chain only), else the per-chain table', () => {
    const a = '0x1111111111111111111111111111111111111111'
    expect(getSessionAnchorAddress(31337, a)).toBe(a)
    expect(getSessionAnchorAddress(84532, a), 'override never leaks to another chain').toBe('0x0000000000000000000000000000000000000000')
    expect(getSessionAnchorAddress(84532, a, 84532)).toBe(a)
    expect(sessionAnchorOverrideChainId('')).toBe(31337)
    expect(sessionAnchorOverrideChainId('84532')).toBe(84532)
    expect(sessionAnchorOverrideChainId('x')).toBe(31337)
    expect(isSessionAnchorDeployed(84532, '')).toBe(false)
    expect(getSessionAnchorAddress(null, '')).toBe('0x0000000000000000000000000000000000000000')
    expect(delegationStorageKey(84532, MGR, '0xABC')).toBe(`pepelab:delegation-v3:84532:${MGR}:0xabc`)
    expect(delegationStorageKey(null, MGR, '0xABC')).toBeNull()
  })

  it('checks the anchor before a tx: code present and bound to the expected manager', async () => {
    const mk = (code: string, mgr: string) => ({
      getAddress: async () => '0x2222222222222222222222222222222222222222',
      sessionManager: (async () => mgr) as never,
      runner: { provider: { getCode: async () => code } },
    })
    expect(await sessionAnchorProblem(mk('0x6080', MGR), MGR)).toBeNull()
    expect(await sessionAnchorProblem(mk('0x', MGR), MGR)).toBe('anchor_no_code')
    expect(await sessionAnchorProblem(mk('0x6080', '0x' + '77'.repeat(20)), MGR)).toBe('anchor_wrong_manager')
    expect(await sessionAnchorProblem({ ...mk('0x6080', MGR), runner: null }, MGR)).toBe('anchor_unreadable')
  })

  describe('revocation builds on the published list', () => {
    const user = Wallet.createRandom()
    const jti1 = '0x' + '01'.repeat(32)
    const jti2 = '0x' + '02'.repeat(32)
    const sign = async (previous: Parameters<typeof revocationListFields>[0]['previous'], jti: string) => {
      const fields = revocationListFields({ issuer: user.address, jti, previous, nowSec: NOW })
      const td = statusListTypedData(fields, MGR)
      const signature = await user.signTypedData(td.domain, td.types, td.value)
      return assembleStatusList({ ...fields, issuerAddress: user.address, signature, verifyingContract: MGR })
    }
    const BASE = 'https://status.example/vc'
    const fileOf = `${BASE}/${user.address.toLowerCase()}.json`
    const serve = (files: Record<string, unknown>) =>
      (async (u: string) => (u in files ? new Response(JSON.stringify(files[u])) : new Response('', { status: 404 }))) as typeof fetch

    it('verifies the published list (signature, contract, canonical ids)', async () => {
      const l1 = await sign(null, jti1)
      expect(statusListProblem(l1, user.address, MGR)).toBeNull()
      expect(statusListProblem({ ...l1, sequence: 9 }, user.address, MGR)).toBe('bad_signature')
      expect(statusListProblem(l1, getAddress('0x' + '33'.repeat(20)), MGR)).toBe('bad_signature')
      expect(statusListProblem(l1, user.address, '0x' + '44'.repeat(20))).toBe('wrong_contract')
      expect(statusListProblem({ ...l1, revoked: [jti2, jti1] }, user.address, MGR)).toBe('malformed')
    })

    it('fetches <base>/<issuer>.json; 404 counts as "none" only with the directory marker', async () => {
      const l1 = await sign(null, jti1)
      expect(await fetchPublishedStatusList(BASE, user.address, MGR, serve({ [fileOf]: l1 }))).toEqual({ kind: 'list', list: l1 })
      expect(await fetchPublishedStatusList(BASE + '/', user.address, MGR, serve({ [`${BASE}/index.json`]: { type: 'AgentCredentialStatusDirectory' } }))).toEqual({ kind: 'none' })
      expect((await fetchPublishedStatusList(BASE, user.address, MGR, serve({}))).kind).toBe('unavailable')
      expect((await fetchPublishedStatusList('', user.address, MGR, serve({})))).toEqual({ kind: 'unavailable', reason: 'status_source_unset' })
      expect((await fetchPublishedStatusList(BASE, user.address, MGR, serve({ [fileOf]: { ...l1, sequence: 5 } })))).toEqual({
        kind: 'unavailable',
        reason: 'status_list_bad_signature',
      })
    })

    it('picks the base: published, or a newer local superset; refuses when the published state is unknown', async () => {
      const pub = await sign(null, jti1) // sequence 1 (e.g. signed with the CLI)
      const staleLocal = await sign(null, jti2) // sequence 1, not a superset
      expect(revocationBase({ kind: 'list', list: pub }, staleLocal)).toEqual({ ok: true, previous: pub })
      const newerLocal = await sign(pub, jti2) // sequence 2, carries jti1
      expect(revocationBase({ kind: 'list', list: pub }, newerLocal)).toEqual({ ok: true, previous: newerLocal })
      expect(revocationBase({ kind: 'none' }, null)).toEqual({ ok: true, previous: null })
      expect(revocationBase({ kind: 'unavailable', reason: 'status_fetch_failed' }, newerLocal)).toEqual({ ok: false, reason: 'status_fetch_failed' })
      const next = revocationListFields({ issuer: user.address, jti: jti2, previous: pub, nowSec: NOW })
      expect(next.sequence).toBe(2)
      expect(next.revoked).toEqual([jti1, jti2])
    })
  })
})
