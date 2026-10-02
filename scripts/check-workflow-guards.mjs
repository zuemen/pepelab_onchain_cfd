#!/usr/bin/env node
// workflow 守門靜態檢查（.github/workflows/*.yml）。**只讀、不送任何請求、不讀任何秘密**。
//
// 為什麼存在：持有鏈上私鑰的 job 靠三件事保護——私鑰只放在 environment secret、只有特定
// job 綁那個 environment、admin 呼叫要先通過守門並經過人工核准（ops/keeper-trigger/README.md）。
// 這三件事都只是 workflow 檔裡的幾行 YAML，改掉其中一行不會讓任何測試變紅：
//   - 新 job 多寫一行 `environment: keeper` 就拿得到 KEEPER_PRIVATE_KEY；
//   - admin-call 少了 `needs: approve` 就不必核准；
//   - 加一個 `pull_request_target` 觸發，fork 的 PR 就能在有 secrets 的情境下執行。
// 這支腳本把這些規則寫成檢查，改動時 CI 會紅，要動規則就得同時改這裡（刻意的摩擦）。
//
// 兩層：
//   第一層（整檔釘選）：持有私鑰的 workflow——任何 job 引用 KEEPER_PRIVATE_KEY／
//       FEE_SETTLEMENT_PRIVATE_KEY（或動態／整包存取 secrets），或綁 keeper／settlement／
//       admin-approval——整份檔案（去 BOM、CRLF→LF，**不去註解或空白**）的 sha256 必須等於
//       PINNED_WORKFLOWS 的釘選值。持鑰 workflow 不在釘選表裡、釘選表裡的檔案不存在，也都失敗。
//       審查兩輪都是「補一種寫法又冒出另一種」（continue-on-error → if: always()、
//       inputs → env.X／toJSON(github)、守門 → 後面 step 的 uses／$GITHUB_PATH），所以改成
//       這幾支檔「任何修改都要人工審過、同步更新雜湊」，不再靠逐條列舉危險寫法。
//   第二層（結構規則，下面 (a)–(g)）：釘選值被更新時仍然要過的底線，也讓錯誤訊息指得出
//       是哪一種危險改動。
//
// 結構規則：
//   (a) 綁 environment 的 job 必須在下方 ENVIRONMENTS 的允許清單內（字串與物件寫法都算，
//       名稱不分大小寫；`${{ }}` 動態名稱一律拒絕；未登記的 environment 一律拒絕）。
//   (b) admin-base-sepolia.yml（precheck → approve → admin-call）採白名單：
//       - workflow 只能有 name／on／permissions／jobs，觸發事件只能是 workflow_dispatch，
//         job 只能是這三個；每個 job 只能有 ADMIN_JOB_KEYS 列出的鍵（所以 `if`、
//         `continue-on-error`、`defaults`、`services`、`container`、`strategy`… 都不行），
//         runs-on 必須是 GitHub 代管的 ubuntu。
//       - 三個 job 的第一個 step 是守門 step：只能有 name／env／run（不可有 `shell`、`if`…），
//         而且 `env`＋`run` 全文的 sha256 必須等於 GUARD_SHA256（admin-call 連同 job 層級的
//         env 一起算）。**改守門就必須同時改這個檔案。** 先前只用 regex 找
//         `if [ "$REF" != … ]`，`shell: cat {0}`、開頭 `exit 0`、重新指派變數、包在
//         `if false` 裡、刪掉觸發者比對都能通過（PR #217 審查 M2）。
//       - precheck 不可綁 environment、不可引用任何 secret、permissions 必須是 {}、只能有
//         守門這一個 step；approve 必須 `needs: precheck`、以字串寫法綁 admin-approval、不引用
//         任何 secret、只能有 gate 這一個 step；admin-call 必須 `needs: approve`，任何 step 都
//         不可設 `continue-on-error`。
//   (c) 觸發事件：任何 workflow 都不可用 `pull_request_target`／`workflow_run`；綁 keeper／
//       settlement 的 workflow（admin 除外）只能用 `schedule`、`workflow_dispatch`，而且
//       `workflow_dispatch` 不可有 inputs（否則允許清單內的 keeper job 可以被改成不經核准、
//       可帶參數的 admin）。
//   (d) 引用 secrets.KEEPER_PRIVATE_KEY／FEE_SETTLEMENT_PRIVATE_KEY 的 job 必須綁對應的
//       environment；不可用動態或整包的 secrets 存取（`secrets[...]`、`toJSON(secrets)`、
//       `secrets: inherit`），那會讓這項檢查看不出 job 拿了哪些 secret。
//   (e) 任何 job 都不可用 job 層級的 `uses:`（reusable workflow）：被呼叫的 workflow 可以自己
//       綁 environment，而且可能在別的 repo，這支檢查看不到它。
//   (f) 任何 `run:` 都不可內插 `${{ inputs.… }}`／`${{ github.event.… }}`（shell injection；
//       一律經 env 傳遞）。
//   (g) 持有私鑰的 workflow：`run:` 內不可有任何 `${{ }}`（值一律經 step 的 env 傳入；
//       `${{ env.X }}`、`toJSON(github)` 也是內插）；step 的 `uses:` 只能是 ALLOWED_KEYED_ACTIONS
//       之一並釘 40 位 commit SHA（不可 docker://、本地 action、tag）；admin workflow 守門以外的
//       step 不可有 `if`（`if: always()`／`failure()` 會在守門失敗後照樣執行）。
//
// YAML 解析用 npm 的 `yaml`（scripts/package.json 固定 2.9.1，package-lock.json 帶 sha512
// integrity；CI 用 `npm ci --ignore-scripts` 安裝）。不自己寫解析器：自製的 YAML 子集解析
// 一旦和 GitHub 的解析結果不同（引號鍵、flow mapping、多行純量…），檢查就會被繞過。
// 為了縮小剩下的差異：anchor／alias、merge key（`<<`）、重複的鍵、多文件一律視為錯誤。
//
// 用法：
//   node scripts/check-workflow-guards.mjs                       # 檢查 .github/workflows
//   node scripts/check-workflow-guards.mjs --workflows <dir>     # 檢查指定目錄
//   node scripts/check-workflow-guards.mjs --print-guard-hashes  # 印出現行守門 step 的 sha256
//   node scripts/check-workflow-guards.mjs --print-pins          # 印出持鑰 workflow 整檔的 sha256
//
// 結束碼：0 通過；1 有問題；2 檢查本身中止（目錄讀不到、缺少 yaml 套件等）。
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * environment → 允許綁它的 job（`檔名#job id`）。新增一個綁 environment 的 job 時要改這裡。
 * 名稱一律小寫：GitHub 的 environment 名稱不分大小寫（docs.github.com「Managing
 * environments for deployment」：Environment names are not case sensitive）。
 */
