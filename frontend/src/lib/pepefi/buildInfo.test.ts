import { it, expect, describe } from 'vitest'

import { buildInfoView, formatBuiltAt, injectedBuildInfo } from './buildInfo'
import { shortSha, buildInfoDefine, resolveBuildInfo } from './buildMeta'

const NOW = new Date('2026-10-04T03:12:45.000Z')
const FULL = 'e85cecb0123456789abcdef0123456789abcdef0'

describe('build 時的 SHA 來源', () => {
  it('Vercel 的 VERCEL_GIT_COMMIT_SHA 優先，截成 7 碼', () => {
    const info = resolveBuildInfo({ vercelSha: FULL, gitSha: () => 'deadbee', now: NOW })
    expect(info).toEqual({ sha: 'e85cecb', builtAt: '2026-10-04T03:12:45.000Z' })
  })

  it('沒有 Vercel 時用 git rev-parse', () => {
    expect(resolveBuildInfo({ vercelSha: undefined, gitSha: () => 'ABCDEF1234\n', now: NOW }).sha).toBe('abcdef1')
  })

  it('兩者都拿不到（git 丟錯、空字串）→ null', () => {
    const boom = () => {
      throw new Error('not a git repository')
    }
    expect(resolveBuildInfo({ vercelSha: '', gitSha: boom, now: NOW }).sha).toBeNull()
    expect(resolveBuildInfo({ gitSha: () => '', now: NOW }).sha).toBeNull()
    expect(resolveBuildInfo({ now: NOW }).sha).toBeNull()
  })

  it('不是 16 進位 SHA 的內容一律不收（不把任意環境變數內容印到畫面上）', () => {
    expect(shortSha('sk-live-123456789')).toBeNull()
    expect(shortSha('https://example.com/abcdef1')).toBeNull()
    expect(shortSha('abc12')).toBeNull()
  })

  it('注入 Vite 的只有 __BUILD_INFO__ 一個鍵、兩個欄位', () => {
    const def = buildInfoDefine({ sha: 'e85cecb', builtAt: NOW.toISOString() })
    expect(Object.keys(def)).toEqual(['__BUILD_INFO__'])
    expect(Object.keys(JSON.parse(def.__BUILD_INFO__))).toEqual(['sha', 'builtAt'])
  })
})

describe('頁尾版本列', () => {
  it('沒有 SHA 時顯示「本機開發」', () => {
    const v = buildInfoView({ sha: null, builtAt: NOW.toISOString() }, 84532)
    expect(v.version).toBe('本機開發')
    expect(v.network).toBe('Base Sepolia · 84532')
    expect(v.builtAt).toBe('2026-10-04 03:12 UTC')
  })

  it('完全沒有注入（vitest、未經 Vite 的環境）也是「本機開發」，且不顯示建置時間', () => {
    expect(injectedBuildInfo()).toBeNull()
    const v = buildInfoView(null, 84532)
    expect(v.version).toBe('本機開發')
    expect(v.builtAt).toBeNull()
  })

  it('有 SHA 時顯示短 SHA；不認得的鏈顯示 chainId', () => {
    expect(buildInfoView({ sha: 'e85cecb', builtAt: '' }, 31337)).toEqual({
      network: 'Anvil Local · 31337',
      version: 'e85cecb',
      builtAt: null,
    })
    expect(buildInfoView(null, 999).network).toBe('chainId 999')
  })

  it('壞掉的時間字串不顯示', () => {
    expect(formatBuiltAt('not-a-date')).toBeNull()
  })
})
