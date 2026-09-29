// 對外回應的敏感字串遮蔽。
//
// ethers v6 的 RPC 錯誤訊息長這樣：
//   could not coalesce error (error={...}, payload={...}, info={ "requestUrl": "https://…/v2/<API KEY>" }, …)
// 只要有一個 catch 把 `err.message` 原樣回給公開使用者，RPC 的 API key 就外流了。
// 這裡把設定裡的秘密與 requestUrl 一律換掉。完整錯誤仍應寫進 console.error。

/** 值本身就是秘密的 env（整個值遮掉）。 */
const SECRET_VALUE_ENV_KEYS = ["UPSTASH_REDIS_REST_TOKEN", "ETHERSCAN_API_KEY", "BASESCAN_API_KEY"];

/**
 * 秘密 URL：整個值、pathname、userinfo、query 值全部遮掉。所有 `*_RPC_URL` 都算——
 * QuickNode、Ankr、Chainstack 等供應商把 key 放在 path 裡。
 */
const SECRET_URL_ENV_KEYS = ["UPSTASH_REDIS_REST_URL"];
const isSecretUrlEnv = (k: string) => k.endsWith("_RPC_URL") || SECRET_URL_ENV_KEYS.includes(k);

/** 公開 URL（本來就寫在 GET / 裡）：只遮 userinfo 與 query 參數的值，host / path 保留。 */
const PUBLIC_URL_ENV_KEYS = ["X402_FACILITATOR_URL"];

const MIN_SECRET_LEN = 6;

function tryDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function secretValues(): string[] {
  const out: string[] = [];
  const push = (v: string | undefined | null) => {
    if (v && v.length >= MIN_SECRET_LEN) out.push(v);
  };
  const pushUrlParts = (u: URL) => {
    for (const part of [u.username, u.password]) {
      push(part);
      push(tryDecode(part));
    }
    for (const val of u.searchParams.values()) push(val);
  };

  for (const k of SECRET_VALUE_ENV_KEYS) push(process.env[k]?.trim());

  for (const k of Object.keys(process.env).filter(isSecretUrlEnv)) {
    const v = process.env[k]?.trim();
    if (!v) continue;
    push(v); // 整個值
    try {
      const u = new URL(v);
      if (u.pathname.length > 1) {
        push(u.pathname);
        push(tryDecode(u.pathname));
      }
      pushUrlParts(u);
    } catch {
      /* 解析失敗：上面已經遮住整個值 */
    }
  }

  for (const k of PUBLIC_URL_ENV_KEYS) {
    const v = process.env[k]?.trim();
    if (!v) continue;
    try {
      pushUrlParts(new URL(v));
    } catch {
      push(v); // 解析失敗就不猜，整個值遮掉
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