export const ENVIRONMENTS = {
  keeper: ["base-sepolia-keeper.yml#keep", "price-keeper.yml#update-prices", "admin-base-sepolia.yml#admin-call"],
  settlement: ["x402-settlement-worker.yml#settle"],
  "admin-approval": ["admin-base-sepolia.yml#approve"],
};

/** 鏈上私鑰 secret → 引用它的 job 必須綁的 environment。 */
export const PROTECTED_SECRETS = {
  KEEPER_PRIVATE_KEY: "keeper",
  FEE_SETTLEMENT_PRIVATE_KEY: "settlement",
};

/** 這兩種觸發會讓不受信任的來源（fork 的 PR、別的 workflow 的結果）在有 secrets 的情境下執行。 */
export const FORBIDDEN_TRIGGERS = ["pull_request_target", "workflow_run"];

/** 放鏈上私鑰的 environment。綁它們的 workflow（admin 除外）只能用下面這兩種觸發、不可有 inputs。 */
export const KEY_ENVIRONMENTS = ["keeper", "settlement"];
export const KEYED_WORKFLOW_TRIGGERS = ["schedule", "workflow_dispatch"];

export const ADMIN = {
  file: "admin-base-sepolia.yml",
  precheckJob: "precheck",
  approveJob: "approve",
  callJob: "admin-call",
  approvalEnvironment: "admin-approval",
  triggers: ["workflow_dispatch"],
};

/**
 * 三個守門 step 的內容指紋（guardDigest）。改了 admin workflow 的守門 step 之後：
 *   node scripts/check-workflow-guards.mjs --print-guard-hashes
 * 把印出來的值貼到這裡。這個 diff 會和 workflow 的 diff 出現在同一個 PR，審查時兩邊一起看。
 */
export const GUARD_SHA256 = {
  precheck: "0b0190f792762b22090845c61f8af891b583a879da08334313df0724a302e051",
  approve: "3bb2042cae8844217ea932bc43433279a532943595d11b9860aaa4a8cb536d50",
  "admin-call": "f9f5ce3f620addf51083a122bd3cd80af7b83c59dc761d5965524fb79ac10c64",
};

/**
 * 第一層：持有私鑰的 workflow 整份檔案的 sha256（正規化：去 BOM、CRLF→LF；註解與空白都算）。
 * **任何修改都要人工審過整份 diff 之後**，執行
 *   node scripts/check-workflow-guards.mjs --print-pins
 * 把印出來的值貼到這裡。Dependabot 升級這幾支檔裡的 action SHA 時也會紅，同樣要人工審過再
 * 更新——這是刻意的。新增一支持鑰 workflow 時也要加進來，否則檢查失敗。
 */
