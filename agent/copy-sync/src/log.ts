// 日誌：所有輸出都先遮蔽秘密。
//
// shared/redact.ts 已經遮掉 env 裡的 *_RPC_URL、*_PRIVATE_KEY 與 ethers 錯誤裡的 requestUrl；
// 這裡再加上「從指令列給的 RPC 網址」與通知 webhook 網址（Slack／Discord 的 webhook 網址
// 本身就是憑證），兩者都不在 redactSecrets 認得的環境變數名稱裡。
import { redactSecrets } from "../../shared/src/redact.ts";

const MIN_SECRET_LEN = 6;

/** 一個網址裡可能是秘密的片段：整個值、path 的每一段、userinfo、query 值。 */
export function urlSecretParts(raw: string): string[] {
  const out = new Set<string>();
  const push = (v: string | undefined | null) => {
    if (v && v.length >= MIN_SECRET_LEN) out.add(v);
  };
  push(raw.trim());
  try {
    const u = new URL(raw.trim());
    if (u.pathname.length > 1) {
      push(u.pathname);
      for (const seg of u.pathname.split("/")) push(seg);
    }
    push(u.username);
    push(u.password);
    for (const v of u.searchParams.values()) push(v);
  } catch {
    /* 解析失敗：上面已經遮住整個值 */
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export type Redactor = (text: string) => string;

export function makeRedactor(extraUrls: Array<string | undefined>): Redactor {
  const parts = extraUrls.flatMap((u) => (u ? urlSecretParts(u) : []));
  return (text: string) => {
    let s = text;
    for (const p of parts) s = s.split(p).join("[redacted]");
    return redactSecrets(s);
  };
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** 錯誤物件轉成一行（截斷、遮蔽）。ethers 的錯誤訊息很長，而且會帶 requestUrl。 */
export function errText(e: unknown, redact: Redactor, max = 200): string {
  const x = e as { shortMessage?: unknown; message?: unknown } | null;
  const raw = typeof x?.shortMessage === "string" ? x.shortMessage : typeof x?.message === "string" ? x.message : String(e);
  const one = redact(raw).replace(/\s+/g, " ");
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * GitHub Actions 認得 `::warning::`／`::error::` 前綴（與 keeper 一致）；本機看起來只是多一個標記。
 * 時間戳用 ISO（UTC），方便和 explorer 對時間。
 */
export function consoleLogger(redact: Redactor, now: () => Date = () => new Date()): Logger {
  const ts = () => now().toISOString();
  return {
    info: (m) => console.log(`${ts()} ${redact(m)}`),
    warn: (m) => console.log(`::warning::${ts()} ${redact(m)}`),
    error: (m) => console.error(`::error::${ts()} ${redact(m)}`),
  };
}
