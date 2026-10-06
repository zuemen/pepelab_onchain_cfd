// RWA 資產卡的鏈上讀值（/rwa）。
//
// 每個欄位各自是一個 Reading：一個 view 不存在或 revert，只讓那一格顯示「此部署沒有這個函式」
// 或「讀取失敗」，不拖垮整張卡，也不以 0／false 冒充讀值。
//
// 交易所位址、ESGRegistryV2 位址都從呼叫端傳入（deployment.ts），這裡不知道是哪一個部署。

import type { Tier } from './carbon'
import type { Reading, FnSupport } from './contractProbe'
import type { ModeSupport } from './assetModeProbe'
import type { AssetModeProbe } from './marketStatus'
import type { AssetSymbol } from 'src/contracts/addresses'

import { ASSET_IDS } from 'src/contracts/addresses'

import { paramsFor } from './carbon'
import { RWA_CLASS, refersToRealWorldAsset } from './rwaProfile'
import { ok, FAILED, supportMap, readGuarded, UNSUPPORTED } from './contractProbe'

/** 交易所上這一頁會呼叫的 view。 */
export const EXCHANGE_VIEWS = [
  'kyc()',
  'rwaAsset(bytes32)',
  'maxLeverageForAsset(bytes32)',
  'maintenanceMarginBpsForAsset(bytes32)',
  'assetMode(bytes32)',
] as const

export type ExchangeView = (typeof EXCHANGE_VIEWS)[number]

export const ESG_VIEWS = ['medianCarbonTier(bytes32)', 'getAttestors(bytes32)'] as const
export type EsgView = (typeof ESG_VIEWS)[number]

/** CarbonTiers.Tier 的序數（與 useCarbonTiers 同一張表）。 */
const TIER_BY_ORDINAL: readonly Tier[] = ['unrated', 'low', 'mid', 'high']

export interface CarbonReading {
  tier: Tier
  /** 仍新鮮的見證筆數。 */
  freshCount: number
  isRated: boolean
}

export interface RwaCardChain {
  rwaFlag: Reading<boolean>
  maxLeverage: Reading<number>
  maintenanceBps: Reading<number>
  carbon: Reading<CarbonReading>
  /** 曾經見證過這檔資產的地址數（getAttestors 的長度）。 */
  attestors: Reading<number>
  /** 給 marketStatus() 用的 assetMode 探測結果。 */
  mode: AssetModeProbe
}

export interface RwaSnapshot {
  kycAddress: Reading<string>
  /** 交易所支不支援 assetMode（休市停單）。 */
  modeSupport: ModeSupport
  /** ESGRegistryV2 是否部署在這條鏈上。 */
  esgDeployed: boolean
  perAsset: Record<string, RwaCardChain>
}

export interface RwaCardDeps {
  /** 交易所的 runtime bytecode（讀不到回 null）。 */
  exchangeCode: () => Promise<string | null>
  kyc: () => Promise<string>
  rwaAsset: (assetId: string) => Promise<boolean>
  maxLeverageForAsset: (assetId: string) => Promise<bigint>
  maintenanceMarginBpsForAsset: (assetId: string) => Promise<bigint>
  assetMode: (assetId: string) => Promise<bigint | number>
  /** 這條鏈沒有 ESGRegistryV2 時為 null。 */
  esg: null | {
    code: () => Promise<string | null>
    medianCarbonTier: (assetId: string) => Promise<{ tier: bigint | number; count: bigint | number; isRated: boolean }>
    getAttestors: (assetId: string) => Promise<readonly string[]>
  }
  timeoutMs?: number
}

const toModeSupport = (s: FnSupport): ModeSupport => s

function modeProbe(support: FnSupport, r: Reading<number>): AssetModeProbe {
  if (support === 'unsupported') return { kind: 'unsupported' }
  if (support === 'unknown') return { kind: 'unknown' }
  return { kind: 'supported', mode: r.status === 'ok' ? r.value : null }
}

/** 讀整頁需要的鏈上值。永遠不 throw。 */
export async function loadRwaSnapshot(
  deps: RwaCardDeps,
  symbols: readonly AssetSymbol[]
): Promise<RwaSnapshot> {
  const ms = deps.timeoutMs ?? 8000
  const code = await deps.exchangeCode().catch(() => null)
  const sup = supportMap(code, EXCHANGE_VIEWS)
  const esgCode = deps.esg ? await deps.esg.code().catch(() => null) : null
  const esgSup = supportMap(esgCode, ESG_VIEWS)
  const esg = deps.esg

  const kycAddress = await readGuarded(sup['kyc()'], () => deps.kyc(), ms)

  const rows = await Promise.all(
    symbols.map(async (symbol) => {
      const assetId = ASSET_IDS[symbol]
      const [rwaFlag, maxLev, mm, mode, carbon, attestors] = await Promise.all([
        readGuarded(sup['rwaAsset(bytes32)'], () => deps.rwaAsset(assetId), ms),
        readGuarded(sup['maxLeverageForAsset(bytes32)'], () => deps.maxLeverageForAsset(assetId), ms),
        readGuarded(sup['maintenanceMarginBpsForAsset(bytes32)'], () => deps.maintenanceMarginBpsForAsset(assetId), ms),
        // unknown（bytecode 讀不到）時不去猜 assetMode，與 assetModeProbe 同一條規則。
        sup['assetMode(bytes32)'] === 'supported'
          ? readGuarded('supported', () => deps.assetMode(assetId), ms)
          : Promise.resolve(UNSUPPORTED),
        esg
          ? readGuarded(esgSup['medianCarbonTier(bytes32)'], () => esg.medianCarbonTier(assetId), ms)
          : Promise.resolve(UNSUPPORTED),
        esg
          ? readGuarded(esgSup['getAttestors(bytes32)'], () => esg.getAttestors(assetId), ms)
          : Promise.resolve(UNSUPPORTED),
      ])
      const row: RwaCardChain = {
        rwaFlag: rwaFlag.status === 'ok' ? ok(Boolean(rwaFlag.value)) : rwaFlag,
        maxLeverage: maxLev.status === 'ok' ? ok(Number(maxLev.value)) : maxLev,
        maintenanceBps: mm.status === 'ok' ? ok(Number(mm.value)) : mm,
        carbon:
          carbon.status === 'ok'
            ? ok({
                tier: TIER_BY_ORDINAL[Number(carbon.value.tier)] ?? 'unrated',
                freshCount: Number(carbon.value.count),
                isRated: Boolean(carbon.value.isRated),
              })
            : carbon,
        attestors: attestors.status === 'ok' ? ok(attestors.value.length) : attestors,
        mode: modeProbe(
          sup['assetMode(bytes32)'],
          mode.status === 'ok' ? ok(Number(mode.value)) : FAILED
        ),
      }
      return [symbol, row] as const
    })
  )

  return {
    kycAddress,
    modeSupport: toModeSupport(sup['assetMode(bytes32)']),
    esgDeployed: deps.esg !== null,
    perAsset: Object.fromEntries(rows),
  }
}