export const PINNED_WORKFLOWS = {
  "admin-base-sepolia.yml": "e8b89234c0bc83d584792aacf587b548634e60b44a5d38efae9fd1b8d11ba9cf",
  "base-sepolia-keeper.yml": "cfc3d0f47dd0da306d2c8fad64b012832b0aa10c72de74b5cfb29bd078bb8bde",
  "price-keeper.yml": "e4ff9a1801593fb6e26d09aabc67b85cc22fc1a8363a937fe0e4486584988a38",
  "x402-settlement-worker.yml": "0bd5876fd343ed8a55c62d905e82a4431e9305658d146d9a9f2d283995b27968",
};

/** 持鑰 workflow 的 step 只能用這些 action，而且必須釘 40 位 commit SHA。 */
export const ALLOWED_KEYED_ACTIONS = ["actions/checkout", "actions/setup-node", "foundry-rs/foundry-toolchain"];

/** 綁了就算「持有私鑰」的 environment（admin-approval 本身沒有私鑰，但它是 admin 核准的關卡）。 */
const PINNING_ENVIRONMENTS = ["keeper", "settlement", "admin-approval"];

/** 整檔指紋：去 BOM、CRLF→LF，其餘一個字都不改。 */
export function fileDigest(text) {
  return createHash("sha256").update(text.replace(/^﻿/, "").replace(/\r\n/g, "\n")).digest("hex");
}

const ADMIN_WORKFLOW_KEYS = ["name", "on", "permissions", "jobs"];
const ADMIN_JOB_KEYS = {
  precheck: ["runs-on", "timeout-minutes", "permissions", "steps"],
  approve: ["needs", "runs-on", "timeout-minutes", "environment", "steps"],
  "admin-call": ["needs", "runs-on", "timeout-minutes", "permissions", "concurrency", "environment", "env", "steps"],
};
const GUARD_STEP_KEYS = ["name", "env", "run"];

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const truthyFlag = (v) => v !== undefined && v !== null && v !== false && v !== "false";
const needsOf = (job) => (typeof job.needs === "string" ? [job.needs] : Array.isArray(job.needs) ? job.needs : []);

/** 把 workflow 文字解析成純 JS 物件。回傳 `{ data, errors }`；有 errors 時 data 為 null。 */
export function parseWorkflow(YAML, text) {
  const doc = YAML.parseDocument(text, { version: "1.2", uniqueKeys: true, merge: false, prettyErrors: true });
  const errors = doc.errors.map((e) => `YAML 解析失敗：${String(e.message).split("\n")[0]}`);
  if (errors.length) return { data: null, errors };
  let anchors = 0;
  let aliases = 0;
  let merges = 0;
  YAML.visit(doc, {
    Alias() {
      aliases += 1;
    },
    Pair(_key, pair) {
      if (YAML.isScalar(pair.key) && pair.key.value === "<<") merges += 1;
    },
    Node(_key, node) {
      if (node.anchor) anchors += 1;
    },
  });
  if (anchors || aliases) {
    return { data: null, errors: [`使用了 YAML anchor／alias（${anchors} 個 anchor、${aliases} 個 alias）；本檢查不支援，請展開寫`] };
  }
  if (merges) {
    return { data: null, errors: [`使用了 YAML merge key（\`<<\`，${merges} 處）；不同解析器的處理不同，請展開寫`] };
  }
  const data = doc.toJS();
  if (!isObject(data)) return { data: null, errors: ["workflow 的最上層不是 mapping"] };
  return { data, errors: [] };
}

/** `on:` 的觸發事件名稱（字串、陣列、mapping 三種寫法）。讀不出來回 null。 */
export function triggersOf(wf) {
  // YAML 1.1 的解析器會把沒加引號的 `on` 讀成布林 true；這裡用 1.2，仍然兩種都接。
  const on = wf.on ?? wf.true;
  if (typeof on === "string") return [on];
  if (Array.isArray(on) && on.every((x) => typeof x === "string")) return on;
  if (isObject(on)) return Object.keys(on);
  return null;
}

/** `on.workflow_dispatch.inputs` 是否存在（只有 mapping 寫法能帶 inputs）。 */
function hasDispatchInputs(wf) {
  const on = wf.on ?? wf.true;
  return isObject(on) && isObject(on.workflow_dispatch) && "inputs" in on.workflow_dispatch;
}

/**
 * job 綁的 environment。
 * @returns {{ kind: "none" } | { kind: "static", name: string } | { kind: "invalid", why: string }}
 */
