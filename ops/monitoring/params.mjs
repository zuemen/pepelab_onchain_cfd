// 可調參數的單一來源（複審 M-1）：型別、上下限、組合限制，以及環境變數的存取點。
//
// 為什麼獨立成一個模組：CI（scripts/check-monitoring.mjs）與 Worker 執行期以前各有一張表——CI 有
// 31 個參數的範圍，執行期只夾住其中 4 個。Cloudflare dashboard 或 `wrangler deploy --var` 設的值不經
// CI，把 CONFIRMATIONS 設成 1e8 就能讓全部事件規則（包括 SEV-1）無聲停擺。現在兩邊 import 同一張表：
//   • CI：checkParamValue() 嚴格驗證 monitors.json 預設值與 wrangler.toml [vars]（超出就紅）。
//   • 執行期：resolveParams() 對**每一個**參數照表夾值；超出範圍或格式不對時用夾住後的值繼續跑，
//     並回傳問題清單（tick 發不可靜音的 monitor-self:config，只列參數名與值，不含秘密）。
//   • 引擎只能透過 param()／numParam()（engine.mjs）拿參數，它們只認這張表裡的名字；環境變數的其他
//     讀取點只能是 envSetting()／envSecret()（同樣只認下面兩張表）。monitor.test.mjs 掃描原始碼，
//     出現其他 env 讀取就紅——新增參數忘了加上下限會被擋下。
//
// 上下限寫在程式碼而不是 monitors.json：把預設值改到離譜的數字不能靠同一個檔案裡順手改上限放行。
// 範圍的原則：任何在範圍內的值都不可以「等於把告警關掉」（複審 L-3）。

export const SEVERITIES = ["SEV-1", "SEV-2", "SEV-3", "SEV-4"];
/** MIN_SEVERITY 可以設的值：不可以設成「只送 SEV-1」（那會把 SEV-2 的提領、價格過期、儲備率全部關掉）。 */
export const MIN_SEVERITY_ALLOWED = ["SEV-2", "SEV-3", "SEV-4"];
/**
 * 持續故障最晚幾輪內要告警：x402 讀取失敗最慢要 HTTP_FAILS_BEFORE_ALERT＋SELF_ERRORS_BEFORE_ALERT−1 輪
 * 才發 monitor-self:errors。6 輪 × 5 分鐘＝30 分鐘。
 */
export const MAX_ALERT_DELAY_ROUNDS = 6;

/**
 * 參數表。
 *   int      整數，min ≤ v ≤ max
 *   decimal  十進位金額（可含小數），min ≤ v ≤ max
 *   severity allowed 之一；執行期不合法時用 fallback
 *   url      https URL；執行期不合法時用預設值
 *   keys     MUTE_KEYS（格式與白名單由 notify.parseMuteKeys 處理）
 */
