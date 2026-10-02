// 告警送出：Telegram／Discord／通用 webhook（例如轉寄 email 的服務）。
//
// 設計原則：
//   • 不需要 GitHub token，也不開 issue —— 監控不擴大 keeper-trigger 那把 Actions token 的權限，
//     也不依賴 GitHub Actions（它正是要被監控的對象之一）。見 docs/ADR-009-monitoring.md。
//   • 通道憑證只從 Worker secret 讀（`wrangler secret put`），**永不寫進 log**：失敗時只記通道名與 HTTP 狀態。
//   • 訊息只含公開資訊（合約位址、tx hash、數值），純文字送出，不讓鏈上資料被解讀成格式或 @mention：
//     Telegram 不設 parse_mode；Discord 沒有純文字模式，所以跳脫 Markdown 並關掉 mention 與連結預覽。
//   • 每個通道各自送、各自重送：一個通道壞了，不影響另一個通道，也不會讓壞掉那個的訊息被丟掉。
//   • 一個通道設定不對只停用它；沒有任何可用通道時丟錯，讓 Cloudflare 把這次 cron 記成失敗，而不是無聲吞掉告警。
import { SEVERITIES, assertHttps, fetchWithTimeout, redactUrls } from "./engine.mjs";
import { envSecret } from "./params.mjs";

/** 送一則通知的逾時（毫秒）。通道卡住時不可以把整輪 cron 拖到 Cloudflare 的牆鐘上限。 */
export const NOTIFY_TIMEOUT_MS = 10_000;

/**
 * Discord 一律把訊息當 Markdown 渲染。跳脫格式字元，讓外部來源的文字（RPC 錯誤內文、signal-api 回應）
 * 不能做出粗體、刪除線、程式碼區塊、劇透，或「文字是 A、連結是 B」的遮罩連結（[ ] 被跳脫就組不成）；
 * 行首的標題、引用、清單記號也跳脫。URL 本身不動（跳脫會弄壞 tx 與處置文件的連結；URL 裡的 _
 * 不會被當成格式）。Discord 顯示時會吃掉跳脫用的反斜線。
 */
