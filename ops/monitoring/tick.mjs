// 一輪監控的外層：讀 KV 狀態 → runOnce → 送通知（含重送 outbox）→ 存回 KV → 心跳。
// 與 worker.mjs 分開，讓測試可以注入 config、假 KV 與假 fetch。
//
// 核心不變量：**SEV-1 一定送得出去，除非通道本身壞了；通道壞了也要有人知道。**
//   • 設定（參數、通道、心跳、RPC）格式不對：只停用／夾住那一項，照常跑，並發不可靜音的
//     monitor-self:config（params.mjs、notify.channelsOf）。
//   • 通知量大：同一條規則一輪內的大量事件合併成一則摘要（roundSummaries）。
//   • outbox 滿了：依嚴重度丟——先丟最低嚴重度、最舊的；SEV-1 與 monitor-self 永不因溢位被丟，
//     超過容量時把最舊的合併成摘要（planOutbox）。有丟棄或合併就發 monitor-self:outbox。
//   • 送出順序：SEV-1 與 monitor-self 優先，其次依發生時間；subrequest 預算先給它們（orderForSend）。
//   • 通道送不出去：留在 outbox、連續幾輪就透過其他通道講；全部送不出去時這次 cron 記為失敗、不打心跳。
import { configProblems, fetchWithTimeout, minSeverityOf, param, redactUrls, runOnce } from "./engine.mjs";
import { NOTIFY_TIMEOUT_MS, channelsOf, formatNote, isSelfNote, parseMuteKeys, sendToChannel, shouldSend } from "./notify.mjs";
import { SEVERITIES, envSecret } from "./params.mjs";

export const STATE_KEY = "state:v1";
/**
 * 基準（首次觀察到的 payTo…）放在獨立的 KV 鍵。要重設基準時只刪這個鍵，不必刪 state:v1——
 * 刪 state:v1 會連事件檢查點、開啟中的告警、累計視窗一起清掉（審查 M5）。
 */
export const BASELINES_KEY = "baselines:v1";
/** 非關鍵通知（SEV-2～SEV-4、恢復）在 outbox 最多保留幾則；超過時先丟最低嚴重度、最舊的。 */
export const MAX_OUTBOX = 100;
/** 關鍵通知（SEV-1、monitor-self）最多保留幾則；超過時把最舊的合併成一則摘要（不丟）。 */
export const MAX_CRITICAL_OUTBOX = 200;
/**
 * 舊通知最多重送多久（秒）。非關鍵的過期就丟（並在 monitor-self:outbox 講出來）；關鍵的只有在
 * 「至少一個通道已經送到」時才過期——一個通道都沒送到的 SEV-1 不因時間被丟。
 */
export const OUTBOX_TTL_SEC = 86_400;
/** Cloudflare 免費方案每次執行的 subrequest 上限（fetch 次數；KV 不算）。通知的預算＝上限－本輪已用。 */
export const SUBREQUEST_LIMIT = 50;
/** 預算算出來太少時，仍至少嘗試送幾則（SEV-1 與 monitor-self 排在最前面）。 */
export const NOTIFY_MIN_BUDGET = 5;
/** 同一條規則一輪內超過幾則「事件」通知就合併成一則摘要。 */
export const ROUND_SUMMARY_AFTER = 5;
/** 摘要裡逐筆列出的明細數。 */
export const SUMMARY_DETAILS = 5;
/** 同一輪內某個通道連續失敗幾次後，本輪不再對它送（直接留在 outbox）。 */
const CHANNEL_GIVE_UP_AFTER = 2;
/** 某個通道連續幾輪都送失敗，才發「通道送不出去」的監控自身告警。 */
export const CHANNEL_STUCK_ROUNDS = 2;

const sevRank = (s) => {
  const i = SEVERITIES.indexOf(s);
  return i < 0 ? SEVERITIES.length : i;
};
const iso = (t) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
/** 32-bit FNV-1a（只用來比較「內容有沒有變」，不是安全雜湊）。 */
const shortHash = (s) => {
  let h = 0x811c9dc5;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};
const atOf = (item) => item.at ?? item.note?.at ?? item.firstAt ?? 0;
/** 這則通知的「實際」嚴重度：恢復通知以原嚴重度計（SEV-1 的恢復也是關鍵通知）。 */
const effSeverity = (note) => (note.status === "恢復" ? (note.origSeverity ?? note.severity) : note.severity);
/** 關鍵通知：SEV-1（含 SEV-1 的恢復）與 monitor-self。不因溢位被丟、送出時排最前面。 */
export const isCritical = (note) => isSelfNote(note) || effSeverity(note) === "SEV-1";