export function environmentOf(job) {
  if (!isObject(job) || !("environment" in job)) return { kind: "none" };
  const env = job.environment;
  const raw = isObject(env) ? env.name : env;
  if (typeof raw !== "string" || raw.trim() === "") {
    return { kind: "invalid", why: "environment 的名稱不是字串（或是空的）" };
  }
  if (raw.includes("${{")) return { kind: "invalid", why: `environment 名稱是動態的（${raw.trim()}），無法靜態判斷` };
  return { kind: "static", name: raw.trim().toLowerCase() };
}

/**
 * 一個字串裡所有 `${{ … }}` 的內容。找結尾 `}}` 時跳過單引號字串——和 actions/runner 的
 * TemplateReader 一樣（單引號切換 inString，`''` 跳脫因此自然成立）。不這樣做的話
 * `${{ format('}}{0}', secrets.X) }}` 會在字串常值裡的 `}}` 被截斷，後面的 secrets.X 就
 * 漏掉了（PR #217 審查 L1）。沒有結尾的 `${{`：把剩下的全部當成運算式（寧可多抓）。
 */
export function expressionsInString(s) {
  const out = [];
  let i = 0;
  for (;;) {
    const start = s.indexOf("${{", i);
    if (start === -1) break;
    let end = -1;
    let inString = false;
    for (let j = start + 3; j < s.length; j += 1) {
      if (s[j] === "'") inString = !inString;
      else if (!inString && s[j] === "}" && s[j - 1] === "}") {
        end = j;
        break;
      }
    }
    if (end === -1) {
      out.push(s.slice(start + 3));
      break;
    }
    out.push(s.slice(start + 3, end - 1));
    i = end + 1;
  }
  return out;
}

/** 走訪所有字串，收集 `${{ … }}` 內的運算式，以及 `if:` 的整個值（`if` 可以不寫 `${{ }}`）。 */
export function expressionsIn(node, out = [], key = null) {
  if (typeof node === "string") {
    if (key === "if") out.push(node);
    out.push(...expressionsInString(node));
  } else if (Array.isArray(node)) {
    for (const v of node) expressionsIn(v, out, key);
  } else if (isObject(node)) {
    for (const [k, v] of Object.entries(node)) expressionsIn(v, out, k);
  }
  return out;
}

/**
 * 運算式裡引用了哪些 secret。運算式的識別字不分大小寫，所以名稱一律轉大寫。
 * `dynamic` 為 true 表示出現了讀不出名稱的存取（`secrets[env.X]`、`toJSON(secrets)`、`secrets.*`…）。
 */
export function secretRefsIn(expressions) {
  const names = new Set();
  let dynamic = false;
  // 前面不是識別字字元也不是 `.`：`inputs.secrets`、`my_secrets` 不算 secrets context。
  const token = /(?<![A-Za-z0-9_.-])secrets(?![A-Za-z0-9_-])/gi;
  for (const expr of expressions) {
    for (const m of expr.matchAll(token)) {
      const rest = expr.slice(m.index + m[0].length);
      const dot = /^\s*\.\s*([A-Za-z_][A-Za-z0-9_-]*)/.exec(rest);
      const idx = /^\s*\[\s*(?:'([^']*)'|"([^"]*)")\s*\]/.exec(rest);
      if (dot) names.add(dot[1].toUpperCase());
      else if (idx) names.add((idx[1] ?? idx[2]).toUpperCase());
      else dynamic = true;
    }
  }
  return { names, dynamic };
}

function refsOfJob(job, topLevel) {
  const refs = secretRefsIn(expressionsIn(job));
  for (const n of topLevel.names) refs.names.add(n);
  refs.dynamic ||= topLevel.dynamic;
  // 呼叫 reusable workflow 時的 `secrets: inherit`：把呼叫端拿得到的 secret 全部交出去。
  if (isObject(job) && typeof job.secrets === "string" && job.secrets.trim().toLowerCase() === "inherit") refs.dynamic = true;
  return refs;
}

