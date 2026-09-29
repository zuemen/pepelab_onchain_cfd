// 旗標字串的解析規則，單獨成檔是為了讓 vite.config.ts（Node 端、沒有 import.meta.env）
// 也能用同一份規則——index.html 的 meta description 在建置時依 FEATURE_COPY_TRADING
// 選字串，規則若在兩邊各寫一份，遲早會一邊認 `yes`、一邊不認。
//
// `1` / `true` / `on` 才算開，其餘（含未設定）都用 fallback 或算關。

export function readFlag(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const v = String(raw).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