// ── 純函式：把讀值翻成畫面上的結論 ────────────────────────────────────────────

const ZERO_ADDRESS = /^0x0{40}$/i

export type KycRequirement = 'required' | 'notRequired' | 'gateOff' | 'unknown'

/**
 * 開倉是否需要 KYC。合約的規則（PerpetualExchange.openPosition）：kyc 不是零地址 **而且**
 * rwaAsset(asset) 為 true 才檢查。
 *   kyc() 不存在或回零地址 → gateOff（沒有任何資產會被檢查）
 *   kyc() 讀取失敗         → unknown
 *   rwaAsset 讀取失敗／不存在 → unknown（不能替合約猜）
 */
export function kycRequirement(kyc: Reading<string>, rwaFlag: Reading<boolean>): KycRequirement {
  if (kyc.status === 'unsupported') return 'gateOff'
  if (kyc.status === 'failed') return 'unknown'
  if (ZERO_ADDRESS.test(kyc.value)) return 'gateOff'
  if (rwaFlag.status !== 'ok') return 'unknown'
  return rwaFlag.value ? 'required' : 'notRequired'
}

export type RwaFlagNote = 'goldMismatch' | 'unflaggedRwa' | 'cryptoNotRwa' | 'cryptoFlagged' | null

/** 「參照現實世界資產」與「鏈上 rwaAsset 標記」不一致時，要照實說出來。 */
export function rwaFlagNote(symbol: AssetSymbol, rwaFlag: Reading<boolean>): RwaFlagNote {
  if (rwaFlag.status !== 'ok') return null
  const real = refersToRealWorldAsset(symbol)
  if (!real) return rwaFlag.value ? 'cryptoFlagged' : 'cryptoNotRwa'
  if (rwaFlag.value) return null
  return RWA_CLASS[symbol] === 'gold' ? 'goldMismatch' : 'unflaggedRwa'
}

export type ClosureRule = 'noStop' | 'stop' | 'unknown' | 'crypto'

/**
 * 休市規則的揭露。只看部署有沒有 assetMode（不看此刻是否休市）：
 * 舊部署沒有 → 「此部署未啟用休市停單，休市時仍以最後收盤價成交」要一直寫著，
 * 不是只在週末才出現。
 */
export function closureRule(symbol: AssetSymbol, modeSupport: ModeSupport): ClosureRule {
  if (RWA_CLASS[symbol] === 'crypto') return 'crypto'
  if (modeSupport === 'unsupported') return 'noStop'
  if (modeSupport === 'supported') return 'stop'
  return 'unknown'
}

/** 見證者揭露：0 位、只有 1 位（營運方自己）、或多位。 */
export function attestorNote(attestors: Reading<number>): 'none' | 'single' | null {
  if (attestors.status !== 'ok') return null
  if (attestors.value === 0) return 'none'
  if (attestors.value === 1) return 'single'
  return null
}

/** 合約的全域槓桿硬上限（PerpetualExchange.MAX_LEVERAGE）。 */
export const EXCHANGE_MAX_LEVERAGE = 5

/**
 * 槓桿上限是不是被碳分級壓住的：合約的 maxLeverageForAsset = min(owner 上限, 碳分級上限)。
 * 鏈上值等於這個分級的上限、而且低於全域硬上限，就標「受碳分級上限」（例如高碳的 sBTC、sGOLD 只有 1×）。
 * 兩個讀值任一不是 ok 就不下結論。
 */
export function carbonCapped(maxLeverage: Reading<number>, carbon: Reading<CarbonReading>): boolean {
  if (maxLeverage.status !== 'ok' || carbon.status !== 'ok') return false
  const cap = paramsFor(carbon.value.isRated ? carbon.value.tier : 'unrated').maxLeverage
  return cap < EXCHANGE_MAX_LEVERAGE && maxLeverage.value === cap
}

/** bps → 百分比字串（500 → "5%"、750 → "7.5%"）。 */
export function bpsToPct(bps: number): string {
  const pct = bps / 100
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`
}
