import fs from 'node:fs'
import path from 'node:path'
import { ethers } from 'ethers'
import { fileURLToPath } from 'node:url'
import { it, expect, describe } from 'vitest'

import { resolveVcKycRegistry } from 'src/contracts/vcKycRegistry'
import {
  ATTESTATION_TYPES,
  vcKycDomain,
  CREDENTIAL_TYPE_IDS,
  buildAttestationValue,
  ATTESTATION_TYPE_STRING,
  INVESTOR_STATUS_LIST_TYPES,
  assembleInvestorCredential,
  assembleInvestorStatusList,
  buildInvestorStatusListValue,
  type InvestorCredential,
  type VerifiedInvestorCredential,
} from 'src/contracts/investorCredential'

import {
  submitBlocker,
  statusFromListDoc,
  isAllowedStatusUrl,
  fetchCredentialStatus,
  verifyPastedCredential,
} from './investorCredentialCheck'

// ----------------------------------------------------------------------

const CHAIN = 31337
const REGISTRY = ethers.getAddress(`0x${'c0'.repeat(20)}`)
const issuer = ethers.Wallet.createRandom()
const mallory = ethers.Wallet.createRandom()
const investor = ethers.Wallet.createRandom()
const NOW = Math.floor(Date.now() / 1000)
const T = ATTESTATION_TYPES as Record<string, ethers.TypedDataField[]>
const LT = INVESTOR_STATUS_LIST_TYPES as Record<string, ethers.TypedDataField[]>

async function makeVc(signer = issuer, o: Partial<{ nonce: number; issuedAt: number }> = {}): Promise<InvestorCredential> {
  const id = `urn:uuid:${crypto.randomUUID()}`
  const issuedAt = o.issuedAt ?? NOW
  const value = buildAttestationValue({
    subject: investor.address,
    credentialType: 'QUALIFIED_INVESTOR',
    credentialHash: ethers.id(id),
    statusListIndex: 0,
    issuedAt,
    expiresAt: issuedAt + 365 * 86400,
    nonce: o.nonce ?? 0,
    deadline: issuedAt + 30 * 86400,
  })
  const domain = vcKycDomain(CHAIN, REGISTRY)
  const signature = await signer.signTypedData(domain, T, value)
  return assembleInvestorCredential({
    id,
    issuer: signer.address,
    value,
    credentialType: 'QUALIFIED_INVESTOR',
    domain,
    signature,
    statusBaseUrl: 'https://status.example.com/investor',
  })
}

async function makeList(revoked: string[], sequence = 1, signer = issuer) {
  const fields = { issuer: signer.address, sequence, issuedAt: NOW, validUntil: NOW + 30 * 86400, revokedBefore: 0, revoked }
  const domain = vcKycDomain(CHAIN, REGISTRY)
  const signature = await signer.signTypedData(domain, LT, buildInvestorStatusListValue(fields))
  return assembleInvestorStatusList({ ...fields, domain, signature })
}

const verified = async (vc: InvestorCredential): Promise<VerifiedInvestorCredential> => {
  const r = verifyPastedCredential(JSON.stringify(vc))
  if (!r.valid) throw new Error(r.reason)
  return r
}

describe('investorCredential schema', () => {
  it('EIP-712 type string 與類型 id 與 VCKycRegistry.sol 一致', () => {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const sol = fs.readFileSync(path.resolve(here, '../../../../contracts/src/VCKycRegistry.sol'), 'utf8')
    expect(sol).toContain(`"${ATTESTATION_TYPE_STRING}"`)
    expect(ethers.TypedDataEncoder.from(T).encodeType('QualifiedInvestorAttestation')).toBe(ATTESTATION_TYPE_STRING)
    expect(CREDENTIAL_TYPE_IDS.QUALIFIED_INVESTOR).toBe(ethers.id('QUALIFIED_INVESTOR'))
    expect(CREDENTIAL_TYPE_IDS.KYC_BASIC).toBe(ethers.id('KYC_BASIC'))
  })
})

