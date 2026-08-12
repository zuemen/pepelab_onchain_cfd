// 「鯨魚」的單一真相：門檻、分類、以及 feed 用的數字格式。
//
// 在這個檔案之前，同一個詞在 UI 裡有兩個互斥的定義：
//   - useWhaleAlerts 用「單筆 notional ≥ 5,000」決定誰進 whale banner；
//   - WhaleTrackerPage 的 whaleTier() 用「累積 volume ≥ 50,000 / 10,000」
//     把人分成 Mega Whale / Whale / Fish。
// 兩者的單位不同（單筆 vs 累積），所以一個剛被 banner 稱作鯨魚的地址，
// 在同一頁的排行榜裡可能顯示 🐟 Fish。使用者看到的是自相矛盾的產品。
//
// 這裡只保留「單筆」這一種單位，因為那才是 whale tracker 在回答的問題
// ——「現在錢往哪流」，而不是「誰歷史上做得最大」（後者是 Marketplace 的
// Star Trader Leaderboard 在做的事，依 reputation / followers / PnL 排序）。
//
// 分級也從「金額大小」換成「行為」：光看 $12k 說不出這筆有什麼特別，
// 說「50× 槓桿」或「這個地址本週第一次出現」才是情報。
//
// 保持純函式、不 import 任何 UI 或 ethers——理由同 chainLogs.ts：
// 這樣它可以被直接測試，而顏色留給元件層從 theme 取，不在 lib 裡寫死 hex。

// ── 門檻 ──────────────────────────────────────────────────────────────────────

/** 單筆 notional ≥ 5,000 mUSDC 才進 whale feed。18-dec。 */
export const WHALE_THRESHOLD = 5_000n * 10n ** 18n

/**
 * 使用者可選的門檻。
 *
 * 固定 $5k 這個數字是憑感覺挑的，而它跟實際的鏈上規模對不上：測試網上一週
 * 27 筆開倉、成交量 $32.8k，平均一筆約 $1.2k——**沒有任何一筆**過得了 $5k，
 * 於是這一頁的主角區永遠是空的。一個永遠空著的 feed 不是「沒有鯨魚」，
 * 是這把尺挑錯了刻度。
 *
 * 與其再猜一個常數，不如讓它可調：什麼叫「大」本來就依市場規模而定，
 * 而規模會隨這條鏈的使用量改變。
 */
export const WHALE_THRESHOLD_OPTIONS: ReadonlyArray<{ label: string; value: bigint }> = [
  { label: '$500',  value:    500n * 10n ** 18n },
  { label: '$1k',   value:  1_000n * 10n ** 18n },
  { label: '$5k',   value: WHALE_THRESHOLD },
  { label: '$25k',  value: 25_000n * 10n ** 18n },
]

/** 單筆 notional ≥ 50,000 mUSDC 掛 Mega 標籤。18-dec。 */
export const MEGA_THRESHOLD = 50_000n * 10n ** 18n

/** 槓桿 ≥ 20× 視為高風險，值得在 feed 上點名。 */
export const HIGH_LEVERAGE_X = 20n

// ── 型別 ──────────────────────────────────────────────────────────────────────

/**
 * 標籤的顏色意圖。元件層負責把它對應到 theme 的實際顏色，
 * 這個檔案不碰 hex —— 舊的 whaleTier 直接回 `{ bgcolor: 'rgba(0,184,217,.16)' }`，
 * 於是 dark/light 切換與品牌色改動都繞不過它。
 */
export type WhaleTone = 'gold' | 'danger' | 'info'

export interface WhaleTag {
  id: 'mega' | 'high-leverage' | 'new-face'
  label: string
  tone: WhaleTone
  /** 給 title / tooltip 用的一句解釋。 */
  hint: string
}

/** positionProfile 需要的最小資訊，開倉事件與未平倉列都滿足它。 */
export interface TradeLike {
  notional: bigint
  leverage: bigint
  /** 這個地址在本次掃描視窗內是不是第一次出現。呼叫端算，這裡只負責標。 */
  isFirstSeen?: boolean
}

// ── 判定 ──────────────────────────────────────────────────────────────────────

/** margin × leverage。三個地方各自 inline 算過同一條式子。 */
export const notionalOf = (margin: bigint, leverage: bigint): bigint => margin * leverage

/** 這一筆夠不夠格進 whale feed。整個 app 只有這一條判斷。 */
export const isWhaleTrade = (notional: bigint, threshold: bigint = WHALE_THRESHOLD): boolean =>
  notional >= threshold

/**
 * 這一筆值得被點名的原因，依重要性排序；平凡的鯨魚開倉回空陣列
 * （它本來就已經在 feed 上了，不需要再掛一個「鯨魚」標籤自我重複）。
 */
export function positionProfile(t: TradeLike): WhaleTag[] {
  const tags: WhaleTag[] = []

  if (t.notional >= MEGA_THRESHOLD) {
    tags.push({
      id: 'mega',
      label: 'Mega',
      tone: 'gold',
      hint: `Notional above ${fCompact(MEGA_THRESHOLD)}`,
    })
  }

  if (t.leverage >= HIGH_LEVERAGE_X) {
    tags.push({
      id: 'high-leverage',
      label: `${t.leverage}× leverage`,
      tone: 'danger',
      hint: 'Liquidates on a small move against the position',
    })
  }

  if (t.isFirstSeen) {
    tags.push({
      id: 'new-face',
      label: 'New face',
      tone: 'info',
      hint: 'First activity from this address in the scanned window',
    })
  }

  return tags
}

// ── 格式 ──────────────────────────────────────────────────────────────────────
// WhaleAlertBanner 與 DashboardPage 各自複製過一份 fNotional / timeAgo。
// 這裡是它們的來源。

/** 18-dec → 精簡金額：$840 / $12.4k / $1.2M。feed 與 KPI 用。 */
export function fCompact(v: bigint): string {
  const n = Number(v) / 1e18
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}k`
  return `${sign}$${abs.toFixed(0)}`
}

/** 18-dec → 完整金額：$12,400.00。表格用，精簡格式會蓋掉有意義的位數。 */
export function fUsd(v: bigint, d = 2): string {
  const n = Number(v) / 1e18
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })}`
}

/** 帶正負號的 PnL：+$1,240.00 / -$85.00。 */
export const fSignedUsd = (v: bigint, d = 2): string => (v >= 0n ? '+' : '') + fUsd(v, d)

/**
 * 相對時間。
 *
 * `nowSec` 可注入是為了能測——用真實時鐘測相對時間會得到一個隨時鐘漂移
 * 而閃爍的測試。未來的時間戳（節點時鐘偏移）夾成 'just now'，不顯示負秒數。
 */
export function timeAgo(ts: number, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const diff = nowSec - ts
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

/** LONG / SHORT。UI 統一英文，方向詞不再各頁自己寫三元運算。 */
export const sideLabel = (isLong: boolean): 'LONG' | 'SHORT' => (isLong ? 'LONG' : 'SHORT')

/** 方向的顏色意圖，同樣交給元件層對應 theme。 */
export const sideTone = (isLong: boolean): 'long' | 'short' => (isLong ? 'long' : 'short')
