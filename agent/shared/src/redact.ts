// 對外回應的敏感字串遮蔽。
//
// ethers v6 的 RPC 錯誤訊息長這樣：
//   could not coalesce error (error={...}, payload={...}, info={ "requestUrl": "https://…/v2/<API KEY>" }, …)
// 只要有一個 catch 把 `err.message` 原樣回給公開使用者，RPC 的 API key 就外流了。
// 這裡把設定裡的秘密與 requestUrl 一律換掉。完整錯誤仍應寫進 console.error。

/** 值本身就是秘密的 env（整個值遮掉）。 */
const SECRET_VALUE_ENV_KEYS = ["UPSTASH_REDIS_REST_TOKEN", "ETHERSCAN_API_KEY", "BASESCAN_API_KEY"];

/**
 * URL 型 env：host 與 path 是公開資訊（例如 facilitator 的網址本來就寫在 GET / 裡），
 * 只遮 userinfo（user:pass@）與 query 參數的值（?apikey=…）。
 * 放在 path 的 key（Alchemy / Infura 的 /v2/<key>、/v3/<key>）由下方的通用規則處理。
 */
const URL_ENV_KEYS = [
  "BASE_SEPOLIA_RPC_URL",
  "SEPOLIA_RPC_URL",
  "UPSTASH_REDIS_REST_URL",
  "X402_FACILITATOR_URL",
];

const MIN_SECRET_LEN = 6;

function secretValues(): string[] {
  const out: string[] = [];
  const push = (v: string | undefined | null) => {
    if (v && v.length >= MIN_SECRET_LEN) out.push(v);
  };

  for (const k of SECRET_VALUE_ENV_KEYS) push(process.env[k]?.trim());

  for (const k of URL_ENV_KEYS) {
    const v = process.env[k]?.trim();
    if (!v) continue;
    try {
      const u = new URL(v);
      push(decodeURIComponent(u.username));
      push(decodeURIComponent(u.password));
      push(u.username);
      push(u.password);
      for (const val of u.searchParams.values()) push(val);
    } catch {
      /* 不是 URL：不猜，交給其他規則 */
    }
  }

  // 安全網：所有 *_PRIVATE_KEY（理論上不該出現在任何回應裡），含 0x 與不含 0x 兩種形式。
  for (const k of Object.keys(process.env).filter((n) => n.endsWith("_PRIVATE_KEY"))) {
    const v = process.env[k]?.trim();
    if (!v) continue;
    const bare = v.replace(/^0x/i, "");
    push(bare);
    push(`0x${bare}`);
  }
  return out.sort((a, b) => b.length - a.length);
}

/** 遮掉字串裡的秘密值與 requestUrl。 */
export function redactSecrets(text: string): string {
  let s = text;
  for (const v of secretValues()) s = s.split(v).join("[redacted]");
  // 私鑰大小寫不一定一致：再用不分大小寫的比對補一次。
  for (const k of Object.keys(process.env).filter((n) => n.endsWith("_PRIVATE_KEY"))) {
    const bare = process.env[k]?.trim().replace(/^0x/i, "");
    if (bare && bare.length >= 32 && /^[0-9a-f]+$/i.test(bare)) {
      s = s.replace(new RegExp(bare, "gi"), "[redacted]");
    }
  }
  // ethers info.requestUrl（JSON 內嵌或 key=value 形式都處理）
  s = s.replace(/("?requestUrl"?\s*[:=]\s*\\?"?)[^"\s,}\\]+/g, "$1[redacted]");
  // 常見 RPC 供應商放在 path 的 key 片段（/v2/<key>、/v3/<key>）
  s = s.replace(/(\/v[23]\/)[A-Za-z0-9_-]{16,}/g, "$1[redacted]");
  return s;
}
