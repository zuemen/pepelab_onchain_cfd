// 頁尾版本列的內容：測試網名稱＋chainId、build 的 commit 短 SHA、build 時間。
// 注入的部分見 buildMeta.ts；這裡只負責讀與格式化。

import type { BuildInfo } from './buildMeta'

import { t, interpolate } from 'src/locales'
import { CHAIN_NAMES } from 'src/contracts/addresses'

import { shortSha } from './buildMeta'

/**
 * 讀 Vite 在 build 時注入的 `__BUILD_INFO__`。測試環境（vitest）沒有注入，回 null。
 * 形狀不對也回 null——畫面寧可顯示「本機開發」，也不把不認得的東西印出來。
 */
export function injectedBuildInfo(): BuildInfo | null {
  if (typeof __BUILD_INFO__ === 'undefined') return null
  const raw = __BUILD_INFO__ as unknown
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { sha?: unknown; builtAt?: unknown }
  return {
    sha: typeof r.sha === 'string' ? shortSha(r.sha) : null,
    builtAt: typeof r.builtAt === 'string' ? r.builtAt : '',
  }
}

export interface BuildInfoView {
  /** 例：Base Sepolia · 84532 */
  network: string
  /** 短 SHA，或「本機開發」。 */
  version: string
  /** 例：2026-10-04 03:12 UTC；沒有時間為 null（不顯示那一欄）。 */
  builtAt: string | null
}

/** ISO 時間 → `YYYY-MM-DD HH:mm UTC`。一律 UTC：看的人在哪個時區都不會誤讀。 */
export function formatBuiltAt(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

export function buildInfoView(info: BuildInfo | null, chainId: number): BuildInfoView {
  const name = CHAIN_NAMES[chainId]
  return {
    network: name
      ? `${name} · ${chainId}`
      : interpolate(t.status.build.unknownChain, { id: chainId }),
    version: info?.sha ?? t.status.build.localDev,
    builtAt: formatBuiltAt(info?.builtAt),
  }
}
