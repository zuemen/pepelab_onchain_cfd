import { it, expect, describe } from 'vitest'

import {
  kycSubmitArgs,
  generateSalt,
  normalizeName,
  isCommitmentHash,
  buildKycSubmission,
  verifyKycCommitment,
} from './kycCommitment'

const SALT = '0x' + '11'.repeat(32)

describe('buildKycSubmission — 個資不上鏈', () => {
  it('送出的參數只有兩個 32-byte 雜湊，不含原始姓名或國籍字串', () => {
    const name = 'Alice Chen 陳小美'
    const args = kycSubmitArgs(buildKycSubmission(name, 'TW'))
    expect(args).toHaveLength(2)
    for (const a of args) {
      expect(isCommitmentHash(a)).toBe(true)
      expect(a).not.toContain('Alice')
      expect(a.toLowerCase()).not.toContain('alice')
      expect(a).not.toContain('陳小美')
    }
    const joined = JSON.stringify(args)
    expect(joined).not.toContain(name)
    expect(joined).not.toContain(normalizeName(name))
    expect(joined).not.toContain('"TW"')
  })

  it('同一組 salt 與資料得到同一組雜湊；換 salt 就完全不同', () => {
    const a = buildKycSubmission('Alice', 'TW', SALT)
    const b = buildKycSubmission('  alice ', 'tw', SALT)
    expect(a.nameHash).toBe(b.nameHash)
    expect(a.nationalityHash).toBe(b.nationalityHash)
    const c = buildKycSubmission('Alice', 'TW', '0x' + '22'.repeat(32))
    expect(c.nameHash).not.toBe(a.nameHash)
    expect(c.nationalityHash).not.toBe(a.nationalityHash)
  })

  it('姓名與國籍各自一個雜湊（不同值就不同）', () => {
    const s = buildKycSubmission('Bob', 'TW', SALT)
    expect(s.nameHash).not.toBe(s.nationalityHash)
  })

  it('每次產生的 salt 都是 32 bytes 且不重複', () => {
    const a = generateSalt()
    const b = generateSalt()
    expect(isCommitmentHash(a)).toBe(true)
    expect(a).not.toBe(b)
  })

  it('拒絕格式錯誤的 salt', () => {
    expect(() => buildKycSubmission('Alice', 'TW', '0x1234')).toThrow()
  })
})

describe('verifyKycCommitment — 審核員線下比對', () => {
  it('使用者出示正確的 salt 與資料時兩者都相符', () => {
    const s = buildKycSubmission('Alice Chen', 'TW', SALT)
    expect(
      verifyKycCommitment({ salt: SALT, fullName: 'alice  chen', nationality: 'tw', onChainName: s.nameHash, onChainNationality: s.nationalityHash }),
    ).toEqual({ nameMatches: true, nationalityMatches: true })
  })

  it('資料不符時回 false', () => {
    const s = buildKycSubmission('Alice Chen', 'TW', SALT)
    expect(
      verifyKycCommitment({ salt: SALT, fullName: 'Bob', nationality: 'JP', onChainName: s.nameHash, onChainNationality: s.nationalityHash }),
    ).toEqual({ nameMatches: false, nationalityMatches: false })
  })
})

describe('isCommitmentHash', () => {
  it('分得出舊版明文與新版雜湊', () => {
    expect(isCommitmentHash('路人甲')).toBe(false)
    expect(isCommitmentHash('TW')).toBe(false)
    expect(isCommitmentHash(buildKycSubmission('x', 'TW', SALT).nameHash)).toBe(true)
  })
})
