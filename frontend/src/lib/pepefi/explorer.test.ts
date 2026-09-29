import { it, expect, describe } from 'vitest'

import { explorerTx, explorerAddr, explorerName, explorerBase } from './explorer'

const ADDR = '0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842'
const TX = '0x' + 'ab'.repeat(32)

describe('explorer — 依 chainId 選瀏覽器', () => {
  it('84532 用 BaseScan（Base Sepolia）', () => {
    expect(explorerAddr(ADDR, 84532)).toBe(`https://sepolia.basescan.org/address/${ADDR}`)
    expect(explorerTx(TX, 84532)).toBe(`https://sepolia.basescan.org/tx/${TX}`)
    expect(explorerName(84532)).toBe('BaseScan')
  })

  it('11155111 用 Etherscan（Ethereum Sepolia）', () => {
    expect(explorerAddr(ADDR, 11155111)).toBe(`https://sepolia.etherscan.io/address/${ADDR}`)
    expect(explorerName(11155111)).toBe('Etherscan')
  })

  it('本機／未知鏈不產生連結', () => {
    expect(explorerBase(31337)).toBeNull()
    expect(explorerAddr(ADDR, null)).toBeNull()
    expect(explorerTx(TX, undefined)).toBeNull()
    expect(explorerName(31337)).toBe('Explorer')
  })
})
