import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { it, expect, describe } from 'vitest'

import { CARBON_FEE_SHARE_BPS, carbonSharePer100Usdc } from './carbon'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

describe('買入手續費的碳權比例', () => {
  it('跟合約的常數一致', () => {
    const source = fs.readFileSync(path.join(REPO, 'contracts/src/v2/AssetVaultV2_5.sol'), 'utf8')
    const match = source.match(/CARBON_FEE_SHARE_BPS = ([\d_]+);/)
    expect(Number(match?.[1].replaceAll('_', ''))).toBe(CARBON_FEE_SHARE_BPS)
  })

  it('同樣買 100 USDC，碳分級越高撥去退役的越多', () => {
    expect(carbonSharePer100Usdc('low')).toBe(0.025)
    expect(carbonSharePer100Usdc('mid')).toBe(0.1)
    expect(carbonSharePer100Usdc('high')).toBe(0.25)
  })

  it('未評等比照最保守的級距', () => {
    expect(carbonSharePer100Usdc('unrated')).toBe(carbonSharePer100Usdc('high'))
  })
})
