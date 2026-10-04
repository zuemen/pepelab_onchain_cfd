// 交易頁的市場狀態徽章（純函式，可測）。
//
// 兩個獨立的事實合成一個徽章：
//   1. 排定時段：此刻依行事曆是否休市（marketHours.ts，與 keeper 同一套規則）。
//   2. 鏈上停單：exchange 有沒有 per-asset 的 assetMode，有的話這個資產現在是哪一個。
//
// 為什麼不能只看時段：休市時能不能開倉是 exchange 決定的，不是行事曆。線上的舊 exchange
// 沒有 assetMode（KNOWN_LIMITATIONS #31），休市照樣成交、以最後收盤價入場——這件事要照實
// 寫在徽章上，而不是只寫「休市中」讓人以為單會被擋。反過來，新版 exchange 被 keeper 切成
// ReduceOnly 時，徽章顯示鏈上真正的狀態（只能減倉），不用行事曆去猜。

import { t } from 'src/locales'

import { marketClosed, sessionClassOf } from './marketHours'

/** 與 PerpetualExchange.AssetMode 同序（closeGuard.ts 也用同一組值）。 */
export const ASSET_MODE = { Active: 0, ReduceOnly: 1, Halted: 2 } as const

/**
 * exchange 是否支援 assetMode，以及這個資產的模式。
 *   supported   — runtime bytecode 有 assetMode(bytes32)；mode = 讀到的值，null = 這次讀不到。
 *   unsupported — bytecode 沒有這個 selector（舊部署）：休市不會停單。
 *   unknown     — 連 bytecode 都讀不到（RPC 問題、未連線）：不對停單下任何結論。
 */
export type AssetModeProbe =
  | { kind: 'supported'; mode: number | null }
  | { kind: 'unsupported' }
  | { kind: 'unknown' }

export type MarketBadgeKind =
  /** 加密資產 24/7（且鏈上沒有停單）。 */
  | 'always'
  | 'open'
  /** 休市，但停單與否不明（探測失敗或模式讀不到）——只說休市，不多說。 */
  | 'closed'
  /** 休市，而 exchange 沒有 assetMode：下單會以收盤價成交。 */
  | 'closedNoStop'
  /** 休市，exchange 支援停單但這個資產仍是 Active（keeper 尚未切換）。 */
  | 'closedActive'
  | 'reduceOnly'
  | 'halted'

export type MarketTone = 'ok' | 'warn' | 'danger' | 'muted'

export interface MarketStatus {
  kind: MarketBadgeKind
  /** 依排定時段此刻是否休市（與鏈上模式無關）。 */
  closed: boolean
  tone: MarketTone
  /** 資產標頭用的完整句子。 */
  label: string
  /** 市場列表用的短標籤。 */
  short: string
  /** 送出開倉前要不要先請使用者確認一次（休市而且單會成交）。不擋單。 */
  confirmBeforeOpen: boolean
}

const TONE: Record<MarketBadgeKind, MarketTone> = {
  always: 'ok',
  open: 'ok',
  closed: 'muted',
  closedNoStop: 'warn',
  closedActive: 'warn',
  reduceOnly: 'warn',
  halted: 'danger',
}

function kindOf(symbol: string, nowSec: number, probe: AssetModeProbe): { kind: MarketBadgeKind; closed: boolean } {
  const closed = marketClosed(symbol, nowSec)
  // 鏈上模式優先：被切成 ReduceOnly／Halted 時，不論行事曆怎麼說，這就是使用者會遇到的事。
  if (probe.kind === 'supported' && probe.mode === ASSET_MODE.Halted) return { kind: 'halted', closed }
  if (probe.kind === 'supported' && probe.mode === ASSET_MODE.ReduceOnly) return { kind: 'reduceOnly', closed }
  if (!closed) return { kind: sessionClassOf(symbol) === 'crypto' ? 'always' : 'open', closed }
  if (probe.kind === 'unsupported') return { kind: 'closedNoStop', closed }
  if (probe.kind === 'supported' && probe.mode === ASSET_MODE.Active) return { kind: 'closedActive', closed }
  return { kind: 'closed', closed }
}

export function marketStatus(a: { symbol: string; nowSec: number; probe: AssetModeProbe }): MarketStatus {
  const { kind, closed } = kindOf(a.symbol, a.nowSec, a.probe)
  const s = t.status.market
  const short =
    kind === 'closedNoStop' || kind === 'closedActive' ? s.short.closed : s.short[kind]
  return {
    kind,
    closed,
    tone: TONE[kind],
    label: s.badge[kind],
    short,
    confirmBeforeOpen: kind === 'closedNoStop' || kind === 'closedActive',
  }
}

/** 下單前確認框的內文（只有 confirmBeforeOpen 的兩種情況有）。 */
export function closedOrderWarning(kind: MarketBadgeKind): string | null {
  if (kind === 'closedNoStop') return t.status.market.confirm.bodyNoStop
  if (kind === 'closedActive') return t.status.market.confirm.bodyActive
  return null
}
