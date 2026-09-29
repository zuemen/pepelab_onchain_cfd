// KYC 視窗開啟時「能不能再送一次」的判斷（純函式，可測）。
//
// 原則：讀取出錯一律 fail-closed（checkFailed，停用送出鍵並提供重試）。
// 只有「確定函式不存在」（舊版 KYCRegistry 沒有 isPending：CALL_EXCEPTION 且 revert
// data 為空）才走舊版合約的退回路徑——用 isVerified 確認合約可讀後放行，因為那一版
// 沒有審核佇列，submitKYC 上鏈即完成。429、逾時、斷線這類暫時錯誤絕不能被當成
// 「函式不存在」而放行。

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown }

export async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * ethers v6 對「合約沒有這個函式」的呈現：eth_call 成功回傳空資料，解碼失敗成
 * CALL_EXCEPTION，且 revert data 為空（null／undefined／'0x'）。有 revert data 的
 * CALL_EXCEPTION 是合約真的 revert，其他 code（SERVER_ERROR、TIMEOUT、NETWORK_ERROR…）
 * 是暫時錯誤——都不算「函式不存在」。
 */
export function isMissingFunctionError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const err = e as { code?: unknown; data?: unknown }
  if (err.code !== 'CALL_EXCEPTION') return false
  return err.data === null || err.data === undefined || err.data === '0x'
}

export type KycSubmitGate =
  | { kind: 'clear' }
  | { kind: 'blocked'; reason: 'unconfirmed' | 'underReview' }
  | { kind: 'checkFailed'; reason: string }

const reasonOf = (e: unknown): string =>
  e instanceof Error ? e.message.slice(0, 160) : String(e ?? 'unknown error').slice(0, 160)

export interface KycSubmitGateInput {
  /** 收據位置（使用者位址等）。value null＝沒有 signer（送不出交易，也就沒有重送的風險）。 */
  location: Settled<unknown | null>
  /** history 最新一筆收據；沒有就是 null。 */
  latestReceipt: { txHash: string | null } | null
  /** getTransactionReceipt 的結果（有 txHash 才需要）。 */
  receiptLookup?: Settled<{ status: number | null } | null>
  /** 交易成功時查 isPending(user) 的結果。 */
  isPendingResult?: Settled<boolean>
  /** isPending 確定不存在時查 isVerified(user) 的結果。 */
  isVerifiedResult?: Settled<boolean>
}

export function decideKycSubmitGate(i: KycSubmitGateInput): KycSubmitGate {
  if (!i.location.ok) return { kind: 'checkFailed', reason: reasonOf(i.location.error) }
  if (i.location.value === null) return { kind: 'clear' }
  if (!i.latestReceipt?.txHash) return { kind: 'clear' }

  if (!i.receiptLookup) return { kind: 'checkFailed', reason: 'receipt not checked' }
  if (!i.receiptLookup.ok) return { kind: 'checkFailed', reason: reasonOf(i.receiptLookup.error) }
  const rc = i.receiptLookup.value
  if (rc === null) return { kind: 'blocked', reason: 'unconfirmed' }
  if (rc.status === 0) return { kind: 'clear' }
  if (rc.status !== 1) return { kind: 'checkFailed', reason: `unexpected receipt status ${String(rc.status)}` }

  // 交易成功：鏈上仍待審就不能重送；已核准或已撤銷才放行（撤銷後需要能重新申請）。
  if (!i.isPendingResult) return { kind: 'checkFailed', reason: 'isPending not checked' }
  if (i.isPendingResult.ok) {
    return i.isPendingResult.value ? { kind: 'blocked', reason: 'underReview' } : { kind: 'clear' }
  }
  if (!isMissingFunctionError(i.isPendingResult.error)) {
    return { kind: 'checkFailed', reason: reasonOf(i.isPendingResult.error) }
  }
  // 舊版合約：isPending 確定不存在 → 用 isVerified 確認合約可讀後放行。
  if (!i.isVerifiedResult) return { kind: 'checkFailed', reason: 'isVerified not checked' }
  if (!i.isVerifiedResult.ok) return { kind: 'checkFailed', reason: reasonOf(i.isVerifiedResult.error) }
  return { kind: 'clear' }
}
