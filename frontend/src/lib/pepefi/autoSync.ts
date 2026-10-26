// 跟單自動同步（ADR-024）的純函式：設定的預設值與檢查、每次同步的成本、油箱夠同步幾次、
// 一筆跟單現在的同步狀態。不含 ethers 或 React。
//
// 權限模型（合約強制，不是畫面自律）：跟隨者在鏈上開啟自動同步之後，任何人都能呼叫
// CopyTracker.resyncFor（跟隨者用 setSyncExecutor 指定了執行者時，只有那個地址），但它只能把
// 部位調成「交易者鏈上最新版」——呼叫者選不了資產、方向或槓桿；槓桿另外被跟隨者自己設的上限
// 夾住。油箱（syncGasBalance）是跟隨者自己存的 ETH，隨時可以提領。這裡算出來的數字只用來顯示、
// 送出前預覽與擋下，真正的條件以合約為準。

const E18 = 10n ** 18n

/** 合約的槓桿上限範圍（setAutoSync 的 maxLeverage 必須在 1..5）。 */
export const AUTO_SYNC_MIN_LEVERAGE = 1
export const AUTO_SYNC_MAX_LEVERAGE = 5

/** CopyTracker.MAX_TIP_WEI 的後備值（0.001 ETH）。鏈上讀得到時以鏈上為準。 */
export const FALLBACK_MAX_TIP_WEI = E18 / 1000n

/**
 * 合約允許的最短冷卻（CopyTracker.MIN_SYNC_INTERVAL = 1 小時）：開啟自動同步時冷卻低於這個值，
 * setAutoSync 會 revert InvalidSyncConfig。擋的是交易者在同一個區塊反覆「發新版 → 自己代為同步」。
 */
export const AUTO_SYNC_MIN_INTERVAL = 3600

/**
 * 冷卻時間的選項（秒）：交易者連發版本時，別人至少隔這麼久才能再替你同步一次。
 * 本人手動同步不受冷卻限制（合約規則）。最短的選項等於合約下限。
 *
 * 預設 24 小時——選項裡最保守的一個。每次同步都是全平再開、各付一次交易費（ADR-024「經濟」），
 * 冷卻是跟隨者唯一能限制「交易者一天能讓你同步幾次」的旋鈕：1 小時一天最多 24 輪（以每輪約 1%
 * 計約為保證金的 21%），24 小時一天 1 輪。要更即時，跟隨者自己調短。
 */
export const COOLDOWN_CHOICES = [AUTO_SYNC_MIN_INTERVAL, 6 * 3600, 24 * 3600] as const
export const DEFAULT_COOLDOWN = 24 * 3600

/** PerpetualExchange.PERFORMANCE_FEE_BPS 的後備值：跟單部位平倉時，獲利的 10% 付給交易者。 */
export const PERFORMANCE_FEE_BPS = 1000

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** 執行者小費的選項（wei）：0 = 只靠自己或自己的 agent 同步。 */
export const TIP_CHOICES = [0n, 2n * 10n ** 13n, 5n * 10n ** 13n, 10n ** 14n] as const
export const DEFAULT_TIP_WEI = 5n * 10n ** 13n // 0.00005 ETH

/** 預設預存夠同步幾次。 */
export const DEFAULT_PREFUND_SYNCS = 5n

export interface SyncConfig {
  autoSync: boolean
  /** 1..5；0 = 沒有另外設上限（只在關閉時允許，合約的語意；畫面不會送出 0）。 */
  maxLeverage: number
  /** 秒。 */
  minSyncInterval: number
  tipWei: bigint
}

export interface SyncState {
  /** Unix 秒；0 = 還沒同步過。 */
  lastSyncedAt: number
  syncCount: number
  /** 跟隨者自己平過這筆跟單的某一條腿：之後不再對交易者計分（黏著）。 */
  followerClosed: boolean
}

export interface AutoSyncSettings {
  maxLeverage: number
  minSyncInterval: number
  tipWei: bigint
}

