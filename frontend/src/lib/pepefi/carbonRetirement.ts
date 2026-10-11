// 碳權退役（issue #105）的鏈上讀數 → 畫面資料。純函式，不碰 RPC。
//
// 合約：contracts/src/CarbonRetirement.sol。退役的是 MockCarbonCredit（**模擬碳權**），
// 本平台在測試網自行鑄造，不對應任何真實減碳。畫面上的模擬聲明**一律顯示**，不看合約的
// SIMULATED() 讀不讀得到——聲明是畫面的義務，不是合約回報的一個狀態；讀不到不能變成不說。

/** 碳權的定點位數：1e18 單位＝一個標示為 1 公噸 CO2e 的模擬碳權。 */
export const TONNE_DECIMALS = 18

/** 畫面一次列出的最近退役筆數。 */
export const RECENT_LIMIT = 10

export interface RawRetirement {
  amount: bigint
  tonnesCO2e: bigint
  timestamp: bigint
  retiredBy: string
}

/** 每個欄位各自讀；null＝那一筆讀失敗（不是 0）。 */
export interface RawRetirementState {
  simulated: boolean | null
  /** 結算幣的 decimals（6 或 18）；讀不到時金額一律顯示為未知，不猜 18。 */
  decimals: number | null
  totalRetiredTonnes: bigint | null
  totalSpent: bigint | null
  budget: bigint | null
  count: bigint | null
  recent: RawRetirement[] | null
}

export interface RetirementRow {
  /** 公噸（模擬）。 */
  tonnes: number
  /** 結算幣金額；decimals 未知時為 null。 */
  amount: number | null
  /** unix 秒。 */
  timestamp: number
  retiredBy: string
}

export interface RetirementSummary {
  totalTonnes: number | null
  totalSpent: number | null
  /** 已撥入、尚未用掉的退役預算。 */
  budget: number | null
  count: number | null
  rows: RetirementRow[]
  /** 合約自己宣告的模擬旗標；只供交叉檢查，畫面的聲明不依賴它。 */
  simulatedOnChain: boolean | null
}

const toNumber = (v: bigint, decimals: number): number => Number(v) / 10 ** decimals

const scaled = (v: bigint | null, decimals: number | null): number | null =>
  v === null || decimals === null ? null : toNumber(v, decimals)

/** 把原始讀數整理成畫面資料。列順序維持合約回傳的「最新在前」。 */
export function summarizeRetirements(raw: RawRetirementState): RetirementSummary {
  return {
    totalTonnes: scaled(raw.totalRetiredTonnes, TONNE_DECIMALS),
    totalSpent: scaled(raw.totalSpent, raw.decimals),
    budget: scaled(raw.budget, raw.decimals),
    count: raw.count === null ? null : Number(raw.count),
    rows: (raw.recent ?? []).map((r) => ({
      tonnes: toNumber(r.tonnesCO2e, TONNE_DECIMALS),
      amount: raw.decimals === null ? null : toNumber(r.amount, raw.decimals),
      timestamp: Number(r.timestamp),
      retiredBy: r.retiredBy,
    })),
    simulatedOnChain: raw.simulated,
  }
}

/**
 * 整份讀數都失敗（位址有設、但一個核心欄位都讀不到）。這和「還沒有任何退役」是兩件事：
 * 前者畫面說「暫時無法確認」，後者照常顯示 0 公噸與空清單。
 */
export function retirementReadFailed(raw: RawRetirementState): boolean {
  return raw.totalRetiredTonnes === null && raw.count === null && raw.recent === null && raw.budget === null
}

/**
 * 合約明確回報「不是模擬」——在這個 repo 裡不該發生（兩顆合約都把 SIMULATED 寫成 constant true）。
 * 真的發生時代表位址指到了別的合約，畫面應該當成讀取異常，而不是把模擬聲明拿掉。
 */
export function simulationFlagContradicts(raw: RawRetirementState): boolean {
  return raw.simulated === false
}