/** `run:` 裡不可內插的 context：值由觸發者（或留言、PR 標題的作者）控制。 */
const UNTRUSTED_IN_RUN = /(?<![A-Za-z0-9_.-])(inputs|github\s*\.\s*event|github\s*\[\s*['"]event['"]\s*\])(?![A-Za-z0-9_-])/i;

/**
 * 守門 step 的內容指紋：`env`（照檔案裡的順序）＋`run` 全文的 sha256；admin-call 連同 job
 * 層級的 `env` 一起算。YAML 註解不在解析結果裡，所以不影響指紋；script 內的任何一個字都算。
 */
export function guardDigest(job, withJobEnv = false) {
  const step = isObject(job) && Array.isArray(job.steps) ? job.steps[0] : null;
  if (!isObject(step) || typeof step.run !== "string") return null;
  const material = {
    env: isObject(step.env) ? Object.entries(step.env).map(([k, v]) => [k, String(v)]) : [],
    run: step.run.replace(/\r\n/g, "\n"),
  };
  if (withJobEnv) material.jobEnv = isObject(job.env) ? Object.entries(job.env).map(([k, v]) => [k, String(v)]) : [];
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

function extraKeys(obj, allowed) {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
}

/** admin workflow 的單一 job：鍵白名單、runner、守門 step。 */
function checkAdminJob(jobId, job, problem) {
  const extra = extraKeys(job, ADMIN_JOB_KEYS[jobId]);
  if (extra.length) {
    problem(jobId, `不可有這些鍵：${extra.map((k) => `\`${k}\``).join("、")}（admin workflow 的 job 只允許 ${ADMIN_JOB_KEYS[jobId].join("／")}）`);
  }
  if (typeof job["runs-on"] !== "string" || !/^ubuntu-[a-z0-9.]+$/.test(job["runs-on"])) {
    problem(jobId, "`runs-on` 必須是 GitHub 代管的 ubuntu runner（字串，例如 ubuntu-latest）");
  }
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const [i, step] of steps.entries()) {
    if (isObject(step) && truthyFlag(step["continue-on-error"])) {
      problem(jobId, `steps[${i}] 不可設 \`continue-on-error\`（失敗會被當成通過）`);
    }
    // 守門 step 的鍵另有白名單；其餘 step 一律不可有 if：`if: always()`／`failure()` 會在守門
    // 失敗之後照樣執行（re-run failed jobs 會沿用已核准的 approve，守門是唯一擋重播的一道）。
    if (i > 0 && isObject(step) && "if" in step) {
      problem(jobId, `steps[${i}] 不可有 \`if\`（\`if: always()\`／\`failure()\` 會在守門失敗後照樣執行）`);
    }
  }
  const first = steps[0];
  if (!isObject(first) || typeof first.run !== "string" || "uses" in first) {
    problem(jobId, "守門不完整：第一個 step 必須是 `run:` 守門 step");
    return;
  }
  const stepExtra = extraKeys(first, GUARD_STEP_KEYS);
  if (stepExtra.length) {
    problem(jobId, `守門 step 不可有這些鍵：${stepExtra.map((k) => `\`${k}\``).join("、")}（只允許 ${GUARD_STEP_KEYS.join("／")}；\`shell\` 可以讓 script 不被執行）`);
  }
  const digest = guardDigest(job, jobId === ADMIN.callJob);
  if (digest !== GUARD_SHA256[jobId]) {
    problem(
      jobId,
      `守門 step 的內容與檢查器釘住的不符（sha256 ${digest}，應為 ${GUARD_SHA256[jobId]}）。` +
        "若是刻意修改守門，請同步更新 scripts/check-workflow-guards.mjs 的 GUARD_SHA256（--print-guard-hashes 會印出現值）",
    );
  }
}

