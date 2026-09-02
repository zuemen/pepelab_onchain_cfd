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
