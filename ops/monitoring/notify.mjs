// 告警送出：Telegram／Discord／通用 webhook（例如轉寄 email 的服務）。
//
// 設計原則：
//   • 不需要 GitHub token，也不開 issue —— 監控不擴大 keeper-trigger 那把 Actions token 的權限，
//     也不依賴 GitHub Actions（它正是要被監控的對象之一）。見 docs/ADR-009-monitoring.md。
//   • 通道憑證只從 Worker secret 讀（`wrangler secret put`），**永不寫進 log**：失敗時只記通道名與 HTTP 狀態。
//   • 訊息只含公開資訊（合約位址、tx hash、數值），純文字送出，不讓鏈上資料被解讀成格式或 @mention：
//     Telegram 不設 parse_mode；Discord 沒有純文字模式，所以跳脫 Markdown 並關掉 mention 與連結預覽。
//   • 每個通道各自送、各自重送：一個通道壞了，不影響另一個通道，也不會讓壞掉那個的訊息被丟掉。
//   • 沒有任何通道設定時丟錯，讓 Cloudflare 把這次 cron 記成失敗，而不是無聲吞掉告警。
import { SEVERITIES, assertHttps, fetchWithTimeout, redactUrls } from "./engine.mjs";

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

export function formatNote(note, { deploymentId, runbookUrl } = {}) {
  const head = `${ICON[note.severity] ?? ""}[${note.severity}] ${note.status}｜${note.title}`;
  const lines = [head, ...note.lines, `規則：${note.ruleId}${deploymentId ? `（${deploymentId}）` : ""}`];
  if (runbookUrl) lines.push(`處置：${runbookUrl}`);
  return lines.join("\n");
}

/** 依環境變數組出可用的通道。格式不對的設定直接丟錯（設定錯誤要大聲失敗）。 */
export function channelsOf(env) {
  const ch = [];
  const tgToken = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const tgChat = String(env.TELEGRAM_CHAT_ID ?? "").trim();
  if (tgToken || tgChat) {
    if (!tgToken || !tgChat) throw new Error("TELEGRAM_BOT_TOKEN 與 TELEGRAM_CHAT_ID 必須同時設定");
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(tgToken)) throw new Error("TELEGRAM_BOT_TOKEN 格式不對");
    ch.push({
      name: "telegram",
      url: `https://api.telegram.org/bot${tgToken}/sendMessage`,
      body: (text) => ({ chat_id: tgChat, text: text.slice(0, 4000), disable_web_page_preview: true }),
    });
  }
  const discord = String(env.DISCORD_WEBHOOK_URL ?? "").trim();
  if (discord) {
    if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(discord)) {
      throw new Error("DISCORD_WEBHOOK_URL 必須是 https://discord.com/api/webhooks/…");
    }
    ch.push({
      name: "discord",
      url: discord,
      // flags 4 = SUPPRESS_EMBEDS：不展開連結預覽。
      body: (text) => ({ content: escapeDiscord(text).slice(0, 1900), allowed_mentions: { parse: [] }, flags: 4 }),
    });
  }
  const hook = String(env.ALERT_WEBHOOK_URL ?? "").trim();
  if (hook) {
    assertHttps("ALERT_WEBHOOK_URL", hook);
    ch.push({ name: "webhook", url: hook, body: null, secret: String(env.ALERT_WEBHOOK_SECRET ?? "") });
  }
  return ch;
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
 */
export async function sendToChannel(note, text, channel, fetchImpl, { log = () => {}, now = Math.floor(Date.now() / 1000), timeoutMs = NOTIFY_TIMEOUT_MS } = {}) {
  try {
    let payload;
    const headers = { "Content-Type": "application/json" };
    if (channel.body) payload = JSON.stringify(channel.body(text));
    else {
      payload = JSON.stringify({
        source: "pepelab-chain-monitor",
        severity: note.severity,
        status: note.status,
        ruleId: note.ruleId,
        key: note.key,
        title: note.title,
        text,
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

/** 監控自身的告警（讀取失敗、落後、狀態重置、通道失效）。 */
export const isSelfNote = (note) => note.ruleId === "monitor-self" || String(note.key ?? "").startsWith("monitor-self");

/**
 * MUTE_KEYS：逗號分隔的告警 key。一個項目靜音「完全相同的 key」與「以它為前綴的子 key」
 * （`x402-payto:unsafe` 只靜音那一則；`fee-withdrawals` 靜音整條規則）。
 * monitor-self 開頭的項目一律忽略——監控自身的故障不可以被靜音。回傳 { keys, ignored }。
 */
export function parseMuteKeys(text) {
  const keys = [];
  const ignored = [];
  for (const k of String(text ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (k.startsWith("monitor-self") || !/^[a-z0-9][a-z0-9-]*(:[^\s,]+)?$/.test(k)) ignored.push(k);
    else keys.push(k);
  }
  return { keys, ignored };
}
export const isMuted = (note, muteKeys = []) => muteKeys.some((k) => note.key === k || String(note.key ?? "").startsWith(`${k}:`));

/**
 * 這則通知要不要送。
 *   • monitor-self:* 永遠送：不受 MIN_SEVERITY 也不受 MUTE_KEYS 影響。把嚴重度門檻調高來壓掉一則
 *     吵人的 SEV-3，不應該連「RPC 全掛、監控瞎了」一起壓掉（審查 M2）。
 *   • MUTE_KEYS 命中的不送（針對單一已知告警，取代「把 MIN_SEVERITY 調到 SEV-2」）。
 *   • 其餘依 MIN_SEVERITY；恢復通知以「原嚴重度」判斷：觸發時送過的，恢復時一定也送。
 */
export function shouldSend(note, minSeverity = "SEV-4", muteKeys = []) {
  const min = SEVERITIES.indexOf(minSeverity);
  if (min < 0) throw new Error(`MIN_SEVERITY 不合法：${minSeverity}`);
  if (isSelfNote(note)) return true;
  if (isMuted(note, muteKeys)) return false;
  const sev = note.status === "恢復" ? (note.origSeverity ?? note.severity) : note.severity;
  const i = SEVERITIES.indexOf(sev);
  return i >= 0 && i <= min;
}