/**
 * 同一條規則一輪內的大量事件通知合併成一則摘要（複審 M-2(4)）：事故當下本來就會爆量（連續提領、
 * 一次 grant 十幾個角色），測試網上也有人能用 faucet 便宜地製造大量提領。逐筆送會吃光 subrequest
 * 與 outbox，把同一段時間的 SEV-1 擠掉。摘要帶筆數、首末時間與前幾筆明細，嚴重度取最嚴重的那筆。
 */
export function roundSummaries(notes, { limit = ROUND_SUMMARY_AFTER, details = SUMMARY_DETAILS } = {}) {
  const groups = new Map();
  for (const n of notes) {
    if (n.status !== "事件" || isSelfNote(n)) continue;
    if (!groups.has(n.ruleId)) groups.set(n.ruleId, []);
    groups.get(n.ruleId).push(n);
  }
  const merged = new Set();
  const out = [];
  for (const [ruleId, list] of groups) {
    if (list.length <= limit) continue;
    for (const n of list) merged.add(n);
    const sorted = [...list].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    const [first, last] = [sorted[0], sorted.at(-1)];
    const severity = sorted.reduce((s, n) => (sevRank(n.severity) < sevRank(s) ? n.severity : s), "SEV-4");
    const pick = (n, re) => n.lines.find((l) => re.test(l));
    const contracts = [...new Set(sorted.map((n) => pick(n, /^合約：/)).filter(Boolean))];
    out.push({
      ruleId,
      key: `${ruleId}:summary:${first.at ?? 0}-${last.at ?? 0}:${list.length}`,
      severity,
      status: "事件",
      title: `${first.title}（本輪 ${list.length} 筆，合併為摘要）`,
      at: first.at,
      firstAt: first.at,
      lines: [
        `本輪掃到 ${list.length} 筆${first.at ? `，發生時間 ${iso(first.at)} ～ ${iso(last.at ?? first.at)}` : ""}；為了不擠掉其他告警，合併成這一則`,
        ...contracts.slice(0, 3),
        `前 ${Math.min(details, sorted.length)} 筆：`,
        ...sorted.slice(0, details).map((n, i) =>
          [`#${i + 1}`, pick(n, /^事件：/), pick(n, /^金額：/), pick(n, /^tx：/)].filter(Boolean).join(" ｜ "),
        ),
        ...(sorted.length > details ? [`其餘 ${sorted.length - details} 筆沒有逐筆通知：請到 explorer 查上列合約在這段時間的事件`] : []),
      ],
    });
  }
  return [...notes.filter((n) => !merged.has(n)), ...out];
}

/** 一則 outbox 項目。 */
const itemOf = (note, text, channels, now) => ({ note, text, channels: [...channels], firstAt: now, at: note.at ?? now, sent: [] });

/**
 * outbox 的保留政策（複審 M-2(1)(3)）。pool 是本輪要處理的全部項目（上一輪留下的＋本輪新的）。
 *   • 非關鍵：超過 MAX_OUTBOX 時先丟最低嚴重度、同嚴重度內最舊的。
 *   • 關鍵（SEV-1、monitor-self）：永不丟；超過 MAX_CRITICAL_OUTBOX 時把最舊的合併成一則摘要。
 * 回傳 { keep, dropped, merged }（dropped／merged 是項目陣列，供 monitor-self:outbox 統計）。
 */
export function planOutbox(pool, { maxOutbox = MAX_OUTBOX, maxCritical = MAX_CRITICAL_OUTBOX } = {}) {
  const crit = pool.filter((i) => isCritical(i.note));
  const non = pool.filter((i) => !isCritical(i.note));
  let dropped = [];
  let keptNon = non;
  if (non.length > maxOutbox) {
    // 丟棄順序：嚴重度低的先、同嚴重度內舊的先。
    const order = [...non].sort((a, b) => sevRank(effSeverity(b.note)) - sevRank(effSeverity(a.note)) || atOf(a) - atOf(b));
    dropped = order.slice(0, non.length - maxOutbox);
    const gone = new Set(dropped);
    keptNon = non.filter((i) => !gone.has(i));
  }
  let merged = [];
  let keptCrit = crit;
  if (crit.length > maxCritical) {
    const order = [...crit].sort((a, b) => atOf(a) - atOf(b));
    merged = order.slice(0, crit.length - maxCritical + 1);
    const gone = new Set(merged);
    keptCrit = [digestOf(merged), ...crit.filter((i) => !gone.has(i))];
  }
  return { keep: [...keptCrit, ...keptNon], dropped, merged };
}

