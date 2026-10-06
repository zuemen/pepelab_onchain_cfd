// 瀏覽器端的合格投資人 VC 檢查 —— docs/SSI_RWA_ACCESS.md §6。
//
// 驗證邏輯本身在 src/contracts/investorCredential.ts（與 agent/issuer 的發證服務同一份），
// 這裡只注入 ethers 並補上「讀狀態清單」與「讀鏈上資格」兩段。
//
// 這裡的檢查都是**預檢**：讓投資人在送交易前就知道 VC 有沒有問題。真正的閘門在鏈上——
// VCKycRegistry.submitAttestation 再驗一次簽章、信任與撤銷；exchange 開倉時呼叫 isVerified。

import { ethers } from 'ethers'

import { t, interpolate } from 'src/locales'

import {
  INVESTOR_STATUS_TYPE,
  isInvestorCredentialRevoked,
  verifyInvestorCredentialWith,
  verifyInvestorStatusListWith,
  type Eip712Crypto,
  type InvestorVcVerifyResult,
  type VerifiedInvestorCredential,
  type VerifyInvestorVcOptions,
} from 'src/contracts/investorCredential'

type Fields = Record<string, ethers.TypedDataField[]>

export const ETHERS_CRYPTO: Eip712Crypto = {
  id: (t) => ethers.id(t),
  getAddress: (a) => ethers.getAddress(a),
  verifyTypedData: (d, t, v, s) => ethers.verifyTypedData(d, t as Fields, v, s),
  hashTypedData: (d, t, v) => ethers.TypedDataEncoder.hash(d, t as Fields, v),
}

/** 解析貼上的文字並驗證。JSON 壞掉也回結構化的失敗。 */
export function verifyPastedCredential(text: string, opts: VerifyInvestorVcOptions = {}): InvestorVcVerifyResult {
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return { valid: false, reasonCode: 'VC_MALFORMED', reason: t.investorVc.status.notJson }
  }
  return verifyInvestorCredentialWith(ETHERS_CRYPTO, doc, opts)
}

export type StatusCheck =
  | { status: 'active'; message: string; sequence?: number }
  | { status: 'revoked'; message: string; sequence: number }
  | { status: 'unknown'; message: string }

/** 單份清單對單張 VC 的判斷（不含 agent 端的防重放記憶；瀏覽器每次重新讀取）。 */
export function statusFromListDoc(vc: VerifiedInvestorCredential, doc: unknown, nowMs = Date.now()): StatusCheck {
  const v = verifyInvestorStatusListWith(ETHERS_CRYPTO, doc, {
    now: nowMs,
    expectedIssuer: vc.issuer,
    expectedChainId: vc.domain.chainId,
    expectedRegistry: vc.domain.verifyingContract,
  })
  if (!v.valid) return { status: 'unknown', message: interpolate(t.investorVc.status.listInvalid, { code: v.reasonCode, reason: v.reason }) }
  if (isInvestorCredentialRevoked(vc, v.list)) {
    return {
      status: 'revoked',
      message: interpolate(t.investorVc.status.revoked, { sequence: v.list.sequence }),
      sequence: v.list.sequence,
    }
  }
  return {
    status: 'active',
    message: interpolate(t.investorVc.status.active, { sequence: v.list.sequence }),
    sequence: v.list.sequence,
  }
}

/** 只允許 https，或本機 http（PoC）。 */
export function isAllowedStatusUrl(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'https:') return !u.hostname.endsWith('.invalid')
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)
  } catch {
    return false
  }
}

const MAX_LIST_BYTES = 256 * 1024

/** 依 VC 的 credentialStatus 取狀態清單：404＝發證者沒有發佈清單（沒有撤銷）；其他失敗＝狀態不明。 */
export async function fetchCredentialStatus(
  vc: VerifiedInvestorCredential,
  doc: { credentialStatus?: { type?: string; statusListCredential?: string } },
  fetchImpl: typeof fetch = fetch,
  nowMs = Date.now()
): Promise<StatusCheck> {
  const st = doc.credentialStatus
  if (!st || st.type !== INVESTOR_STATUS_TYPE || typeof st.statusListCredential !== 'string') {
    return { status: 'unknown', message: t.investorVc.status.noStatus }
  }
  const url = st.statusListCredential
  if (!isAllowedStatusUrl(url)) {
    return { status: 'unknown', message: interpolate(t.investorVc.status.badUrl, { url }) }
  }
  try {
    const res = await fetchImpl(url, { redirect: 'manual', cache: 'no-store' })
    if (res.status === 404) return { status: 'active', message: t.investorVc.status.noList }
    if (!res.ok) return { status: 'unknown', message: interpolate(t.investorVc.status.httpError, { status: res.status }) }
    const text = await res.text()
    if (text.length > MAX_LIST_BYTES) return { status: 'unknown', message: t.investorVc.status.tooLarge }
    return statusFromListDoc(vc, JSON.parse(text), nowMs)
  } catch (e) {
    return { status: 'unknown', message: interpolate(t.investorVc.status.fetchFailed, { reason: (e as Error).message }) }
  }
}

export interface OnchainEligibility {
  issuerTrusted: boolean
  revokedOnChain: boolean
  submitted: boolean
  subjectNonce: bigint
  /** 目前鏈上登記的同類型憑證是否有效、何時到期（0 = 沒有）。 */
  registeredValid: boolean
  registeredExpiresAt: number
  isVerified: boolean
}

/**
 * 送出前要先排除的狀況（給按鈕 disable 與提示用）。null = 可以送。
 * 連線的錢包不必是 VC 的 subject：任何人都可以代送，資格記在 subject 上。
 */
export function submitBlocker(
  vc: VerifiedInvestorCredential,
  chain: OnchainEligibility,
  chainId: number | null,
  nowSec = Math.floor(Date.now() / 1000)
): string | null {
  if (chainId !== null && chainId !== vc.domain.chainId) {
    return interpolate(t.investorVc.blocker.wrongChain, { chainId: vc.domain.chainId })
  }
  if (!chain.issuerTrusted) return t.investorVc.blocker.untrusted
  if (chain.revokedOnChain) return t.investorVc.blocker.revokedOnChain
  if (chain.submitted) return t.investorVc.blocker.submitted
  if (BigInt(vc.nonce) !== chain.subjectNonce) {
    return interpolate(t.investorVc.blocker.nonce, { vc: vc.nonce, chain: chain.subjectNonce.toString() })
  }
  if (nowSec > vc.deadline) return t.investorVc.blocker.deadline
  return null
}