export const PARAM_SPECS = {
  // 確認數：Base 的 reorg 很淺；64 塊約 2 分鐘。更大等於把全部事件告警延後（複審 M-1：1e8 → 永不掃描）。
  CONFIRMATIONS: { type: "int", min: 0, max: 64 },
  // KV 沒有檢查點時往回掃的區塊數。下限 150（一輪 cron 的區塊數）：狀態遺失時不可以從「現在」開始、
  // 靜默漏掉中間的事件（複審 M-1：0 或 0.5 → 永不掃描）。上限 10,000（MAX_SCAN_REQUESTS × MAX_BLOCK_RANGE）。
  INITIAL_LOOKBACK_BLOCKS: { type: "int", min: 150, max: 10_000 },
  // 公開 RPC（sepolia.base.org）的 eth_getLogs 上限是 1,000 塊（2026-10-01 實測）。下限 300：
  // 300 × MAX_SCAN_REQUESTS 下限 2 = 600 塊／輪，是 cron 間隔（150 塊）的 4 倍，落後時追得上。
  MAX_BLOCK_RANGE: { type: "int", min: 300, max: 1000 },
  // Cloudflare 免費方案每次執行 50 個 subrequest：事件掃描最多佔 20 個，其餘留給狀態規則與通知。
  MAX_SCAN_REQUESTS: { type: "int", min: 2, max: 20 },
  LAG_ALERT_BLOCKS: { type: "int", min: 150, max: 1800 }, // 1 小時（Base 每 2 秒一塊）
  // 狀態型告警持續時的提醒間隔：上限 1 天（原本 7 天、執行期無上限 → 開著的告警永不提醒）。
  REMIND_SEC: { type: "int", min: 300, max: 86_400 },
  MIN_SEVERITY: { type: "severity", allowed: MIN_SEVERITY_ALLOWED, fallback: "SEV-2" },
  MUTE_KEYS: { type: "keys" },
  // 金額門檻：上限 1,000,000（測試網的池子只有幾百到幾十萬；更大等於關掉絕對門檻）。
  LARGE_WITHDRAWAL_USDC: { type: "decimal", min: 0, max: 1_000_000 },
  LARGE_WITHDRAWAL_WINDOW_USDC: { type: "decimal", min: 0, max: 1_000_000 },
  // 單筆佔餘額 50% 以上才響＝等於沒有相對門檻。
  LARGE_WITHDRAWAL_BPS: { type: "int", min: 1, max: 5000 },
  // 累計視窗：太短等於關掉累計門檻（拆單隔 30 分鐘就不會被加總）。
  WITHDRAWAL_WINDOW_SEC: { type: "int", min: 1800, max: 86_400 },
  INSURANCE_WITHDRAW_USDC: { type: "decimal", min: 0, max: 1_000_000 },
  BAILOUT_MIN_USDC: { type: "decimal", min: 0, max: 1_000_000 },
  LARGE_REDEEM_USDC: { type: "decimal", min: 0, max: 1_000_000 },
  FEE_WITHDRAW_ALERT_USDC: { type: "decimal", min: 0, max: 1_000_000 },
  // 交易所硬上限 maxPriceAge 現行 6 小時：預警超過它就沒有意義。
  ORACLE_STALE_WARN_SEC: { type: "int", min: 300, max: 21_600 },
  // 股票／ETF／商品：4 天（涵蓋連假週末）。
  NONCRYPTO_STALE_SEC: { type: "int", min: 3600, max: 345_600 },
  ORACLE_DEVIATION_BPS: { type: "int", min: 1, max: 1000 },
  // 偏離規則唯一的 SEV-1 路徑：30% 以上才升級＝等於關掉。
  ORACLE_DEVIATION_CRIT_BPS: { type: "int", min: 1, max: 3000 },
  // 參考價的最大年齡：太短等於永遠「沒有可用的參考價」。
  REFERENCE_MAX_AGE_SEC: { type: "int", min: 600, max: 86_400 },
  INSURANCE_MIN_USDC: { type: "decimal", min: 1, max: 1_000_000 },
  INSURANCE_DROP_BPS: { type: "int", min: 1, max: 5000 },
  EXCHANGE_BALANCE_DROP_BPS: { type: "int", min: 1, max: 5000 },
  INCENTIVES_BALANCE_DROP_BPS: { type: "int", min: 1, max: 5000 },
  // 0 表示「跌破下限才講」，那已經是 vault-reserve-breached 的事；至少提早 1%。
  RESERVE_WARN_MARGIN_BPS: { type: "int", min: 100, max: 5000 },
  // gas 門檻：0 等於關掉 gas 告警。
  GAS_MIN_ETH: { type: "decimal", min: 0.001, max: 10 },
  GAS_CRIT_ETH: { type: "decimal", min: 0.001, max: 10 },
  SIGNAL_API_URL: { type: "url" },
  HTTP_FAILS_BEFORE_ALERT: { type: "int", min: 1, max: 6 },
  SELF_ERRORS_BEFORE_ALERT: { type: "int", min: 1, max: 6 },
};

/** 成對的參數：左邊必須 ≤ 右邊（預警門檻不可比嚴重門檻更嚴）。執行期違反時把左邊夾成右邊。 */
export const PARAM_ORDER = [
  ["ORACLE_DEVIATION_BPS", "ORACLE_DEVIATION_CRIT_BPS"],
  ["GAS_CRIT_ETH", "GAS_MIN_ETH"],
];

/**
 * 不是 monitors.json 參數、但可以用 [vars] 或 dashboard 設的公開設定。執行期格式不對時忽略（或略過
 * 不合法的項目）並回報，不讓一個打錯的位址讓整條規則讀取失敗。
 */
