// 一輪監控的外層：讀 KV 狀態 → runOnce → 送通知（含重送 outbox）→ 存回 KV → 心跳。
// 與 worker.mjs 分開，讓測試可以注入 config、假 KV 與假 fetch。
import { assertHttps, configProblems, fetchWithTimeout, minSeverityOf, param, redactUrls, runOnce } from "./engine.mjs";
import { NOTIFY_TIMEOUT_MS, channelsOf, formatNote, parseMuteKeys, sendToChannel, shouldSend } from "./notify.mjs";

export const STATE_KEY = "state:v1";
/**
 * 基準（首次觀察到的 payTo…）放在獨立的 KV 鍵。要重設基準時只刪這個鍵，不必刪 state:v1——
 * 刪 state:v1 會連事件檢查點、開啟中的告警、累計視窗一起清掉（審查 M5）。
 */
export const BASELINES_KEY = "baselines:v1";
/** 送不出去的通知最多保留幾則（超過時丟最舊的）。 */
export const MAX_OUTBOX = 100;
/** 每輪最多重送幾則舊通知（subrequest 有限：壞掉的通道不可以把新告警的額度吃光）。 */
export const MAX_RESEND_PER_TICK = 10;
/** 舊通知最多重送多久（秒）；過期就丟（通道壞了一天以上，那則通知已經沒有時效）。 */
export const OUTBOX_TTL_SEC = 86_400;
/** 同一輪內某個通道連續失敗幾次後，本輪不再對它送（直接留在 outbox）。 */
const CHANNEL_GIVE_UP_AFTER = 2;
/** 某個通道連續幾輪都有通知送不出去，才發「通道送不出去」的監控自身告警。 */
export const CHANNEL_STUCK_ROUNDS = 2;