export function escapeDiscord(text) {
  const esc = (t) => t.replace(/([\\*_~`|\[\]])/g, "\\$1").replace(/^(\s*)(#{1,3}\s|>|[-+]\s|\d+\.\s)/gm, "$1\\$2");
  return String(text)
    .split(/(https?:\/\/[^\s<>()\[\]]+)/g)
    .map((part, i) => (i % 2 === 1 ? part : esc(part)))
    .join("");
}

const ICON = { "SEV-1": "🔴", "SEV-2": "🟠", "SEV-3": "🟡", "SEV-4": "⚪" };

const isoTime = (t) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

/**
 * 訊息內文。帶發生時間（UTC）：outbox 重送可能晚到最多 24 小時，沒有時間就看不出這是哪時候的事
 * （複審 L-e）。狀態型的「持續／恢復」另外帶首次發生時間。
 */
export function formatNote(note, { deploymentId, runbookUrl } = {}) {
  const head = `${ICON[note.severity] ?? ""}[${note.severity}] ${note.status}｜${note.title}`;
  const time = note.at
    ? `時間：${isoTime(note.at)}${note.firstAt && note.firstAt !== note.at ? `（首次 ${isoTime(note.firstAt)}）` : ""}`
    : null;
  const lines = [head, ...note.lines, ...(time ? [time] : []), `規則：${note.ruleId}${deploymentId ? `（${deploymentId}）` : ""}`];
  if (runbookUrl) lines.push(`處置：${runbookUrl}`);
  return lines.join("\n");
}

/**
 * 依環境變數組出可用的通道。回傳 { channels, problems }。
 * 一個通道設定格式不對時**只停用那個通道**（複審 L-4：原本直接丟錯，Discord Canary 的 webhook 網址
 * 就讓 Telegram 也一起停擺、SEV-1 完全送不出去）；problems 由 tick 透過其他通道以不可靜音的
 * monitor-self:config 講出來。訊息只寫通道與原因，**不帶值**（token／webhook URL 本身就是憑證）。
 * 全部通道都不可用時由 tick 丟錯，Cloudflare 會把這次 cron 記成失敗。
 */
export function channelsOf(env) {
  const channels = [];
  const problems = [];
  const tgToken = envSecret(env, "TELEGRAM_BOT_TOKEN");
  const tgChat = envSecret(env, "TELEGRAM_CHAT_ID");
  if (tgToken || tgChat) {
    if (!tgToken || !tgChat) problems.push("telegram 通道已停用：TELEGRAM_BOT_TOKEN 與 TELEGRAM_CHAT_ID 必須同時設定");
    else if (!/^\d+:[A-Za-z0-9_-]+$/.test(tgToken)) problems.push("telegram 通道已停用：TELEGRAM_BOT_TOKEN 格式不對（應為 <數字>:<英數>）");
    else {
      channels.push({
        name: "telegram",
        url: `https://api.telegram.org/bot${tgToken}/sendMessage`,
        body: (text) => ({ chat_id: tgChat, text: text.slice(0, 4000), disable_web_page_preview: true }),
      });
    }
  }
  const discord = envSecret(env, "DISCORD_WEBHOOK_URL");
  if (discord) {
    // Discord Canary／PTB 用戶端複製出來的 webhook 網址是 canary.／ptb. 子網域，一樣有效。
    if (!/^https:\/\/((canary|ptb)\.)?(discord\.com|discordapp\.com)\/api\/webhooks\//.test(discord)) {
      problems.push("discord 通道已停用：DISCORD_WEBHOOK_URL 必須是 https://discord.com/api/webhooks/…（或 canary.／ptb. 子網域）");
    } else {
      channels.push({
        name: "discord",
        url: discord,
        // flags 4 = SUPPRESS_EMBEDS：不展開連結預覽。
        body: (text) => ({ content: escapeDiscord(text).slice(0, 1900), allowed_mentions: { parse: [] }, flags: 4 }),
      });
    }
  }
  const hook = envSecret(env, "ALERT_WEBHOOK_URL");
  if (hook) {
    let ok = false;
    try {
      assertHttps("ALERT_WEBHOOK_URL", hook);
      ok = true;
    } catch (e) {
      problems.push(`webhook 通道已停用：${e.message}`);
    }
    if (ok) channels.push({ name: "webhook", url: hook, body: null, secret: envSecret(env, "ALERT_WEBHOOK_SECRET") });
  }
  return { channels, problems };
}

/**
 * 去重 id：同一則通知（同一個 key、狀態、發生時間）不論重送幾次都一樣。接收端以它去重——
 * 通知是 at-least-once（逾時但對方其實收到了，下一輪會再送），5 分鐘的時間戳視窗內也可能被重放。
 */