// ── 指定執行者（syncExecutor） ───────────────────────────────────────────────

/** syncExecutor(follower, idx) 的回傳：零位址（任何人）→ null。 */
export function parseExecutor(raw: unknown): string | null {
  const a = typeof raw === 'string' ? raw : ''
  return /^0x[0-9a-fA-F]{40}$/.test(a) && a.toLowerCase() !== ZERO_ADDRESS ? a : null
}

export const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase()

export type ExecutorProblem = 'address' | 'self'

/**
 * 「誰能代為同步」欄位的輸入檢查。空字串＝任何人（不指定）。填自己的地址沒有意義（本人本來就隨時能同步），
 * 多半是把主錢包地址誤當成 agent 的熱錢包，所以擋下。
 */
export function executorProblem(input: string, follower: string | null): ExecutorProblem | null {
  const v = input.trim()
  if (v === '') return null
  if (!/^0x[0-9a-fA-F]{40}$/.test(v) || v.toLowerCase() === ZERO_ADDRESS) return 'address'
  if (sameAddress(v, follower)) return 'self'
  return null
}

// ── 讀鏈結果 → 型別 ──────────────────────────────────────────────────────────

type Tupleish = Record<string | number, unknown>

const num = (v: unknown): number => Number(v ?? 0)
const big = (v: unknown): bigint => (typeof v === 'bigint' ? v : BigInt(String(v ?? 0)))

/** syncConfig(follower, idx) 的回傳（ethers Result：名稱與位置都讀得到）。 */
export function parseSyncConfig(raw: unknown): SyncConfig {
  const r = raw as Tupleish
  return {
    autoSync: Boolean(r.autoSync ?? r[0]),
    maxLeverage: num(r.maxLeverage ?? r[1]),
    minSyncInterval: num(r.minSyncInterval ?? r[2]),
    tipWei: big(r.tipWei ?? r[3]),
  }
}

/** getSyncState(follower, idx) 的回傳。 */
export function parseSyncState(raw: unknown): SyncState {
  const r = raw as Tupleish
  return {
    lastSyncedAt: num(r.lastSyncedAt ?? r[0]),
    syncCount: num(r.syncCount ?? r[1]),
    followerClosed: Boolean(r.followerClosed ?? r[2]),
  }
}

// ── 設定 ─────────────────────────────────────────────────────────────────────

/**
 * 預設的槓桿上限：跟單當下策略裡最高的那一檔槓桿。
 *
 * 最安全的預設——之後交易者發新版就算全部改成 5×，自動同步也不會讓你的槓桿高過你跟單時
 * 看過、同意過的那個數字。要放寬得自己改。
 */
export function defaultMaxLeverage(strategyLeverages: readonly (bigint | number)[]): number {
  const top = strategyLeverages.reduce<number>((m, l) => Math.max(m, Number(l)), 0)
  return clampLeverage(top || AUTO_SYNC_MIN_LEVERAGE)
}

export const clampLeverage = (lev: number): number =>
  Math.min(AUTO_SYNC_MAX_LEVERAGE, Math.max(AUTO_SYNC_MIN_LEVERAGE, Math.round(lev)))

export type SettingsProblem = 'leverage' | 'tip' | 'interval'

/** 合約 setAutoSync 會擋的設定：送出前先擋下。 */
export function settingsProblem(s: AutoSyncSettings, maxTipWei: bigint = FALLBACK_MAX_TIP_WEI): SettingsProblem | null {
  if (!Number.isInteger(s.maxLeverage) || s.maxLeverage < AUTO_SYNC_MIN_LEVERAGE || s.maxLeverage > AUTO_SYNC_MAX_LEVERAGE) {
    return 'leverage'
  }
  if (s.tipWei < 0n || s.tipWei > maxTipWei) return 'tip'
  // uint32，且開啟時不得低於合約下限 MIN_SYNC_INTERVAL
  if (!Number.isInteger(s.minSyncInterval) || s.minSyncInterval < AUTO_SYNC_MIN_INTERVAL || s.minSyncInterval > 0xffffffff) {
    return 'interval'
  }
  return null
}

