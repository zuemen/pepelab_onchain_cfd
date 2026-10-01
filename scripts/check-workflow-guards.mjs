#!/usr/bin/env node
// workflow 守門靜態檢查（.github/workflows/*.yml）。**只讀、不送任何請求、不讀任何秘密**。
//
// 為什麼存在：持有鏈上私鑰的 job 現在靠三件事保護——私鑰只放在 environment secret、
// 只有特定 job 綁那個 environment、admin 呼叫要先經過人工核准（ops/keeper-trigger/README.md）。
// 這三件事都只是 workflow 檔裡的幾行 YAML，改掉其中一行不會讓任何測試變紅：
//   - 新 job 多寫一行 `environment: keeper` 就拿得到 KEEPER_PRIVATE_KEY；
//   - admin-call 少了 `needs: approve` 就不必核准；
//   - 加一個 `pull_request_target` 觸發，fork 的 PR 就能在有 secrets 的情境下執行。
// 這支腳本把這些規則寫成檢查，改動時 CI 會紅，要動規則就得同時改這裡（刻意的摩擦）。
//
// 檢查項目：
//   (a) 綁 environment 的 job 必須在下方 ENVIRONMENTS 的允許清單內（字串與物件寫法都算，
//       名稱不分大小寫；`${{ }}` 動態名稱一律拒絕；未登記的 environment 一律拒絕）。
//   (b) admin-base-sepolia.yml：admin-call 必須 `needs: approve`、不可有 job 層級的 `if`／
//       `continue-on-error`，第一個 step 必須是 ref==refs/heads/master 與 run_attempt==1 的守門；
//       approve 必須綁 admin-approval、不引用任何 secret、不可被 `if`／`continue-on-error` 繞過。
//   (c) 任何 workflow 都不可用 `pull_request_target`／`workflow_run` 觸發。
//   (d) 引用 secrets.KEEPER_PRIVATE_KEY／FEE_SETTLEMENT_PRIVATE_KEY 的 job 必須綁對應的
//       environment；不可用動態或整包的 secrets 存取（`secrets[...]`、`toJSON(secrets)`、
//       `secrets: inherit`），那會讓這項檢查看不出 job 拿了哪些 secret。
//
// YAML 解析用 npm 的 `yaml`（scripts/package.json 固定 2.9.1，package-lock.json 帶 sha512
// integrity；CI 用 `npm ci --ignore-scripts` 安裝）。不自己寫解析器：自製的 YAML 子集解析
// 一旦和 GitHub 的解析結果不同（引號鍵、flow mapping、多行純量…），檢查就會被繞過。
// 為了縮小剩下的差異：anchor／alias、重複的鍵、多文件一律視為錯誤。
//
// 用法：
//   node scripts/check-workflow-guards.mjs                    # 檢查 .github/workflows
//   node scripts/check-workflow-guards.mjs --workflows <dir>  # 檢查指定目錄
//
// 結束碼：0 通過；1 有問題；2 檢查本身中止（目錄讀不到、缺少 yaml 套件等）。
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

