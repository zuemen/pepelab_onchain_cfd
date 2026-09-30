// 公開 x402 Signal API 的基底網址。正式環境設 VITE_SIGNAL_API_URL 覆寫；
// 未設時預設指向已上線的 Vercel 部署，本機開發可改設為 http://localhost:4021。
// 前端各頁（文件頁 / 監控 / 試買）共用。
// 解析規則（空字串也退回預設）在 signalApiUrl.ts，與建置期的 CSP 檢查共用。
import { resolveSignalApiUrl, DEFAULT_SIGNAL_API_URL } from './signalApiUrl'

export { DEFAULT_SIGNAL_API_URL }

export const SIGNAL_API_URL: string = resolveSignalApiUrl(
  import.meta.env.VITE_SIGNAL_API_URL as string | undefined
)

/** 訪客試用：呼叫伺服器端免費 demo（不付款、不結算，只回真實訊號；settlementTx 永遠為空）。 */
export async function demoBuySignal(trader?: string): Promise<{
  ok: boolean
  error?: string
  settlementTx?: string
  trader?: string
  signal?: unknown
  paymentInfo?: unknown
}> {
  const res = await fetch(`${SIGNAL_API_URL}/demo/buy-signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(trader ? { trader } : {}),
  })
  return res.json()
}