function checkAdmin(wf, topLevel, problem) {
  const wfExtra = extraKeys(wf, ADMIN_WORKFLOW_KEYS);
  if (wfExtra.length) {
    problem(null, `workflow 層級不可有這些鍵：${wfExtra.map((k) => `\`${k}\``).join("、")}（只允許 ${ADMIN_WORKFLOW_KEYS.join("／")}；\`concurrency\` 會讓等核准的 run 卡住 keeper，\`defaults\` 可以換掉 shell）`);
  }
  const triggers = triggersOf(wf) ?? [];
  if (triggers.length !== 1 || triggers[0] !== ADMIN.triggers[0]) {
    problem(null, `觸發事件只能是 \`workflow_dispatch\`（現在是 ${triggers.join("、") || "讀不出來"}）`);
  }
  if (topLevel.names.size || topLevel.dynamic) {
    problem(null, "workflow 層級（jobs 以外）不可引用 secret：precheck 與 approve 也會拿到");
  }

  const jobs = isObject(wf.jobs) ? wf.jobs : {};
  const known = [ADMIN.precheckJob, ADMIN.approveJob, ADMIN.callJob];
  for (const id of Object.keys(jobs)) {
    if (!known.includes(id)) problem(id, `admin workflow 只能有 ${known.join("、")} 三個 job`);
  }
  const precheck = jobs[ADMIN.precheckJob];
  const approve = jobs[ADMIN.approveJob];
  const call = jobs[ADMIN.callJob];
  const secretsUsed = (job) => {
    const refs = refsOfJob(job, topLevel);
    return [...refs.names].map((n) => `secrets.${n}`).concat(refs.dynamic ? ["動態／整包的 secrets 存取"] : []);
  };

  // precheck：人工核准「之前」的檢查，必須是一個什麼都拿不到的 job。
  if (!isObject(precheck)) {
    problem(ADMIN.precheckJob, `找不到 job「${ADMIN.precheckJob}」（核准之前的檢查；改名或移除時要同步改 scripts/check-workflow-guards.mjs）`);
  } else {
    if (environmentOf(precheck).kind !== "none") {
      problem(ADMIN.precheckJob, "不可綁 environment（綁了有 reviewers 的 environment，檢查就會變成在核准之後才執行）");
    }
    const used = secretsUsed(precheck);
    if (used.length) problem(ADMIN.precheckJob, `不可使用任何 secret（${used.join("、")}）：這個 job 在人工核准之前執行`);
    if (!isObject(precheck.permissions) || Object.keys(precheck.permissions).length !== 0) {
      problem(ADMIN.precheckJob, "`permissions` 必須是 `{}`（這個 job 不需要 GITHUB_TOKEN 的任何權限）");
    }
    if (Array.isArray(precheck.steps) && precheck.steps.length !== 1) problem(ADMIN.precheckJob, "只能有守門這一個 step");
    checkAdminJob(ADMIN.precheckJob, precheck, problem);
  }

  if (!isObject(approve)) {
    problem(ADMIN.approveJob, `找不到 job「${ADMIN.approveJob}」（人工核准的 job；改名或移除時要同步改 scripts/check-workflow-guards.mjs）`);
  } else {
    // 只接受字串寫法：物件寫法可以帶 `deployment: false`，不必要地改變核准的行為。
    if (typeof approve.environment !== "string" || approve.environment.trim().toLowerCase() !== ADMIN.approvalEnvironment) {
      problem(ADMIN.approveJob, `必須以字串寫法綁 environment「${ADMIN.approvalEnvironment}」（人工核准靠它的 required reviewers）`);
    }
    const needs = needsOf(approve);
    if (needs.length !== 1 || needs[0] !== ADMIN.precheckJob) {
      problem(ADMIN.approveJob, `必須 \`needs: ${ADMIN.precheckJob}\`（否則被 precheck 擋下的 run 仍會進入等待核准的清單）`);
    }
    const used = secretsUsed(approve);
    if (used.length) problem(ADMIN.approveJob, `不可使用任何 secret（${used.join("、")}）：這個 job 只負責人工核准`);
    if (Array.isArray(approve.steps) && approve.steps.length !== 1) problem(ADMIN.approveJob, "只能有 gate 這一個 step");
    checkAdminJob(ADMIN.approveJob, approve, problem);
  }

  if (!isObject(call)) {
    problem(ADMIN.callJob, `找不到 job「${ADMIN.callJob}」（改名或移除時要同步改 scripts/check-workflow-guards.mjs）`);
  } else {
    if (!needsOf(call).includes(ADMIN.approveJob)) {
      problem(ADMIN.callJob, `必須 \`needs: ${ADMIN.approveJob}\`（否則不經人工核准就拿得到私鑰）`);
    }
    checkAdminJob(ADMIN.callJob, call, problem);
  }
}

/**
 * @param {{ name: string, text: string }[]} files  name 是檔名（不含目錄）
 * @param {object} YAML  `yaml` 套件（由呼叫端載入，方便在缺套件時給出清楚的訊息）
 * @returns {{ problems: string[], jobs: number, files: number }}
 */
