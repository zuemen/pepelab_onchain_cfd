// signal-api 基底網址的解析規則。單獨成檔（不碰 import.meta.env）是為了讓
// vite.config.ts 的 CSP 建置檢查（cspConnect.ts）與 app 用**同一條**規則：
// 未設定或設成空字串都退回預設部署——`VITE_SIGNAL_API_URL=` 這種空值在 Vercel 的
// 環境變數介面很容易出現，用 `??` 會讓它變成空字串、fetch 打到相對路徑。

export const DEFAULT_SIGNAL_API_URL = 'https://agent-git-master-zuemens-projects.vercel.app'

export function resolveSignalApiUrl(raw: string | undefined | null): string {
  return (raw || DEFAULT_SIGNAL_API_URL).replace(/\/$/, '')
}
