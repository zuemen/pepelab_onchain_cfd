// 碳強度 → 級距 → (交易費率, 借貸費率, 槓桿上限) 的唯一定義——前端鏡射。
//
// 這是 contracts/src/CarbonTiers.sol 的 TypeScript 版本，門檻與逐級參數必須
// 跟合約那邊完全一致。兩邊沒有編譯期連結，這裡改了門檻、合約沒有跟著改，
// 兩邊的測試各自都還是綠的，數字卻已經漂移——carbon.test.ts 把兩邊該一致的
// 數字都釘住，但那只能在「這個檔案自己的測試」裡抓到打錯字，抓不到「合約
// 那邊被改了但這裡沒改」。改門檻永遠是兩個檔案一起改。
//
// ADR-003：門檻是常數，不是可設定參數。可設定就等於可裁量，而不可裁量正是
// 這個機制唯一站得住的理由。
//
// 單位：carbonIntensity 是「每百萬美元營收的 tCO2e」（營收基準），適用範圍
// 只有股票與 ETF——黃金與加密貨幣沒有營收，不能套用同一個公式。細節與被否
// 決的替代方案見 docs/data/carbon-intensity.md 的「Open questions for #95」；
// 那些資產的級距要在別處直接指定，不能硬塞一個跨資產類別、算出來會誤導人
// 的正規化數字進 tierOf（例如用市值正規化比特幣，算出來會比蘋果還低）。

export type Tier = 'unrated' | 'low' | 'mid' | 'high'

export interface CarbonTierParams {
  /** bps。 */
  tradingFeeBps: number
  /** bps，每小時。 */
  borrowFeeBpsPerHour: number
  /** 只會是 1、2、5——對齊 StrategyRegistry._validLeverage。 */
  maxLeverage: number
}

const LOW_MAX_INTENSITY = 1
const MID_MAX_INTENSITY = 8

const PARAMS: Record<Exclude<Tier, 'unrated'>, CarbonTierParams> = {
  // 對齊 PerpetualExchange 現行預設值（TRADING_FEE_BPS=10,
  // BORROW_FEE_BPS_PER_HOUR=1, MAX_LEVERAGE=5）——上線不能悄悄調高
  // 已經是最低一級的資產的成本。
  low: { tradingFeeBps: 10, borrowFeeBpsPerHour: 1, maxLeverage: 5 },
  mid: { tradingFeeBps: 40, borrowFeeBpsPerHour: 4, maxLeverage: 2 },
  // 對齊 PerpetualExchange 自己的硬上限（MAX_TRADING_FEE_BPS=100,
  // MAX_BORROW_FEE_BPS_PER_HOUR=10）——交易所本身允許的最保守值。
  high: { tradingFeeBps: 100, borrowFeeBpsPerHour: 10, maxLeverage: 1 },
}

/**
 * 把一個營收基準的碳強度對應到級距。
 *
 * `isRated` 是呼叫端自己已經判斷好的答案——「這個資產現在有沒有未過期的
 * 見證資料」，通常來自 ESGRegistryV2 的中位數讀取結果。刻意做成必填參數
 * 而不是從 carbonIntensity 推斷，因為 0 落在 low 的區間裡：一個沒有見證
 * 資料的資產如果被當成 `tierOf(0)`，會拿到成本最低、槓桿最高的待遇，跟
 * 「未評等資產一律落到最保守級」的原意正好相反。把這個決定變成必填參數，
 * 讓呼叫端不可能不小心漏掉這一步。
 */
export function tierOf(carbonIntensity: number, isRated: boolean): Tier {
  if (!isRated) return 'unrated'
  if (carbonIntensity < LOW_MAX_INTENSITY) return 'low'
  if (carbonIntensity <= MID_MAX_INTENSITY) return 'mid'
  return 'high'
}

/**
 * 把級距對應到費率與槓桿上限。
 *
 * `unrated` 在數字上跟 `high`完全相同——這是刻意的，對應「未評等資產一律
 * 落到最保守級(1x、最高費率)」——但保留成獨立的字串值，讓畫面能顯示
 * 「未評等」而不是誤報成「高碳」。
 */
export function paramsFor(tier: Tier): CarbonTierParams {
  return PARAMS[tier === 'unrated' ? 'high' : tier]
}