/**
 * 同步時實際用的槓桿，與合約相同：策略槓桿、交易所這檔資產的上限（高碳資產較低）、
 * 跟隨者自己的上限三者取小。上限是 0 代表沒有另外設。
 */
export function effectiveLeverage(strategyLeverage: number, assetMax: number | null, followerMax: number): number {
  let lev = strategyLeverage
  if (assetMax !== null && assetMax > 0) lev = Math.min(lev, assetMax)
  if (followerMax > 0) lev = Math.min(lev, followerMax)
  return Math.max(1, lev)
}

// ── 成本與油箱 ───────────────────────────────────────────────────────────────

/**
 * 一次同步從油箱扣多少：新版每一條腿一份交易所 executionFee，別人代為執行時再加小費。
 * 自己按「立即同步」不付小費。
 */
export function syncCostWei(executionFee: bigint, legs: number, tipWei: bigint, selfCall: boolean): bigint {
  return executionFee * BigInt(Math.max(0, legs)) + (selfCall ? 0n : tipWei)
}

/** 油箱夠同步幾次（往下取整）。每次成本是 0 時回 null（不受油箱限制）。 */
export function syncsAffordable(balanceWei: bigint, costWei: bigint): bigint | null {
  if (costWei <= 0n) return null
  return balanceWei > 0n ? balanceWei / costWei : 0n
}

/** 預設預存：夠讓別人代為同步 DEFAULT_PREFUND_SYNCS 次。 */
export const defaultPrefundWei = (executionFee: bigint, legs: number, tipWei: bigint): bigint =>
  syncCostWei(executionFee, legs, tipWei, false) * DEFAULT_PREFUND_SYNCS

/**
 * followTraderAtVersionWithAutoSync 的 msg.value：先付這次開倉每條腿的 executionFee，
 * 剩下的全部存進油箱。
 */
export const followWithAutoSyncValue = (executionFee: bigint, legs: number, prefundWei: bigint): bigint =>
  executionFee * BigInt(Math.max(0, legs)) + (prefundWei > 0n ? prefundWei : 0n)

/** 自己按「立即同步」時油箱還差多少（0 = 夠）。 */
export const selfSyncShortfall = (balanceWei: bigint, executionFee: bigint, legs: number): bigint => {
  const need = syncCostWei(executionFee, legs, 0n, true)
  return need > balanceWei ? need - balanceWei : 0n
}

// ── 立即同步前的預覽 ─────────────────────────────────────────────────────────

/** 交易者最新版的一條腿，加上交易所這檔資產目前的上限與交易費率（讀不到為 null）。 */
export interface ResyncLegInput {
  asset: string
  /** 權重（bps，10000 = 100%）。 */
  weight: bigint
  isLong: boolean
  strategyLeverage: number
  assetMaxLeverage: number | null
  tradingFeeBps: number | null
}

/** 這筆跟單目前的一條腿（Portfolio 的部位列）。value／pnl 讀不到為 null。 */
export interface CurrentLegInput {
  value: bigint | null
  pnl: bigint | null
  leverage: number
}

export interface ResyncPreviewLeg extends ResyncLegInput {
  /** 這次同步實際用的槓桿：策略、資產上限、跟隨者上限三者取小。 */
  leverage: number
  /** 被資產上限或跟隨者上限夾住了。 */
  capped: boolean
}

