import { Wallet, verifyTypedData } from 'ethers'
import { it, expect, describe } from 'vitest'

import {
  AUTH_TYPES_V2,
  authDomainV2,
  newAuthNonce,
  authVcVersion,
  defaultValidUntil,
  buildAuthTypedValueV2,
  assembleAuthorizationVC,
  DEFAULT_VC_VALIDITY_SEC,
} from './agentAuth'

const MGR = '0x5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e'

describe('agentAuth v2 issuance (SessionsPage path)', () => {
  it('signs a v2 VC bound to the session manager, with validUntil and nonce', async () => {
    const user = Wallet.createRandom()
    const agent = Wallet.createRandom()
    const issuedAt = 1_790_000_000
    const caps = { maxMarginPerTrade: '50', totalBudget: '1000', maxLeverage: 5, expiry: issuedAt + 30 * 86400 }
    const validUntil = defaultValidUntil(issuedAt, caps.expiry)
    const nonce = newAuthNonce()
    const value = buildAuthTypedValueV2({
      issuer: user.address, agent: agent.address, sessionId: 3, caps, issuedAt, validUntil, nonce,
    })
    const signature = await user.signTypedData(authDomainV2(MGR), AUTH_TYPES_V2, value)
    const vc = assembleAuthorizationVC({
      issuerAddress: user.address, agentAddress: agent.address, sessionId: 3, caps, issuedAt, signature,
      v2: { validUntil, nonce, verifyingContract: MGR },
    })

    expect(authVcVersion(vc)).toBe(2)
    expect(vc.proof.eip712Domain).toEqual({ version: '2', verifyingContract: MGR })
    expect(vc.credentialSubject.nonce).toMatch(/^0x[0-9a-f]{64}$/)
    expect(vc.credentialSubject.validUntil).toBe(issuedAt + DEFAULT_VC_VALIDITY_SEC)
    expect(vc.expirationDate).toBe(new Date(validUntil * 1000).toISOString())
    expect(vc['@context'][1]).toContain('/v2')
    expect(verifyTypedData(authDomainV2(MGR), AUTH_TYPES_V2, value, signature)).toBe(user.address)
  })

  it('validUntil: default 30 days, configurable, never exceeds the session expiry; nonces are unique', () => {
    expect(DEFAULT_VC_VALIDITY_SEC).toBe(30 * 86400)
    expect(defaultValidUntil(1000, 2000)).toBe(2000)
    expect(defaultValidUntil(0, 10 ** 10)).toBe(30 * 86400)
    expect(defaultValidUntil(0, 10 ** 10, 3 * 86400)).toBe(3 * 86400)
    expect(defaultValidUntil(0, 10 ** 10, 0)).toBe(30 * 86400)
    expect(newAuthNonce()).not.toBe(newAuthNonce())
  })
})
