import { t } from 'src/locales'

// ----------------------------------------------------------------------

export function prettyError(err: unknown, context?: 'mining' | 'tier' | 'copy' | 'checkin'): string {
  if (!err) return t.errors.unknown

  // 合約錯誤 → 使用者看得懂的說法。訊息本身住在 catalog。
  //
  // 在函式**裡面**讀，不在 module scope。module scope 的讀取會被模組求值順序綁住，
  // 而編輯任何一個 catalog 檔都會讓 src/locales 失效——dev 的 HMR 就可能在 locales
  // 重新初始化之前先跑這個檔案，於是 `t` 是 undefined。函式內讀每次只是一次屬性存取。
  //
  // 收成 `Record<string, string>` 是必要的：selector 與 keyword 都是執行期才知道的
  // 字串，catalog 推導出來的型別只認得那 73 個字面 key，用任意字串索引會編譯失敗。
  //
  // 順序有意義——下面的 keyword 掃描是照插入順序逐一比對的。catalog 保留了原本的順序。
  const ERROR_MAP: Record<string, string> = t.errors.contract

  const e = err as {
    data?: string
    message?: string
    reason?: string
    shortMessage?: string
    code?: string
    /** ethers v6 decodes custom errors here when the ABI knows them. */
    revert?: { name?: string } | null
    /** ethers v5 / some providers. */
    errorName?: string
    /** JSON-RPC wraps the real error one level down. */
    error?: { data?: string; message?: string } | null
    info?: { error?: { data?: string; message?: string } } | null
  }

  // 1. custom error selector
  const data = e.data
    ?? (typeof e.error?.data === 'string' ? e.error.data : undefined)
    ?? (typeof e.info?.error?.data === 'string' ? e.info.error.data : undefined)
  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    const sel = data.slice(0, 10).toLowerCase()
    if (ERROR_MAP[sel]) return ERROR_MAP[sel]
  }

  // 1b. Decoded custom error name.
  //
  // 合約這一輪把大量的 require-string 換成 custom error（PepeAMM 的
  // StaleOraclePrice/PriceOutOfBand、KYCRegistry 的 NoSubmission…）。ethers v6
  // 在 ABI 認得該 error 時會把名字放在 `revert.name`，但 `message` 裡只會留下
  // 「execution reverted」這種沒有資訊量的字串——只靠關鍵字掃描會全部落到 fallback。
  const revertName = e.revert?.name ?? e.errorName
  if (typeof revertName === 'string' && ERROR_MAP[revertName]) return ERROR_MAP[revertName]

  // 2. keyword scan across all message fields
  const msg = e.shortMessage ?? e.reason ?? e.message ?? e.code ?? String(err)
  const msgLower = `${revertName ?? ''} ${msg}`.toLowerCase()
  
  for (const [keyword, friendly] of Object.entries(ERROR_MAP)) {
    if (msgLower.includes(keyword.toLowerCase())) return friendly
  }

  // 3. Fallback for generic reverts using context
  if (msgLower.includes('missing revert data') || msgLower.includes('execution reverted') || msgLower.includes('3: execution reverted')) {
    if (context === 'copy') {
      return t.errors.reverted.copy;
    }
    if (context === 'tier') {
      return t.errors.reverted.tier;
    }
    if (context === 'mining') {
      return t.errors.reverted.mining;
    }
    if (context === 'checkin') {
      return t.errors.reverted.checkin;
    }
    return t.errors.reverted.generic;
  }

  // 4. 認不出來的錯誤。
  //
  // 舊版直接 `return msg.slice(0, 120)`，於是使用者會在 toast 上看到
  // "could not coalesce error (error={ \"code\": -32603, \"data\": {...} }, payload=…"
  // 這種東西：看不懂、沒有可行動的資訊，還會把 RPC 端點與內部欄位漏到畫面上。
  // 這裡只給一句能行動的話，原文留給 console 供開發者查。
  console.warn('[prettyError] unmapped error:', err)
  return t.errors.unrecognised
}