export interface ResyncPreview {
  legs: ResyncPreviewLeg[]
  /** 新版每條腿一份 executionFee（本人同步不付小費）。 */
  executionFeeWei: bigint
  /** 油箱不夠付執行費時，要附在交易上的差額。油箱讀不到為 null。 */
  topUpWei: bigint | null
  /** 平倉預計釋出的保證金（目前價值 − 獲利腿的績效費）；任何一腿讀不到為 null。 */
  estReleased: bigint | null
  /** 獲利的腿先結算的績效費（約）。 */
  estPerformanceFee: bigint | null
  /** 依新版開倉的交易費（約，與合約的手續費緩衝同一個算法）；任何一檔費率讀不到為 null。 */
  estOpenTradingFee: bigint | null
  /** 跟隨者沒有設槓桿上限（沒開過自動同步）：照新版槓桿開倉，只受資產上限約束。 */
  noFollowerCap: boolean
  /** 這次會用到的最高槓桿高於目前部位的最高槓桿。 */
  leverageRaised: boolean
}

/**
 * 「立即同步」確認視窗的內容：新版各腿、實際槓桿、要付的 ETH 執行費、預估的 USDC 交易費與績效費。
 *
 * 平倉時的交易費、借款費與資金費已經算在部位的目前價值裡（getPositionValue），所以釋出的保證金 ≈ 目前價值
 * − 獲利腿的績效費（合約以未扣費的損益計，這裡以扣費後的損益估，略低估）。開倉交易費照合約 _totalTradingFee：
 * Σ 釋出 × 權重 × 槓桿 × 費率。全部是估計值，實際以上鏈結果為準。
 */
export function resyncPreview(i: {
  legs: readonly ResyncLegInput[]
  followerMax: number
  executionFee: bigint
  tankBalance: bigint | null
  currentLegs: readonly CurrentLegInput[]
  performanceFeeBps?: number
}): ResyncPreview {
  const legs = i.legs.map((l): ResyncPreviewLeg => {
    const leverage = effectiveLeverage(l.strategyLeverage, l.assetMaxLeverage, i.followerMax)
    return { ...l, leverage, capped: leverage < l.strategyLeverage }
  })
  const executionFeeWei = syncCostWei(i.executionFee, legs.length, 0n, true)
  const topUpWei = i.tankBalance === null ? null : selfSyncShortfall(i.tankBalance, i.executionFee, legs.length)
  const perfBps = BigInt(i.performanceFeeBps ?? PERFORMANCE_FEE_BPS)

  let estReleased: bigint | null = null
  let estPerformanceFee: bigint | null = null
  if (i.currentLegs.length > 0 && i.currentLegs.every((c) => c.value !== null && c.pnl !== null)) {
    estPerformanceFee = i.currentLegs.reduce((s, c) => s + (c.pnl! > 0n ? (c.pnl! * perfBps) / 10_000n : 0n), 0n)
    const value = i.currentLegs.reduce((s, c) => s + c.value!, 0n)
    estReleased = value > estPerformanceFee ? value - estPerformanceFee : 0n
  }
  let estOpenTradingFee: bigint | null = null
  if (estReleased !== null && legs.every((l) => l.tradingFeeBps !== null)) {
    estOpenTradingFee = legs.reduce(
      (s, l) => s + (estReleased! * l.weight * BigInt(l.leverage) * BigInt(l.tradingFeeBps!)) / 100_000_000n,
      0n
    )
  }
  const topNew = legs.reduce((m, l) => Math.max(m, l.leverage), 0)
  const topNow = i.currentLegs.reduce((m, c) => Math.max(m, c.leverage), 0)
  return {
    legs,
    executionFeeWei,
    topUpWei,
    estReleased,
    estPerformanceFee,
    estOpenTradingFee,
    noFollowerCap: i.followerMax <= 0,
    leverageRaised: topNow > 0 && topNew > topNow,
  }
}

// ── 狀態 ─────────────────────────────────────────────────────────────────────

