import { Wallet, id as keccakId, verifyTypedData, TypedDataEncoder } from 'ethers'
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
import { getSessionAnchorAddress, isSessionAnchorDeployed } from 'src/contracts/sessionCredentialAnchor'

import {
  spendPercent,
  usdcToAtomic,
  fetchKyaSpend,
  credentialHash,
  DEFAULT_X402_FORM,
  delegationTypedData,
  statusListTypedData,
  buildFieldsForSession,
  revocationListFields,
  delegationStorageKey,
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

  it('resolves the anchor address from env override, else the per-chain table', () => {
    const a = '0x1111111111111111111111111111111111111111'
    expect(getSessionAnchorAddress(84532, a)).toBe(a)
    expect(isSessionAnchorDeployed(84532, '')).toBe(false)
    expect(getSessionAnchorAddress(null, '')).toBe('0x0000000000000000000000000000000000000000')
    expect(delegationStorageKey(84532, MGR, '0xABC')).toBe(`pepelab:delegation-v3:84532:${MGR}:0xabc`)
    expect(delegationStorageKey(null, MGR, '0xABC')).toBeNull()
  })
})