export const ENV_SETTINGS = {
  EXPECTED_PAY_TO: {
    doc: "signal-api 的 PAY_TO（公開地址）",
    parse(v) {
      if (!v) return { value: "" };
      return ADDR.test(v) ? { value: v } : { value: "", problem: "不是合法位址，已忽略（以首次觀察值為基準）" };
    },
  },
  EXTRA_GAS_WALLETS: {
    doc: "其他需要 gas 的錢包（逗號分隔）",
    parse(v) {
      const all = v.split(",").map((s) => s.trim()).filter(Boolean);
      const ok = all.filter((a) => ADDR.test(a));
      const bad = all.length - ok.length;
      return { value: ok, ...(bad ? { problem: `有 ${bad} 個不合法位址，已略過（其餘照常檢查）` } : {}) };
    },
  },
};
/**
 * 秘密與 binding：只能用 `wrangler secret put`（或 KV binding）設定。執行期只透過 envSecret() 讀，
 * 錯誤訊息永不帶值。
 */
export const SECRET_ENV = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
  "DISCORD_WEBHOOK_URL",
  "ALERT_WEBHOOK_URL",
  "ALERT_WEBHOOK_SECRET",
  "HEARTBEAT_URL",
  "RPC_URL",
];

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const NUM = /^-?\d+(\.\d+)?$/;
const HTTPS = /^https:\/\/[^\s/]+(\/[^\s]*)?$/;
const show = (v) => String(v).replace(/\s+/g, " ").slice(0, 40);

/** CI 用：一個參數值是否合法（嚴格，不夾值）。回傳錯誤文字或 null。keys 型別由呼叫端另外檢查。 */
export function checkParamValue(name, value) {
  const spec = PARAM_SPECS[name];
  if (!spec) return "沒有型別定義（PARAM_SPECS）";
  const v = String(value ?? "").trim();
  if (spec.type === "int") {
    if (!/^\d+$/.test(v)) return `必須是非負整數，現在是 ${JSON.stringify(v)}`;
    const n = Number(v);
    if (n < spec.min || n > spec.max) return `必須在 ${spec.min}–${spec.max} 之間，現在是 ${n}`;
  } else if (spec.type === "decimal") {
    if (!/^\d+(\.\d+)?$/.test(v)) return `必須是非負的十進位數字，現在是 ${JSON.stringify(v)}`;
    if (Number(v) < spec.min || Number(v) > spec.max) return `必須在 ${spec.min}–${spec.max} 之間，現在是 ${v}`;
  } else if (spec.type === "severity") {
    if (!spec.allowed.includes(v)) return `必須是 ${spec.allowed.join("/")}，現在是 ${JSON.stringify(v)}`;
  } else if (spec.type === "url") {
    if (!HTTPS.test(v)) return `必須是 https URL，現在是 ${JSON.stringify(v)}`;
  }
  return null;
}

/**
 * 執行期：把一個值夾進範圍。回傳 { value, problem?, invalid? }。invalid 表示格式根本不對（呼叫端改用預設值）；
 * 其他情況（超出範圍、不是整數、負數）夾到最近的合法值。
 */
export function clampParam(name, raw) {
  const spec = PARAM_SPECS[name];
  if (!spec) throw new Error(`未定義的參數 ${name}（不在 PARAM_SPECS）`);
  const v = String(raw ?? "").trim();
  if (spec.type === "int" || spec.type === "decimal") {
    if (!NUM.test(v)) return { value: undefined, invalid: true, problem: "格式不對" };
    let n = Number(v);
    const why = [];
    if (spec.type === "int" && !Number.isInteger(n)) {
      n = Math.floor(n);
      why.push("不是整數");
    }
    if (n < spec.min) {
      n = spec.min;
      why.push(`低於下限 ${spec.min}`);
    } else if (n > spec.max) {
      n = spec.max;
      why.push(`超過上限 ${spec.max}`);
    }
    const value = spec.type === "int" ? n : why.length ? String(n) : v;
    return why.length ? { value, problem: why.join("、") } : { value };
  }
  if (spec.type === "severity") {
    return spec.allowed.includes(v) ? { value: v } : { value: spec.fallback, problem: `不允許（只能是 ${spec.allowed.join("/")}）` };
  }
  if (spec.type === "url") return HTTPS.test(v) ? { value: v } : { value: undefined, invalid: true, problem: "不是 https URL" };
  return { value: v }; // keys
}

