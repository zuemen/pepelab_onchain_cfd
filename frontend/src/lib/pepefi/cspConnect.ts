// 建置期檢查：VITE_SIGNAL_API_URL 必須在 vercel.json 的 CSP connect-src 白名單裡。
//
// signal-api 的網址可以用環境變數覆寫，CSP 卻是寫死在 vercel.json 的。兩邊各改各的，
// 正式站就會變成「瀏覽器把每一次 fetch 擋掉、只在 console 留一行」——K 線、Benchmark、
// x402 試買全部靜默失效，而 build 與部署都是綠的。所以在 vite build 時就對一次，
// 對不上直接讓 build 失敗並說明原因。
//
// 這個檔案在 Node 端（vite.config.ts）被 import，不能碰 import.meta.env。

import { resolveSignalApiUrl } from './signalApiUrl';

export interface VercelConfig {
  headers?: { source: string; headers: { key: string; value: string }[] }[];
}

/** vercel.json 裡套用到全站（`/(.*)`）的 CSP connect-src 來源清單。 */
export function connectSrcOf(config: VercelConfig): string[] {
  const csp = config.headers
    ?.find((h) => h.source === '/(.*)')
    ?.headers.find((h) => h.key.toLowerCase() === 'content-security-policy')?.value;
  if (!csp) return [];
  const directive = csp
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .find(([name]) => name === 'connect-src');
  return directive ? directive.slice(1) : [];
}

/**
 * 這個 URL 會不會被 connect-src 放行。只處理本專案用得到的寫法：`'self'`（同源，
 * 建置期無從得知部署網域，一律不算）與完整 origin（`https://host[:port]`）。
 * 刻意不支援萬用字元——securityHeaders.test.ts 本來就禁止在 connect-src 用 `*`。
 */
export function isConnectAllowed(url: string, connectSrc: readonly string[]): boolean {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  return connectSrc.some((src) => src.replace(/\/$/, '') === origin);
}

/**
 * 回傳錯誤說明（null = 通過）。先用與 app 相同的 resolveSignalApiUrl 解析——未設定或
 * 空字串都是預設部署——再檢查**實際會被打的那個網址**，預設值也一併驗。
 */
export function checkSignalApiUrl(raw: string | undefined, config: VercelConfig): string | null {
  const url = resolveSignalApiUrl(raw);
  const connectSrc = connectSrcOf(config);
  if (isConnectAllowed(url, connectSrc)) return null;
  // 這是給部署的人看的 build 錯誤（終端機／CI log），不是介面顯示字串，所以不進 catalog、
  // 用英文寫——locales.test.ts 的掃描器也因此不會把它當成漏搬的顯示字串。
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    /* 不是合法 URL：照原字串報 */
  }
  return [
    `VITE_SIGNAL_API_URL=${url} is not in the CSP connect-src allow-list of frontend/vercel.json.`,
    'Browsers on the production site would block every request to it (K-line, benchmarks and the x402 trial fail silently).',
    `Add ${origin} to connect-src in vercel.json, or use an allow-listed URL.`,
    `Current connect-src: ${connectSrc.join(' ') || '(not found)'}`,
  ].join('\n');
}