/**
 * 一筆 active 跟單現在的同步狀態。
 *
 * - upToDate：已經是交易者最新版。
 * - manual：有新版、沒開自動同步——要自己按「立即同步」。
 * - feeAboveCap：交易所的 executionFee 被調高，超過你開啟自動同步時同意的費率（syncExecFeeCap）——
 *   別人不能代為同步，直到你看過新費率、重新儲存自動同步設定（以畫面上的費率為新上限）；自己按
 *   「立即同步」時也是以畫面上顯示的費率簽名同意（resyncAtVersion 的 maxExecFeePerLeg）。
 * - cooldown：有新版、開了自動同步，但還在冷卻時間內（readyAt 之後別人才能代為同步；本人不受限）。
 *   冷卻從上次同步起算，從未同步過則從跟單當下起算（與合約 syncReadyAt 相同）。
 * - needsGas：有新版、開了自動同步，但油箱不夠付一次代為同步的成本。
 * - waiting：條件都滿足，等任何一個執行者（自己的 agent、平台 keeper、第三方）送出。
 * - waitingExecutor：條件都滿足，等跟隨者指定的那個執行者送出（其他人會被合約拒絕）。
 * - unknown：讀不到最新版或同步設定。
 */
export type SyncStatus =
  | { kind: 'upToDate' }
  | { kind: 'manual' }
  | { kind: 'feeAboveCap' }
  | { kind: 'cooldown'; readyAt: number }
  | { kind: 'needsGas'; shortfall: bigint }
  | { kind: 'waiting' }
  | { kind: 'waitingExecutor' }
  | { kind: 'unknown' }

export interface SyncStatusInput {
  recordVersion: bigint
  /** 交易者最新版的 versionId（0 起算）；讀不到為 null。 */
  latestVersion: bigint | null
  config: SyncConfig | null
  state: SyncState | null
  gasBalance: bigint | null
  executionFee: bigint | null
  /** 最新版有幾條腿；讀不到為 null。 */
  latestLegs: number | null
  nowSec: number
  /** 跟單當下（CopyRecord.copiedAt，Unix 秒）：從未同步過時冷卻從這裡起算。 */
  copiedAt?: number
  /** 跟隨者同意的每腿執行費（CopyTracker.syncExecFeeCap）；讀不到或合約沒有為 null／省略。 */
  execFeeCap?: bigint | null
  /** 跟隨者指定的執行者（CopyTracker.syncExecutor）；null／省略＝任何人。 */
  executor?: string | null
}

export function syncStatus(i: SyncStatusInput): SyncStatus {
  if (i.latestVersion === null) return { kind: 'unknown' }
  if (i.recordVersion >= i.latestVersion) return { kind: 'upToDate' }
  if (!i.config) return { kind: 'unknown' }
  if (!i.config.autoSync) return { kind: 'manual' }
  // 合約先查冷卻、再查執行費上限；畫面先顯示需要本人處理的那一項（冷卻會自己過去）。
  if (i.executionFee !== null && i.execFeeCap !== undefined && i.execFeeCap !== null && i.executionFee > i.execFeeCap) {
    return { kind: 'feeAboveCap' }
  }
  const since = i.state && i.state.lastSyncedAt > 0 ? i.state.lastSyncedAt : (i.copiedAt ?? 0)
  const readyAt = since + i.config.minSyncInterval
  if (since > 0 && i.nowSec < readyAt) return { kind: 'cooldown', readyAt }
  if (i.gasBalance !== null && i.executionFee !== null && i.latestLegs !== null) {
    const cost = syncCostWei(i.executionFee, i.latestLegs, i.config.tipWei, false)
    if (i.gasBalance < cost) return { kind: 'needsGas', shortfall: cost - i.gasBalance }
  }
  return i.executor ? { kind: 'waitingExecutor' } : { kind: 'waiting' }
}

/**
 * 跟單頁的自動同步卡要給什麼（ADR-024）。
 * - unsupported：這條鏈上的 CopyTracker 沒有自動同步——只說明跟單仍是快照式。
 * - expertOnly：Simple Mode——只說明要到專家模式開啟，不給勾選框。設定含槓桿上限，同步會依新版開新部位，
 *   是交易桌的入口；投資組合在 Simple Mode 也只給「關閉」、不給開啟與設定，兩頁說法一致。
 * - available：Expert Mode 而且合約支援——給勾選框與設定欄位。
 */
