import type { ContractRunner } from 'ethers'

import { Contract } from 'ethers'
import { useState, useEffect, useCallback } from 'react'

import { withRetry } from 'src/lib/pepefi/rpcBatch'
import { settle, isMissingFunctionError } from 'src/lib/pepefi/kycSubmitGate'
import { getVcKycSource, type VcKycSource } from 'src/contracts/vcKycRegistry'

// ----------------------------------------------------------------------

/**
 * 這個部署的 VC 准入登錄（VCKycRegistry）位址。
 *
 *   vc       ：確定是 VC 登錄（env／表，或專屬租戶的 KYCRegistry 探測 requiredType() 成功）
 *   none     ：沒有 VC 准入（平台部署沒設 env，或專屬租戶的 KYC 登錄是 allowlist）
 *   checking ：探測中
 *   unknown  ：探測讀不到（RPC 失敗）——不當成 VC，也不當成 allowlist，UI 顯示無法確認
 *   disconnected：要探測但還沒有可讀鏈的 provider（沒連錢包）
 *
 * 平台部署（default／示範租戶）不探測，結果只取決於 env／表，與改版前相同。
 */
export type VcKycRegistryState =
  | { status: 'vc'; address: string }
  | { status: 'none' | 'checking' | 'unknown' | 'disconnected'; address: null }

const PROBE_ABI = ['function requiredType() view returns (bytes32)']
/** 整個探測（含重試）的上限。逾時＝讀不到（unknown），不是 allowlist。 */
export const PROBE_TIMEOUT_MS = 8000

export type ProbeResult = { ok: true; value: string } | { ok: false; missing: boolean }

/**
 * 讀 requiredType()：成功回值；函式不存在（allowlist 登錄）回 missing；其他錯誤與逾時回 missing=false。
 * 純函式（測試注入 read 與 timeoutMs）。
 */
export async function probeRequiredType(read: () => Promise<string>, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, missing: false }), timeoutMs)
  })
  const probe = settle(withRetry(read)).then<ProbeResult>((r) =>
    r.ok ? { ok: true, value: String(r.value) } : { ok: false, missing: isMissingFunctionError(r.error) },
  )
  try {
    return await Promise.race([probe, timeout])
  } finally {
    clearTimeout(timer)
  }
}
const ZERO32 = `0x${'0'.repeat(64)}`

/** 純函式：探測結果 → 狀態（測試注入）。 */
export function vcStateFromProbe(
  source: VcKycSource,
  probe: ProbeResult | null,
): VcKycRegistryState {
  if (source.kind === 'none') return { status: 'none', address: null }
  if (source.kind === 'known') return { status: 'vc', address: source.address }
  if (probe === null) return { status: 'checking', address: null }
  if (probe.ok) {
    // requiredType 是 0 的登錄不可能讓任何人通過，不當成可用的 VC 登錄。
    return /^0x[0-9a-fA-F]{64}$/.test(probe.value) && probe.value !== ZERO32
      ? { status: 'vc', address: source.address }
      : { status: 'none', address: null }
  }
  // 函式不存在（舊的 allowlist KYCRegistry）＝不是 VC 登錄；其他錯誤＝無法確認。
  return probe.missing ? { status: 'none', address: null } : { status: 'unknown', address: null }
}

export function useVcKycRegistry(
  chainId: number | null,
  runner: ContractRunner | null | undefined,
): VcKycRegistryState & { retry: () => void } {
  const source = getVcKycSource(chainId)
  const key = source.kind === 'none' ? 'none' : `${source.kind}:${source.address}`
  const [attempt, setAttempt] = useState(0)
  const [probe, setProbe] = useState<{ key: string; attempt: number; result: ProbeResult } | null>(null)
  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    if (source.kind !== 'probe' || !runner) return undefined
    let cancelled = false
    const reg = new Contract(source.address, PROBE_ABI, runner)
    void probeRequiredType(() => reg.requiredType() as Promise<string>).then((result) => {
      if (!cancelled) setProbe({ key, attempt, result })
    })
    return () => {
      cancelled = true
    }
    // key 已涵蓋 source 的內容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, runner, attempt])

  if (source.kind === 'probe' && !runner) return { status: 'disconnected', address: null, retry }
  // 重試時舊結果不算：回到「確認中」直到這一輪有結果。
  const current = probe && probe.key === key && probe.attempt === attempt ? probe.result : null
  return { ...vcStateFromProbe(source, current), retry }
}

/** 交易所接的 KYC 登錄就是這個部署的 VC 登錄嗎？（決定「去取得資格」走憑證頁還是舊表單） */
export function isVcKycRegistry(state: VcKycRegistryState, kycRegistryAddress: string | null | undefined): boolean {
  return state.status === 'vc' && !!kycRegistryAddress && state.address.toLowerCase() === kycRegistryAddress.toLowerCase()
}

/**
 * 「去取得 KYC 資格」該怎麼呈現：
 *   credentials：交易所的 KYC 登錄是 VC 登錄 → 前往憑證頁
 *   checking   ：專屬部署的登錄種類還在確認（探測中、沒連錢包）→ 只顯示確認中，不給舊表單
 *   unknown    ：專屬部署的登錄種類讀不到（RPC 失敗或逾時）→ 顯示無法確認＋重試，不給舊表單
 *   legacy     ：舊的 allowlist 登錄 → 原本的 submitKYC 表單（平台部署一律是這個，行為不變）
 */
export type KycActionMode = 'credentials' | 'checking' | 'unknown' | 'legacy'

export function kycActionMode(state: VcKycRegistryState, kycRegistryAddress: string | null | undefined): KycActionMode {
  if (isVcKycRegistry(state, kycRegistryAddress)) return 'credentials'
  // checking／unknown／disconnected 只會出現在專屬部署有候選時（vcStateFromProbe）。
  if (state.status === 'unknown') return 'unknown'
  if (state.status === 'checking' || state.status === 'disconnected') return 'checking'
  return 'legacy'
}
