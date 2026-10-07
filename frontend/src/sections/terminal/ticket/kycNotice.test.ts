import { it, expect, describe } from 'vitest'

import { kycTicketNotice } from './kycNotice'

describe('kycTicketNotice', () => {
  it('舊 allowlist 登錄：指向 Exchange 頁送出申請', () => {
    expect(kycTicketNotice('sAAPL', { unknown: false, pending: false, vcAction: 'legacy' })).toContain('Exchange')
  })

  it('VC 准入登錄（以及確認中／讀不到種類）：不再叫人去 Exchange 頁送出申請', () => {
    for (const vcAction of ['credentials', 'checking', 'unknown'] as const) {
      const msg = kycTicketNotice('sGOLD', { unknown: false, pending: false, vcAction })
      expect(msg).toContain('sGOLD')
      expect(msg).toContain('合格投資人')
      expect(msg).not.toContain('Exchange')
    }
  })

  it('讀取失敗與審核中的說法優先', () => {
    expect(kycTicketNotice('sGOLD', { unknown: true, pending: false, vcAction: 'credentials' })).toContain('fail-closed')
    expect(kycTicketNotice('sAAPL', { unknown: false, pending: true, vcAction: 'legacy' })).toContain('等待審核')
  })
})
