// check-workflow-guards.mjs 的自我測試：repo 本身必須通過、反例 fixture 必須失敗。
//   npm ci --ignore-scripts --prefix scripts      # 第一次：安裝固定版本的 yaml
//   node --test scripts/check-workflow-guards.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN,
  ENVIRONMENTS,
  checkWorkflows,
  environmentOf,
  expressionsIn,
  loadYaml,
  readWorkflowDir,
  secretRefsIn,
  triggersOf,
} from "./check-workflow-guards.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const script = join(here, "check-workflow-guards.mjs");
const fixtures = join(here, "fixtures/check-workflow-guards");
const YAML = await loadYaml();
const REAL = readWorkflowDir(join(root, ".github/workflows"));

const cli = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

/**
 * 以現行 repo 的 workflow 為底，改掉其中一支再檢查。`from` 找不到就讓測試失敗：
 * workflow 改版後這裡的替換目標要跟著更新，不能默默變成「什麼都沒改所以通過」。
 */
function mutate(file, from, to) {
  let hit = false;
  const files = REAL.map((f) => {
    if (f.name !== file) return f;
    assert.ok(typeof from === "string" ? f.text.includes(from) : from.test(f.text), `${file} 裡找不到替換目標：${from}`);
    hit = true;
    return { name: f.name, text: f.text.replace(from, to) };
  });
  assert.ok(hit, `找不到 ${file}`);
  return checkWorkflows(files, YAML).problems;
}
const withExtra = (name, text) => checkWorkflows([...REAL, { name, text }], YAML).problems;
const some = (problems, re) => assert.ok(problems.some((p) => re.test(p)), `預期有 ${re}，實際：\n${problems.join("\n") || "（沒有任何問題）"}`);