/** 把多則關鍵通知合併成一則（SEV-1、不可靜音）。通道取聯集：任何一則還沒送到的通道都要收到摘要。 */
function digestOf(items) {
  const count = items.reduce((s, i) => s + (i.note.mergedCount ?? 1), 0);
  const [first, last] = [atOf(items[0]), atOf(items.at(-1))];
  const keys = [...new Set(items.map((i) => i.note.key))];
  const note = {
    ruleId: "monitor-self",
    key: `monitor-self:outbox-digest:${first}-${last}:${count}`,
    severity: "SEV-1",
    status: "事件",
    title: `${count} 則 SEV-1／監控自身通知合併（outbox 容量已滿，未丟棄）`,
    at: first,
    firstAt: first,
    mergedCount: count,
    lines: [
      `通道長時間送不出去，關鍵通知超過 ${MAX_CRITICAL_OUTBOX} 則；最舊的 ${count} 則合併成這一則（發生時間 ${iso(first)} ～ ${iso(last)}）`,
      `涉及的 key（${keys.length} 個）：${keys.slice(0, 12).join("、")}${keys.length > 12 ? "…" : ""}`,
      ...items.slice(0, 5).map((i) => `• ${String(i.text ?? "").split("\n")[0].slice(0, 160)}`),
      "逐筆內容已無法重送：請到 explorer 查這段時間的事件，並檢查告警通道",
    ],
  };
  const channels = [...new Set(items.flatMap((i) => i.channels))];
  return { note, text: formatNote(note), channels, firstAt: Math.min(...items.map((i) => i.firstAt ?? first)), at: first, sent: [] };
}

/**
 * 送出順序（複審 M-2(2)）：SEV-1 與 monitor-self 優先，其次依發生時間。同一個 key 只要有一則是關鍵的，
 * 這個 key 的全部通知都一起提前——保留 L-e：同一個 key 的「觸發」先於它的「恢復」。
 */
export function orderForSend(items) {
  const critKeys = new Set(items.filter((i) => isCritical(i.note)).map((i) => i.note.key));
  // monitor-self:outbox（有通知被丟或合併）排在最前面：積欠很多時它不可以排在幾百則舊通知後面。
  const cls = (i) => (i.note.urgent ? -1 : isCritical(i.note) || critKeys.has(i.note.key) ? 0 : 1);
  return items
    .map((item, i) => ({ item, i }))
    .sort((x, y) => cls(x.item) - cls(y.item) || atOf(x.item) - atOf(y.item) || x.i - y.i)
    .map((x) => x.item);
}

