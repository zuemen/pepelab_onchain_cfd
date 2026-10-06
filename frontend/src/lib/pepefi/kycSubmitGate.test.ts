import { it, expect, describe } from 'vitest'

import { decideKycSubmitGate, isMissingFunctionError, kycOutcomeAfterSubmit, kycRegistryModeFromProbe, type KycSubmitGateInput } from './kycSubmitGate'

const ok = <T,>(value: T) => ({ ok: true as const, value })
const fail = (error: unknown) => ({ ok: false as const, error })

const LOC = ok({ user: '0xabc' })
const LATEST = { txHash: '0x' + '1'.repeat(64) }
/** ethers v6 對「函式不存在」的錯誤：CALL_EXCEPTION、revert data 為空。 */
const missingFn = Object.assign(new Error('missing revert data'), { code: 'CALL_EXCEPTION', data: null })
const rateLimited = Object.assign(new Error('429 Too Many Requests'), { code: 'SERVER_ERROR' })
const timeout = Object.assign(new Error('request timeout'), { code: 'TIMEOUT' })

const gate = (i: Partial<KycSubmitGateInput>) =>
  decideKycSubmitGate({ location: LOC, latestReceipt: LATEST, ...i })

describe('decideKycSubmitGate', () => {
  it('沒有上一筆收據：放行', () => {
    expect(gate({ latestReceipt: null })).toEqual({ kind: 'clear' })
  })

  it('沒有 signer（location 為 null）：放行（送不出交易，也就沒有重送風險）', () => {
    expect(gate({ location: ok(null) })).toEqual({ kind: 'clear' })
  })

  it('receiptLocation 查詢失敗：checkFailed', () => {
    expect(gate({ location: fail(new Error('network down')) }).kind).toBe('checkFailed')
  })

  it('receipt 為 null（尚未確認）：blocked', () => {
    expect(gate({ receiptLookup: ok(null) })).toEqual({ kind: 'blocked', reason: 'unconfirmed' })
  })

  it('receipt status 0（交易失敗）：放行', () => {
    expect(gate({ receiptLookup: ok({ status: 0 }) })).toEqual({ kind: 'clear' })
  })

  it('receipt status 1 且仍待審：blocked', () => {
    expect(gate({ receiptLookup: ok({ status: 1 }), isPendingResult: ok(true) }))
      .toEqual({ kind: 'blocked', reason: 'underReview' })
  })

  it('receipt status 1 且已不在待審（核准或撤銷）：放行', () => {
    expect(gate({ receiptLookup: ok({ status: 1 }), isPendingResult: ok(false) })).toEqual({ kind: 'clear' })
  })

  it('receipt 查詢失敗：checkFailed', () => {
    expect(gate({ receiptLookup: fail(rateLimited) }).kind).toBe('checkFailed')
  })

  it('isPending 確定不存在（舊版合約）且 isVerified 可讀：放行', () => {
    expect(gate({ receiptLookup: ok({ status: 1 }), isPendingResult: fail(missingFn), isVerifiedResult: ok(false) }))
      .toEqual({ kind: 'clear' })
  })

  it('isPending 不存在但 isVerified 也讀不到：checkFailed', () => {
    expect(gate({ receiptLookup: ok({ status: 1 }), isPendingResult: fail(missingFn), isVerifiedResult: fail(timeout) }).kind)
      .toBe('checkFailed')
  })

  it('isPending 暫時錯誤（429／逾時）：checkFailed，不可放行', () => {
    for (const e of [rateLimited, timeout]) {
      expect(gate({ receiptLookup: ok({ status: 1 }), isPendingResult: fail(e), isVerifiedResult: ok(false) }).kind)
        .toBe('checkFailed')
    }
  })

  it('isPending 真的 revert（有 revert data）也不是「函式不存在」：checkFailed', () => {
    const reverted = Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: '0x08c379a0' })
    expect(gate({ receiptLookup: ok({ status: 1 }), isPendingResult: fail(reverted), isVerifiedResult: ok(true) }).kind)
      .toBe('checkFailed')
  })
})

describe('isMissingFunctionError', () => {
  it('只有 CALL_EXCEPTION 且 revert data 為空才算', () => {
    expect(isMissingFunctionError(missingFn)).toBe(true)
    expect(isMissingFunctionError({ code: 'CALL_EXCEPTION', data: '0x' })).toBe(true)
    expect(isMissingFunctionError({ code: 'CALL_EXCEPTION' })).toBe(true)
    expect(isMissingFunctionError({ code: 'CALL_EXCEPTION', data: '0x08c379a0' })).toBe(false)
    expect(isMissingFunctionError(rateLimited)).toBe(false)
    expect(isMissingFunctionError(new Error('x'))).toBe(false)
    expect(isMissingFunctionError(null)).toBe(false)
  })
})

describe('kycOutcomeAfterSubmit', () => {
  it('送出後鏈上已是 verified（線上自助驗證版 KYCRegistry）：顯示已通過', () => {
    expect(kycOutcomeAfterSubmit(true)).toBe('verified')
  })

  it('送出後仍未 verified（審核制）：顯示待審核', () => {
    expect(kycOutcomeAfterSubmit(false)).toBe('awaitingReview')
  })

  it('讀不到（null）：不放大成已通過，維持待審核', () => {
    expect(kycOutcomeAfterSubmit(null)).toBe('awaitingReview')
  })
})

describe('kycRegistryModeFromProbe', () => {
  it('isPending 讀得到：審核制', () => {
    expect(kycRegistryModeFromProbe(ok(false))).toBe('review')
  })

  it('isPending 不存在（線上舊版）：自助驗證', () => {
    expect(kycRegistryModeFromProbe(fail(missingFn))).toBe('selfService')
  })

  it('限流／逾時：unknown，不宣稱送出即通過', () => {
    expect(kycRegistryModeFromProbe(fail(rateLimited))).toBe('unknown')
    expect(kycRegistryModeFromProbe(fail(timeout))).toBe('unknown')
  })
})
