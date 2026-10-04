import path from 'node:path'
import { it, expect, describe } from 'vitest'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { ASSET_IDS } from 'src/contracts/addresses'

import {
  calendarOpen,
  SESSION_CLASS,
  sessionClassOf,
  closedForTrading,
  futureWeekendClosed,
} from './marketHours'

// 前端的時段規則是 keeper 的複製（見 marketHours.ts 開頭）。這支測試直接載入
// agent/keeper 的原始檔，逐點比對兩邊——任何一邊改了規則而另一邊沒跟上，這裡就紅。
//
// 用動態 import 而不是 `import … from '../../../../agent/keeper/market'`：靜態 import
// 會讓前端的 tsc 把 keeper 的檔案收進來型別檢查，而 keeper 用 `./x.ts` 副檔名 import，
// 在前端的 tsconfig 下會報錯。vitest 執行時照樣載入真正的 keeper 原始碼。

const KEEPER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../agent/keeper')

interface KeeperMarket {
  ASSET_CLASS: Record<string, string>
  calendarOpen: (cls: 'crypto' | 'equity' | 'future', nowSec: number) => boolean
  futureWeekendClosed: (nowSec: number) => boolean
}
interface KeeperOperator {
  modeClassOf: (symbol: string) => string
  switchesMode: (symbol: string) => boolean
}
interface KeeperMarketMode {
  closedForTrading: (symbols: readonly string[], nowSec: number, leadSec: number) => string[]
}

const load = <T,>(file: string): Promise<T> =>
  import(/* @vite-ignore */ pathToFileURL(path.join(KEEPER_DIR, file)).href) as Promise<T>

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000

/**
 * 比對用的時間格點：每 15 分鐘一點，涵蓋
 *   • 2026 夏令時間開始（3/8，日）所在的週四到下週三
 *   • 2026 夏令時間結束（11/1，日）所在的週四到下週三
 *   • 一個一般的十月週末（含週五 17:00 ET 黃金收盤）
 * 時段邊界（09:30、16:00、17:00、18:00 ET）都落在整 15 分鐘上，所以每個邊界的兩側
 * 都會被比到。keeper 每次呼叫都新建 Intl.DateTimeFormat，格點再密測試會慢到逾時。
 */
function grid(): number[] {
  const out: number[] = []
  const spans: [number, number][] = [
    [utc(2026, 3, 5), utc(2026, 3, 12)],
    [utc(2026, 10, 29), utc(2026, 11, 5)],
    [utc(2026, 10, 1), utc(2026, 10, 6)],
  ]
  for (const [from, to] of spans) {
    for (let ts = from; ts < to; ts += 900) out.push(ts)
  }
  return out
}

// keeper 的 nyClock 每次呼叫都新建 Intl.DateTimeFormat，整段格點跑下來要好幾秒。
describe('前端時段規則 ≡ agent/keeper', { timeout: 60_000 }, () => {
  it('資產分類表與 keeper 的 ASSET_CLASS 完全相同', async () => {
    const keeper = await load<KeeperMarket>('market.ts')
    expect(SESSION_CLASS).toEqual(keeper.ASSET_CLASS)
  })

  it('未分類資產的歸類規則相同（keeper 的 modeClassOf：當 equity，會切停單）', async () => {
    const op = await load<KeeperOperator>('operator.ts')
    for (const sym of [...Object.keys(ASSET_IDS), 'sNEW', 'PEPE']) {
      expect(sessionClassOf(sym), sym).toBe(op.modeClassOf(sym))
    }
  })

  it('calendarOpen 與 futureWeekendClosed 在整段格點上逐點相同', async () => {
    const keeper = await load<KeeperMarket>('market.ts')
    const mismatches: string[] = []
    for (const ts of grid()) {
      for (const cls of ['crypto', 'equity', 'future'] as const) {
        if (calendarOpen(cls, ts) !== keeper.calendarOpen(cls, ts)) {
          mismatches.push(`calendarOpen(${cls}, ${new Date(ts * 1000).toISOString()})`)
        }
      }
      if (futureWeekendClosed(ts) !== keeper.futureWeekendClosed(ts)) {
        mismatches.push(`futureWeekendClosed(${new Date(ts * 1000).toISOString()})`)
      }
    }
    expect(mismatches.slice(0, 10)).toEqual([])
  })

  it('「此刻休市」的資產集合 = keeper closedForTrading(leadSec = 0)，也就是 keeper 會切 ReduceOnly 的那些', async () => {
    const mode = await load<KeeperMarketMode>('marketMode.ts')
    const symbols = [...Object.keys(ASSET_IDS), 'sNEW']
    const mismatches: string[] = []
    for (const ts of grid()) {
      const ours = closedForTrading(symbols, ts)
      const theirs = mode.closedForTrading(symbols, ts, 0)
      if (ours.join(',') !== theirs.join(',')) {
        mismatches.push(`${new Date(ts * 1000).toISOString()}: 前端 [${ours}] ≠ keeper [${theirs}]`)
      }
    }
    expect(mismatches.slice(0, 5)).toEqual([])
  })

  it('格點真的涵蓋了開盤與休市兩種狀態（防止比對兩個永遠相同的常數）', () => {
    const states = new Set(grid().map((ts) => closedForTrading(['sAAPL', 'sGOLD', 'sBTC'], ts).join(',')))
    expect(states).toContain('')
    expect(states).toContain('sAAPL')
    expect(states).toContain('sAAPL,sGOLD')
  })
})