/** monitor-self:outbox 的統計（數量、涉及的 key、時間範圍）。 */
function outboxStats(dropped, merged, expired) {
  const all = [...dropped, ...merged, ...expired];
  const bySev = {};
  for (const i of dropped) bySev[effSeverity(i.note)] = (bySev[effSeverity(i.note)] ?? 0) + 1;
  const times = all.map(atOf).filter((t) => t > 0);
  return {
    dropped: dropped.length,
    merged: merged.reduce((s, i) => s + (i.note.mergedCount ?? 1), 0),
    expired: expired.length,
    bySev,
    keys: [...new Set(all.map((i) => i.note.key))].slice(0, 30),
    from: times.length ? Math.min(...times) : null,
    to: times.length ? Math.max(...times) : null,
  };
}
const addStats = (a, b) => ({
  dropped: a.dropped + b.dropped,
  merged: a.merged + b.merged,
  expired: a.expired + b.expired,
  bySev: Object.fromEntries([...new Set([...Object.keys(a.bySev), ...Object.keys(b.bySev)])].map((k) => [k, (a.bySev[k] ?? 0) + (b.bySev[k] ?? 0)])),
  keys: [...new Set([...a.keys, ...b.keys])].slice(0, 30),
  from: [a.from, b.from].filter((x) => x !== null).reduce((m, x) => Math.min(m, x), Infinity),
  to: [a.to, b.to].filter((x) => x !== null).reduce((m, x) => Math.max(m, x), -Infinity),
});
function outboxNote(stats, now) {
  const from = Number.isFinite(stats.from) ? stats.from : null;
  const to = Number.isFinite(stats.to) ? stats.to : null;
  const sev = Object.entries(stats.bySev).sort().map(([s, n]) => `${s}×${n}`).join("、");
  return {
    ruleId: "monitor-self",
    key: `monitor-self:outbox:${now}`,
    severity: "SEV-2",
    status: "事件",
    title: "告警 outbox 溢位：有通知被丟棄或合併",
    urgent: true,
    at: now,
    firstAt: now,
    stats: { ...stats, from, to },
    lines: [
      `丟棄 ${stats.dropped} 則${sev ? `（${sev}）` : ""}、過期丟棄 ${stats.expired} 則、合併 ${stats.merged} 則 SEV-1／監控自身通知（合併的沒有丟，見另一則摘要）`,
      ...(from !== null ? [`涉及通知的發生時間：${iso(from)} ～ ${iso(to ?? from)}`] : []),
      `涉及的 key：${stats.keys.slice(0, 12).join("、") || "（無）"}${stats.keys.length > 12 ? "…" : ""}`,
      "代表告警通道長時間送不出去或通知量異常：請檢查通道，並到 explorer 補查這段時間的事件",
    ],
  };
}