/** 組合限制（CI 與執行期共用）。values：名稱 → 數值（已套用覆寫）。回傳 [{ message, fix: [name, value] }]。 */
export function paramCombos(values) {
  const out = [];
  for (const [lo, hi] of PARAM_ORDER) {
    const [a, b] = [Number(values[lo]), Number(values[hi])];
    if (Number.isFinite(a) && Number.isFinite(b) && a > b) {
      out.push({ message: `${lo}（${a}）不可大於 ${hi}（${b}）`, fix: [lo, values[hi]] });
    }
  }
  const h = Number(values.HTTP_FAILS_BEFORE_ALERT);
  const e = Number(values.SELF_ERRORS_BEFORE_ALERT);
  if (Number.isFinite(h) && Number.isFinite(e) && h + e - 1 > MAX_ALERT_DELAY_ROUNDS) {
    out.push({
      message: `HTTP_FAILS_BEFORE_ALERT（${h}）＋SELF_ERRORS_BEFORE_ALERT（${e}）−1 = ${h + e - 1} 輪，超過 ${MAX_ALERT_DELAY_ROUNDS} 輪（約 30 分鐘）`,
      fix: ["SELF_ERRORS_BEFORE_ALERT", Math.max(1, MAX_ALERT_DELAY_ROUNDS + 1 - h)],
    });
  }
  return out;
}
/** CI 用：組合限制的錯誤文字。 */
export const paramComboProblems = (values) => paramCombos(values).map((c) => c.message);

const isSet = (v) => v !== undefined && v !== null && String(v).trim() !== "";

/**
 * 執行期：所有參數的有效值。env 覆寫優先，否則 monitors.json 的預設值；照 PARAM_SPECS 夾值，
 * 再套組合限制。回傳 { values, problems }（problems 是給 monitor-self:config 的文字，不含秘密）。
 * 參數不在 monitors.json 是建置錯誤（CI 會擋），這裡直接丟錯。
 */
export function resolveParams(config, env = {}) {
  const values = {};
  const problems = [];
  for (const name of Object.keys(PARAM_SPECS)) {
    const def = config.params?.[name];
    if (!def) throw new Error(`未定義的參數 ${name}（monitors.json 沒有）`);
    const override = env?.[name];
    const fromEnv = isSet(override);
    const raw = fromEnv ? String(override).trim() : String(def.default);
    let r = clampParam(name, raw);
    if (r.invalid) {
      const d = clampParam(name, String(def.default));
      if (d.invalid) throw new Error(`參數 ${name} 的預設值格式不對`);
      r = { value: d.value, problem: `${r.problem}，改用預設值` };
    }
    values[name] = r.value;
    if (r.problem) {
      const shown = PARAM_SPECS[name].type === "url" ? "（值不顯示）" : show(raw);
      problems.push(`${name}=${shown} ${r.problem}，以 ${values[name]} 執行${fromEnv ? "" : "（monitors.json 預設值）"}`);
    }
  }
  for (const c of paramCombos(values)) {
    values[c.fix[0]] = c.fix[1];
    problems.push(`${c.message}；${c.fix[0]} 以 ${c.fix[1]} 執行`);
  }
  return { values, problems };
}

/** 公開設定（ENV_SETTINGS）的有效值與問題。 */
export function envSetting(env, name) {
  const spec = ENV_SETTINGS[name];
  if (!spec) throw new Error(`未定義的設定 ${name}（不在 ENV_SETTINGS）`);
  return spec.parse(String(env?.[name] ?? "").trim());
}
/** 秘密（SECRET_ENV）：去掉前後空白的字串；沒設是 ""。 */
export function envSecret(env, name) {
  if (!SECRET_ENV.includes(name)) throw new Error(`未定義的秘密 ${name}（不在 SECRET_ENV）`);
  return String(env?.[name] ?? "").trim();
}
/** 所有公開設定的問題（給 monitor-self:config）。 */
export function envSettingProblems(env) {
  const out = [];
  for (const name of Object.keys(ENV_SETTINGS)) {
    const r = envSetting(env, name);
    if (r.problem) out.push(`${name} ${r.problem}`);
  }
  return out;
}
