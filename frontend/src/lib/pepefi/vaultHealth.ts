// /tokens 金庫面板的判斷：儲備夠不夠、儲備從哪來、現在能不能買賣。全部是純函式，
// 元件只管渲染；前端測試不渲染元件，這裡是唯一測得到這些判斷的地方。

import { t, interpolate } from 'src/locales'

import { formatRatio, formatAmount } from './solvency'

/** AssetVaultV2 的金額一律 18-dec（ADR-011）。 */
const VAULT_DECIMALS = 18

const BPS = 10_000n

export interface VaultHealth {
  /** 金庫 USDC 餘額扣掉累積手續費。null＝讀不到（reserveStatus 之前的舊金庫）。 */
  reserve: bigint | null
  /** 已發行代幣的現值。 */
  liability: bigint | null
  /** null＝讀不到。 */
  ratioBps: bigint | null
  /** 低於這個比率合約拒絕 mint。 */
  minRatioBps: bigint | null
  paused: boolean | null
  /** 有資產無法定價：比率偏樂觀，視為未知（CONTEXT.md 的 Unknown Ratio）。 */
  stale: boolean
  mintingHalted: boolean
  /** GuardedOracle 單次更新的偏差上限。 */
  maxDeviationBps: bigint | null
  /** VaultFunded 加總，見 vaultFunding.ts。null＝讀不到，不是 0。 */
  operatorFunded: bigint | null
}

export interface ReserveSources {
  operatorFunded: bigint
  /** 其餘部分：使用者買進扣掉贖回的淨額。 */
  userNet: bigint
  operatorShareBps: bigint
  /** 不含注資的儲備率。null＝尚無發行，或負債不可信。 */
  ownRatioBps: bigint | null
}

/**
 * 合約的儲備率把營運方注資算進去，注資一大比率就很好看，看不出金庫有多依賴營運方
 * （docs/RISK_MODEL.md：價格上漲時的差額來自營運方資金）。拆開才看得出來。
 */
export function reserveSources(h: VaultHealth): ReserveSources | null {
  if (h.reserve === null || h.operatorFunded === null) return null
  const { reserve, liability, operatorFunded } = h
  const counted = operatorFunded < reserve ? operatorFunded : reserve
  const userNet = reserve - counted
  return {
    operatorFunded,
    userNet,
    operatorShareBps: reserve === 0n ? 0n : (counted * BPS) / reserve,
    ownRatioBps: h.stale || liability === null || liability === 0n ? null : (userNet * BPS) / liability,
  }
}

export type VaultActionState = 'open' | 'blocked' | 'unknown'

/** 合約層面現在能不能買進／贖回。贖回只有暫停擋得住（docs/RISK_MODEL.md）。 */
export function vaultActions(h: VaultHealth): { buy: VaultActionState; redeem: VaultActionState } {
  if (h.paused === null) return { buy: 'unknown', redeem: 'unknown' }
  if (h.paused) return { buy: 'blocked', redeem: 'blocked' }
  return { buy: h.mintingHalted || h.stale || belowFloor(h) ? 'blocked' : 'open', redeem: 'open' }
}

export function belowFloor(h: VaultHealth): boolean {
  return h.ratioBps !== null && h.minRatioBps !== null && h.ratioBps < h.minRatioBps
}

export function formatVaultAmount(v: bigint): string {
  return formatAmount(v, VAULT_DECIMALS)
}

/** 面板上的儲備率字串。不可信時不給數字，尚無發行時也沒有比率可講。 */
export function reserveRatioLabel(h: VaultHealth): string {
  if (h.stale) return t.tokens.health.reserveRatioUnknown
  if (h.liability === 0n) return t.tokens.health.reserveRatioInfinite
  return h.ratioBps === null ? '—' : formatRatio(h.ratioBps)
}

export interface SimpleReserveNote {
  severity: 'info' | 'warning' | 'error'
  message: string
}

/** Simple Mode 的一句話版：跟 Expert 面板同一組事實。 */
export function simpleReserveNote(h: VaultHealth, isV2: boolean): SimpleReserveNote {
  const copy = t.tokens.health
  if (!isV2) return { severity: 'info', message: copy.simpleNotConnected }
  if (h.paused === true) return { severity: 'error', message: copy.simplePaused }
  if (h.stale) return { severity: 'warning', message: copy.simpleUnknown }
  if (h.mintingHalted) {
    return { severity: 'error', message: interpolate(copy.simpleMintingHalted, { ratio: reserveRatioLabel(h) }) }
  }
  if (belowFloor(h)) {
    return { severity: 'error', message: interpolate(copy.simpleBelowFloor, { ratio: reserveRatioLabel(h) }) }
  }
  if (h.paused === null) return { severity: 'warning', message: copy.simpleStatusUnknown }

  if (h.reserve === null || h.liability === null) return { severity: 'info', message: copy.simpleOpen }
  const amounts = { reserve: formatVaultAmount(h.reserve), liability: formatVaultAmount(h.liability) }
  const sources = reserveSources(h)
  return {
    severity: 'info',
    message: sources
      ? interpolate(copy.simpleNoteFunded, { ...amounts, share: formatRatio(sources.operatorShareBps) })
      : interpolate(copy.simpleNote, amounts),
  }
}
