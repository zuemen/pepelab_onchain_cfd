// 對外回應的敏感字串遮蔽。
//
// ethers v6 的 RPC 錯誤訊息長這樣：
//   could not coalesce error (error={...}, payload={...}, info={ "requestUrl": "https://…/v2/<API KEY>" }, …)
// 只要有一個 catch 把 `err.message` 原樣回給公開使用者，RPC 的 API key 就外流了。
// 這裡把「設定裡帶憑證的值」與 requestUrl 欄位一律換掉。完整錯誤仍應寫進 console.error。

/** 可能帶憑證的 env（值本身就是秘密，或是含 key 的 URL）。 */
const SECRET_ENV_KEYS = [
  "BASE_SEPOLIA_RPC_URL",
  "SEPOLIA_RPC_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "ETHERSCAN_API_KEY",
  "BASESCAN_API_KEY",
  "X402_FACILITATOR_URL",
];

function secretValues(): string[] {
  const out: string[] = [];
  for (const k of SECRET_ENV_KEYS) {
    const v = process.env[k]?.trim();
    if (!v || v.length < 8) continue;
    out.push(v);
    // URL 形式的也遮掉 path / query（key 常在這兩處），但保留公開的 host 不影響判讀。
    try {
      const u = new URL(v);
      if (u.pathname.length > 1) out.push(u.pathname);
      if (u.search) out.push(u.search.slice(1));
    } catch {
      /* 不是 URL */
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

/** 遮掉字串裡的秘密值與 requestUrl。 */
export function redactSecrets(text: string): string {
  let s = text;
  for (const v of secretValues()) {
    if (v.length >= 8) s = s.split(v).join("[redacted]");
  }
  // ethers info.requestUrl（JSON 內嵌或 key=value 形式都處理）
  s = s.replace(/("?requestUrl"?\s*[:=]\s*\\?"?)[^"\s,}\\]+/g, "$1[redacted]");
  // 常見 RPC 供應商 URL 上的 key 片段
  s = s.replace(/(\/v[23]\/)[A-Za-z0-9_-]{16,}/g, "$1[redacted]");
  return s;
}
