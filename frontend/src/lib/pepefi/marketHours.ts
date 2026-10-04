// 市場時段：美股／ETF 正規盤、黃金（COMEX）週末休市、加密 24/7。
//
// 這份是 agent/keeper 的時段規則的**逐字複製**，不是另一套規則：
//   • SESSION_CLASS            ← agent/keeper/market.ts 的 ASSET_CLASS
//   • sessionClassOf           ← agent/keeper/operator.ts 的 modeClassOf（未分類當 equity）
//   • calendarOpen             ← agent/keeper/market.ts 的 calendarOpen
//   • futureWeekendClosed      ← agent/keeper/market.ts 的 futureWeekendClosed
//   • closedForTrading         ← agent/keeper/marketMode.ts 的 closedForTrading（leadSec = 0）
//
// 為什麼複製而不是 import：前端的 tsconfig 只收 src/，keeper 的檔案用 `./x.ts` 副檔名
// import（前端沒開 allowImportingTsExtensions），而 keeper 由 GitHub 排程在線上執行，
// 不該為了前端顯示改它的模組邊界。分歧由 marketHours.keeper.test.ts 擋：它直接載入
// keeper 的原始檔，在跨越夏令時間切換的整段時間格點上逐點比對兩邊的結果。
// frontend-ci.yml 的 paths 也列了這兩個 keeper 檔，改 keeper 一定會跑到那支測試。
//
// 只看行事曆、不含假日（keeper 的行事曆後備也不含）。這裡回答的是「此刻依排定時段
// 是否休市」，不是「交易所是否真的停單」——後者要看鏈上 assetMode（marketStatus.ts）。
//
// 這個檔案不 import 任何東西。

export type SessionClass = 'crypto' | 'equity' | 'future'

/** 與 agent/keeper/market.ts 的 ASSET_CLASS 相同（一致性測試逐鍵比對）。 */
export const SESSION_CLASS: Record<string, SessionClass> = {
  sBTC: 'crypto',
  sETH: 'crypto',
  sAAPL: 'equity',
  sTSLA: 'equity',
  sNVDA: 'equity',
  sMSFT: 'equity',
  sGOOGL: 'equity',
  sBOND: 'equity', // BGRN（ETF）
  sICLN: 'equity', // ETF
  sESGU: 'equity', // ETF
  sGOLD: 'future', // GC=F（COMEX 黃金期貨）
}

/**
 * 休市判斷用的類別。與 keeper 的 modeClassOf 同一條規則：未分類的資產當 equity——
 * 對「休市時能不能開倉」而言 crypto 是最寬鬆的預設（永遠開），新資產忘了分類時寧可
 * 顯示休市，也不要在休市時說「開盤中」。
 */
export function sessionClassOf(symbol: string): SessionClass {
  return SESSION_CLASS[symbol] ?? 'equity'
}

/** America/New_York 的星期（0=Sun）與當日分鐘數。夏令時間由 Intl 時區資料處理。 */
let nyFormat: Intl.DateTimeFormat | null = null

function nyClock(nowSec: number): { dow: number; min: number } {
  // 與 keeper 相同的格式設定；建一次重用（徽章每次重繪、列表每一列都會呼叫）。
  nyFormat ??= new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = nyFormat.formatToParts(new Date(nowSec * 1000))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))
  return { dow, min: Number(get('hour')) * 60 + Number(get('minute')) }
}

/**
 * 靜態行事曆（不含假日）：
 *   equity — 週一至週五 09:30–16:00 ET
 *   future — COMEX 金屬：週日 18:00 ET 到週五 17:00 ET，每日 17:00–18:00 休息
 *   crypto — 永遠開
 */
export function calendarOpen(cls: SessionClass, nowSec: number): boolean {
  if (cls === 'crypto') return true
  const { dow, min } = nyClock(nowSec)
  if (cls === 'equity') return dow >= 1 && dow <= 5 && min >= 9 * 60 + 30 && min < 16 * 60
  // future
  if (dow === 6) return false
  if (dow === 0) return min >= 18 * 60
  if (dow === 5) return min < 17 * 60
  return min < 17 * 60 || min >= 18 * 60
}

/**
 * COMEX 週末休市窗口：週五 17:00 ET 到週日 18:00 ET（不含假日）。
 * 每天 17:00–18:00 ET 的一小時休息不算——keeper 在那一小時也不切停單。
 */
export function futureWeekendClosed(nowSec: number): boolean {
  const { dow, min } = nyClock(nowSec)
  if (dow === 6) return true
  if (dow === 5) return min >= 17 * 60
  if (dow === 0) return min < 18 * 60
  return false
}

/**
 * 此刻依排定時段是否休市（＝keeper 在這個時刻、不算收盤提前量時會切 ReduceOnly 的那些）：
 *   crypto — 永遠 false（24/7）
 *   equity — 正規盤以外
 *   future — 只有週末窗口（每日一小時休息不算）
 */
export function marketClosed(symbol: string, nowSec: number): boolean {
  const cls = sessionClassOf(symbol)
  if (cls === 'crypto') return false
  if (cls === 'equity') return !calendarOpen('equity', nowSec)
  return futureWeekendClosed(nowSec)
}

/** 對應 keeper 的 closedForTrading(symbols, nowSec, 0)：此刻休市的資產。 */
export function closedForTrading(symbols: readonly string[], nowSec: number): string[] {
  return symbols.filter((s) => marketClosed(s, nowSec))
}