/** `tierOf` 與 `paramsFor` 的一次呼叫版本。 */
export function paramsForIntensity(
  carbonIntensity: number,
  isRated: boolean,
): CarbonTierParams & { tier: Tier } {
  const tier = tierOf(carbonIntensity, isRated)
  return { tier, ...paramsFor(tier) }
}

// ── 見證新鮮度 ──────────────────────────────────────────────────────────────
//
// 詞彙表 Attestation：「Expires; a lapsed attestation stops counting rather than
// lingering as an old number.」碳強度來自發行方每年一次的公開申報,所以最大見證
// 年齡對齊申報週期——一年。過了就 fail-closed:呼叫端把這個資產當成 Unrated
// （最保守級),而不是繼續拿一個舊數字算費率。ESGRegistryV2 之後上鏈時,鏈上的
// maxAttestationAge 必須跟這裡一致,和 CarbonTiers 的門檻同理。

/** 天。發行方碳申報是年度的,一個週期沒有新見證就視為過期。 */
export const MAX_ATTESTATION_AGE_DAYS = 365

const DAY_MS = 86_400_000

/** 見證觀測日與現在相差幾天。負數（未來日期）夾成 0。 */
export function attestationAgeDays(observedISO: string, nowMs: number): number {
  const observedMs = Date.parse(observedISO)
  if (Number.isNaN(observedMs)) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.floor((nowMs - observedMs) / DAY_MS))
}

/**
 * 見證是否已過期。無法解析的日期一律當成過期——跟 `tierOf` 的 `isRated`
 * 必填同一個道理,「不知道」不能被當成「沒問題」。
 */
export function attestationExpired(
  observedISO: string,
  nowMs: number,
  maxAgeDays: number = MAX_ATTESTATION_AGE_DAYS,
): boolean {
  return attestationAgeDays(observedISO, nowMs) > maxAgeDays
}

/** 下一次見證的到期日（ISO `YYYY-MM-DD`）——畫面用來顯示「下次見證日」。 */
export function nextAttestationDue(
  observedISO: string,
  maxAgeDays: number = MAX_ATTESTATION_AGE_DAYS,
): string {
  const observedMs = Date.parse(observedISO)
  if (Number.isNaN(observedMs)) return '—'
  return new Date(observedMs + maxAgeDays * DAY_MS).toISOString().slice(0, 10)
}

// ── 組合加權碳強度 ──────────────────────────────────────────────────────────
//
// User story 7：「看到我的投資組合的加權碳強度是一個數字」。依市值加權,跟
// esgContribution 用同一套權重。未評等的持倉不會被塞進一個看起來正常的平均值
// （story 17「沒有資料不會被當成沒有問題」）——它們的權重被單獨回報成
// `unratedWeightPct`,讓畫面能說「你有 X% 的持倉沒有碳資料」而不是默默把它們
// 當成 0。

export interface CarbonWeight {
  /** 每百萬美元營收的 tCO2e；未評等或非營收基準的資產為 null。 */
  carbonIntensity: number | null
  /** 這個資產現在有沒有未過期的見證資料（呼叫端已判斷,含 `attestationExpired`）。 */
  isRated: boolean
  /** 任何非負刻度：市值、bps、權重都可以,只有相對大小有意義。 */
  weight: number
}

export interface PortfolioCarbon {
  /** 已評等持倉的加權平均碳強度；完全沒有已評等持倉時為 null。 */
  intensity: number | null
  /** 已評等持倉佔總權重的百分比,0–100。 */
  ratedWeightPct: number
  /** 未評等持倉佔總權重的百分比,0–100。 */
  unratedWeightPct: number
}

export function portfolioCarbon(holdings: readonly CarbonWeight[]): PortfolioCarbon {
  let totalWeight = 0
  let ratedWeight = 0
  let weightedSum = 0
  for (const h of holdings) {
    if (!(h.weight > 0)) continue
    totalWeight += h.weight
    if (h.isRated && h.carbonIntensity !== null) {
      ratedWeight += h.weight
      weightedSum += h.weight * h.carbonIntensity
    }
  }
  if (totalWeight === 0) {
    return { intensity: null, ratedWeightPct: 0, unratedWeightPct: 0 }
  }
  return {
    intensity: ratedWeight > 0 ? weightedSum / ratedWeight : null,
    ratedWeightPct: (ratedWeight / totalWeight) * 100,
    unratedWeightPct: ((totalWeight - ratedWeight) / totalWeight) * 100,
  }
}
