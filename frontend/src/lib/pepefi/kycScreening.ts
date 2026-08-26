// Screening：見 ADR 0004（frontend/docs/adr/0004-screening-recommends-reviewer-decides.md）。
//
// 純函式，只產出**建議**，從不觸碰鏈上狀態——approveKYC／approveKYCBatch 永遠
// 是 Reviewer 按下去的，這裡的輸出只是幫他決定要不要仔細看。
//
// 兩份清單都是刻意虛構的：
//  - 轄區：不模擬任何真實制裁名單，唯一的訊號是「OTHER」——申請人選了平台
//    列不出名字的國家，這是任何 KYC 系統都會轉人工的正當理由，而且不對任何
//    真實國家做出任何宣稱。
//  - 姓名：取自公認的虛構角色（電影/影集），不是任何真人或任何真實制裁名單
//    的片段。與任何真實個人或組織無關。

export type ScreeningVerdict = 'clean' | 'needsReview'

export type ScreeningReasonCode = 'unclearJurisdiction' | 'watchlistNameMatch'

export interface ScreeningResult {
  verdict: ScreeningVerdict
  reasons: ScreeningReasonCode[]
}

/** 虛構的轄區訊號：申請人選了「OTHER」（列表列不出的國家）。不是制裁名單。 */
const UNCLEAR_JURISDICTIONS: readonly string[] = ['OTHER']

/**
 * 虛構的姓名 watchlist。取材自知名虛構角色，刻意選一眼就看得出是假的名字，
 * 與任何真實制裁名單、真實人物皆無關——見 ADR 0004。
 */
export const FICTIONAL_WATCHLIST_NAMES: readonly string[] = [
  'Norman Bates',
  'Walter White',
  'Tony Soprano',
  'Keyser Söze',
  'Hannibal Lecter',
]

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

const NORMALIZED_WATCHLIST = new Set(FICTIONAL_WATCHLIST_NAMES.map(normalizeName))

export function screenApplication(input: { fullName: string; nationality: string }): ScreeningResult {
  const reasons: ScreeningReasonCode[] = []

  if (UNCLEAR_JURISDICTIONS.includes(input.nationality)) {
    reasons.push('unclearJurisdiction')
  }
  if (NORMALIZED_WATCHLIST.has(normalizeName(input.fullName))) {
    reasons.push('watchlistNameMatch')
  }

  return { verdict: reasons.length > 0 ? 'needsReview' : 'clean', reasons }
}
