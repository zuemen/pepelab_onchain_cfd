import { describe, it, expect } from 'vitest'

import {
  PEPE_EVOLUTION_STAGES,
  EVOLUTION_HOLDING_DAYS,
  evolutionStageFor,
  getEvolutionStage,
} from './PepeEvolution'

// issue #101 — 進化改由「組合加權碳強度 + 持有時長」驅動。同一套七階段美術，
// 換掉輸入。這份測試釘住那條映射，不渲染任何元件。

describe('evolutionStageFor', () => {
  it('剛買進(0 天、尚無碳資料):第 0 階「蛙蛋」', () => {
    expect(evolutionStageFor(null, 0).stage).toBe(0)
  })

  it('持有天數推進階段——低碳組合不設限,730 天到頂(蛙神)', () => {
    expect(evolutionStageFor(0.15, 0).stage).toBe(0)
    expect(evolutionStageFor(0.15, 7).stage).toBe(1)
    expect(evolutionStageFor(0.15, 30).stage).toBe(2)
    expect(evolutionStageFor(0.15, 90).stage).toBe(3)
    expect(evolutionStageFor(0.15, 180).stage).toBe(4)
    expect(evolutionStageFor(0.15, 365).stage).toBe(5)
    expect(evolutionStageFor(0.15, 730).stage).toBe(6)
  })

  it('天數落在門檻之間取較低階', () => {
    expect(evolutionStageFor(0.15, 89).stage).toBe(2)
    expect(evolutionStageFor(0.15, 729).stage).toBe(5)
  })

  it('高碳組合(>8)無論持有多久,最高只到第 3 階', () => {
    expect(evolutionStageFor(10.2, 730).stage).toBe(3)
    expect(evolutionStageFor(8.001, 100000).stage).toBe(3)
  })

  it('中碳組合(1–8)最高到第 5 階「蛙皇」,到不了蛙神', () => {
    expect(evolutionStageFor(4.34, 730).stage).toBe(5)
    expect(evolutionStageFor(8, 730).stage).toBe(5) // 剛好 8 仍是中碳
    expect(evolutionStageFor(1, 730).stage).toBe(5) // 剛好 1 是中碳下界
  })

  it('未評等組合(null)當成高碳封頂——「沒有資料」不是「沒問題」', () => {
    expect(evolutionStageFor(null, 730).stage).toBe(3)
  })

  it('低碳下界:剛好低於 1 不設限', () => {
    expect(evolutionStageFor(0.999, 730).stage).toBe(6)
  })

  it('負持有天數夾到第 0 階', () => {
    expect(evolutionStageFor(0.1, -5).stage).toBe(0)
  })

  it('回傳的是 PEPE_EVOLUTION_STAGES 裡的同一個物件(同一套美術)', () => {
    expect(PEPE_EVOLUTION_STAGES).toContain(evolutionStageFor(0.15, 90))
    expect(EVOLUTION_HOLDING_DAYS).toHaveLength(PEPE_EVOLUTION_STAGES.length)
  })
})

describe('getEvolutionStage(level) — 舊的等級驅動仍保留給藥水/XP 迴圈', () => {
  it('沒有被移除', () => {
    expect(getEvolutionStage(1).stage).toBe(0)
    expect(getEvolutionStage(30).stage).toBe(6)
  })
})