export type AutoSyncEntry = 'unsupported' | 'expertOnly' | 'available'

export function autoSyncEntry(supported: boolean, mode: 'simple' | 'expert'): AutoSyncEntry {
  if (!supported) return 'unsupported'
  return mode === 'expert' ? 'available' : 'expertOnly'
}

/**
 * 全站提醒（CopySyncNotice）：哪些紀錄落後交易者的最新版、其中哪些要本人處理。
 *
 * 沒有自己跑 agent 的人收不到 webhook；部位停在舊版時（沒開自動同步、油箱不足、執行費被調高……）
 * 他只能靠這個提醒知道。
 * - snapshot：合約不支援自動同步（status 為 null）——只能到投資組合更新到最新版。
 * - manual／needsGas／feeAboveCap：自動同步不會自己發生，要本人處理。
 * - 其餘（cooldown、waiting、waitingExecutor、unknown）只算落後，不算「要你處理」：冷卻會過去、執行者會送出。
 */
export type AttentionReason = 'snapshot' | 'manual' | 'needsGas' | 'feeAboveCap'

export interface AttentionItem {
  recordIdx: number
  recordVersion: bigint
  /** 交易者最新版的 versionId；讀不到為 null（不算落後，不猜）。 */
  latestVersion: bigint | null
  /** 合約支援自動同步時的同步狀態；不支援為 null。 */
  status: SyncStatus | null
}

export interface SyncAttention {
  /** 落後最新版的筆數。 */
  behind: number
  /** 其中要本人處理的筆數。 */
  needsYou: number
  /** 要本人處理的原因（去重，依嚴重程度排序）。 */
  reasons: AttentionReason[]
  /**
   * 「知道了」記住的是這一組（哪一筆、落後到哪一版）：交易者再發一版或多一筆落後，就再提醒一次。
   * 空字串＝沒有落後。
   */
  signature: string
}

const REASON_ORDER: readonly AttentionReason[] = ['feeAboveCap', 'needsGas', 'manual', 'snapshot']

export function syncAttention(items: readonly AttentionItem[]): SyncAttention {
  const behind = items.filter(i => i.latestVersion !== null && i.recordVersion < i.latestVersion)
  const reasons = new Set<AttentionReason>()
  let needsYou = 0
  for (const i of behind) {
    const r: AttentionReason | null = i.status === null
      ? 'snapshot'
      : i.status.kind === 'manual' || i.status.kind === 'needsGas' || i.status.kind === 'feeAboveCap'
        ? i.status.kind
        : null
    if (r) {
      needsYou += 1
      reasons.add(r)
    }
  }
  return {
    behind: behind.length,
    needsYou,
    reasons: REASON_ORDER.filter(r => reasons.has(r)),
    signature: behind
      .map(i => `${i.recordIdx}:${String(i.latestVersion)}`)
      .sort()
      .join(','),
  }
}

/** 畫面上的版本號從 1 起算（與動態牆「第 N 版」一致）；合約的 versionId 從 0 起算。 */
export const versionLabel = (versionId: bigint | number): string => String(Number(versionId) + 1)

/** 秒 → 時數字串（冷卻時間的顯示）。 */
export const hoursLabel = (seconds: number): string => {
  const h = seconds / 3600
  return Number.isInteger(h) ? String(h) : h.toFixed(1)
}

/** 使用者輸入的 ETH 字串 → wei；空字串、負數、格式錯誤回 null。最多 18 位小數。 */
export function parseEthInput(s: string): bigint | null {
  const v = s.trim()
  if (!/^\d+(\.\d{0,18})?$|^\.\d{1,18}$/.test(v)) return null
  const [whole, frac = ''] = v.split('.')
  return BigInt(whole || '0') * E18 + BigInt((frac + '0'.repeat(18)).slice(0, 18))
}
