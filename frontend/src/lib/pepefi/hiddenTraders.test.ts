import { describe, it, expect } from 'vitest'

import { isHiddenTrader } from './hiddenTraders'

// issue #383：ESG Master 的策略是照平台自評的 ESG 分數選股，分數拿掉後它就沒有依據。
// 它已經註冊在鏈上，從資料檔刪掉也還是會被 getAllTraders 讀到，所以由前端隱藏。

const ESG_MASTER_BASE_SEPOLIA = '0x7cd08d32F70F828781546adBdfe14dcA33fc115B'
const ESG_MASTER_LOCAL = '0xFABB0ac9d68B0B445fB7357272Ff202C5651694a'
const WHALE_ALPHA_BASE_SEPOLIA = '0x81D7d3bE29c09E9e9ead88203784e0F27892C162'

describe('isHiddenTrader', () => {
  it('Base Sepolia 上的 ESG Master 要隱藏，地址大小寫不影響', () => {
    expect(isHiddenTrader(84532, ESG_MASTER_BASE_SEPOLIA)).toBe(true)
    expect(isHiddenTrader(84532, ESG_MASTER_BASE_SEPOLIA.toLowerCase())).toBe(true)
  })

  it('本機回放鏈上的 ESG Master 也要隱藏', () => {
    expect(isHiddenTrader(31337, ESG_MASTER_LOCAL)).toBe(true)
  })

  it('名單依鏈分開：同一個地址在別條鏈上是別人', () => {
    expect(isHiddenTrader(31337, ESG_MASTER_BASE_SEPOLIA)).toBe(false)
    expect(isHiddenTrader(null, ESG_MASTER_BASE_SEPOLIA)).toBe(false)
  })

  it('其他交易者照常顯示', () => {
    expect(isHiddenTrader(84532, WHALE_ALPHA_BASE_SEPOLIA)).toBe(false)
  })
})
