// 告警送出：Telegram／Discord／通用 webhook（例如轉寄 email 的服務）。
//
// 設計原則：
//   • 不需要 GitHub token，也不開 issue —— 監控不擴大 keeper-trigger 那把 Actions token 的權限，
//     也不依賴 GitHub Actions（它正是要被監控的對象之一）。見 docs/ADR-009-monitoring.md。
//   • 通道憑證只從 Worker secret 讀（`wrangler secret put`），**永不寫進 log**：失敗時只記通道名與 HTTP 狀態。
//   • 訊息只含公開資訊（合約位址、tx hash、數值），純文字送出，不讓鏈上資料被解讀成格式或 @mention。
//   • 沒有任何通道設定時丟錯，讓 Cloudflare 把這次 cron 記成失敗，而不是無聲吞掉告警。
import { SEVERITIES } from "./engine.mjs";

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
      body: (text) => ({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }),
    });
  }
  const hook = String(env.ALERT_WEBHOOK_URL ?? "").trim();
  if (hook) {
    if (!/^https:\/\//.test(hook)) throw new Error("ALERT_WEBHOOK_URL 必須是 https");
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
 * 送一則通知到所有通道。回傳成功送達的通道數；全部失敗時呼叫端會把它留在 outbox 重送。
 */
export async function sendNote(note, text, channels, fetchImpl, log = () => {}) {
  let delivered = 0;
  for (const c of channels) {
    try {
      let payload;
      const headers = { "Content-Type": "application/json" };
      if (c.body) payload = JSON.stringify(c.body(text));
      else {
        payload = JSON.stringify({
          source: "pepelab-chain-monitor",
          severity: note.severity,
          status: note.status,
          ruleId: note.ruleId,
          key: note.key,
          title: note.title,
          text,
        });
        if (c.secret) headers["X-Pepelab-Signature"] = `sha256=${await hmacHex(c.secret, payload)}`;
      }
      const res = await fetchImpl(c.url, { method: "POST", headers, body: payload });
      if (res.ok) delivered++;
      else log(`notify ${c.name} 失敗：HTTP ${res.status}`);
    } catch (e) {
      // 不印 e.message 以外的東西；fetch 的錯誤訊息不含 URL。
      log(`notify ${c.name} 例外：${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
  return delivered;
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
