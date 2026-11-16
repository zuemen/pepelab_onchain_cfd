import { describe, it, expect } from 'vitest'

import { SHOW_DIRECTION, spotTemplate } from './legDisplay'

// 2026-11-15 指導者：資產一律以 RWA 代幣現貨呈現
describe('spotTemplate', () => {
  it('旗標打開時原樣回傳', () => {
    expect(spotTemplate('{side} {asset} {weight}% · {leverage}×', true)).toBe('{side} {asset} {weight}% · {leverage}×')
  })

  it('拿掉 {side} 與 {leverage}×（含前面的分隔點），多餘空白收掉', () => {
    expect(spotTemplate('{side} {asset} {weight}% · {leverage}×', false)).toBe('{asset} {weight}%')
    expect(spotTemplate('{side}{asset} {weight}% {leverage}×', false)).toBe('{asset} {weight}%')
    expect(spotTemplate('{asset} {side} {weight}%', false)).toBe('{asset} {weight}%')
    expect(spotTemplate('{asset} {leverage}× @ {price}', false)).toBe('{asset} @ {price}')
  })

  it('括號裡講槓桿上限的補充整段拿掉', () => {
    expect(spotTemplate('任何人都能調整（上限 {lev}×），之後可關閉。', false)).toBe('任何人都能調整，之後可關閉。')
    expect(spotTemplate('anyone can move it (capped at {lev}×), with no need', false)).toBe('anyone can move it, with no need')
  })

  it('default 租戶預設不顯示方向（跟 SHOW_LEVERAGE 同一個旗標）', () => {
    expect(SHOW_DIRECTION).toBe(false)
  })
  it('拿掉方向後不留空括號、括號內不以逗號開頭（動態牆句子）', () => {
    expect(spotTemplate('新增一筆 {asset} 投資（{side}），總額 {notional}', false)).toBe('新增一筆 {asset} 投資，總額 {notional}')
    expect(spotTemplate('{asset}（{side}，總額 {notional}）的投資被自動結清', false)).toBe('{asset}（總額 {notional}）的投資被自動結清')
  })
})
