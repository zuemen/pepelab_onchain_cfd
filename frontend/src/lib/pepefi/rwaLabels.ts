// RWA 透明度頁共用的顯示轉換（純函式，可測）。

import type { Reading } from './contractProbe'

import { t, interpolate } from 'src/locales'

import { ageUnit } from './oracleWitness'

/** Reading → 顯示字串：ok 套用 fmt；不存在的函式與讀取失敗分開講。 */
export function readingText<T>(r: Reading<T> | undefined, fmt: (v: T) => string): string {
  if (!r) return t.rwa.common.loading
  if (r.status === 'ok') return fmt(r.value)
  return r.status === 'unsupported' ? t.rwa.common.notInDeployment : t.rwa.common.readFailed
}

/** 秒數 → 「12 分鐘」這種字串。 */
export function ageText(sec: number): string {
  const { unit, n } = ageUnit(sec)
  return interpolate(t.rwa.common[unit], { n: String(n) })
}

/** unix 秒 → 本機時間字串（YYYY-MM-DD HH:mm，24 小時制）。 */
export function timeText(sec: number): string {
  const d = new Date(sec * 1000)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 帶正負號的 bps 字串。 */
export function signedBps(bps: number): string {
  return interpolate(t.rwa.common.bps, { n: `${bps > 0 ? '+' : ''}${bps}` })
}

/** USD 價格：≥ 1000 兩位小數，小價格四位有效。 */
export function usd(n: number): string {
  const dp = n >= 1000 ? 2 : n >= 1 ? 2 : 4
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
}
