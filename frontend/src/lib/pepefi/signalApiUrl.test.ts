import { it, expect, describe } from 'vitest'

import { resolveSignalApiUrl, DEFAULT_SIGNAL_API_URL } from './signalApiUrl'

describe('resolveSignalApiUrl', () => {
  it('未設定或空字串都退回預設部署', () => {
    expect(resolveSignalApiUrl(undefined)).toBe(DEFAULT_SIGNAL_API_URL)
    expect(resolveSignalApiUrl(null)).toBe(DEFAULT_SIGNAL_API_URL)
    expect(resolveSignalApiUrl('')).toBe(DEFAULT_SIGNAL_API_URL)
  })
  it('有值就用它，去掉結尾斜線', () => {
    expect(resolveSignalApiUrl('https://x.example.com/')).toBe('https://x.example.com')
  })
})
