import { describe, it, expect } from 'vitest'

import { latestSubmissionByAddress, bucketOf } from './kycQueue'

describe('latestSubmissionByAddress', () => {
  it('keeps the highest blockNumber entry when an address submitted more than once', () => {
    const logs = [
      { user: '0xAbC', blockNumber: 10, transactionHash: '0xfirst' },
      { user: '0xabc', blockNumber: 20, transactionHash: '0xsecond' },
    ]
    const out = latestSubmissionByAddress(logs)
    expect(out.size).toBe(1)
    expect(out.get('0xabc')?.transactionHash).toBe('0xsecond')
  })

  it('normalises addresses to lowercase as map keys', () => {
    const logs = [{ user: '0xAbC', blockNumber: 1, transactionHash: '0xtx' }]
    const out = latestSubmissionByAddress(logs)
    expect(out.has('0xabc')).toBe(true)
    expect(out.has('0xAbC')).toBe(false)
  })

  it('keeps separate entries for different addresses', () => {
    const logs = [
      { user: '0xAAA', blockNumber: 1, transactionHash: '0xa' },
      { user: '0xBBB', blockNumber: 2, transactionHash: '0xb' },
    ]
    const out = latestSubmissionByAddress(logs)
    expect(out.size).toBe(2)
  })

  it('returns an empty map for no logs', () => {
    expect(latestSubmissionByAddress([]).size).toBe(0)
  })

  it('does not let an earlier log overwrite a later one regardless of array order', () => {
    const logs = [
      { user: '0xabc', blockNumber: 20, transactionHash: '0xsecond' },
      { user: '0xabc', blockNumber: 10, transactionHash: '0xfirst' },
    ]
    const out = latestSubmissionByAddress(logs)
    expect(out.get('0xabc')?.transactionHash).toBe('0xsecond')
  })

  it('keeps the later-in-array entry when two submissions land in the same block', () => {
    // queryFilter returns logs in ascending log-index order within a block,
    // so the second entry here is the true latest submission.
    const logs = [
      { user: '0xabc', blockNumber: 5, transactionHash: '0xearlier-in-block' },
      { user: '0xabc', blockNumber: 5, transactionHash: '0xlater-in-block' },
    ]
    const out = latestSubmissionByAddress(logs)
    expect(out.get('0xabc')?.transactionHash).toBe('0xlater-in-block')
  })
})

describe('bucketOf', () => {
  it('is verified when verified=true, regardless of pending', () => {
    expect(bucketOf({ verified: true, pending: false })).toBe('verified')
    expect(bucketOf({ verified: true, pending: true })).toBe('verified')
  })

  it('is pending when not verified but still pending', () => {
    expect(bucketOf({ verified: false, pending: true })).toBe('pending')
  })

  it('is revoked when neither verified nor pending — the only reachable path is revokeKYC', () => {
    expect(bucketOf({ verified: false, pending: false })).toBe('revoked')
  })
})