export async function tick({ config, env, now = Math.floor(Date.now() / 1000), fetchImpl = fetch, log = console.log, sleep }) {
  const { channels, problems: channelProblems } = channelsOf(env);
  if (channels.length === 0) {
    // 全部通道都不可用：明確失敗（Cloudflare 把這次 cron 記成失敗）。訊息不帶值。
    const why = channelProblems.length ? channelProblems.join("；") : "沒有設定任何告警通道（TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID、DISCORD_WEBHOOK_URL 或 ALERT_WEBHOOK_URL）";
    throw new Error(`沒有可用的告警通道：${why}`);
  }
  // 心跳 URL 格式不對：停用心跳並回報（不丟錯——丟錯會讓整輪停擺、SEV-1 送不出去）。
  let hb = envSecret(env, "HEARTBEAT_URL");
  const hbProblems = [];
  if (hb) {
    let ok = false;
    try {
      ok = new URL(hb).protocol === "https:";
    } catch {
      /* 不是 URL */
    }
    if (!ok) {
      hb = "";
      hbProblems.push("HEARTBEAT_URL 不是 https:// 開頭的合法 URL（值不顯示）：心跳已停用，外部的 dead-man's switch 會因此告警");
    }
  }
  const kv = env.MONITOR_STATE;
  if (!kv) throw new Error("缺少 KV binding MONITOR_STATE");
  const state = (await kv.get(STATE_KEY, "json")) ?? {};
  const storedBaselines = (await kv.get(BASELINES_KEY, "json")) ?? {};
  state.baselines = { ...(state.baselines ?? {}), ...storedBaselines }; // 引擎只看 state.baselines；存回時再拆開

  // 上一輪留下來的 outbox：每則記著「還有哪些通道沒送到」。
  const names = channels.map((c) => c.name);
  const carried = [];
  const expired = [];
  for (const item of state.outbox ?? []) {
    item.sent ??= [];
    let pending = (item.channels ?? names).filter((n) => names.includes(n));
    if (!pending.length) {
      // 原本要送的通道已移除或被停用：送到過任何一個通道的就算了；一個都沒送到的改送現有通道（不默默丟掉）。
      if (item.sent.length) continue;
      pending = [...names];
    }
    const stale = now - (item.firstAt ?? now) > OUTBOX_TTL_SEC;
    if (stale && (!isCritical(item.note) || item.sent.length)) {
      if (!isCritical(item.note)) expired.push(item);
      continue;
    }
    carried.push({ ...item, channels: pending, firstAt: item.firstAt ?? now });
  }
  // 某個通道連續 CHANNEL_STUCK_ROUNDS 輪都送失敗 → 透過（其他還活著的）通道講出來。
  // 單輪失敗（對方限流、短暫 5xx）下一輪重送就好，不值得告警。全部通道都壞時靠 cron 失敗與心跳停止。
  const stuck = new Map();
  for (const item of carried) for (const n of item.channels) stuck.set(n, (stuck.get(n) ?? 0) + 1);
  const selfFindings = [...stuck].filter(([name]) => (state.channelStuck?.[name] ?? 0) >= CHANNEL_STUCK_ROUNDS).map(([name, count]) => ({
    ruleId: "monitor-self",
    key: `monitor-self:channel:${name}`,
    severity: "SEV-3",
    title: `告警通道 ${name} 送不出去`,
    lines: [
      `${count} 則通知還沒送到 ${name}（留在 outbox 每輪重送；SEV-1 與監控自身通知不會因時間或容量被丟）`,
      "其他通道不受影響。請檢查這個通道的 bot token／webhook 是否被撤銷或限流",
    ],
  }));

  // 設定問題（不經 CI 的覆寫值、格式不對的通道或心跳）：Worker 以安全值照常運作，同時用
  // monitor-self:config 講出來（不可靜音）。複審 M-A、L-f、M-1、L-4。
  const allowedMute = (config.mutableKeys ?? []).map((m) => m.key);
  const mute = parseMuteKeys(param(config, env, "MUTE_KEYS"), allowedMute);
  const cfgIssues = [...channelProblems, ...hbProblems, ...configProblems(config, env)];
  if (mute.rejected.length || mute.ignored.length) {
    cfgIssues.unshift(
      `設定了不可靜音的 key：${[...mute.rejected, ...mute.ignored].join(", ")}（已忽略，照常送出）；只有 monitors.json 的 mutableKeys 可以靜音：${allowedMute.join(", ") || "（無）"}`,
    );
  }
  if (cfgIssues.length) {
    // 指紋＝問題內容：告警開著時又多了（或換了）一個設定問題，要立刻再通知，不等 REMIND_SEC（同 L-2）。
    selfFindings.push({
      ruleId: "monitor-self",
      key: "monitor-self:config",
      severity: "SEV-2",
      title: "監控設定問題",
      lines: cfgIssues,
      fingerprint: shortHash(cfgIssues.join("\n")),
      changeNote: "設定問題的內容與上次通知不同（見上列）",
    });
  }

  // 本輪已用的 subrequest（通知的預算＝上限－已用）。
  let used = 0;
  const counted = (...a) => {
    used++;
    return fetchImpl(...a);
  };
  const { notes, errors, summary } = await runOnce({ config, env, state, fetchImpl: counted, now, log, sleep, selfFindings });
  // KV 沒有事件檢查點（首次部署，或 state:v1 被刪／遺失）：這一輪才重新開始掃，只往回看
  // INITIAL_LOOKBACK_BLOCKS（有上下限）。更早的區塊沒有被掃到，要講出來——否則狀態遺失期間的
  // owner／角色／接線變更會無聲漏掉。
  if (summary.initialFrom !== undefined) {
    const back = param(config, env, "INITIAL_LOOKBACK_BLOCKS");
    notes.push({
      ruleId: "monitor-self",
      key: `monitor-self:state-reset:${summary.initialFrom}`,
      severity: "SEV-3",
      status: "事件",
      title: "監控狀態重置",
      lines: [
        `KV 沒有事件檢查點（首次部署，或狀態被清除／遺失）：事件掃描往回看 ${back} 個區塊（約 ${Math.round((Number(back) * (config.network?.blockTimeSec ?? 2)) / 60)} 分鐘），從區塊 ${summary.initialFrom} 重新開始；更早的事件未掃描`,
        "開啟中的告警、累計提領視窗、保險金與餘額高點也從零開始累積",
        `若不是剛部署：到 ${config.network.explorer} 補查狀態遺失期間的 owner／角色／接線變更`,
      ],
    });
  }
  const minSev = minSeverityOf(config, env);
  if (cfgIssues.length) log(`設定問題：${cfgIssues.join(" | ").slice(0, 300)}`);
  const ruleById = new Map(config.rules.map((r) => [r.id, r]));
  const textOf = (n) => formatNote(n, { deploymentId: config.deployment?.id, runbookUrl: ruleById.get(n.ruleId)?.runbookUrl });
  const fresh = roundSummaries(notes.filter((n) => shouldSend(n, minSev, mute.keys))).map((n) => itemOf(n, textOf(n), names, now));

  // 保留政策：先決定要留哪些（送得出去的一定在裡面），有丟棄或合併就加一則 monitor-self:outbox。
  const plan = planOutbox([...carried, ...fresh]);
  let pool = plan.keep;
  if (plan.dropped.length || plan.merged.length || expired.length) {
    let stats = outboxStats(plan.dropped, plan.merged, expired);
    // 上一輪還沒送到任何通道的 outbox 通知併進這一則（通道壞很久時不會一輪一則地堆積）。
    const prior = pool.filter((i) => String(i.note.key).startsWith("monitor-self:outbox:") && !i.sent?.length && i.note.stats);
    for (const p of prior) stats = addStats(stats, p.note.stats);
    const gone = new Set(prior);
    pool = pool.filter((i) => !gone.has(i));
    const n = outboxNote(stats, now);
    pool.push(itemOf(n, textOf(n), names, now));
  }

  // 送出：關鍵的優先、其次依發生時間；預算用完就留到下一輪。每個通道各自記帳：
  // A 通道送到、B 通道失敗 → 這則只對 B 重送（審查 L6）。同一個 key 在某個通道送失敗後，
  // 本輪不再對該通道送這個 key 較晚的通知（不讓「恢復」比「觸發」先到）。
  const byName = new Map(channels.map((c) => [c.name, c]));
  const streak = new Map(); // 本輪各通道連續失敗次數
  const failedCh = new Set();
  const okCh = new Set();
  const blocked = new Set();
  let budget = Math.max(NOTIFY_MIN_BUDGET, SUBREQUEST_LIMIT - used - (hb ? 1 : 0));
  let delivered = 0;
  let deferred = 0;
  for (const item of orderForSend(pool)) {
    const still = [];
    for (const n of item.channels) {
      const bk = `${n}|${item.note.key}`;
      if (blocked.has(bk) || (streak.get(n) ?? 0) >= CHANNEL_GIVE_UP_AFTER || budget <= 0) {
        if (budget <= 0) deferred++;
        still.push(n);
        blocked.add(bk);
        continue;
      }
      budget--;
      if (await sendToChannel(item.note, item.text, byName.get(n), counted, { log, now, timeoutMs: NOTIFY_TIMEOUT_MS, deploymentId: config.deployment?.id ?? "" })) {
        streak.set(n, 0);
        okCh.add(n);
        delivered++;
        item.sent = [...(item.sent ?? []), n];
      } else {
        streak.set(n, (streak.get(n) ?? 0) + 1);
        failedCh.add(n);
        still.push(n);
        blocked.add(bk);
      }
    }
    item.channels = still;
  }

  const undelivered = pool.filter((item) => item.channels.length);
  state.outbox = undelivered;
  // 各通道「連續幾輪送失敗」：本輪有失敗 +1；本輪有成功或沒有積欠 → 0；只是預算用完沒輪到 → 不變。
  const pendingCh = new Set(undelivered.flatMap((item) => item.channels));
  state.channelStuck = Object.fromEntries(
    names
      .map((n) => [n, failedCh.has(n) ? (state.channelStuck?.[n] ?? 0) + 1 : okCh.has(n) || !pendingCh.has(n) ? 0 : (state.channelStuck?.[n] ?? 0)])
      .filter(([, v]) => v > 0),
  );
  const baselines = state.baselines ?? {};
  delete state.baselines;
  if (JSON.stringify(baselines) !== JSON.stringify(storedBaselines)) await kv.put(BASELINES_KEY, JSON.stringify(baselines));
  await kv.put(STATE_KEY, JSON.stringify(state));

  const droppedN = plan.dropped.length + expired.length;
  log(`tick: findings=${summary.findings} notes=${notes.length} delivered=${delivered} pending=${undelivered.length} dropped=${droppedN} merged=${plan.merged.length} errors=${errors.length} rpc=${summary.rpcRequests}+${summary.rpcRetries} subrequests=${used}`);

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
    const crit = undelivered.filter((i) => isCritical(i.note)).length;
    throw new Error(
      `${undelivered.length} 則告警未送達（${detail}；其中關鍵 ${crit} 則；已留在 outbox 重送${deferred ? `；本輪通知預算用完 ${deferred} 次` : ""}）` +
        `${droppedN ? `，另丟棄 ${droppedN} 則` : ""}${plan.merged.length ? `，合併 ${plan.merged.length} 則` : ""}`,
    );
  }
  if (errors.length) throw new Error(`${errors.length} 條規則讀取失敗：${errors.join(" | ").slice(0, 400)}`);
  return { notes, errors, sent: delivered };
}
