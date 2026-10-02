// check-workflow-guards.mjs 的自我測試：repo 本身必須通過、反例必須失敗。
//   npm ci --ignore-scripts --prefix scripts      # 第一次：安裝固定版本的 yaml
//   node --test scripts/check-workflow-guards.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN,
  ENVIRONMENTS,
  GUARD_SHA256,
  checkWorkflows,
  currentGuardHashes,
  environmentOf,
  expressionsIn,
  expressionsInString,
  guardDigest,
  loadYaml,
  readWorkflowDir,
  secretRefsIn,
  triggersOf,
} from "./check-workflow-guards.mjs";
import { bypassCases, inJob } from "./fixtures/check-workflow-guards/bypass-cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const script = join(here, "check-workflow-guards.mjs");
const fixtures = join(here, "fixtures/check-workflow-guards");
const YAML = await loadYaml();
const REAL = readWorkflowDir(join(root, ".github/workflows"));
const REAL_ADMIN = REAL.find((f) => f.name === ADMIN.file);

const PRE = "precheck";
const APPROVE = "approve";
const CALL = "admin-call";
const HASH_MISMATCH = (job) => new RegExp(`admin-base-sepolia\\.yml#${job}：守門 step 的內容與檢查器釘住的不符`);

const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
const check = (files) => checkWorkflows(files, YAML).problems;
const withFile = (name, text) => check(REAL.map((f) => (f.name === name ? { name, text } : f)));
const withExtra = (name, text) => check([...REAL, { name, text }]);

/**
 * 以現行 repo 的 workflow 為底，改掉其中一支再檢查。`from` 找不到就讓測試失敗：
 * workflow 改版後這裡的替換目標要跟著更新，不能默默變成「什麼都沒改所以通過」。
 */
function mutate(file, from, to) {
  const f = REAL.find((x) => x.name === file);
  assert.ok(f, `找不到 ${file}`);
  assert.ok(typeof from === "string" ? f.text.includes(from) : from.test(f.text), `${file} 裡找不到替換目標：${from}`);
  return withFile(file, f.text.replace(from, to));
}
/** 只在某一個 job 的區段內替換（admin workflow 的三個守門 step 內容幾乎相同）。 */
const mutateJob = (file, jobId, from, to) => withFile(file, inJob(REAL.find((x) => x.name === file).text, jobId, from, to));
const some = (problems, re) =>
  assert.ok(problems.some((p) => re.test(p)), `預期有 ${re}，實際：\n${problems.join("\n") || "（沒有任何問題）"}`);

test("現行 repo 的 workflow 全部通過", () => {
  const r = cli();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /workflow 守門檢查通過 ✓（\d+ 個檔案、\d+ 個 job）/);
  assert.deepEqual(check(REAL), []);
});

test("允許清單裡的每個 job 都真的存在於現行 repo（清單沒有過期的項目）", () => {
  for (const [envName, ids] of Object.entries(ENVIRONMENTS)) {
    for (const id of ids) {
      const [file, jobId] = id.split("#");
      const f = REAL.find((x) => x.name === file);
      assert.ok(f, `${id}：找不到 ${file}`);
      const job = YAML.parse(f.text).jobs?.[jobId];
      assert.ok(job, `${id}：找不到 job`);
      assert.deepEqual(environmentOf(job), { kind: "static", name: envName }, id);
    }
  }
});

test("合規的 fixture（各種不該誤報的寫法）加上現行的 admin workflow → 通過", () => {
  const good = readWorkflowDir(join(fixtures, "good"));
  assert.ok(good.length >= 4);
  assert.deepEqual(check([...good, REAL_ADMIN]), []);
});

