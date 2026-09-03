import { it, expect, describe } from 'vitest'

import { paths } from 'src/routes/paths'

import { navData, navDataForMode } from './nav-config-dashboard'

// issue #101 — Mode 分流 11 / 11. `mode-context.test.ts` is the precedent:
// pure-logic, no DOM. This pins which entries the sidebar shows per mode.

const pathsOf = (data: ReturnType<typeof navDataForMode>) =>
  data.flatMap((section) => section.items.map((i) => i.path))

describe('navDataForMode — expert', () => {
  it('回傳完整的 navData,一個字都不動(口試要用)', () => {
    expect(navDataForMode('expert')).toBe(navData)
  })
})

describe('navDataForMode — simple', () => {
  const simple = navDataForMode('simple')
  const simplePaths = pathsOf(simple)

  it('只有一個區塊', () => {
    expect(simple).toHaveLength(1)
  })

  it('恰好 8 個側邊欄入口——其餘 3 個 Simple 頁面(Landing / Copy / TraderProfile)不在側邊欄', () => {
    expect(simplePaths).toHaveLength(8)
  })

  it('投資人視角需要的入口都在', () => {
    for (const p of [
      paths.pepefi.portfolio,
      paths.pepefi.marketplace,
      paths.pepefi.tokens,
      paths.pepefi.esg,
      paths.pepefi.history,
      paths.pepefi.sessions,
      paths.pepefi.exchange,
      paths.pepefi.pepe,
    ]) {
      expect(simplePaths, p).toContain(p)
    }
  })

  it('賭場信號與進階工具收進 Expert——Simple 側邊欄看不到', () => {
    for (const p of [
      paths.pepefi.whale,
      paths.pepefi.terminal,
      paths.pepefi.vault,
      paths.pepefi.rewards,
      paths.pepefi.x402,
      paths.pepefi.agentMonitor,
      paths.pepefi.trader,
      paths.pepefi.stake,
    ]) {
      expect(simplePaths, p).not.toContain(p)
    }
  })

  it('每個 Simple 入口都對應到一個真的 navData 項目——沒有被靜默 filter 掉的死路徑', () => {
    const allNavPaths = pathsOf(navData)
    for (const p of simplePaths) {
      expect(allNavPaths, p).toContain(p)
    }
    // 側邊欄項目都帶標題,不是空殼
    for (const item of simple[0].items) {
      expect(typeof item.title === 'string' ? item.title.length : 1).toBeGreaterThan(0)
    }
  })

  it('#101 的新增項目確實是這次才進 Simple 的(marketplace / esg / history / sessions)', () => {
    for (const p of [paths.pepefi.marketplace, paths.pepefi.esg, paths.pepefi.history, paths.pepefi.sessions]) {
      expect(simplePaths).toContain(p)
    }
  })
})
