import { it, expect, describe } from 'vitest'

import {
  toKycReceipt,
  kycSubmitArgs,
  loadKycReceipts,
  legacyReceiptKey,
  promoteKycReceipt,
  sanitizeKycReceipt,
  savePendingKycReceipt,
  clearPendingKycReceipt,
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

describe('KYC 收據（localStorage）', () => {
  const LOC = { chainId: 84532, registry: '0xAbC0000000000000000000000000000000000001', user: '0xDef0000000000000000000000000000000000002' }
  const TX1 = '0x' + '1'.repeat(64)
  const TX2 = '0x' + '2'.repeat(64)

  const withFakeStorage = (fn: (store: Map<string, string>) => void) => {
    const store = new Map<string, string>()
    const g = globalThis as { localStorage?: unknown }
    const prev = g.localStorage
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
    }
    try { fn(store) } finally { g.localStorage = prev }
  }

  const receipt = (name: string, salt: string, txHash: string | null, createdAt: number) =>
    toKycReceipt(buildKycSubmission(name, 'TW', salt), { ...LOC, txHash, createdAt })

  it('只存 salt 與兩個雜湊，不存明文姓名與國籍', () => {
    const r = toKycReceipt(buildKycSubmission('Alice Chen 陳小美', 'TW', SALT), { ...LOC, txHash: null })
    const json = JSON.stringify(r)
    expect(json).not.toMatch(/alice/i)
    expect(json).not.toContain('陳小美')
    expect(json).not.toContain('"TW"')
    expect(Object.keys(r)).not.toContain('fullName')
    expect(Object.keys(r)).not.toContain('normalizedName')
  })

  it('舊收據在「重送＋取消」之後仍在（pending 與 history 分開）', () => {
    withFakeStorage(() => {
      // 第一次：送出成功，升格進 history
      const first = receipt('Alice', SALT, null, 1)
      expect(savePendingKycReceipt(first)).toBe(true)
      expect(promoteKycReceipt({ ...first, txHash: TX1 })).toBe(true)
      // 第二次：送出前寫 pending，然後錢包取消 → 只刪 pending
      const salt2 = '0x' + '22'.repeat(32)
      savePendingKycReceipt(receipt('Alice', salt2, null, 2))
      clearPendingKycReceipt(LOC, salt2)
      const got = loadKycReceipts(LOC)
      expect(got.pending).toEqual([])
      expect(got.history.map((r) => r.txHash)).toEqual([TX1])
      expect(got.history[0].salt).toBe(SALT)
    })
  })

  it('以 txHash 保存多份，新到舊；同一個 txHash 覆寫；位址大小寫不影響', () => {
    withFakeStorage(() => {
      promoteKycReceipt({ ...receipt('A', SALT, null, 1), txHash: TX1 })
      promoteKycReceipt({ ...receipt('B', '0x' + '33'.repeat(32), null, 5), txHash: TX2 })
      promoteKycReceipt({ ...receipt('A', SALT, null, 3), txHash: TX1.toUpperCase().replace('0X', '0x') })
      const got = loadKycReceipts({ ...LOC, user: LOC.user.toLowerCase(), registry: LOC.registry.toUpperCase().replace('0X', '0x') })
      expect(got.history.map((r) => r.createdAt)).toEqual([5, 3])
    })
  })

  it('沒拿到 tx hash 的 pending 會被讀出來（頁面在錢包彈窗時被關掉）', () => {
    withFakeStorage(() => {
      savePendingKycReceipt(receipt('A', SALT, null, 9))
      expect(loadKycReceipts(LOC).pending.map((r) => r.salt)).toEqual([SALT])
    })
  })

  it('讀取舊版單一 key：白名單清洗（清掉明文）、搬進 history、刪除舊 key', () => {
    withFakeStorage((store) => {
      const old = { ...receipt('Alice', SALT, TX1, 7), fullName: 'Alice', nationality: 'TW', normalizedName: 'alice' }
      store.set(legacyReceiptKey(LOC), JSON.stringify(old))
      const got = loadKycReceipts(LOC)
      expect(got.history).toHaveLength(1)
      expect(Object.keys(got.history[0])).not.toContain('fullName')
      expect(store.has(legacyReceiptKey(LOC))).toBe(false)
      expect([...store.values()].join()).not.toMatch(/alice/i)
    })
  })

  it('pending 以 salt 為索引：clearPending 只刪 salt 相符的那一筆', () => {
    withFakeStorage(() => {
      const s2 = '0x' + '44'.repeat(32)
      savePendingKycReceipt(receipt('A', SALT, null, 1))
      savePendingKycReceipt(receipt('B', s2, null, 2))
      clearPendingKycReceipt(LOC, SALT)
      expect(loadKycReceipts(LOC).pending.map((r) => r.salt)).toEqual([s2])
      // 升格只清同 salt 的 pending
      promoteKycReceipt({ ...receipt('C', '0x' + '55'.repeat(32), null, 3), txHash: TX2 })
      expect(loadKycReceipts(LOC).pending.map((r) => r.salt)).toEqual([s2])
    })
  })

  it('舊版單一 key 沒有 txHash：清洗後放進 pending，不刪除 salt', () => {
    withFakeStorage((store) => {
      const old = { ...receipt('Alice', SALT, null, 7), fullName: 'Alice', nationality: 'TW' }
      store.set(legacyReceiptKey(LOC), JSON.stringify(old))
      const got = loadKycReceipts(LOC)
      expect(got.history).toEqual([])
      expect(got.pending.map((r) => r.salt)).toEqual([SALT])
      expect(Object.keys(got.pending[0])).not.toContain('fullName')
      expect(store.has(legacyReceiptKey(LOC))).toBe(false)
      expect([...store.values()].join()).not.toMatch(/alice/i)
      // 再讀一次仍在（沒有被刪）
      expect(loadKycReceipts(LOC).pending.map((r) => r.salt)).toEqual([SALT])
    })
  })

  it('sanitizeKycReceipt 丟掉白名單以外的欄位、格式錯誤回 null', () => {
    expect(sanitizeKycReceipt({ salt: 1 })).toBeNull()
    const s = sanitizeKycReceipt({ ...receipt('A', SALT, TX1, 1), fullName: 'A' })
    expect(s && Object.keys(s).sort()).toEqual(
      ['chainId', 'createdAt', 'nameHash', 'nationalityHash', 'registry', 'salt', 'scheme', 'txHash', 'user'],
    )
  })

  it('沒有 localStorage（私密模式、node）時不丟例外', () => {
    const g = globalThis as { localStorage?: unknown }
    const prev = g.localStorage
    g.localStorage = undefined
    try {
      expect(savePendingKycReceipt(receipt('A', SALT, null, 1))).toBe(false)
      expect(loadKycReceipts(LOC)).toEqual({ history: [], pending: [] })
      expect(() => clearPendingKycReceipt(LOC, SALT)).not.toThrow()
    } finally { g.localStorage = prev }
  })
})
