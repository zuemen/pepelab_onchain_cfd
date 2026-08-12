import { it, vi, expect, describe, afterEach, beforeEach } from 'vitest'

import { readStoredMode, writeStoredMode } from './mode-context'

const STORAGE_KEY = 'pepefi:mode'

/**
 * vitest.config.ts runs this suite under the `node` environment (no jsdom),
 * matching the rest of the pepefi lib tests, which are pure-logic and never
 * need a DOM. `localStorage` doesn't exist here, so a minimal in-memory
 * stand-in is installed as the global for each test — just enough surface
 * (get/set/clear, and methods that can be made to throw) to exercise the
 * try/catch paths mode-context.tsx defends with.
 */
function fakeLocalStorage() {
  const store = new Map<string, string>()
  return {
    getItem: vi.fn((k: string) => store.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => { store.set(k, v) }),
    clear: vi.fn(() => store.clear()),
  }
}

let storage: ReturnType<typeof fakeLocalStorage>

beforeEach(() => {
  storage = fakeLocalStorage()
  vi.stubGlobal('localStorage', storage)
})

afterEach(() => vi.unstubAllGlobals())

describe('readStoredMode', () => {
  it('defaults to simple when nothing is stored', () => {
    expect(readStoredMode()).toBe('simple')
  })

  it('reads a valid stored mode', () => {
    storage.setItem(STORAGE_KEY, 'expert')
    expect(readStoredMode()).toBe('expert')
    storage.setItem(STORAGE_KEY, 'simple')
    expect(readStoredMode()).toBe('simple')
  })

  it('falls back to the default on garbage values', () => {
    // 舊版直接把字串 cast 成 Mode，任何非 'simple'/'expert' 的髒值都會被當成
    // 合法模式往下傳，於是 `mode === 'expert'` 永遠是 false 且沒有任何錯誤
    // 可以解釋為什麼「切換模式」看起來壞了。這條測試就是在守這個行為。
    storage.setItem(STORAGE_KEY, 'pro')
    expect(readStoredMode()).toBe('simple')
    storage.setItem(STORAGE_KEY, '')
    expect(readStoredMode()).toBe('simple')
    storage.setItem(STORAGE_KEY, 'null')
    expect(readStoredMode()).toBe('simple')
  })

  it('falls back to the default when storage throws', () => {
    storage.getItem.mockImplementation(() => { throw new Error('SecurityError: storage disabled') })
    expect(readStoredMode()).toBe('simple')
  })
})

describe('writeStoredMode', () => {
  it('persists the mode for readStoredMode to find', () => {
    writeStoredMode('expert')
    expect(storage.getItem(STORAGE_KEY)).toBe('expert')
    expect(readStoredMode()).toBe('expert')
  })

  it('does not throw when storage is unavailable', () => {
    storage.setItem.mockImplementation(() => { throw new Error('QuotaExceededError') })
    expect(() => writeStoredMode('expert')).not.toThrow()
  })
})