describe('verifyPastedCredential', () => {
  it('發證者簽的 VC 驗得過，並帶出資格與到期', async () => {
    const vc = await makeVc()
    const r = verifyPastedCredential(JSON.stringify(vc), { expectedRegistry: REGISTRY, expectedChainId: CHAIN })
    expect(r.valid).toBe(true)
    if (!r.valid) return
    expect(r.issuer).toBe(issuer.address)
    expect(r.subject).toBe(investor.address)
    expect(r.credentialType).toBe('QUALIFIED_INVESTOR')
    expect(r.expiresAt - r.issuedAt).toBe(365 * 86400)
  })

  it('竄改、錯 registry、壞 JSON 都被拒', async () => {
    const vc = await makeVc()
    const tampered = { ...vc, validUntil: new Date((NOW + 9 * 365 * 86400) * 1000).toISOString() }
    expect(verifyPastedCredential(JSON.stringify(tampered))).toMatchObject({ valid: false, reasonCode: 'VC_BAD_SIGNATURE' })
    const other = ethers.getAddress(`0x${'c1'.repeat(20)}`)
    expect(verifyPastedCredential(JSON.stringify(vc), { expectedRegistry: other })).toMatchObject({
      valid: false,
      reasonCode: 'VC_WRONG_DOMAIN',
    })
    expect(verifyPastedCredential('{oops')).toMatchObject({ valid: false, reasonCode: 'VC_MALFORMED' })
    expect(verifyPastedCredential(JSON.stringify({ ...vc, id: 'urn:x' }))).toMatchObject({
      valid: false,
      reasonCode: 'VC_HASH_MISMATCH',
    })
  })
})

describe('撤銷狀態', () => {
  it('清單有這張 → revoked；沒有 → active；別人簽的清單 → unknown', async () => {
    const vc = await verified(await makeVc())
    expect(statusFromListDoc(vc, await makeList([vc.credentialHash]))).toMatchObject({ status: 'revoked' })
    expect(statusFromListDoc(vc, await makeList([]))).toMatchObject({ status: 'active' })
    expect(statusFromListDoc(vc, await makeList([], 1, mallory))).toMatchObject({ status: 'unknown' })
  })

  it('fetch：404 = 沒有撤銷；500／壞網址 = 不明；清單撤銷 = revoked', async () => {
    const doc = await makeVc()
    const vc = await verified(doc)
    const res = (status: number, body = '') => new Response(body, { status })
    expect(await fetchCredentialStatus(vc, doc, async () => res(404))).toMatchObject({ status: 'active' })
    expect(await fetchCredentialStatus(vc, doc, async () => res(500))).toMatchObject({ status: 'unknown' })
    const list = await makeList([vc.credentialHash])
    expect(await fetchCredentialStatus(vc, doc, async () => res(200, JSON.stringify(list)))).toMatchObject({
      status: 'revoked',
    })
    const bad = { ...doc, credentialStatus: { ...doc.credentialStatus, statusListCredential: 'http://evil.example/x.json' } }
    expect(await fetchCredentialStatus(vc, bad, async () => res(404))).toMatchObject({ status: 'unknown' })
    expect(isAllowedStatusUrl('http://127.0.0.1:8080/x.json')).toBe(true)
    expect(isAllowedStatusUrl('https://status.example.invalid/x.json')).toBe(false)
  })
})

describe('submitBlocker', () => {
  const base = {
    issuerTrusted: true,
    revokedOnChain: false,
    submitted: false,
    subjectNonce: 0n,
    registeredValid: false,
    registeredExpiresAt: 0,
    isVerified: false,
  }
  it('鏈上條件不符時給出原因；全部符合回 null', async () => {
    const vc = await verified(await makeVc())
    expect(submitBlocker(vc, base, CHAIN)).toBeNull()
    expect(submitBlocker(vc, base, 84532)).toMatch(/chainId 31337/)
    expect(submitBlocker(vc, { ...base, issuerTrusted: false }, CHAIN)).toMatch(/受信任/)
    expect(submitBlocker(vc, { ...base, revokedOnChain: true }, CHAIN)).toMatch(/撤銷/)
    expect(submitBlocker(vc, { ...base, submitted: true }, CHAIN)).toMatch(/登記過/)
    expect(submitBlocker(vc, { ...base, subjectNonce: 1n }, CHAIN)).toMatch(/nonce/)
    expect(submitBlocker(vc, base, CHAIN, vc.deadline + 1)).toMatch(/期限/)
  })
})

describe('registry 位址', () => {
  it('env 優先；沒有設定時回 null（前端降級為「尚未啟用」）', () => {
    expect(resolveVcKycRegistry(31337, REGISTRY)).toBe(REGISTRY)
    expect(resolveVcKycRegistry(84532, '')).toBeNull()
    expect(resolveVcKycRegistry(null, undefined)).toBeNull()
    expect(resolveVcKycRegistry(31337, '0x0000000000000000000000000000000000000000')).toBeNull()
    expect(resolveVcKycRegistry(31337, 'not-an-address')).toBeNull()
  })
})
