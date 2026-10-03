import { Wallet, verifyTypedData, TypedDataEncoder } from 'ethers'
import { it, expect, describe } from 'vitest'

import { AUTH_TYPES_V2 } from './agentAuth'
import {
  STATUS_LIST_TYPES,
  statusListDomain,
  assembleStatusList,
  canonicalRevokedIds,
  isCanonicalRevokedIds,
  buildStatusListTypedValue,
} from './agentAuthStatus'

const MGR = '0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e'
const ID_A = '0x' + 'ab'.repeat(32)
const ID_B = '0x' + '0c'.repeat(32)

describe('agentAuthStatus (ADR-016 status list schema)', () => {
  it('signs a status list in the same domain as the v2 VC, with a distinct primary type', async () => {
    const user = Wallet.createRandom()
    const fields = {
      issuer: user.address,
      sequence: 3,
      issuedAt: 1_790_000_000,
      validUntil: 1_790_000_000 + 30 * 86400,
      revokedBefore: 0,
      revoked: canonicalRevokedIds([ID_A.toUpperCase().replace('0X', '0x'), ID_B, ID_A]),
    }
    expect(fields.revoked).toEqual([ID_B, ID_A])
    const value = buildStatusListTypedValue(fields)
    const signature = await user.signTypedData(statusListDomain(MGR), STATUS_LIST_TYPES, value)
    expect(verifyTypedData(statusListDomain(MGR), STATUS_LIST_TYPES, value, signature)).toBe(user.address)

    // A list signature can never be mistaken for a VC: different struct hash in the same domain.
    const listHash = TypedDataEncoder.hashStruct('AgentCredentialStatusList', STATUS_LIST_TYPES, value)
    expect(Object.keys(AUTH_TYPES_V2)).not.toContain('AgentCredentialStatusList')
    expect(listHash).toMatch(/^0x[0-9a-f]{64}$/)

    const doc = assembleStatusList({ ...fields, issuerAddress: user.address, signature, verifyingContract: MGR })
    expect(doc.issuer).toBe(`did:pkh:eip155:84532:${user.address}`)
    expect(doc.proof.eip712Domain).toEqual({ version: '2', verifyingContract: MGR })
    expect(doc.proof.created).toBe(new Date(fields.issuedAt * 1000).toISOString())
  })

  it('accepts only lowercase, strictly ascending bytes32 ids', () => {
    expect(isCanonicalRevokedIds([ID_B, ID_A])).toBe(true)
    expect(isCanonicalRevokedIds([ID_A, ID_B])).toBe(false)
    expect(isCanonicalRevokedIds([ID_A, ID_A])).toBe(false)
    expect(isCanonicalRevokedIds([ID_A.toUpperCase()])).toBe(false)
    expect(() => canonicalRevokedIds(['0x1234'])).toThrow()
  })
})