test("反例 fixture 必須以非零結束，並逐項列出", () => {
  const r = cli("--workflows", join(fixtures, "bad"));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = r.stdout;
  // (a) environment 允許清單
  assert.match(out, /rogue-environment\.yml#borrow-key：不在 environment「keeper」的允許清單內/);
  assert.match(out, /rogue-environment\.yml#object-form：不在 environment「keeper」的允許清單內/, "物件（flow mapping）寫法＋大寫");
  assert.match(out, /rogue-environment\.yml#quoted-key：不在 environment「settlement」的允許清單內/, "加引號的鍵");
  assert.match(out, /rogue-environment\.yml#dynamic：environment 名稱是動態的/);
  assert.match(out, /rogue-environment\.yml#unknown：綁了未登記的 environment「production」/);
  // (b) admin
  assert.match(out, /admin-base-sepolia\.yml：workflow 層級不可有這些鍵：`concurrency`/);
  assert.match(out, /admin-base-sepolia\.yml#build：admin workflow 只能有 precheck、approve、admin-call 三個 job/);
  assert.match(out, /admin-base-sepolia\.yml#precheck：不可綁 environment/);
  assert.match(out, /admin-base-sepolia\.yml#precheck：不可使用任何 secret（secrets\.PRECHECK_TOKEN）/);
  assert.match(out, /admin-base-sepolia\.yml#precheck：`permissions` 必須是 `\{\}`/);
  assert.match(out, /admin-base-sepolia\.yml#precheck：不可有這些鍵：`environment`、`if`、`continue-on-error`、`concurrency`/);
  assert.match(out, /admin-base-sepolia\.yml#precheck：steps\[0\] 不可設 `continue-on-error`/);
  assert.match(out, /admin-base-sepolia\.yml#precheck：守門 step 不可有這些鍵：`continue-on-error`/);
  assert.match(out, HASH_MISMATCH(PRE));
  assert.match(out, /admin-base-sepolia\.yml#approve：必須以字串寫法綁 environment「admin-approval」/);
  assert.match(out, /admin-base-sepolia\.yml#approve：必須 `needs: precheck`/);
  assert.match(out, /admin-base-sepolia\.yml#approve：不可使用任何 secret（secrets\.ADMIN_TOKEN）/);
  assert.match(out, /admin-base-sepolia\.yml#approve：不可有這些鍵：`if`/);
  assert.match(out, HASH_MISMATCH(APPROVE));
  assert.match(out, /admin-base-sepolia\.yml#admin-call：必須 `needs: approve`/);
  assert.match(out, /admin-base-sepolia\.yml#admin-call：不可有這些鍵：`if`/);
  assert.match(out, HASH_MISMATCH(CALL));
  // (c) 觸發
  assert.match(out, /trigger-string\.yml：不可使用 `pull_request_target` 觸發/);
  assert.match(out, /trigger-list\.yml：不可使用 `workflow_run` 觸發/);
  assert.match(out, /trigger-map\.yaml：不可使用 `pull_request_target` 觸發/);
  assert.match(out, /trigger-map\.yaml：不可使用 `workflow_run` 觸發/);
  assert.match(out, /price-keeper\.yml：綁了 environment「keeper」的 workflow 只能用 schedule、workflow_dispatch 觸發（多了 `issue_comment`）/);
  assert.match(out, /price-keeper\.yml：綁了 environment「keeper」的 workflow 不可有 `workflow_dispatch\.inputs`/);
  // (d) 私鑰 secret 必須綁 environment
  assert.match(out, /unbound-secret\.yml#no-environment：引用 secrets\.KEEPER_PRIVATE_KEY 但沒有綁 environment（應綁「keeper」）/);
  assert.match(out, /unbound-secret\.yml#lower-case-inline：引用 secrets\.FEE_SETTLEMENT_PRIVATE_KEY 但沒有綁 environment/, "小寫＋寫在 run 裡");
  assert.match(out, /unbound-secret\.yml#index-form：引用 secrets\.KEEPER_PRIVATE_KEY 但沒有綁 environment/, "secrets['X'] 寫法");
  assert.match(out, /unbound-secret\.yml#wrong-environment：引用 secrets\.FEE_SETTLEMENT_PRIVATE_KEY 但綁的是 environment「admin-approval」/);
  assert.match(out, /unbound-secret\.yml#dump-all：使用了動態或整包的 secrets 存取/);
  assert.match(out, /unbound-secret\.yml#computed：使用了動態或整包的 secrets 存取/);
  assert.match(out, /unbound-secret\.yml#inherit：使用了動態或整包的 secrets 存取/);
  assert.match(out, /top-level-secret\.yml#first：引用 secrets\.KEEPER_PRIVATE_KEY 但沒有綁 environment/);
  assert.match(out, /top-level-secret\.yml#second：引用 secrets\.KEEPER_PRIVATE_KEY 但沒有綁 environment/);
  assert.match(out, /reusable-and-parser\.yml#string-braces：引用 secrets\.KEEPER_PRIVATE_KEY 但沒有綁 environment/, "字串常值裡的 }}");
  // (e) reusable workflow
  assert.match(out, /reusable-and-parser\.yml#remote-reusable：不可用 job 層級的 `uses:`/);
  assert.match(out, /reusable-and-parser\.yml#local-reusable：不可用 job 層級的 `uses:`/);
  assert.match(out, /unbound-secret\.yml#inherit：不可用 job 層級的 `uses:`/);
  // (f) run 內插
  assert.match(out, /price-keeper\.yml#update-prices：steps\[1\] 的 `run` 直接內插了 \$\{\{ github\.event\.comment\.body \}\}/);
  assert.match(out, /price-keeper\.yml#update-prices：steps\[2\] 的 `run` 直接內插了 \$\{\{ format\('\{0\}', inputs\.target\) \}\}/);
  // 解析層：看不懂的一律算失敗
  assert.match(out, /anchor-alias\.yml：使用了 YAML anchor／alias/);
  assert.match(out, /merge-key\.yml：使用了 YAML merge key/);
  assert.match(out, /duplicate-key\.yml：YAML 解析失敗：Map keys must be unique/);
  assert.match(out, /broken\.yml：YAML 解析失敗/);
  assert.match(out, /\d+ 個 workflow 守門問題（13 個檔案、25 個 job）/);
});

test("目錄不存在或沒有 workflow → 結束碼 2（檢查中止，不是通過）", () => {
  assert.equal(cli("--workflows", join(fixtures, "nope")).status, 2);
  assert.equal(cli("--workflows", join(here, "fixtures/check-addresses")).status, 2, "目錄裡沒有 yml");
});

// ── 以現行 workflow 為底的反例：每一項都是「改一行就繞過」的情境 ──

test("(a) 其他 job 綁 keeper／settlement／admin-approval → 擋", () => {
  some(
    mutate("oracle-health.yml", /\n  base-sepolia:\n/, "\n  base-sepolia:\n    environment: keeper\n"),
    /oracle-health\.yml#base-sepolia：不在 environment「keeper」的允許清單內/,
  );
  some(
    mutate("consistency.yml", /\n  addresses:\n/, "\n  addresses:\n    environment:\n      name: Settlement\n      deployment: false\n"),
    /consistency\.yml#addresses：不在 environment「settlement」的允許清單內/,
  );
  some(
    withExtra("new-thing.yml", "on: schedule\njobs:\n  keep:\n    runs-on: ubuntu-latest\n    environment: keeper\n    steps:\n      - run: echo hi\n"),
    /new-thing\.yml#keep：不在 environment「keeper」的允許清單內/,
  );
  some(
    withExtra("new-thing.yml", "on: push\njobs:\n  approve:\n    runs-on: ubuntu-latest\n    environment: admin-approval\n    steps:\n      - run: echo hi\n"),
    /new-thing\.yml#approve：不在 environment「admin-approval」的允許清單內/,
  );
});

test("(b) GUARD_SHA256 等於現行守門 step 的指紋；--print-guard-hashes 印出同樣的值", () => {
  assert.deepEqual(currentGuardHashes(REAL, YAML), GUARD_SHA256);
  const r = cli("--print-guard-hashes");
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const [job, hash] of Object.entries(GUARD_SHA256)) assert.ok(r.stdout.includes(`"${job}": "${hash}"`), r.stdout);
});

test("(b) 守門指紋：YAML 註解不算；env、run、admin-call 的 job env 任何一個字改了都算", () => {
  const wf = YAML.parse(REAL_ADMIN.text);
  const base = guardDigest(wf.jobs[CALL], true);
  assert.equal(base, GUARD_SHA256[CALL]);
  const clone = () => structuredClone(wf.jobs[CALL]);

  // 註解（YAML 層）不影響：在守門 step 前後、env 裡加註解，檢查仍通過。
  assert.deepEqual(mutateJob(ADMIN.file, CALL, "          REF: ${{ github.ref }}\n", "          # 一行註解\n          REF: ${{ github.ref }}  # 行尾註解\n"), []);

  const j1 = clone();
  j1.steps[0].run += " ";
  assert.notEqual(guardDigest(j1, true), base, "run 多一個空白");
  const j2 = clone();
  j2.steps[0].env.REF = "${{ github.ref_name }}";
  assert.notEqual(guardDigest(j2, true), base, "env 的值");
  const j3 = clone();
  j3.steps[0].env = { ...j3.steps[0].env, EXTRA: "x" };
  assert.notEqual(guardDigest(j3, true), base, "env 多一個鍵");
  const j4 = clone();
  j4.env.BASH_ENV = "/tmp/x";
  assert.notEqual(guardDigest(j4, true), base, "admin-call 的 job 層級 env");
  const j5 = clone();
  j5.steps[0].run = j5.steps[0].run.replace(/\n/g, "\r\n");
  assert.equal(guardDigest(j5, true), base, "CRLF 與 LF 視為相同");
  assert.equal(guardDigest({ steps: [{ uses: "x" }] }), null);

  // 三個 job 各自：script 多一行 → 被擋。
  for (const job of [PRE, APPROVE, CALL]) {
    some(mutateJob(ADMIN.file, job, "          set -euo pipefail\n", "          set -euo pipefail\n          true\n"), HASH_MISMATCH(job));
  }
  // 觸發者白名單改回黑名單式的比較、或把擁有者換成寫死的字串 → 被擋。
  some(mutateJob(ADMIN.file, PRE, '!= "$owner" ]; then', '= "blocked" ]; then'), HASH_MISMATCH(PRE));
  some(mutateJob(ADMIN.file, CALL, "          OWNER: ${{ github.repository_owner }}\n", "          OWNER: ${{ github.actor }}\n"), HASH_MISMATCH(CALL));
  some(mutateJob(ADMIN.file, APPROVE, "          ACTOR: ${{ github.actor }}\n", "          ACTOR: ${{ github.repository_owner }}\n"), HASH_MISMATCH(APPROVE));
});

test("(b) precheck 被拿掉、被繞過或拿得到東西 → 擋", () => {
  some(mutate(ADMIN.file, "\n  precheck:\n", "\n  precheck-old:\n"), /admin-base-sepolia\.yml#precheck：找不到 job「precheck」/);
  some(mutateJob(ADMIN.file, APPROVE, "    needs: precheck\n", ""), /approve：必須 `needs: precheck`/);
  some(mutateJob(ADMIN.file, APPROVE, "    needs: precheck\n", "    needs: []\n"), /approve：必須 `needs: precheck`/);
  assert.deepEqual(mutateJob(ADMIN.file, APPROVE, "    needs: precheck\n", "    needs: [precheck]\n"), [], "陣列寫法合法");

  const perm = "    permissions: {}\n";
  const e = mutateJob(ADMIN.file, PRE, perm, `${perm}    environment: admin-approval\n`);
  some(e, /precheck：不可綁 environment/);
  some(e, /precheck：不在 environment「admin-approval」的允許清單內/);
  some(mutateJob(ADMIN.file, PRE, perm, `${perm}    environment:\n      name: keeper\n      deployment: false\n`), /precheck：不可綁 environment/);
  some(mutateJob(ADMIN.file, PRE, perm, `${perm}    environment: \${{ inputs.target }}\n`), /precheck：不可綁 environment/);
  some(mutateJob(ADMIN.file, PRE, perm, "    permissions:\n      contents: write\n"), /precheck：`permissions` 必須是 `\{\}`/);
  some(mutateJob(ADMIN.file, PRE, perm, ""), /precheck：`permissions` 必須是 `\{\}`/);
  for (const key of ["if: github.actor != 'x'", "continue-on-error: true", "needs: approve", "container: ubuntu", "outputs: {}"]) {
    some(mutateJob(ADMIN.file, PRE, perm, `${perm}    ${key}\n`), new RegExp(`precheck：不可有這些鍵：\`${key.split(":")[0]}\``));
  }
  some(mutateJob(ADMIN.file, PRE, perm, `${perm}    concurrency:\n      group: keeper-key-base-sepolia\n`), /precheck：不可有這些鍵：`concurrency`/);
  some(mutateJob(ADMIN.file, PRE, "    runs-on: ubuntu-latest\n", "    runs-on: self-hosted\n"), /precheck：`runs-on` 必須是 GitHub 代管的 ubuntu runner/);
  some(mutateJob(ADMIN.file, PRE, "    runs-on: ubuntu-latest\n", "    runs-on: [self-hosted, linux]\n"), /precheck：`runs-on` 必須是/);
  // 第二個 step（就算無害）也不行；帶 secret 的更不行。
  some(mutate(ADMIN.file, "\n  approve:\n", "\n      - run: echo extra\n\n  approve:\n"), /precheck：只能有守門這一個 step/);
  some(
    mutate(ADMIN.file, "\n  approve:\n", "\n      - run: echo \"$X\"\n        env:\n          X: ${{ secrets.BASE_SEPOLIA_RPC_URL }}\n\n  approve:\n"),
    /precheck：不可使用任何 secret（secrets\.BASE_SEPOLIA_RPC_URL）/,
  );
});

test("(b) approve／admin-call 的結構被改 → 擋", () => {
  some(mutateJob(ADMIN.file, CALL, "    needs: approve\n", ""), /admin-call：必須 `needs: approve`/);
  some(mutateJob(ADMIN.file, CALL, "    needs: approve\n", "    needs: []\n"), /admin-call：必須 `needs: approve`/);
  some(mutateJob(ADMIN.file, CALL, "    needs: approve\n", "    needs: precheck\n"), /admin-call：必須 `needs: approve`/, "跳過 approve");
  some(mutateJob(ADMIN.file, CALL, "    needs: approve\n", "    needs: approve\n    if: always()\n"), /admin-call：不可有這些鍵：`if`/);
  assert.deepEqual(mutateJob(ADMIN.file, CALL, "    needs: approve\n", "    needs: [precheck, approve]\n"), [], "陣列寫法合法");
  for (const key of ["continue-on-error: true", "container: ubuntu", "strategy: {}"]) {
    some(mutateJob(ADMIN.file, CALL, "    needs: approve\n", `    needs: approve\n    ${key}\n`), new RegExp(`admin-call：不可有這些鍵：\`${key.split(":")[0]}\``));
  }

  const envLine = "    environment: admin-approval\n";
  const p = mutateJob(ADMIN.file, APPROVE, envLine, "    environment: keeper\n");
  some(p, /approve：必須以字串寫法綁 environment「admin-approval」/);
  some(p, /approve：不在 environment「keeper」的允許清單內/);
  some(mutateJob(ADMIN.file, APPROVE, envLine, ""), /approve：必須以字串寫法綁 environment「admin-approval」/);
  some(mutateJob(ADMIN.file, APPROVE, envLine, `${envLine}    if: always()\n`), /approve：不可有這些鍵：`if`/);
  some(mutateJob(ADMIN.file, APPROVE, envLine, `${envLine}    permissions:\n      deployments: write\n`), /approve：不可有這些鍵：`permissions`/);
  some(mutateJob(ADMIN.file, APPROVE, "    needs: precheck\n", "    needs: [precheck, admin-call]\n"), /approve：必須 `needs: precheck`/);

  // approve 用到 secret：指紋不符＋不可使用 secret＋(d) 綁錯 environment。
  const q = mutateJob(ADMIN.file, APPROVE, "          GH_TOKEN: ${{ github.token }}\n", "          GH_TOKEN: ${{ secrets.KEEPER_PRIVATE_KEY }}\n");
  some(q, /approve：不可使用任何 secret（secrets\.KEEPER_PRIVATE_KEY）/);
  some(q, /approve：引用 secrets\.KEEPER_PRIVATE_KEY 但綁的是 environment「admin-approval」/);
  some(q, HASH_MISMATCH(APPROVE));

  // workflow 層級：只允許 name／on／permissions／jobs。
  const top = (extra) => mutate(ADMIN.file, "\npermissions:\n  contents: read\n", `\n${extra}\npermissions:\n  contents: read\n`);
  const w = top("env:\n  PK: ${{ secrets.KEEPER_PRIVATE_KEY }}\n");
  some(w, /admin-base-sepolia\.yml：workflow 層級不可有這些鍵：`env`/);
  some(w, /admin-base-sepolia\.yml：workflow 層級（jobs 以外）不可引用 secret/);
  some(w, /precheck：不可使用任何 secret（secrets\.KEEPER_PRIVATE_KEY）/);
  some(top("concurrency:\n  group: keeper-key-base-sepolia\n"), /workflow 層級不可有這些鍵：`concurrency`/);
  some(top("defaults:\n  run:\n    shell: bash\n"), /workflow 層級不可有這些鍵：`defaults`/);
});

test("(b) admin workflow 不見了或 job 改名 → 擋（要同步改檢查）", () => {
  some(check(REAL.filter((f) => f.name !== ADMIN.file)), /admin-base-sepolia\.yml：找不到這支 workflow/);
  some(mutate(ADMIN.file, "\n  admin-call:\n", "\n  admin-call-2:\n"), /找不到 job「admin-call」/);
  some(mutate(ADMIN.file, "\n  approve:\n", "\n  approval:\n"), /找不到 job「approve」/);
});

test("(c) 任何 workflow 加上 pull_request_target／workflow_run → 擋", () => {
  some(mutate("consistency.yml", "  pull_request:\n", "  pull_request_target:\n"), /consistency\.yml：不可使用 `pull_request_target` 觸發/);
  some(
    mutate("oracle-health.yml", "  workflow_dispatch:\n", "  workflow_dispatch:\n  workflow_run:\n    workflows: [Consistency]\n    types: [completed]\n"),
    /oracle-health\.yml：不可使用 `workflow_run` 觸發/,
  );
});

test("(c) 持有私鑰的 workflow：觸發事件白名單、不可有 inputs；admin 只能 workflow_dispatch", () => {
  for (const [file, envName] of [["base-sepolia-keeper.yml", "keeper"], ["price-keeper.yml", "keeper"], ["x402-settlement-worker.yml", "settlement"]]) {
    for (const trigger of ["push", "pull_request", "issue_comment", "repository_dispatch", "workflow_call"]) {
      some(
        mutate(file, "  workflow_dispatch:\n", `  workflow_dispatch:\n  ${trigger}:\n`),
        new RegExp(`${file.replace(".", "\\.")}：綁了 environment「${envName}」的 workflow 只能用 schedule、workflow_dispatch 觸發（多了 \`${trigger}\`）`),
      );
    }
    some(
      mutate(file, "  workflow_dispatch:\n", "  workflow_dispatch:\n    inputs:\n      x:\n        required: false\n"),
      new RegExp(`${file.replace(".", "\\.")}：綁了 environment「${envName}」的 workflow 不可有 \`workflow_dispatch\\.inputs\``),
    );
  }
  // 沒有綁 keeper／settlement 的 workflow 不受這條限制（consistency.yml 本來就有 push／pull_request）。
  assert.deepEqual(check(REAL), []);
  some(mutate(ADMIN.file, "\non:\n  workflow_dispatch:\n", "\non:\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:\n"), /admin-base-sepolia\.yml：觸發事件只能是 `workflow_dispatch`/);
  some(mutate(ADMIN.file, "\non:\n  workflow_dispatch:\n", "\non:\n  push:\n"), /admin-base-sepolia\.yml：觸發事件只能是 `workflow_dispatch`/);
});

test("(d) 用到私鑰的 job 拿掉或換掉 environment → 擋", () => {
  const strip = /    environment:\n      name: (keeper|settlement)\n      deployment: false\n/;
  some(mutate("base-sepolia-keeper.yml", strip, ""), /base-sepolia-keeper\.yml#keep：引用 secrets\.KEEPER_PRIVATE_KEY 但沒有綁 environment/);
  some(mutate("price-keeper.yml", strip, ""), /price-keeper\.yml#update-prices：引用 secrets\.KEEPER_PRIVATE_KEY 但沒有綁 environment/);
  some(mutate("x402-settlement-worker.yml", strip, ""), /x402-settlement-worker\.yml#settle：引用 secrets\.FEE_SETTLEMENT_PRIVATE_KEY 但沒有綁 environment/);
  const p = mutate("x402-settlement-worker.yml", "      name: settlement\n", "      name: keeper\n");
  some(p, /settle：不在 environment「keeper」的允許清單內/);
  some(p, /settle：引用 secrets\.FEE_SETTLEMENT_PRIVATE_KEY 但綁的是 environment「keeper」（應綁「settlement」）/);
  some(
    mutate("oracle-health.yml", "KEEPER_RPC_URL: ${{ secrets.BASE_SEPOLIA_RPC_URL }}", "KEEPER_RPC_URL: ${{ secrets.BASE_SEPOLIA_RPC_URL }}\n      PK: ${{ secrets.KEEPER_PRIVATE_KEY }}"),
    /oracle-health\.yml#base-sepolia：引用 secrets\.KEEPER_PRIVATE_KEY 但沒有綁 environment/,
  );
});

test("(e) job 層級的 uses（reusable workflow）一律擋；step 層級的 uses 不受影響", () => {
  const wf = (body) => `on: push\njobs:\n${body}`;
  some(withExtra("r.yml", wf("  c:\n    uses: someone/else/.github/workflows/w.yml@main\n")), /r\.yml#c：不可用 job 層級的 `uses:`/);
  some(withExtra("r.yml", wf("  c:\n    uses: ./.github/workflows/base-sepolia-keeper.yml\n")), /r\.yml#c：不可用 job 層級的 `uses:`/);
  assert.deepEqual(withExtra("r.yml", wf("  c:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n")), []);
});

test("(f) run 不可內插 inputs／github.event；經 env 傳遞、github.event_name 不算", () => {
  const wf = (run, env = "") => `on: push\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${run}\n${env}`;
  const hit = /x\.yml#j：steps\[0\] 的 `run` 直接內插了/;
  some(withExtra("x.yml", wf("echo ${{ inputs.name }}")), hit);
  some(withExtra("x.yml", wf("echo ${{ github.event.issue.title }}")), hit);
  some(withExtra("x.yml", wf("echo ${{ github.event['comment'].body }}")), hit);
  some(withExtra("x.yml", wf("echo ${{ github['event'].comment.body }}")), hit);
  some(withExtra("x.yml", wf("echo ${{ format('{0}', INPUTS.name) }}")), hit, "不分大小寫、包在函式裡");
  some(withExtra("x.yml", wf("|\n          echo one\n          echo ${{ toJSON(github.event) }}")), hit, "多行 script");
  assert.deepEqual(withExtra("x.yml", wf('echo "$NAME"', "        env:\n          NAME: ${{ inputs.name }}\n")), [], "經 env 傳遞");
  assert.deepEqual(withExtra("x.yml", wf("echo ${{ github.event_name }} ${{ github.sha }} ${{ matrix.os }}")), [], "不是觸發者可控的值");
  assert.deepEqual(withExtra("x.yml", wf('echo "inputs.name github.event.x"')), [], "運算式之外的文字不算");
});

test("PR #217 審查的 40 個繞過嘗試：以現行 workflow 重做，全部被擋，而且是以預期的理由", () => {
  const cases = bypassCases(REAL);
  assert.equal(cases.length, 40);
  assert.equal(new Set(cases.map((c) => c.id)).size, 40);
  for (const c of cases) {
    const problems = check(c.files);
    assert.ok(problems.length > 0, `${c.id}（${c.desc}）通過了檢查＝繞過成功`);
    for (const re of c.expect) some(problems, re);
  }
});

test("expressionsInString：找 `}}` 時跳過單引號字串（與 actions/runner 的 TemplateReader 一致）", () => {
  assert.deepEqual(expressionsInString("a ${{ x }} b ${{ y }}"), [" x ", " y "]);
  assert.deepEqual(expressionsInString("${{ format('}}{0}', secrets.K) }}"), [" format('}}{0}', secrets.K) "]);
  assert.deepEqual(expressionsInString("${{ 'it''s }}' }} tail ${{ z }}"), [" 'it''s }}' ", " z "], "'' 跳脫");
  assert.deepEqual(expressionsInString("${{ a }}}}"), [" a "]);
  assert.deepEqual(expressionsInString("${{ 'never closed }} secrets.K"), [" 'never closed }} secrets.K"], "字串沒關 → 整段都算");
  assert.deepEqual(expressionsInString("${{ unclosed secrets.K"), [" unclosed secrets.K"]);
  assert.deepEqual(expressionsInString("no expression } } {{ }}"), []);
  assert.deepEqual(expressionsInString("${{}}"), [""]);
  // 舊的寫法（indexOf("}}")）在第一個 `}}` 就截斷，後面的 secrets 會漏掉。
  const names = (s) => [...secretRefsIn(expressionsIn(s)).names];
  assert.deepEqual(names("${{ format('}}{0}', secrets.KEEPER_PRIVATE_KEY) }}"), ["KEEPER_PRIVATE_KEY"]);
  assert.deepEqual(names("${{ format('a}}b}}c', 1) }} ${{ secrets.FEE_SETTLEMENT_PRIVATE_KEY }}"), ["FEE_SETTLEMENT_PRIVATE_KEY"]);
});

test("secretRefsIn：名稱不分大小寫、索引寫法、動態存取；不是 secrets context 的不算", () => {
  const refs = (s) => {
    const r = secretRefsIn(expressionsIn(s));
    return { names: [...r.names].sort(), dynamic: r.dynamic };
  };
  assert.deepEqual(refs("${{ secrets.KEEPER_PRIVATE_KEY }}"), { names: ["KEEPER_PRIVATE_KEY"], dynamic: false });
  assert.deepEqual(refs("a ${{ SECRETS.keeper_private_key }} b ${{ secrets . X }}"), { names: ["KEEPER_PRIVATE_KEY", "X"], dynamic: false });
  assert.deepEqual(refs(`\${{ secrets['A'] }} \${{ secrets[ "b" ] }}`), { names: ["A", "B"], dynamic: false });
  assert.deepEqual(refs("${{ secrets.A || secrets.B }}"), { names: ["A", "B"], dynamic: false });
  assert.deepEqual(refs("${{ toJSON(secrets) }}"), { names: [], dynamic: true });
  assert.deepEqual(refs("${{ secrets[env.NAME] }}"), { names: [], dynamic: true });
  assert.deepEqual(refs("${{ secrets.* }}"), { names: [], dynamic: true });
  assert.deepEqual(refs("${{ secrets.KEEPER_PRIVATE_KEY"), { names: ["KEEPER_PRIVATE_KEY"], dynamic: false }, "沒有結尾的 ${{ 也要抓");
  assert.deepEqual(refs("${{ inputs.secrets }} ${{ env.my_secrets }} ${{ vars.secrets_x }}"), { names: [], dynamic: false });
  assert.deepEqual(refs("echo secrets.KEEPER_PRIVATE_KEY"), { names: [], dynamic: false }, "運算式之外的文字不算");
  // `if:` 可以不寫 ${{ }}
  assert.deepEqual([...secretRefsIn(expressionsIn({ if: "secrets.X != ''" })).names], ["X"]);
});

test("environmentOf／triggersOf：各種寫法", () => {
  assert.deepEqual(environmentOf({}), { kind: "none" });
  assert.deepEqual(environmentOf({ environment: " Keeper " }), { kind: "static", name: "keeper" });
  assert.deepEqual(environmentOf({ environment: { name: "keeper", deployment: false } }), { kind: "static", name: "keeper" });
  assert.equal(environmentOf({ environment: { url: "https://x" } }).kind, "invalid");
  assert.equal(environmentOf({ environment: null }).kind, "invalid");
  assert.equal(environmentOf({ environment: "${{ inputs.e }}" }).kind, "invalid");
  assert.equal(environmentOf({ environment: { name: "keeper-${{ inputs.e }}" } }).kind, "invalid");

  assert.deepEqual(triggersOf({ on: "push" }), ["push"]);
  assert.deepEqual(triggersOf({ on: ["push", "workflow_run"] }), ["push", "workflow_run"]);
  assert.deepEqual(triggersOf({ on: { push: null, pull_request_target: {} } }), ["push", "pull_request_target"]);
  assert.deepEqual(triggersOf({ true: { push: null } }), ["push"], "YAML 1.1 把 on 讀成 true 的情況");
  assert.equal(triggersOf({}), null);
});
