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

// ── #333：跟單前的退役估算 ─────────────────────────────────────────────────────

export interface CopyRetirementInputs {
  /** 跟單金額（結算幣最小單位）。 */
  totalMargin: bigint
  /** CopyTracker.COPY_FEE_BPS。 */
  copyFeeBps: bigint
  /** FeeRouter.PLATFORM_SHARE_BPS。 */
  platformShareBps: bigint
  /** PlatformFeeSplitter.carbonShareBps（immutable）。 */
  carbonShareBps: bigint
  /** CarbonRetirement.pricePerTonne（結算幣最小單位 / 1e18 碳權單位）。 */
  pricePerTonne: bigint
}

export interface CopyRetirementEstimate {
  copyFee: bigint
  platformShare: bigint
  toRetirement: bigint
  /** 1e18 = 1 公噸模擬碳權。 */
  tonnes: bigint
}

const BPS = 10_000n

/**
 * 這次跟單的跟單費，經平台份額、退役比例、模擬價格，換算成會促成平台退役的噸數。每一步都照
 * 合約的整數除法向下取整，所以和鏈上實際撥入的數字一致。只算跟單費：跟單部位日後的績效費
 * 也會經過同一條路，但金額要看損益，事前算不出來——畫面因此標明是估算。
 */
export function copyRetirementEstimate(x: CopyRetirementInputs): CopyRetirementEstimate {
  const copyFee = (x.totalMargin * x.copyFeeBps) / BPS
  const platformShare = (copyFee * x.platformShareBps) / BPS
  const toRetirement = (platformShare * x.carbonShareBps) / BPS
  const tonnes = x.pricePerTonne === 0n ? 0n : (toRetirement * 10n ** BigInt(TONNE_DECIMALS)) / x.pricePerTonne
  return { copyFee, platformShare, toRetirement, tonnes }
}

// ── #333：退役紀錄的交易雜湊 ───────────────────────────────────────────────────

export interface RetiredLog {
  amount: bigint
  tonnesCO2e: bigint
  timestamp: bigint
  txHash: string
}

/**
 * 合約的退役清單沒有存交易雜湊，所以用 CarbonRetired 事件補：以金額、噸數、時間三者比對
 * （事件就是這三個欄位）。每個事件只配一列；配不到的列是 null，不借用別筆的雜湊。
 */
export function attachRetirementTx<R extends RetirementRow>(
  rows: readonly R[],
  raw: readonly RawRetirement[],
  logs: readonly RetiredLog[],
): (R & { txHash: string | null })[] {
  const unused = [...logs]
  return rows.map((row, i) => {
    const r = raw[i]
    const at = r
      ? unused.findIndex((l) => l.amount === r.amount && l.tonnesCO2e === r.tonnesCO2e && l.timestamp === r.timestamp)
      : -1
    const txHash = at >= 0 ? unused.splice(at, 1)[0].txHash : null
    return { ...row, txHash }
  })
}

/** 本機展示鏈：回放把時間往前撥，區塊與時間不成比例，anvil 的 getLogs 也沒有範圍上限。 */
export const LOCAL_CHAIN_ID = 31337
/** 每筆退役的估計區塊前後各查幾塊。估計誤差來自出塊時間不完全固定；200 塊＝Base 上約 ±7 分鐘。 */
const ROW_WINDOW_BLOCKS = 200

export interface BlockRange {
  fromBlock: number
  toBlock: number
}

/**
 * 查 CarbonRetired 事件的區塊範圍。
 *
 * 本機鏈：回放把時間一天天往前撥，區塊與時間沒有線性關係；anvil 的 getLogs 又沒有範圍上限，
 * 所以整條鏈一次查完。
 *
 * 公開鏈：出塊時間固定（Base 2 秒），每筆退役的時間就能推回它大概在哪一塊，只查那附近——
 * 最近 10 筆最多 10 段，不必從現在往回掃好幾天（公開節點一次只能查幾百塊）。相鄰的範圍合併。
 */
export function retirementLogRanges(
  chainId: number | null,
  latest: { number: number; timestamp: number },
  rowTimestamps: readonly number[],
  blockTimeSec: number,
): BlockRange[] {
  if (chainId === LOCAL_CHAIN_ID) return [{ fromBlock: 0, toBlock: latest.number }]
  const ranges = rowTimestamps
    .map((ts) => Math.round(latest.number - Math.max(0, latest.timestamp - ts) / blockTimeSec))
    .map((b) => ({
      fromBlock: Math.max(0, b - ROW_WINDOW_BLOCKS),
      toBlock: Math.min(latest.number, b + ROW_WINDOW_BLOCKS),
    }))
    .sort((a, b) => a.fromBlock - b.fromBlock)
  const merged: BlockRange[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.fromBlock <= last.toBlock + 1) last.toBlock = Math.max(last.toBlock, r.toBlock)
    else merged.push({ ...r })
  }
  return merged
}
