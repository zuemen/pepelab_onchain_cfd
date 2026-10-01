// GitHub App installation token：讓 Worker 以 `<app-slug>[bot]` 的身分觸發 keeper，
// 而不是用擁有者本人的 PAT（理由見 README「觸發者身分」）。
//
// 只用 WebCrypto（Cloudflare Workers 與 node 都有），沒有任何依賴。
//
// 依據（docs.github.com，2026-10-01 查閱）：
//   - JWT：RS256；iat 建議回推 60 秒、exp 不得超過 10 分鐘、iss 為 App 的 client ID 或 app ID。
//     〈Generating a JSON Web Token (JWT) for a GitHub App〉
//   - 換 token：POST /app/installations/{installation_id}/access_tokens，回 201，
//     body 可帶 `repositories`、`permissions` 縮小範圍；token 一小時後到期。
//     〈Generating an installation access token for a GitHub App〉、REST「Apps」
//   - GitHub 下載的私鑰是 PKCS#1（`BEGIN RSA PRIVATE KEY`）。
//     〈Managing private keys for GitHub Apps〉
//     WebCrypto 的 importKey 只收 PKCS#8，所以這裡把 PKCS#1 包成 PKCS#8 再匯入，
//     擁有者不需要另外用 openssl 轉檔（少一份落在磁碟上的私鑰副本）。
//
// 錯誤訊息一律不含私鑰、JWT 或 token（redact() 再擋一次）。

const API = "https://api.github.com";
const JWT_BACKDATE_SEC = 60;
// 上限是「未來 10 分鐘」。留 1 分鐘給時鐘誤差：超過上限 GitHub 會直接拒絕。
const JWT_LIFETIME_SEC = 9 * 60;
// 到期前 5 分鐘就視為過期，重新換一個。
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000;

const APP_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY"];
// app ID（數字）或 client ID（例如 Iv23li…）；兩者都可當 JWT 的 iss。
const APP_ID = /^[A-Za-z0-9._-]{1,64}$/;
const INSTALLATION_ID = /^[0-9]{1,20}$/;
const REPO = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/** isolate 記憶體內的快取。Cloudflare 可能隨時回收 isolate，那就只是多換一次 token。 */
let cached = null;

/** 測試用：清掉快取。 */
export function resetAppTokenCache() {
  cached = null;
}

/** 把看起來像憑證的片段遮掉，並逐字遮掉已知的秘密值。 */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const s of secrets) {
    if (typeof s === "string" && s.length >= 8) out = out.split(s).join("[redacted]");
  }
  return out
    .replace(/-----BEGIN [^-]*-----[\s\S]*?(-----END [^-]*-----|$)/g, "[redacted pem]")
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted jwt]")
    .replace(/\b(gh[a-z]|github_pat)_[A-Za-z0-9_.-]{10,}/g, "[redacted token]");
}

/**
 * 讀 App 設定。三項都沒設 → null（沿用 PAT）。只設了一部分 → 丟錯：
 * 默默退回 PAT 會讓 run 的觸發者變回擁有者本人，KEEPER_TRIGGER_ACTOR 的 gate 就失去意義。
 */
export function appConfigOf(env) {
  const present = APP_KEYS.filter((k) => String(env[k] ?? "").trim() !== "");
  if (present.length === 0) return null;
  if (present.length !== APP_KEYS.length) {
    const missing = APP_KEYS.filter((k) => !present.includes(k));
    throw new Error(`GitHub App 設定不完整：缺少 ${missing.join("、")}（三項要一起設定，或全部不設以沿用 GITHUB_TOKEN）`);
  }
  const appId = String(env.GITHUB_APP_ID).trim();
  const installationId = String(env.GITHUB_APP_INSTALLATION_ID).trim();
  if (!APP_ID.test(appId)) throw new Error("GITHUB_APP_ID 格式不對（應為 App ID 數字或 Client ID）");
  if (!INSTALLATION_ID.test(installationId)) throw new Error("GITHUB_APP_INSTALLATION_ID 格式不對（應為數字）");
  return { appId, installationId, privateKeyPem: String(env.GITHUB_APP_PRIVATE_KEY) };
}

function derLength(n) {
  if (n < 0x80) return [n];
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return [0x80 | bytes.length, ...bytes];
}

/**
 * PKCS#1 RSAPrivateKey（DER）→ PKCS#8 PrivateKeyInfo（DER）。
 *   PrivateKeyInfo ::= SEQUENCE { version INTEGER 0,
 *     algorithm SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL },
 *     privateKey OCTET STRING { RSAPrivateKey } }          （RFC 5208 §5、RFC 8017 A.1）
 */
export function pkcs1ToPkcs8(pkcs1) {
  const version = [0x02, 0x01, 0x00];
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octetHeader = [0x04, ...derLength(pkcs1.length)];
  const bodyLength = version.length + algorithm.length + octetHeader.length + pkcs1.length;
  const header = [0x30, ...derLength(bodyLength)];
  const out = new Uint8Array(header.length + bodyLength);
  out.set(header, 0);
  out.set(version, header.length);
  out.set(algorithm, header.length + version.length);
  out.set(octetHeader, header.length + version.length + algorithm.length);
  out.set(pkcs1, header.length + bodyLength - pkcs1.length);
  return out;
}

/**
 * PEM → PKCS#8 DER。接受 `BEGIN PRIVATE KEY`（PKCS#8）與 `BEGIN RSA PRIVATE KEY`（PKCS#1，
 * GitHub 下載的預設格式）。其餘（加密的金鑰、EC、公鑰、憑證、不是 PEM）一律丟錯。
 */
