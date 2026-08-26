// Review Queue 的純邏輯——見 ADR 0005（frontend/docs/adr/0005-review-queue-rebuilt-from-events.md）。
//
// 兩件事分開成純函式，因為兩者都容易做錯，也都值得直接測：
//  1. 同一位址可能送過不只一次申請，佇列只在乎最新一筆代表這個人。
//  2. 分桶用即時鏈上讀取（verified / pending），不是從 KYCVerified /
//     KYCRevoked 事件回推——順序反過來或漏掉一個事件，桶就會分錯。

export type ReviewBucket = 'pending' | 'verified' | 'revoked'

export interface SubmittedLog {
  user:            string
  blockNumber:     number
  transactionHash: string
}

/**
 * 依位址去重，同一位址只留最新一筆申請紀錄。
 * 位址統一轉小寫比較，回傳的 key 也是小寫。
 *
 * 用 `>=` 而不是 `>`：同一位址在同一個 block 裡送兩次申請時（快速重送、或
 * Anvil 這種瞬間出塊的鏈上很容易發生），queryFilter 回傳的 log 順序是該
 * block 內的 log index 遞增序——用 `>=` 讓後出現的那筆覆蓋前一筆，才會留下
 * 真正最新的一筆；`>` 會讓同一塊裡先出現的那筆卡住，覆蓋不了。
 */
export function latestSubmissionByAddress(logs: readonly SubmittedLog[]): Map<string, SubmittedLog> {
  const out = new Map<string, SubmittedLog>()
  for (const log of logs) {
    const addr = log.user.toLowerCase()
    const prev = out.get(addr)
    if (!prev || log.blockNumber >= prev.blockNumber) out.set(addr, { ...log, user: addr })
  }
  return out
}

/**
 * 分桶規則，直接對應 KYCRegistry 的狀態機：
 *  - verified=true              → verified（approveKYC 之後）
 *  - verified=false, pending=true → pending（送出後尚未被審核）
 *  - verified=false, pending=false → revoked（唯一會走到這裡的路徑是
 *    revokeKYC——送過申請的位址不會無緣無故兩者皆 false）
 */
export function bucketOf(status: { verified: boolean; pending: boolean }): ReviewBucket {
  if (status.verified) return 'verified'
  if (status.pending) return 'pending'
  return 'revoked'
}
