// build 時注入前端的版本資訊（vite.config.ts 的 `define.__BUILD_INFO__`）。
//
// 這個檔案在 vite.config.ts 裡被載入（Node 端），所以不能 import 任何 `src/…` 別名的
// 模組——別名在設定檔載入階段還不存在。顯示用的格式化在 buildInfo.ts。
//
// 只注入兩個欄位：commit 短 SHA 與 build 時間。刻意不注入整個 process.env 或任何
// VITE_* 的值——版本列是給審查與 Demo 看「這是哪一版」，不是環境變數的窗口。SHA 也
// 只收 16 進位字串：環境變數被設成別的東西（或被塞了內容）時當作沒有，不原樣顯示。

export interface BuildInfo {
  /** commit 短 SHA（7 碼）；拿不到為 null，畫面顯示「本機開發」。 */
  sha: string | null
  /** build 時間（ISO 8601，UTC）。 */
  builtAt: string
}

const HEX_SHA = /^[0-9a-f]{7,40}$/i

/** 完整或短 SHA → 7 碼小寫；不是 16 進位 SHA（空字串、其他內容）回 null。 */
export function shortSha(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim()
  return HEX_SHA.test(v) ? v.slice(0, 7).toLowerCase() : null
}

/**
 * SHA 的來源順序：Vercel 的 VERCEL_GIT_COMMIT_SHA → 本機 `git rev-parse`。
 * 兩個都拿不到（不是 git 目錄、沒有 git、Vercel 沒提供）→ null。
 */
export function resolveBuildInfo(a: {
  vercelSha?: string | null
  gitSha?: () => string | null
  now?: Date
}): BuildInfo {
  let sha = shortSha(a.vercelSha)
  if (!sha && a.gitSha) {
    try {
      sha = shortSha(a.gitSha())
    } catch {
      sha = null
    }
  }
  return { sha, builtAt: (a.now ?? new Date()).toISOString() }
}

/** 交給 Vite `define` 的物件：只有 `__BUILD_INFO__` 一個鍵、只有兩個欄位。 */
export function buildInfoDefine(info: BuildInfo): Record<'__BUILD_INFO__', string> {
  return { __BUILD_INFO__: JSON.stringify({ sha: info.sha, builtAt: info.builtAt }) }
}