test("現行 repo 的 workflow 全部通過", () => {
  const r = cli();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /workflow 守門檢查通過 ✓（\d+ 個檔案、\d+ 個 job）/);
  assert.deepEqual(checkWorkflows(REAL, YAML).problems, []);
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

test("合規的 fixture 通過（各種不該誤報的寫法）", () => {
  const r = cli("--workflows", join(fixtures, "good"));
  assert.equal(r.status, 0, r.stdout + r.stderr);
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
  assert.match(out, /admin-base-sepolia\.yml#approve：必須綁 environment「admin-approval」/);
  assert.match(out, /admin-base-sepolia\.yml#approve：不可使用任何 secret（secrets\.ADMIN_TOKEN）/);
  assert.match(out, /admin-base-sepolia\.yml#approve：不可有 job 層級的 `if`/);
  assert.match(out, /admin-base-sepolia\.yml#approve：steps\[0\] 不可設 `continue-on-error`/);
  assert.match(out, /admin-base-sepolia\.yml#admin-call：必須 `needs: approve`/);
  assert.match(out, /admin-base-sepolia\.yml#admin-call：不可有 job 層級的 `if`/);
  assert.match(out, /admin-base-sepolia\.yml#admin-call：守門不完整：缺少 ref 守門.*缺少 run_attempt 守門/);
  // (c) 觸發
  assert.match(out, /trigger-string\.yml：不可使用 `pull_request_target` 觸發/);
  assert.match(out, /trigger-list\.yml：不可使用 `workflow_run` 觸發/);
  assert.match(out, /trigger-map\.yaml：不可使用 `pull_request_target` 觸發/);
  assert.match(out, /trigger-map\.yaml：不可使用 `workflow_run` 觸發/);
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
  // 解析層：看不懂的一律算失敗
  assert.match(out, /anchor-alias\.yml：使用了 YAML anchor／alias/);
  assert.match(out, /duplicate-key\.yml：YAML 解析失敗：Map keys must be unique/);
  assert.match(out, /broken\.yml：YAML 解析失敗/);
  assert.match(out, /\d+ 個 workflow 守門問題（10 個檔案/);
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
    withExtra("new-thing.yml", "on: push\njobs:\n  keep:\n    runs-on: ubuntu-latest\n    environment: keeper\n    steps:\n      - run: echo hi\n"),
    /new-thing\.yml#keep：不在 environment「keeper」的允許清單內/,
  );
  some(
    withExtra("new-thing.yml", "on: push\njobs:\n  approve:\n    runs-on: ubuntu-latest\n    environment: admin-approval\n    steps:\n      - run: echo hi\n"),
    /new-thing\.yml#approve：不在 environment「admin-approval」的允許清單內/,
  );
});

test("(b) admin-call 拿掉 needs: approve、加 if、approve 改綁別的 environment 或用到 secret → 擋", () => {
  some(mutate(ADMIN.file, "    needs: approve\n", ""), /admin-call：必須 `needs: approve`/);
  some(mutate(ADMIN.file, "    needs: approve\n", "    needs: []\n"), /admin-call：必須 `needs: approve`/);
  some(mutate(ADMIN.file, "    needs: approve\n", "    needs: approve\n    if: always()\n"), /admin-call：不可有 job 層級的 `if`/);
  assert.deepEqual(mutate(ADMIN.file, "    needs: approve\n", "    needs: [approve]\n"), [], "陣列寫法合法");

  const p = mutate(ADMIN.file, "    environment: admin-approval\n", "    environment: keeper\n");
  some(p, /approve：必須綁 environment「admin-approval」/);
  some(p, /approve：不在 environment「keeper」的允許清單內/);
  some(mutate(ADMIN.file, "    environment: admin-approval\n", ""), /approve：必須綁 environment「admin-approval」/);
  some(mutate(ADMIN.file, "    environment: admin-approval\n", "    environment: admin-approval\n    if: github.actor != 'x'\n"), /approve：不可有 job 層級的 `if`/);

  const q = mutate(ADMIN.file, "          GH_TOKEN: ${{ github.token }}\n", "          GH_TOKEN: ${{ secrets.KEEPER_PRIVATE_KEY }}\n");
  some(q, /approve：不可使用任何 secret（secrets\.KEEPER_PRIVATE_KEY）/);
  some(q, /approve：引用 secrets\.KEEPER_PRIVATE_KEY 但綁的是 environment「admin-approval」/);
  some(
    mutate(ADMIN.file, "\npermissions:\n  contents: read\n", "\nenv:\n  PK: ${{ secrets.KEEPER_PRIVATE_KEY }}\n\npermissions:\n  contents: read\n"),
    /admin-base-sepolia\.yml：workflow 層級（jobs 以外）不可引用 secret/,
  );
});

test("(b) admin-call 的 ref／run_attempt 守門被拿掉或弱化 → 擋", () => {
  const guard = /守門不完整/;
  some(mutate(ADMIN.file, 'if [ "$RUN_ATTEMPT" != "1" ]; then', 'if [ "$RUN_ATTEMPT" != "99" ]; then'), /缺少 run_attempt 守門/);
  some(mutate(ADMIN.file, "          RUN_ATTEMPT: ${{ github.run_attempt }}\n", '          RUN_ATTEMPT: "1"\n'), /缺少 run_attempt 守門/);
  some(mutate(ADMIN.file, "          RUN_ATTEMPT: ${{ github.run_attempt }}\n", "          RUN_ATTEMPT: ${{ github.run_attempt || '1' }}\n"), /缺少 run_attempt 守門/);
  // admin-call 的守門 step（approve 的 gate 也有同樣的 ref 檢查，所以用 admin-call 專屬的錨點）。
  const callRef = /(RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}[\s\S]*?)if \[ "\$REF" != "refs\/heads\/master" \]; then/;
  some(mutate(ADMIN.file, callRef, '$1if [ "$REF" != "refs/heads/main" ]; then'), /缺少 ref 守門/);
  some(mutate(ADMIN.file, callRef, '$1if [ "$REF" == "refs/heads/master" ]; then'), /缺少 ref 守門/);
  // exit 1 被註解掉
  some(
    mutate(ADMIN.file, /(請重新 dispatch 並重新核准。"\n\s+)exit 1/, "$1# exit 1"),
    /缺少 run_attempt 守門/,
  );
  // 守門 step 不再是第一個、或可被略過
  some(mutate(ADMIN.file, "      - name: Guard — 只接受 master 上第一次執行\n", "      - run: echo first\n      - name: Guard — 只接受 master 上第一次執行\n"), guard);
  some(mutate(ADMIN.file, "      - name: Guard — 只接受 master 上第一次執行\n", "      - name: Guard — 只接受 master 上第一次執行\n        if: github.actor != 'zuemen'\n"), /守門 step 不可有 `if`/);
  some(mutate(ADMIN.file, "      - name: Guard — 只接受 master 上第一次執行\n", "      - name: Guard — 只接受 master 上第一次執行\n        continue-on-error: true\n"), /守門 step 不可設 `continue-on-error`/);
});

test("(b) admin workflow 不見了或 job 改名 → 擋（要同步改檢查）", () => {
  some(checkWorkflows(REAL.filter((f) => f.name !== ADMIN.file), YAML).problems, /admin-base-sepolia\.yml：找不到這支 workflow/);
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