export function pemToPkcs8Der(pem) {
  // secret 以單行貼上時，換行常變成字面的「\n」。
  const text = String(pem ?? "").replace(/\\r|\\n/g, "\n").trim();
  const m = /^-----BEGIN ([A-Z0-9 ]{1,40})-----([\s\S]*?)-----END ([A-Z0-9 ]{1,40})-----$/.exec(text);
  if (!m || m[1] !== m[3]) {
    throw new Error("GITHUB_APP_PRIVATE_KEY 不是 PEM（應以 -----BEGIN RSA PRIVATE KEY----- 或 -----BEGIN PRIVATE KEY----- 開頭，並包含完整的 END 行）");
  }
  const label = m[1];
  if (label !== "PRIVATE KEY" && label !== "RSA PRIVATE KEY") {
    throw new Error(`GITHUB_APP_PRIVATE_KEY 的 PEM 類型是「${label}」；只接受 RSA PRIVATE KEY（PKCS#1）或 PRIVATE KEY（PKCS#8，未加密）`);
  }
  if (/Proc-Type:|DEK-Info:/.test(m[2])) {
    throw new Error("GITHUB_APP_PRIVATE_KEY 是加了密碼的 PEM；請使用 GitHub 下載的原始 .pem（未加密）");
  }
  const b64 = m[2].replace(/\s+/g, "");
  if (b64 === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new Error("GITHUB_APP_PRIVATE_KEY 的 PEM 內容不是合法的 base64");
  }
  let der;
  try {
    der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("GITHUB_APP_PRIVATE_KEY 的 PEM 內容不是合法的 base64");
  }
  return label === "RSA PRIVATE KEY" ? pkcs1ToPkcs8(der) : der;
}

async function importSigningKey(pem) {
  const der = pemToPkcs8Der(pem);
  try {
    return await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  } catch (e) {
    // 不帶原始訊息：只留錯誤類別，避免任何實作把金鑰內容放進訊息。
    throw new Error(`GITHUB_APP_PRIVATE_KEY 無法匯入為 RSA 簽章金鑰（${e?.name ?? "Error"}）；請確認是 GitHub App 產生的 RSA 私鑰`);
  }
}

function b64url(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 簽一個給 GitHub App 用的 RS256 JWT。 */
export async function createAppJwt({ appId, privateKeyPem }, nowMs = Date.now()) {
  const key = await importSigningKey(privateKeyPem);
  const nowSec = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSec - JWT_BACKDATE_SEC, exp: nowSec + JWT_LIFETIME_SEC, iss: appId };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(sig)}`;
}

/**
 * 取得 installation token（有快取）。回傳 `{ token, expiresAtMs, fromCache }`。
 * 任何失敗都丟錯（呼叫端讓 cron 記成失敗），不退回 PAT。
 */
export async function getInstallationToken(cfg, repo, nowMs = Date.now(), fetchImpl = fetch) {
  const rm = REPO.exec(String(repo ?? ""));
  if (!rm) throw new Error("GITHUB_REPO 格式不對（應為 owner/name）");
  const cacheKey = `${cfg.appId}|${cfg.installationId}|${repo}`;
  if (cached && cached.key === cacheKey && nowMs < cached.expiresAtMs - REFRESH_BEFORE_EXPIRY_MS) {
    return { token: cached.token, expiresAtMs: cached.expiresAtMs, fromCache: true };
  }
  cached = null;

  const jwt = await createAppJwt(cfg, nowMs);
  let res;
  try {
    res = await fetchImpl(`${API}/app/installations/${cfg.installationId}/access_tokens`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
        "User-Agent": "pepelab-keeper-trigger",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      // 只要 Actions: write、只要這一個 repo。App 本身就只該有這些，這裡再縮一次：
      // 就算之後有人把 App 的權限或安裝範圍放大，Worker 拿到的 token 也不會跟著變大。
      body: JSON.stringify({ repositories: [rm[2]], permissions: { actions: "write" } }),
    });
  } catch (e) {
    throw new Error(`GitHub App 換 installation token 失敗：${redact(e?.message ?? e, [jwt, cfg.privateKeyPem])}`);
  }

  if (res.status !== 201) {
    let message = "";
    try {
      message = String(JSON.parse(await res.text())?.message ?? "");
    } catch {
      // 不是 JSON 就不帶內容
    }
    const hint =
      res.status === 401 ? "（JWT 被拒：檢查 GITHUB_APP_ID 與私鑰是否屬於同一個 App、私鑰是否已被刪除）"
      : res.status === 403 ? "（被禁止：App 可能被停用，或沒有 Actions: Read and write 權限）"
      : res.status === 404 ? "（找不到 installation：檢查 GITHUB_APP_INSTALLATION_ID，以及 App 是否仍安裝在本 repo）"
      : res.status === 422 ? "（範圍不符：App 沒有安裝在這個 repo，或沒有被授予 Actions 權限）"
      : "";
    throw new Error(
      `GitHub App 換 installation token 失敗：HTTP ${res.status}${hint} ${redact(message, [jwt, cfg.privateKeyPem]).slice(0, 160)}`.trim(),
    );
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("GitHub App 換 installation token 失敗：回應不是 JSON");
  }
  const token = body?.token;
  if (typeof token !== "string" || token === "") {
    throw new Error("GitHub App 換 installation token 失敗：回應沒有 token");
  }
  const expiresAtMs = Date.parse(body.expires_at ?? "");
  // 讀不到到期時間就不快取（下次重新換），這一次照用。
  if (Number.isFinite(expiresAtMs)) cached = { key: cacheKey, token, expiresAtMs };
  return { token, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : null, fromCache: false, permissions: body.permissions ?? null };
}

/** 快取中的 token 被 GitHub 拒絕（401）時呼叫：下一次 cron 重新換。 */
export function invalidateAppToken(token) {
  if (cached && cached.token === token) cached = null;
}
