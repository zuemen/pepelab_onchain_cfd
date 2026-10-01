// 一輪監控的外層：讀 KV 狀態 → runOnce → 送通知（含重送 outbox）→ 存回 KV → 心跳。
// 與 worker.mjs 分開，讓測試可以注入 config、假 KV 與假 fetch。
import { runOnce, param } from "./engine.mjs";
import { channelsOf, formatNote, parseMuteKeys, sendNote, shouldSend } from "./notify.mjs";

export const STATE_KEY = "state:v1";
/**
 * 基準（首次觀察到的 payTo…）放在獨立的 KV 鍵。要重設基準時只刪這個鍵，不必刪 state:v1——
 * 刪 state:v1 會連事件檢查點、開啟中的告警、累計視窗一起清掉（審查 M5）。
 */
export const BASELINES_KEY = "baselines:v1";
/** 送不出去的通知最多保留幾則（超過時丟最舊的，並另發一則說明）。 */
export const MAX_OUTBOX = 100;

export async function tick({ config, env, now = Math.floor(Date.now() / 1000), fetchImpl = fetch, log = console.log, sleep }) {
  const channels = channelsOf(env);
  if (channels.length === 0) {
    throw new Error("沒有設定任何告警通道（TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID、DISCORD_WEBHOOK_URL 或 ALERT_WEBHOOK_URL）");
  }
  const kv = env.MONITOR_STATE;
  if (!kv) throw new Error("缺少 KV binding MONITOR_STATE");
  const state = (await kv.get(STATE_KEY, "json")) ?? {};
  const storedBaselines = (await kv.get(BASELINES_KEY, "json")) ?? {};
  state.baselines = { ...(state.baselines ?? {}), ...storedBaselines }; // 引擎只看 state.baselines；存回時再拆開

  const { notes, errors, summary } = await runOnce({ config, env, state, fetchImpl, now, log, sleep });
  // KV 沒有事件檢查點（首次部署，或 state:v1 被刪／遺失）：這一輪才從 head 附近重新開始掃。
  // 之前的區塊沒有被掃到，要講出來——否則狀態遺失期間的 owner／角色／接線變更會無聲漏掉。
  if (summary.initialFrom !== undefined) {
    notes.push({
      ruleId: "monitor-self",
      key: `monitor-self:state-reset:${summary.initialFrom}`,
      severity: "SEV-3",
      status: "事件",
      title: "監控狀態重置",
      lines: [
        `KV 沒有事件檢查點（首次部署，或狀態被清除／遺失）：事件掃描從區塊 ${summary.initialFrom} 重新開始，區塊 ${summary.initialFrom} 之前的事件未掃描`,
        "開啟中的告警、累計提領視窗、保險金與餘額高點也從零開始累積",
        `若不是剛部署：到 ${config.network.explorer} 補查這段期間的 owner／角色／接線變更`,
      ],
    });
  }
  const minSev = param(config, env, "MIN_SEVERITY");
  const mute = parseMuteKeys(param(config, env, "MUTE_KEYS"));
  if (mute.ignored.length) log(`MUTE_KEYS 忽略 ${mute.ignored.length} 個項目（monitor-self 不可靜音，或格式不對）`);
  const ruleById = new Map(config.rules.map((r) => [r.id, r]));
  const fresh = notes
    .filter((n) => shouldSend(n, minSev, mute.keys))
    .map((n) => ({
      note: n,
      text: formatNote(n, { deploymentId: config.deployment?.id, runbookUrl: ruleById.get(n.ruleId)?.runbookUrl }),
    }));

  const queue = [...(state.outbox ?? []), ...fresh];
  const undelivered = [];
  for (const item of queue) {
    const ok = await sendNote(item.note, item.text, channels, fetchImpl, log);
    if (ok === 0) undelivered.push(item);
  }
  let dropped = 0;
  if (undelivered.length > MAX_OUTBOX) {
    dropped = undelivered.length - MAX_OUTBOX;
    undelivered.splice(0, dropped);
  }
  state.outbox = undelivered;
  const baselines = state.baselines ?? {};
  delete state.baselines;
  if (JSON.stringify(baselines) !== JSON.stringify(storedBaselines)) await kv.put(BASELINES_KEY, JSON.stringify(baselines));
  await kv.put(STATE_KEY, JSON.stringify(state));

  log(`tick: findings=${summary.findings} notes=${notes.length} sent=${queue.length - undelivered.length - dropped} pending=${undelivered.length} errors=${errors.length}`);

  // 心跳（dead-man's switch）：只有整輪乾淨時才打，所以「心跳停了」同時涵蓋 Worker 停擺、
  // 規則讀取失敗與通道失效。HEARTBEAT_URL 是 Worker secret。
  const hb = String(env.HEARTBEAT_URL ?? "").trim();
  if (hb && errors.length === 0 && undelivered.length === 0) {
    try {
      await fetchImpl(hb, { method: "GET" });
    } catch (e) {
      log(`heartbeat 失敗：${String(e?.message ?? e).slice(0, 80)}`);
    }
  }
  if (undelivered.length) throw new Error(`${undelivered.length} 則告警未送達（已留在 outbox 重送）${dropped ? `，另丟棄最舊的 ${dropped} 則` : ""}`);
  if (errors.length) throw new Error(`${errors.length} 條規則讀取失敗：${errors.join(" | ").slice(0, 400)}`);
  return { notes, errors, sent: queue.length };
}