export async function tick({ config, env, now = Math.floor(Date.now() / 1000), fetchImpl = fetch, log = console.log, sleep }) {
  const channels = channelsOf(env);
  if (channels.length === 0) {
    throw new Error("沒有設定任何告警通道（TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID、DISCORD_WEBHOOK_URL 或 ALERT_WEBHOOK_URL）");
  }
  const hb = String(env.HEARTBEAT_URL ?? "").trim();
  if (hb) assertHttps("HEARTBEAT_URL", hb);
  const kv = env.MONITOR_STATE;
  if (!kv) throw new Error("缺少 KV binding MONITOR_STATE");
  const state = (await kv.get(STATE_KEY, "json")) ?? {};
  const storedBaselines = (await kv.get(BASELINES_KEY, "json")) ?? {};
  state.baselines = { ...(state.baselines ?? {}), ...storedBaselines }; // 引擎只看 state.baselines；存回時再拆開

  // 上一輪留下來的 outbox：每則記著「還有哪些通道沒送到」。通道已經從設定移除的就不再等它。
  const names = channels.map((c) => c.name);
  const carried = [];
  let expired = 0;
  for (const item of state.outbox ?? []) {
    const pending = (item.channels ?? names).filter((n) => names.includes(n));
    if (!pending.length) continue;
    if (now - (item.firstAt ?? now) > OUTBOX_TTL_SEC) expired++;
    else carried.push({ ...item, channels: pending, firstAt: item.firstAt ?? now });
  }
  // 某個通道連續 CHANNEL_STUCK_ROUNDS 輪都有通知送不出去 → 透過（其他還活著的）通道講出來。
  // 單輪失敗（對方限流、短暫 5xx）下一輪重送就好，不值得告警。全部通道都壞時靠 cron 失敗與心跳停止。
  const stuck = new Map();
  for (const item of carried) for (const n of item.channels) stuck.set(n, (stuck.get(n) ?? 0) + 1);
  const selfFindings = [...stuck].filter(([name]) => (state.channelStuck?.[name] ?? 0) >= CHANNEL_STUCK_ROUNDS).map(([name, count]) => ({
    ruleId: "monitor-self",
    key: `monitor-self:channel:${name}`,
    severity: "SEV-3",
    title: `告警通道 ${name} 送不出去`,
    lines: [
      `${count} 則通知還沒送到 ${name}（留在 outbox，每輪重送最多 ${MAX_RESEND_PER_TICK} 則，超過 ${OUTBOX_TTL_SEC / 3600} 小時丟棄）`,
      "其他通道不受影響。請檢查這個通道的 bot token／webhook 是否被撤銷或限流",
    ],
  }));

  // 設定問題（不經 CI 的覆寫值）：不在白名單的 MUTE_KEYS、等於關掉告警的門檻、MIN_SEVERITY=SEV-1。
  // Worker 以安全值照常運作，同時用 monitor-self 講出來（不可靜音）。複審 M-A、L-f。
  const allowedMute = (config.mutableKeys ?? []).map((m) => m.key);
  const mute = parseMuteKeys(param(config, env, "MUTE_KEYS"), allowedMute);
  const cfgIssues = configProblems(config, env);
  if (mute.rejected.length || mute.ignored.length) {
    cfgIssues.unshift(
      `設定了不可靜音的 key：${[...mute.rejected, ...mute.ignored].join(", ")}（已忽略，照常送出）；只有 monitors.json 的 mutableKeys 可以靜音：${allowedMute.join(", ") || "（無）"}`,
    );
  }
  if (cfgIssues.length) {
    selfFindings.push({ ruleId: "monitor-self", key: "monitor-self:config", severity: "SEV-2", title: "監控設定問題", lines: cfgIssues });
  }

  const { notes, errors, summary } = await runOnce({ config, env, state, fetchImpl, now, log, sleep, selfFindings });
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
  const minSev = minSeverityOf(config, env);
  if (cfgIssues.length) log(`設定問題：${cfgIssues.join(" | ").slice(0, 300)}`);
  const ruleById = new Map(config.rules.map((r) => [r.id, r]));
  const fresh = notes
    .filter((n) => shouldSend(n, minSev, mute.keys))
    .map((n) => ({
      note: n,
      text: formatNote(n, { deploymentId: config.deployment?.id, runbookUrl: ruleById.get(n.ruleId)?.runbookUrl }),
      channels: [...names],
      firstAt: now,
      at: n.at ?? now,
    }));

  // 送出：新通知優先（全部通道），再重送舊的（每輪有上限）。每個通道各自記帳：
  // A 通道送到、B 通道失敗 → 這則只對 B 重送（審查 L6：原本只要有一個通道送到，其他通道的失敗就被丟掉）。
  const byName = new Map(channels.map((c) => [c.name, c]));
  const streak = new Map(); // 本輪各通道連續失敗次數
  let delivered = 0;
  const deliver = async (item) => {
    const still = [];
    for (const n of item.channels) {
      if ((streak.get(n) ?? 0) >= CHANNEL_GIVE_UP_AFTER) {
        still.push(n); // 這個通道本輪看起來掛了：不再浪費 subrequest，留到下一輪
        continue;
      }
      if (await sendToChannel(item.note, item.text, byName.get(n), fetchImpl, { log, now, timeoutMs: NOTIFY_TIMEOUT_MS, deploymentId: config.deployment?.id ?? "" })) {
        streak.set(n, 0);
        delivered++;
      } else {
        streak.set(n, (streak.get(n) ?? 0) + 1);
        still.push(n);
      }
    }
    item.channels = still;
  };
  // 依「發生時間」送：通道恢復的那一輪，舊的「觸發」要先於新的「恢復」到（複審 L-e：原本新通知先送，
  // 值班的人會先看到恢復、再看到觸發）。舊通知每輪最多重送 MAX_RESEND_PER_TICK 則；壞掉的通道
  // 本輪失敗 CHANNEL_GIVE_UP_AFTER 次後就不再對它送，所以不會吃光新告警的額度。
  const batch = [...carried.slice(0, MAX_RESEND_PER_TICK), ...fresh]
    .map((item, i) => ({ item, i }))
    .sort((x, y) => (x.item.at ?? x.item.firstAt ?? 0) - (y.item.at ?? y.item.firstAt ?? 0) || x.i - y.i);
  for (const { item } of batch) await deliver(item);

  const undelivered = [...carried, ...fresh].filter((item) => item.channels.length);
  let dropped = expired;
  if (undelivered.length > MAX_OUTBOX) {
    dropped += undelivered.length - MAX_OUTBOX;
    undelivered.splice(0, undelivered.length - MAX_OUTBOX);
  }
  state.outbox = undelivered;
  // 各通道「連續幾輪有通知送不出去」。
  const stuckNow = new Set(undelivered.flatMap((item) => item.channels));
  state.channelStuck = Object.fromEntries([...stuckNow].map((n) => [n, (state.channelStuck?.[n] ?? 0) + 1]));
  const baselines = state.baselines ?? {};
  delete state.baselines;
  if (JSON.stringify(baselines) !== JSON.stringify(storedBaselines)) await kv.put(BASELINES_KEY, JSON.stringify(baselines));
  await kv.put(STATE_KEY, JSON.stringify(state));

  log(`tick: findings=${summary.findings} notes=${notes.length} delivered=${delivered} pending=${undelivered.length} dropped=${dropped} errors=${errors.length} rpc=${summary.rpcRequests}+${summary.rpcRetries}`);

  // 心跳（dead-man's switch）：只有整輪乾淨時才打，所以「心跳停了」同時涵蓋 Worker 停擺、
  // 規則讀取失敗與通道失效。HEARTBEAT_URL 是 Worker secret（URL 本身就是憑證，不進 log）。
  if (hb && errors.length === 0 && undelivered.length === 0) {
    try {
      await fetchWithTimeout(fetchImpl, hb, { method: "GET" }, NOTIFY_TIMEOUT_MS);
    } catch (e) {
      const aborted = e?.name === "AbortError" || /abort/i.test(String(e?.message ?? ""));
      log(`heartbeat 失敗：${aborted ? "逾時" : redactUrls(e?.message ?? e).slice(0, 80)}`);
    }
  }
  if (undelivered.length) {
    const per = new Map();
    for (const item of undelivered) for (const n of item.channels) per.set(n, (per.get(n) ?? 0) + 1);
    const detail = [...per].map(([n, c]) => `${n}×${c}`).join("、");
    throw new Error(`${undelivered.length} 則告警未送達（${detail}；已留在 outbox 重送）${dropped ? `，另丟棄 ${dropped} 則` : ""}`);
  }
  if (errors.length) throw new Error(`${errors.length} 條規則讀取失敗：${errors.join(" | ").slice(0, 400)}`);
  return { notes, errors, sent: delivered };
}