export function checkWorkflows(files, YAML, { pins = PINNED_WORKFLOWS } = {}) {
  const problems = [];
  let jobCount = 0;
  let sawAdmin = false;

  for (const { name, text } of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const problem = (job, msg) => problems.push(job ? `${name}#${job}：${msg}` : `${name}：${msg}`);
    const { data: wf, errors } = parseWorkflow(YAML, text);
    if (!wf) {
      // 解析不了的檔案等於沒檢查，一律算問題（fail-closed）。
      for (const e of errors) problem(null, e);
      continue;
    }

    // (c) 觸發事件
    const triggers = triggersOf(wf);
    if (!triggers) problem(null, "讀不出 `on:` 的觸發事件");
    for (const t of triggers ?? []) {
      if (FORBIDDEN_TRIGGERS.includes(String(t).trim().toLowerCase())) {
        problem(null, `不可使用 \`${t}\` 觸發（不受信任的來源會在拿得到 secrets 的情境下執行）`);
      }
    }

    const { jobs: _jobs, ...rest } = wf;
    const topLevel = secretRefsIn(expressionsIn(rest));
    const jobs = isObject(wf.jobs) ? wf.jobs : null;
    if (!jobs) {
      problem(null, "沒有 `jobs:` mapping");
      continue;
    }

    const keyEnvsUsed = new Set();
    let holdsKeys = false;
    for (const [jobId, job] of Object.entries(jobs)) {
      jobCount += 1;
      const id = `${name}#${jobId}`;
      const env = environmentOf(job);
      if (env.kind === "static" && KEY_ENVIRONMENTS.includes(env.name)) keyEnvsUsed.add(env.name);
      if (env.kind === "invalid" || (env.kind === "static" && PINNING_ENVIRONMENTS.includes(env.name))) holdsKeys = true;

      // (a) environment 允許清單
      if (env.kind === "invalid") {
        problem(jobId, env.why);
      } else if (env.kind === "static") {
        const allowed = ENVIRONMENTS[env.name];
        if (!allowed) {
          problem(jobId, `綁了未登記的 environment「${env.name}」；要新增請改 scripts/check-workflow-guards.mjs 的 ENVIRONMENTS`);
        } else if (!allowed.includes(id)) {
          problem(jobId, `不在 environment「${env.name}」的允許清單內（允許：${allowed.join("、")}）`);
        }
      }

      // (d) 私鑰 secret 必須綁對應的 environment
      const refs = refsOfJob(job, topLevel);
      if (refs.dynamic || Object.keys(PROTECTED_SECRETS).some((s) => refs.names.has(s))) holdsKeys = true;
      if (refs.dynamic) {
        problem(jobId, "使用了動態或整包的 secrets 存取（`secrets[...]`、`toJSON(secrets)`、`secrets: inherit` 等）；請逐一寫成 secrets.<名稱>");
      }
      for (const [secret, wantEnv] of Object.entries(PROTECTED_SECRETS)) {
        if (!refs.names.has(secret)) continue;
        if (env.kind !== "static") {
          problem(jobId, `引用 secrets.${secret} 但沒有綁 environment（應綁「${wantEnv}」）`);
        } else if (env.name !== wantEnv) {
          problem(jobId, `引用 secrets.${secret} 但綁的是 environment「${env.name}」（應綁「${wantEnv}」）`);
        }
      }

      // (e) reusable workflow
      if (isObject(job) && "uses" in job) {
        problem(jobId, "不可用 job 層級的 `uses:` 呼叫 reusable workflow（被呼叫的 workflow 可以自己綁 environment，這支檢查看不到它）");
      }

      // (f) run 不可內插觸發者可控的值
      for (const [i, step] of (isObject(job) && Array.isArray(job.steps) ? job.steps : []).entries()) {
        if (!isObject(step) || typeof step.run !== "string") continue;
        const hit = expressionsInString(step.run).find((e) => UNTRUSTED_IN_RUN.test(e));
        if (hit !== undefined) {
          problem(jobId, `steps[${i}] 的 \`run\` 直接內插了 \${{ ${hit.trim()} }}（shell injection）；請改成經 env 傳遞`);
        }
      }
    }

    if (holdsKeys || name === ADMIN.file) {
      // (g) 持有私鑰的 workflow：run 不內插任何運算式、uses 只准釘 SHA 的允許清單
      for (const [jobId, job] of Object.entries(jobs)) {
        for (const [i, step] of (isObject(job) && Array.isArray(job.steps) ? job.steps : []).entries()) {
          if (!isObject(step)) continue;
          if (typeof step.run === "string" && expressionsInString(step.run).length) {
            problem(jobId, `steps[${i}] 的 \`run\` 內插了 \${{ }}（持有私鑰的 workflow 一律經 step 的 env 傳入，包括 env.X、toJSON(github)）`);
          }
          if ("uses" in step) {
            const m = typeof step.uses === "string" ? /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([0-9a-f]{40})$/.exec(step.uses.trim()) : null;
            if (!m || !ALLOWED_KEYED_ACTIONS.includes(m[1])) {
              problem(jobId, `steps[${i}] 的 \`uses: ${step.uses}\` 不允許（持有私鑰的 workflow 只能用 ${ALLOWED_KEYED_ACTIONS.join("、")}，並釘 40 位 commit SHA）`);
            }
          }
        }
      }
      // 第一層：整檔釘選
      if (pins) {
        const digest = fileDigest(text);
        if (!Object.hasOwn(pins, name)) {
          problem(null, `這是持有私鑰的 workflow（引用私鑰 secret 或綁 keeper／settlement／admin-approval），但不在 PINNED_WORKFLOWS 裡。人工審過整份檔案後，把它加進 scripts/check-workflow-guards.mjs 的 PINNED_WORKFLOWS（sha256 ${digest}）`);
        } else if (pins[name] !== digest) {
          problem(null, `這是持有私鑰的 workflow，任何修改都要人工審過整份 diff 後更新 scripts/check-workflow-guards.mjs 的 PINNED_WORKFLOWS 雜湊（現在的 sha256 ${digest}，釘選值 ${pins[name]}；--print-pins 會印出現值）`);
        }
      }
    }

    if (name === ADMIN.file) {
      // (b) admin workflow
      sawAdmin = true;
      checkAdmin(wf, topLevel, problem);
    } else if (keyEnvsUsed.size) {
      // (c) 持有私鑰的 workflow：觸發事件白名單、不可有 inputs
      const envs = [...keyEnvsUsed].join("、");
      for (const t of triggers ?? []) {
        if (!KEYED_WORKFLOW_TRIGGERS.includes(t)) {
          problem(null, `綁了 environment「${envs}」的 workflow 只能用 ${KEYED_WORKFLOW_TRIGGERS.join("、")} 觸發（多了 \`${t}\`）`);
        }
      }
      if (hasDispatchInputs(wf)) {
        problem(null, `綁了 environment「${envs}」的 workflow 不可有 \`workflow_dispatch.inputs\`（會變成不經核准、可帶參數的 admin）`);
      }
    }
  }

  if (pins) {
    for (const pinned of Object.keys(pins)) {
      if (!files.some((f) => f.name === pinned)) {
        problems.push(`${pinned}：在 PINNED_WORKFLOWS 裡但檔案不存在；若是刻意移除或改名，請同步改 scripts/check-workflow-guards.mjs`);
      }
    }
  }
  if (!sawAdmin) {
    problems.push(`${ADMIN.file}：找不到這支 workflow；若是刻意移除或改名，請同步改 scripts/check-workflow-guards.mjs`);
  }
  return { problems, jobs: jobCount, files: files.length };
}