export const ADMIN = {
  file: "admin-base-sepolia.yml",
  approveJob: "approve",
  callJob: "admin-call",
  approvalEnvironment: "admin-approval",
  ref: "refs/heads/master",
};

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** 把 workflow 文字解析成純 JS 物件。回傳 `{ data, errors }`；有 errors 時 data 為 null。 */
export function parseWorkflow(YAML, text) {
  const doc = YAML.parseDocument(text, { version: "1.2", uniqueKeys: true, merge: false, prettyErrors: true });
  const errors = doc.errors.map((e) => `YAML 解析失敗：${String(e.message).split("\n")[0]}`);
  if (errors.length) return { data: null, errors };
  let anchors = 0;
  let aliases = 0;
  YAML.visit(doc, {
    Alias() {
      aliases += 1;
    },
    Node(_key, node) {
      if (node.anchor) anchors += 1;
    },
  });
  if (anchors || aliases) {
    return { data: null, errors: [`使用了 YAML anchor／alias（${anchors} 個 anchor、${aliases} 個 alias）；本檢查不支援，請展開寫`] };
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

/** 走訪所有字串，收集 `${{ … }}` 內的運算式，以及 `if:` 的整個值（`if` 可以不寫 `${{ }}`）。 */
export function expressionsIn(node, out = [], key = null) {
  if (typeof node === "string") {
    if (key === "if") out.push(node);
    let i = 0;
    for (;;) {
      const start = node.indexOf("${{", i);
      if (start === -1) break;
      const end = node.indexOf("}}", start + 3);
      // 沒有結尾的 `${{`：把剩下的全部當成運算式（寧可多抓）。
      out.push(end === -1 ? node.slice(start + 3) : node.slice(start + 3, end));
      if (end === -1) break;
      i = end + 2;
    }
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

const truthyFlag = (v) => v !== undefined && v !== null && v !== false && v !== "false";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** env 裡值「恰好是」`${{ <expr> }}` 的變數名稱。 */
function envVarBoundTo(env, expr) {
  if (!isObject(env)) return [];
  const re = new RegExp(`^\\$\\{\\{\\s*${escapeRegExp(expr)}\\s*\\}\\}$`, "i");
  return Object.entries(env)
    .filter(([k, v]) => typeof v === "string" && re.test(v.trim()) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .map(([k]) => k);
}

/** script 裡是否有 `if [ "$VAR" != "<literal>" ]; then … exit 1 … fi`（exit 1 在第一個 fi 之前）。 */
function hasRejectUnless(script, varName, literal) {
  const cond = new RegExp(
    `if\\s+\\[\\s+"\\$\\{?${escapeRegExp(varName)}\\}?"\\s+!=\\s+"${escapeRegExp(literal)}"\\s+\\]\\s*;\\s*then\\b`,
    "g",
  );
  for (const m of script.matchAll(cond)) {
    const after = script.slice(m.index + m[0].length);
    const fi = /^\s*fi\b/m.exec(after);
    const body = fi ? after.slice(0, fi.index) : after;
    // 去掉註解行後要有一行單獨的 `exit 1`（或其他非零）。
    const lines = body.split("\n").map((l) => l.trim()).filter((l) => !l.startsWith("#"));
    if (lines.some((l) => /^exit\s+[1-9][0-9]*$/.test(l))) return true;
  }
  return false;
}

function checkAdmin(wf, topLevel, problem) {
  const jobs = isObject(wf.jobs) ? wf.jobs : {};
  const approve = jobs[ADMIN.approveJob];
  const call = jobs[ADMIN.callJob];

  if (!isObject(approve)) {
    problem(ADMIN.approveJob, `找不到 job「${ADMIN.approveJob}」（人工核准的 job；改名或移除時要同步改 scripts/check-workflow-guards.mjs）`);
  } else {
    const env = environmentOf(approve);
    if (env.kind !== "static" || env.name !== ADMIN.approvalEnvironment) {
      problem(ADMIN.approveJob, `必須綁 environment「${ADMIN.approvalEnvironment}」（人工核准靠它的 required reviewers）`);
    }
    const refs = refsOfJob(approve, topLevel);
    if (refs.names.size || refs.dynamic) {
      const what = [...refs.names].map((n) => `secrets.${n}`).concat(refs.dynamic ? ["動態／整包的 secrets 存取"] : []);
      problem(ADMIN.approveJob, `不可使用任何 secret（${what.join("、")}）：這個 job 只負責人工核准`);
    }
    if ("if" in approve) problem(ADMIN.approveJob, "不可有 job 層級的 `if`（被略過時不會要求核准）");
    if (truthyFlag(approve["continue-on-error"])) problem(ADMIN.approveJob, "不可設 `continue-on-error`（gate 失敗會被當成通過）");
    for (const [i, step] of (Array.isArray(approve.steps) ? approve.steps : []).entries()) {
      if (isObject(step) && truthyFlag(step["continue-on-error"])) {
        problem(ADMIN.approveJob, `steps[${i}] 不可設 \`continue-on-error\`（gate 失敗會被當成通過）`);
      }
    }
  }

  if (!isObject(call)) {
    problem(ADMIN.callJob, `找不到 job「${ADMIN.callJob}」（改名或移除時要同步改 scripts/check-workflow-guards.mjs）`);
    return;
  }
  const needs = typeof call.needs === "string" ? [call.needs] : Array.isArray(call.needs) ? call.needs : [];
  if (!needs.includes(ADMIN.approveJob)) {
    problem(ADMIN.callJob, `必須 \`needs: ${ADMIN.approveJob}\`（否則不經人工核准就拿得到私鑰）`);
  }
  if ("if" in call) {
    problem(ADMIN.callJob, "不可有 job 層級的 `if`（例如 `always()` 會讓它在 approve 失敗或被略過時照樣執行）");
  }
  if (truthyFlag(call["continue-on-error"])) problem(ADMIN.callJob, "不可設 `continue-on-error`");

  const first = Array.isArray(call.steps) ? call.steps[0] : null;
  const missing = [];
  if (!isObject(first) || typeof first.run !== "string" || "uses" in first) {
    missing.push("第一個 step 必須是 `run:` 守門 step");
  } else {
    if ("if" in first) missing.push("守門 step 不可有 `if`");
    if (truthyFlag(first["continue-on-error"])) missing.push("守門 step 不可設 `continue-on-error`");
    const refVars = envVarBoundTo(first.env, "github.ref");
    const attemptVars = envVarBoundTo(first.env, "github.run_attempt");
    if (!refVars.some((v) => hasRejectUnless(first.run, v, ADMIN.ref))) {
      missing.push(`缺少 ref 守門（env 綁 \${{ github.ref }}，script 在不等於 "${ADMIN.ref}" 時 exit 1）`);
    }
    if (!attemptVars.some((v) => hasRejectUnless(first.run, v, "1"))) {
      missing.push('缺少 run_attempt 守門（env 綁 ${{ github.run_attempt }}，script 在不等於 "1" 時 exit 1）');
    }
  }
  if (missing.length) problem(ADMIN.callJob, `守門不完整：${missing.join("；")}`);
}

/**
 * @param {{ name: string, text: string }[]} files  name 是檔名（不含目錄）
 * @param {object} YAML  `yaml` 套件（由呼叫端載入，方便在缺套件時給出清楚的訊息）
 * @returns {{ problems: string[], jobs: number, files: number }}
 */
export function checkWorkflows(files, YAML) {
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

    for (const [jobId, job] of Object.entries(jobs)) {
      jobCount += 1;
      const id = `${name}#${jobId}`;
      const env = environmentOf(job);

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
    }

    // (b) admin workflow
    if (name === ADMIN.file) {
      sawAdmin = true;
      if (topLevel.names.size || topLevel.dynamic) {
        problem(null, "workflow 層級（jobs 以外）不可引用 secret：approve job 也會拿到");
      }
      checkAdmin(wf, topLevel, problem);
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

async function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const i = argv.indexOf("--workflows");
  const dir = i !== -1 && argv[i + 1] ? resolve(argv[i + 1]) : join(root, ".github/workflows");
  if (!existsSync(dir)) throw new Error(`找不到目錄：${dir}`);
  const YAML = await loadYaml();
  const files = readWorkflowDir(dir);
  if (files.length === 0) throw new Error(`${dir} 裡沒有任何 workflow 檔`);
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
