import { it, expect, describe } from 'vitest'

import { t, interpolate } from 'src/locales'
import { LOCALES } from 'src/locales/catalogs'

import { ASSET_MODE, marketStatus, closedOrderWarning, type AssetModeProbe } from './marketStatus'

const utc = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000

const SAT = utc(2026, 10, 3, 17, 0) // 週六：美股、黃金休市
const MON_OPEN = utc(2026, 10, 5, 15, 0) // 週一 11:00 EDT：美股開盤

const supported = (mode: number | null): AssetModeProbe => ({ kind: 'supported', mode })
const UNSUPPORTED: AssetModeProbe = { kind: 'unsupported' }
const UNKNOWN: AssetModeProbe = { kind: 'unknown' }

describe('市場狀態徽章 · 三種鏈上狀態', () => {
  describe('支援 assetMode，且已被切換', () => {
    it('ReduceOnly 顯示「只能減倉」，不論行事曆', () => {
      for (const ts of [SAT, MON_OPEN]) {
        const s = marketStatus({ symbol: 'sAAPL', nowSec: ts, probe: supported(ASSET_MODE.ReduceOnly) })
        expect(s.kind).toBe('reduceOnly')
        expect(s.label).toBe('只能減倉')
        expect(s.short).toBe('只能減倉')
        expect(s.confirmBeforeOpen).toBe(false) // 鏈上會擋開倉，不必再提示
      }
    })

    it('Halted 顯示「暫停」，加密資產也一樣', () => {
      const s = marketStatus({ symbol: 'sBTC', nowSec: MON_OPEN, probe: supported(ASSET_MODE.Halted) })
      expect(s.kind).toBe('halted')
      expect(s.label).toBe('暫停')
      expect(s.tone).toBe('danger')
      expect(s.confirmBeforeOpen).toBe(false)
    })

    it('休市時的 ReduceOnly 仍記得「排定時段是休市」', () => {
      expect(marketStatus({ symbol: 'sGOLD', nowSec: SAT, probe: supported(ASSET_MODE.ReduceOnly) }).closed).toBe(true)
    })
  })

  describe('支援 assetMode，但為 Active', () => {
    it('開盤時顯示「開盤中」，不提示', () => {
      const s = marketStatus({ symbol: 'sAAPL', nowSec: MON_OPEN, probe: supported(ASSET_MODE.Active) })
      expect(s.kind).toBe('open')
      expect(s.label).toBe('開盤中')
      expect(s.confirmBeforeOpen).toBe(false)
    })

    it('休市但停單尚未生效：照實說會以收盤價成交，並在送出前提示', () => {
      const s = marketStatus({ symbol: 'sAAPL', nowSec: SAT, probe: supported(ASSET_MODE.Active) })
      expect(s.kind).toBe('closedActive')
      expect(s.label).toContain('收盤價成交')
      expect(s.short).toBe('休市')
      expect(s.confirmBeforeOpen).toBe(true)
      expect(closedOrderWarning(s.kind)).toBe(t.status.market.confirm.bodyActive)
    })

    it('加密資產週末仍是 24/7', () => {
      const s = marketStatus({ symbol: 'sETH', nowSec: SAT, probe: supported(ASSET_MODE.Active) })
      expect(s.kind).toBe('always')
      expect(s.closed).toBe(false)
    })

    it('模式讀不到（null）時只說休市，不猜停單有沒有生效', () => {
      const s = marketStatus({ symbol: 'sAAPL', nowSec: SAT, probe: supported(null) })
      expect(s.kind).toBe('closed')
      expect(s.label).toBe('休市中')
      expect(s.confirmBeforeOpen).toBe(false)
    })
  })

  describe('不支援 assetMode（線上舊 exchange，KNOWN_LIMITATIONS #31）', () => {
    it('休市：照實寫「此測試網部署未啟用休市停單，下單會以收盤價成交」', () => {
      const s = marketStatus({ symbol: 'sAAPL', nowSec: SAT, probe: UNSUPPORTED })
      expect(s.kind).toBe('closedNoStop')
      expect(s.label).toBe('休市中（此測試網部署未啟用休市停單，下單會以收盤價成交）')
      expect(s.tone).toBe('warn')
      expect(s.confirmBeforeOpen).toBe(true)
      expect(interpolate(closedOrderWarning(s.kind)!, { asset: 'sAAPL' })).toMatch(
        /^sAAPL 目前休市。此測試網部署未啟用休市停單/
      )
    })

    it('黃金週五 17:00 ET 起同樣適用', () => {
      expect(marketStatus({ symbol: 'sGOLD', nowSec: utc(2026, 10, 2, 20, 59), probe: UNSUPPORTED }).kind).toBe('open')
      expect(marketStatus({ symbol: 'sGOLD', nowSec: utc(2026, 10, 2, 21, 0), probe: UNSUPPORTED }).kind).toBe(
        'closedNoStop'
      )
    })

    it('開盤時就是開盤中；加密資產 24/7', () => {
      expect(marketStatus({ symbol: 'sAAPL', nowSec: MON_OPEN, probe: UNSUPPORTED }).kind).toBe('open')
      expect(marketStatus({ symbol: 'sBTC', nowSec: SAT, probe: UNSUPPORTED }).label).toBe('24/7 交易')
    })
  })

  describe('探測失敗（unknown）', () => {
    it('休市只說「休市中」，不宣稱有沒有停單，也不跳提示', () => {
      const s = marketStatus({ symbol: 'sAAPL', nowSec: SAT, probe: UNKNOWN })
      expect(s.kind).toBe('closed')
      expect(s.confirmBeforeOpen).toBe(false)
      expect(closedOrderWarning(s.kind)).toBeNull()
    })
  })
})

describe('徽章與版本列文案不帶品牌', () => {
  it('status 命名空間（兩種語系）沒有 Pepe 字樣——demo-bank 租戶顯示同一組文案', () => {
    for (const code of Object.keys(LOCALES) as (keyof typeof LOCALES)[]) {
      expect(JSON.stringify(LOCALES[code].catalog.status), code).not.toMatch(/pepe/i)
    }
  })
})