export function readWorkflowDir(dir) {
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}

export async function loadYaml() {
  try {
    return await import("yaml");
  } catch {
    throw new Error("找不到 `yaml` 套件。請先執行：npm ci --ignore-scripts --prefix scripts");
  }
}

/** 這支檔是否持有私鑰（第一層的判斷）：以空的釘選表檢查，看它是否被要求釘選。 */
export function holdsKeysFile(f, YAML) {
  return checkWorkflows([f], YAML, { pins: {} }).problems.some((p) => p.includes("不在 PINNED_WORKFLOWS 裡"));
}

/** 現行 admin workflow 三個守門 step 的指紋（給 --print-guard-hashes 與測試用）。 */
export function currentGuardHashes(files, YAML) {
  const f = files.find((x) => x.name === ADMIN.file);
  const { data: wf } = f ? parseWorkflow(YAML, f.text) : { data: null };
  const jobs = wf && isObject(wf.jobs) ? wf.jobs : {};
  return Object.fromEntries(
    [ADMIN.precheckJob, ADMIN.approveJob, ADMIN.callJob].map((id) => [id, guardDigest(jobs[id], id === ADMIN.callJob)]),
  );
}

async function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const i = argv.indexOf("--workflows");
  const dir = i !== -1 && argv[i + 1] ? resolve(argv[i + 1]) : join(root, ".github/workflows");
  if (!existsSync(dir)) throw new Error(`找不到目錄：${dir}`);
  const YAML = await loadYaml();
  const files = readWorkflowDir(dir);
  if (files.length === 0) throw new Error(`${dir} 裡沒有任何 workflow 檔`);
  if (argv.includes("--print-pins")) {
    for (const f of files) {
      if (Object.hasOwn(PINNED_WORKFLOWS, f.name) || holdsKeysFile(f, YAML)) {
        console.log(`${JSON.stringify(f.name)}: ${JSON.stringify(fileDigest(f.text))},`);
      }
    }
    return 0;
  }
  if (argv.includes("--print-guard-hashes")) {
    for (const [id, hash] of Object.entries(currentGuardHashes(files, YAML))) console.log(`${JSON.stringify(id)}: ${JSON.stringify(hash)},`);
    return 0;
  }
  const { problems, jobs } = checkWorkflows(files, YAML);
  for (const p of problems) console.log(`✗ ${p}`);
  if (problems.length) {
    console.log(`\n${problems.length} 個 workflow 守門問題（${files.length} 個檔案、${jobs} 個 job）`);
    return 1;
  }
  console.log(`workflow 守門檢查通過 ✓（${files.length} 個檔案、${jobs} 個 job）`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`檢查中止：${e.message}`);
      process.exit(2);
    },
  );
}