export async function noteId(note, deploymentId = "") {
  // 狀態型告警的觀察值（複審 L-2）：開著時值又變了，那是另一則通知，id 不可以和前一則相同。
  const text = `${deploymentId}|${note.key ?? note.ruleId}|${note.status}|${note.at ?? ""}${note.fingerprint !== undefined ? `|${note.fingerprint}` : ""}`;
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 送一則通知到「一個」通道。回傳是否送達；失敗時呼叫端把它留在 outbox，只對這個通道重送。
 *
 * 通用 webhook 的簽章（設定 ALERT_WEBHOOK_SECRET 時）：
 *   X-Pepelab-Timestamp: <unix 秒>
 *   X-Pepelab-Signature: sha256=<HMAC-SHA256(secret, `${timestamp}.${body}`)>
 * 簽章涵蓋時間戳，接收端應拒絕時間差超過 5 分鐘的請求——沒有時間戳的簽章可以被無限期重放。
 * 接收端要對「收到的原始 body bytes」驗簽（不要先 JSON.parse 再序列化）、用常數時間比較，
 * 並以 body 的 id 去重（見 README）。
 */
export async function sendToChannel(note, text, channel, fetchImpl, { log = () => {}, now = Math.floor(Date.now() / 1000), timeoutMs = NOTIFY_TIMEOUT_MS, deploymentId = "" } = {}) {
  try {
    let payload;
    const headers = { "Content-Type": "application/json" };
    if (channel.body) payload = JSON.stringify(channel.body(text));
    else {
      payload = JSON.stringify({
        source: "pepelab-chain-monitor",
        id: await noteId(note, deploymentId),
        severity: note.severity,
        status: note.status,
        ruleId: note.ruleId,
        key: note.key,
        title: note.title,
        text,
        occurredAt: note.at ?? null,
        firstAt: note.firstAt ?? note.at ?? null,
        sentAt: now,
      });
      if (channel.secret) {
        headers["X-Pepelab-Timestamp"] = String(now);
        headers["X-Pepelab-Signature"] = `sha256=${await hmacHex(channel.secret, `${now}.${payload}`)}`;
      }
    }
    const res = await fetchWithTimeout(fetchImpl, channel.url, { method: "POST", headers, body: payload }, timeoutMs);
    if (res.ok) return true;
    log(`notify ${channel.name} 失敗：HTTP ${res.status}`);
  } catch (e) {
    // 通道 URL 本身就是憑證：錯誤訊息裡的 URL 一律遮蔽。
    const aborted = e?.name === "AbortError" || /abort/i.test(String(e?.message ?? ""));
    log(`notify ${channel.name} 例外：${aborted ? `逾時（${timeoutMs / 1000} 秒）` : redactUrls(e?.message ?? e).slice(0, 80)}`);
  }
  return false;
}

/** 監控自身的告警（讀取失敗、落後、狀態重置、通道失效、設定問題）。 */
export const isSelfNote = (note) => note.ruleId === "monitor-self" || String(note.key ?? "").startsWith("monitor-self");

/**
 * MUTE_KEYS：逗號分隔的告警 key，**只接受 monitors.json 的 mutableKeys 白名單**（完全相同的 key，
 * 沒有前綴比對）。複審 M-A：原本執行期不看嚴重度、也不看白名單——在 Cloudflare dashboard 設
 * `MUTE_KEYS=owner-transferred` 就能讓 SEV-1 完全不響，CI 也放行 `x402-payto:changed` 這種
 * 「SEV-1 規則唯一的 SEV-1 子 key」。
 * 回傳 { keys（生效的）, rejected（不在白名單，忽略）, ignored（monitor-self 或格式不對，忽略）}。
 */
export function parseMuteKeys(text, allowed = []) {
  const allow = new Set(allowed);
  const keys = [];
  const rejected = [];
  const ignored = [];
  for (const k of String(text ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (k.startsWith("monitor-self") || !/^[a-z0-9][a-z0-9-]*(:[^\s,]+)?$/.test(k)) ignored.push(k);
    else if (!allow.has(k)) rejected.push(k);
    else keys.push(k);
  }
  return { keys, rejected, ignored };
}
export const isMuted = (note, muteKeys = []) => muteKeys.includes(note.key);

/**
 * 這則通知要不要送。
 *   • monitor-self:* 與標 unmutable 的（例如 x402「基準已設定」）永遠送。
 *   • SEV-1（觸發、持續，或原嚴重度 SEV-1 的恢復）永遠送：不受 MUTE_KEYS 影響，MIN_SEVERITY 也最多只能設到 SEV-2。
 *   • MUTE_KEYS 命中的不送（只有白名單裡的 key 會進到 muteKeys）。
 *   • 其餘依 MIN_SEVERITY；恢復通知以「原嚴重度」判斷：觸發時送過的，恢復時一定也送。
 */
export function shouldSend(note, minSeverity = "SEV-4", muteKeys = []) {
  const min = SEVERITIES.indexOf(minSeverity);
  if (min < 0) throw new Error(`MIN_SEVERITY 不合法：${minSeverity}`);
  if (isSelfNote(note) || note.unmutable) return true;
  const sev = note.status === "恢復" ? (note.origSeverity ?? note.severity) : note.severity;
  if (sev === "SEV-1") return true;
  if (isMuted(note, muteKeys)) return false;
  const i = SEVERITIES.indexOf(sev);
  return i >= 0 && i <= Math.max(min, 1);
}
