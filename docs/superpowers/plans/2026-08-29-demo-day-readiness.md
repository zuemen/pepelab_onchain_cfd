# Demo Day Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 PR #91 的 CI 轉綠、合併上線，使 8/31 Demo Day 當天正式站的領獎台、RWA 定位與無槓桿介面都是活的。

**Architecture:** 四段獨立可測的修復，順序有依賴：先讓兩個紅燈的 CI 檢查變綠（它們擋住合併），再合併觸發 Vercel 部署，最後在正式站上驗收並補一次鏈上種資料。CI 的兩個失敗都**不是**功能問題——一個是 foundry 版本漂移撞到過緊的 gas 斷言，一個是 `bundle:check` 用「重建後比對雜湊」這種對環境敏感的方式驗證同步性。

**Tech Stack:** Foundry (forge 1.7.1 本機 / 1.8.0 CI)、esbuild、Vite + React + MUI、ethers v6、GitHub Actions、Vercel、Base Sepolia (chainId 84532)

**Spec:** 本計畫實作的「規格」是評審在 2026-08-27 給的七點回饋（已逐條處理，見 PR #91 說明），以及原始任務單「讓正式站排行榜前三名上榜」。兩者都完整轉錄在 `docs/superpowers/plans/2026-07-26-pepefi-professor-requirements.md` 的後續與 PR #91 的描述中。

## Global Constraints

- **鏈：** 只有 Base Sepolia，chainId `84532`。出塊時間 **2 秒**（不是 Ethereum Sepolia 的 12 秒——本專案已經被這個假設咬過兩次）。
- **合約位址（已部署，不要重新部署）：** PerpetualExchange `0xEf75ECA6514cE96B18382E921aC6190a0cF8c072`、MockUSDC `0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035`、MockOracle `0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3`。
- **套件管理器：** `frontend/` 只用 yarn，`agent/` 只用 npm。混用會產生第二份 lockfile。
- **祕密：** `contracts/.env.roles`（含 `SEED_MNEMONIC`、`KEEPER_PK`）已被 `.gitignore` 的 `.env.*.local` 與 `.env` 規則涵蓋。**任何情況下不得 commit、不得印在終端機輸出裡。**
- **語系：** 所有顯示字串走 `frontend/src/locales/`，zh-TW 與 en **必須同步**，否則 `locales.test.ts` 的 ratchet 會擋 build。
- **分支：** 工作分支 `feat/rwa-first-positioning`（已推上 origin，PR #91）。正式站的 Vercel Production 分支是 `master`。
- **時間盒：** Demo Day 8/31。正式站領獎台目前跑的是舊版前端（27 小時視窗），**最後一批平倉在 block 46063334，視窗在 block 46113334 失效**——約 2026-08-29 中午前後。

---

## File Structure

| 檔案 | 動作 | 責任 |
|---|---|---|
| `contracts/test/AuditFixesCore.t.sol` | 修改（第 257 行附近） | 放寬 gas 斷言的容差，並把「為什麼是這個數字」寫進註解 |
| `.github/workflows/contracts-ci.yml` | 修改（第 54、97 行） | 把 foundry 從 `stable` 釘到明確版本，讓 CI 可重現 |
| `agent/signal-api/check-vercel-bundle.mjs` | 改寫 | 從「重建後比雜湊」改為「比對來源指紋」，消除環境敏感性 |
| `agent/signal-api/build-vercel.mjs` | 修改 | 打包時一併寫出來源指紋檔 |
| `agent/signal-api/api/.bundle-sources.json` | 新增 | 記錄這份 bundle 是從哪些 src 檔案的哪個雜湊打包出來的 |
| `agent/signal-api/src/bundleFingerprint.mjs` | 新增 | 指紋計算的單一真相來源，build 與 check 共用 |
| `agent/signal-api/src/bundleFingerprint.test.mjs` | 新增 | 指紋函式的測試（換行正規化、檔案順序無關） |
| `.gitattributes` | 修改 | 把 `*.ts` 釘成 LF，讓跨平台的來源雜湊一致 |
| `docs/RUNBOOK_DEMO_DAY.md` | 新增 | Demo 當天的 pre-flight 檢查清單 |

---

## Task 1: 讓 gas 斷言不再因為 foundry 版本而誤報

**Files:**
- Modify: `contracts/test/AuditFixesCore.t.sol:233-258`
- Modify: `.github/workflows/contracts-ci.yml:54` 與 `:97`

**Interfaces:**
- Consumes: 無（獨立）
- Produces: 無新介面。產出是「Contracts CI 的 `forge build + test` 轉綠」。

**背景（執行者必讀）：** CI 的失敗訊息是
`[FAIL: health cost must not scale with closed positions: 44972 >= 44703] test_C3_accountHealthGasDoesNotGrowWithChurn()`。
本機 forge **1.7.1** 跑同一條測試是 PASS，CI 用的是 `version: stable` 解析出來的 forge **1.8.0**。這條測試在意的是「`getAccountHealth` 的成本會不會隨著已平倉部位線性成長」——修復前是每筆死資料多 593 gas（400 筆約 237,000 gas）。現在超標的量是 **269 gas**，是修復前規模的千分之一，屬於版本間 gas 計價的雜訊，不是行為回歸。所以正確的修法是把容差放寬到仍能抓到真正回歸的量級，並且把 foundry 版本釘住讓 CI 可重現。**不要**改 `PerpetualExchange.sol` 來迎合這個數字。

- [ ] **Step 1: 先確認本機重現得了 CI 的版本**

```bash
cd contracts
forge --version   # 預期看到 1.7.x —— 與 CI 的 1.8.0 不同，這就是差異來源
forge test --match-test test_C3_accountHealthGasDoesNotGrowWithChurn -vv
```

Expected: 本機 PASS（`[PASS] test_C3_accountHealthGasDoesNotGrowWithChurn()`）。本機綠、CI 紅，本身就是「環境敏感」的證據。

- [ ] **Step 2: 放寬容差並寫下理由**

編輯 `contracts/test/AuditFixesCore.t.sol`，把這一行：

```solidity
        // Pre-fix this grew by ~593 gas per dead entry (≈237,000 for 400).
        assertLt(dirty, clean + 2_000, "health cost must not scale with closed positions");
```

改成：

```solidity
        // Pre-fix this grew by ~593 gas per dead entry (≈237,000 for 400), so the
        // regression this guards against is five orders of magnitude bigger than
        // the tolerance. The old 2,000 margin was tight enough that a compiler /
        // forge version bump alone could trip it: CI on forge 1.8.0 measured
        // 44,972 against a 44,703 ceiling — 269 gas over — while forge 1.7.1
        // passed locally on the same commit. A test that fails on a toolchain
        // upgrade is not testing the contract.
        assertLt(dirty, clean + 20_000, "health cost must not scale with closed positions");
```

- [ ] **Step 3: 跑測試確認仍然通過**

```bash
cd contracts
forge test --match-test test_C3_accountHealthGasDoesNotGrowWithChurn -vv
```

Expected: PASS。

- [ ] **Step 4: 確認這條測試仍然抓得到真正的回歸**

暫時把 `PerpetualExchange.sol:1227` 的 `_removeUserPosition(pos.owner, positionId);` 註解掉（這是 C-3 修復本身），重跑測試：

```bash
cd contracts
forge test --match-test test_C3_accountHealthGasDoesNotGrowWithChurn -vv
```

Expected: **FAIL**，且 dirty 會大到十萬以上——證明 20,000 的容差仍然守得住原本的漏洞。確認後把那一行還原：

```bash
git checkout -- src/PerpetualExchange.sol
```

- [ ] **Step 5: 把 foundry 版本釘住**

編輯 `.github/workflows/contracts-ci.yml`，**兩處**（第 54 行的 `forge build + test` job 與第 97 行的 `gas snapshot` job）都把：

```yaml
        with:
          version: stable
```

改成：

```yaml
        with:
          # 釘版本,不用 `stable`:2026-08-28 stable 從 1.7.1 滾到 1.8.0,gas 計價
          # 跟著變,test_C3_accountHealthGasDoesNotGrowWithChurn 在沒有任何合約
          # 變更的情況下由綠轉紅。工具鏈自己升版不該讓 CI 說謊。升版要是一個
          # 看得見的 commit。
          version: v1.8.0
```

- [ ] **Step 6: 跑完整合約測試**

```bash
cd contracts
forge test
```

Expected: `653 tests passed, 0 failed`（若期間有新增測試，數字只會往上）。

- [ ] **Step 7: Commit**

```bash
git add contracts/test/AuditFixesCore.t.sol .github/workflows/contracts-ci.yml
git commit -m "test(gas): 放寬 C-3 健康度 gas 容差並釘住 CI 的 foundry 版本

CI 從 stable 解析到 forge 1.8.0,同一個 commit 在本機 1.7.1 是綠的,在 CI 量到
44,972 對上 44,703 的上限——超標 269 gas。這條測試防的是「每筆死資料多 593
gas、400 筆約 237,000」的漏洞,容差本來就不該窄到工具鏈升版就會踩到。

容差放寬到 20,000（仍比要防的回歸小一個數量級以上,已用註解掉 C-3 修復的方式
反證它抓得到）,並把 foundry 釘成 v1.8.0,讓工具鏈升版變成一個看得見的 commit。"
```

---

## Task 2: 讓 bundle 同步檢查不再因為 esbuild 環境而誤報

**Files:**
- Create: `agent/signal-api/src/bundleFingerprint.mjs`
- Create: `agent/signal-api/src/bundleFingerprint.test.mjs`
- Create: `agent/signal-api/api/.bundle-sources.json`（由 build 產生後 commit）
- Modify: `agent/signal-api/build-vercel.mjs`
- Modify: `agent/signal-api/check-vercel-bundle.mjs`
- Modify: `.gitattributes`
- Modify: `agent/package.json`（把新測試接進 `test:signal-api`）

**Interfaces:**
- Consumes: 無（獨立）
- Produces: `fingerprintSources(dir: string): Promise<{ files: Record<string, string>, digest: string }>` —— 供 `build-vercel.mjs` 與 `check-vercel-bundle.mjs` 共用。`files` 是「相對路徑 → 該檔內容的 sha256 前 16 碼」，`digest` 是整體指紋。

**背景（執行者必讀）：** `check-vercel-bundle.mjs` 現在的作法是「在 CI 上重新 esbuild 一次，把輸出文字的 sha256 拿去跟 commit 進 repo 的 `api/index.js` 比」。這個不變式的本意是對的（Vercel 直接吃 commit 進 repo 的 bundle，**沒有 build step**，改了 src 忘了重打包，線上就是舊碼），但實作方式讓它依賴「兩台機器的 esbuild 會產生位元組相同的輸出」。實測不成立：

| 環境 | esbuild | 重建後的 hash |
|---|---|---|
| 本機 `signal-api/node_modules` | 0.24.2 | `71fde29ee445c7cf`（＝目前 commit 進 repo 的那份） |
| 本機 hoist 到 `agent/node_modules` | 0.28.1 | `0f40bd349edc2f2a` |
| GitHub Actions | （lock 解析結果） | `945cfee402b45c74` |

三個都不一樣。要驗的其實不是「輸出位元組相同」，而是「**這份 bundle 是從現在這些 src 打出來的**」。改成記錄來源指紋就與 esbuild 版本無關了。

- [ ] **Step 1: 寫失敗的測試**

Create `agent/signal-api/src/bundleFingerprint.test.mjs`:

```javascript
// 指紋函式的行為測試。用 node:test 跑,與 repo 內其他 agent 測試一致(純 node,
// 不引入測試框架)。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fingerprintSources } from "./bundleFingerprint.mjs";

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), "fp-"));
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
  }
  return dir;
}

test("同樣的內容給同樣的 digest", async () => {
  const a = await fixture({ "a.ts": "export const x = 1\n" });
  const b = await fixture({ "a.ts": "export const x = 1\n" });
  assert.equal((await fingerprintSources(a)).digest, (await fingerprintSources(b)).digest);
});

test("改一個字元 digest 就變", async () => {
  const a = await fixture({ "a.ts": "export const x = 1\n" });
  const b = await fixture({ "a.ts": "export const x = 2\n" });
  assert.notEqual((await fingerprintSources(a)).digest, (await fingerprintSources(b)).digest);
});

test("CRLF 與 LF 視為相同 —— 跨平台 checkout 不該讓 CI 說謊", async () => {
  const lf   = await fixture({ "a.ts": "export const x = 1\nexport const y = 2\n" });
  const crlf = await fixture({ "a.ts": "export const x = 1\r\nexport const y = 2\r\n" });
  assert.equal((await fingerprintSources(lf)).digest, (await fingerprintSources(crlf)).digest);
});

test("digest 不隨檔案系統回傳順序改變", async () => {
  const one = await fixture({ "a.ts": "1\n", "b.ts": "2\n" });
  const two = await fixture({ "b.ts": "2\n", "a.ts": "1\n" });
  assert.equal((await fingerprintSources(one)).digest, (await fingerprintSources(two)).digest);
});

test("只看 .ts,不看編譯產物或測試以外的雜物", async () => {
  const withNoise = await fixture({ "a.ts": "1\n", "notes.md": "hello\n" });
  const without   = await fixture({ "a.ts": "1\n" });
  assert.equal((await fingerprintSources(withNoise)).digest, (await fingerprintSources(without)).digest);
});

test("子目錄的檔案也算進去", async () => {
  const flat   = await fixture({ "a.ts": "1\n" });
  const nested = await fixture({ "a.ts": "1\n", "sub/b.ts": "2\n" });
  assert.notEqual((await fingerprintSources(flat)).digest, (await fingerprintSources(nested)).digest);
});
```

- [ ] **Step 2: 跑測試確認它失敗**

```bash
cd agent/signal-api
node --test src/bundleFingerprint.test.mjs
```

Expected: FAIL —— `Cannot find module ... bundleFingerprint.mjs`。

- [ ] **Step 3: 寫最小實作**

Create `agent/signal-api/src/bundleFingerprint.mjs`:

```javascript
// Bundle 來源指紋。build 與 check 共用這一份,兩邊算法不同就等於沒有檢查。
//
// 為什麼不是「重建後比對輸出位元組」(舊作法):那要求兩台機器的 esbuild 產生
// 完全相同的輸出。實測不成立 —— 同一個 commit,本機 esbuild 0.24.2 得到
// 71fde29ee445c7cf、0.28.1 得到 0f40bd349edc2f2a、GitHub Actions 得到
// 945cfee402b45c74。於是 CI 紅燈講的是「你的 esbuild 跟我的不一樣」,不是
// 「你忘了重新打包」,而後者才是這個檢查存在的理由(稽核 2026-08-06 四·Medium:
// Vercel 直接服務 commit 進 repo 的 bundle,沒有 build step)。
//
// 改成記錄「這份 bundle 是從哪些來源打出來的」就與工具鏈無關了。
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";

/** 換行正規化:Windows checkout 是 CRLF、Linux 是 LF,同一份原始碼不該有兩個指紋。 */
const normalize = (s) => s.replace(/\r\n/g, "\n");

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

async function collect(dir, base, out) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collect(full, base, out);
    } else if (entry.name.endsWith(".ts")) {
      // 路徑一律用 "/",否則 Windows 的 "\" 會讓 digest 跟 Linux 不同。
      out[relative(base, full).split(sep).join("/")] = sha(normalize(await readFile(full, "utf8")));
    }
  }
  return out;
}

/**
 * @param {string} dir 要掃描的來源目錄(signal-api/src)
 * @returns {Promise<{files: Record<string,string>, digest: string}>}
 */
export async function fingerprintSources(dir) {
  const files = await collect(dir, dir, {});
  // 排序後再組合:readdir 的順序不保證,不排序 digest 會隨檔案系統而變。
  const canonical = Object.keys(files).sort().map((k) => `${k}:${files[k]}`).join("\n");
  return { files, digest: sha(canonical) };
}
```

- [ ] **Step 4: 跑測試確認通過**

```bash
cd agent/signal-api
node --test src/bundleFingerprint.test.mjs
```

Expected: `# pass 6` / `# fail 0`。

- [ ] **Step 5: 讓 build 寫出指紋**

把 `agent/signal-api/build-vercel.mjs` **整份**換成下面這份（原檔只有 26 行，整份取代比描述插入位置更不容易出錯）：

```javascript
// 把 Vercel serverless 進入點 esbuild 打包成自包 ESM：api/index.js。
// 內聯 app.ts / settlement / onchainRevenue / @pepelab/shared 與所有 npm 依賴，
// 故執行期不需解析 .ts 副檔名或 workspace symlink，且格式與 package.json
// "type":"module" 一致（不會再噴 "exports is not defined"）。
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";

import { fingerprintSources } from "./src/bundleFingerprint.mjs";

await build({
  entryPoints: ["src/vercel-entry.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "api/index.js",
  // ESM 下補 require/__dirname/__filename，避免某些被內聯的 CJS 依賴在執行期缺這些。
  banner: {
    js:
      "import{createRequire as __cr}from'module';" +
      "import{fileURLToPath as __ftp}from'url';" +
      "import{dirname as __dn}from'path';" +
      "const require=__cr(import.meta.url);" +
      "const __filename=__ftp(import.meta.url);" +
      "const __dirname=__dn(__filename);",
  },
});

console.log("✓ bundled api/index.js (self-contained ESM)");

// 把「這份 bundle 是從哪些來源打出來的」一起寫下來。bundle:check 比對的是這個，
// 不是重新 esbuild 一次的輸出 —— 見 src/bundleFingerprint.mjs 開頭的說明。
const fp = await fingerprintSources("src");
await writeFile(
  "api/.bundle-sources.json",
  JSON.stringify({ digest: fp.digest, files: fp.files }, null, 2) + "
",
);
console.log(`✓ wrote api/.bundle-sources.json (${fp.digest})`);
```

- [ ] **Step 6: 改寫檢查**

把 `agent/signal-api/check-vercel-bundle.mjs` **整份**換成：

```javascript
// 檢查 commit 進 repo 的 api/index.js 是否從目前的 src/*.ts 打包而來。
//
// 稽核 2026-08-06（四·Medium）：Vercel 服務的是 commit 進 repo 的 4.8MB bundle，
// **沒有 build step** —— 改了 src/*.ts 忘記重打包，線上跑的就是舊碼，而且沒有任何
// 東西會告訴你。這支讓 CI 能把「忘記 bundle」變成一個紅燈。
//
// 2026-08-29：原本的作法是在 CI 上重新 esbuild 一次、比對輸出位元組。那等於要求
// 每台機器的 esbuild 產生完全相同的輸出，實測不成立（同一個 commit 在三個環境得到
// 三個 hash），於是紅燈講的是「你的 esbuild 跟我的不一樣」而不是「你忘了重新打包」。
// 現在改成比對來源指紋，見 src/bundleFingerprint.mjs。
//
//   npm run bundle:check -w signal-api     # 不一致 → exit 1
import { readFile, access } from "node:fs/promises";

import { fingerprintSources } from "./src/bundleFingerprint.mjs";

const OUT = "api/index.js";
const MANIFEST = "api/.bundle-sources.json";

try {
  await access(OUT);
} catch {
  console.error(`::error::${OUT} 不存在 —— 請跑 npm run bundle:vercel 並 commit。`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
} catch {
  console.error(
    `::error::${MANIFEST} 不存在或不是合法 JSON —— 請跑 \`npm run bundle:vercel -w signal-api\` 後把 ` +
      `${OUT} 與 ${MANIFEST} 一起 commit。`,
  );
  process.exit(1);
}

const fresh = await fingerprintSources("src");

if (fresh.digest !== manifest.digest) {
  // 指出「哪幾個檔案變了」,而不是只丟兩個對不起來的 hash —— 後者只能告訴你
  // 「有東西不對」,不能告訴你要看哪裡。
  const changed = Object.keys(fresh.files).filter((f) => fresh.files[f] !== manifest.files?.[f]);
  const removed = Object.keys(manifest.files ?? {}).filter((f) => !(f in fresh.files));
  console.error(
    `::error::${OUT} 不是從目前的 src/*.ts 打包出來的（manifest ${manifest.digest} ≠ 現在 ${fresh.digest}）。\n` +
      (changed.length ? `新增或修改：${changed.join(", ")}\n` : "") +
      (removed.length ? `已刪除：${removed.join(", ")}\n` : "") +
      "Vercel 服務的是這個 commit 進 repo 的 bundle，沒有 build step —— " +
      "請跑 `npm run bundle:vercel -w signal-api` 後把 api/index.js 與 api/.bundle-sources.json 一起 commit。",
  );
  process.exit(1);
}

console.log(`✓ ${OUT} 與 src/ 同步（${fresh.digest}）`);
```

- [ ] **Step 7: 把 .ts 釘成 LF**

編輯 `.gitattributes`，在 `*.yaml text eol=lf` 那一組後面加上：

```gitattributes
# TypeScript 來源:bundle 的來源指紋會讀這些檔案的內容,CRLF/LF 混用會讓同一份
# 原始碼在 Windows 與 Linux 得到不同答案。指紋函式本身也做換行正規化,兩層保險。
*.ts text eol=lf
```

- [ ] **Step 8: 重新打包並自我驗證**

```bash
cd agent/signal-api
npm run bundle:vercel
npm run bundle:check
```

Expected: `✓ wrote api/.bundle-sources.json (…)` 然後 `✓ api/index.js 與 src/ 同步（…）`。

- [ ] **Step 9: 驗證它真的抓得到「忘記重新打包」**

```bash
cd agent/signal-api
printf '\n// tamper\n' >> src/symbols.ts
npm run bundle:check
```

Expected: **exit 1**，訊息包含 `新增或修改：symbols.ts`。確認後還原：

```bash
git checkout -- src/symbols.ts
npm run bundle:check   # 應該回到 ✓
```

- [ ] **Step 10: 把新測試接進 agent 的測試指令**

編輯 `agent/package.json` 的第 27 行，把：

```json
    "test:signal-api": "tsx signal-api/src/benchmarks.test.ts"
```

改成：

```json
    "test:signal-api": "tsx signal-api/src/benchmarks.test.ts && node --test signal-api/src/bundleFingerprint.test.mjs"
```

（第 22 行的 `test` 已經串了 `test:signal-api`，不需要另外改。）

- [ ] **Step 11: 跑 agent 全套**

```bash
cd agent
npm test
```

Expected: 全部通過，最後看到 `bundleFingerprint.test.mjs` 的 `# pass 6`。

- [ ] **Step 12: Commit**

```bash
git add agent/signal-api/src/bundleFingerprint.mjs \
        agent/signal-api/src/bundleFingerprint.test.mjs \
        agent/signal-api/build-vercel.mjs \
        agent/signal-api/check-vercel-bundle.mjs \
        agent/signal-api/api/index.js \
        agent/signal-api/api/.bundle-sources.json \
        agent/package.json .gitattributes
git commit -m "fix(signal-api): bundle 同步檢查改比來源指紋,不再重建後比位元組

原本的 bundle:check 在 CI 上重新 esbuild 一次,拿輸出的 sha256 去比 commit 進
repo 的 api/index.js。那要求每台機器的 esbuild 產生位元組相同的輸出,實測不成立:
同一個 commit,本機 esbuild 0.24.2 得到 71fde29ee445c7cf、0.28.1 得到
0f40bd349edc2f2a、GitHub Actions 得到 945cfee402b45c74。於是 CI 紅燈講的是「你的
esbuild 跟我的不一樣」,而不是這個檢查真正要防的「你改了 src 卻忘記重新打包」。

改成打包時寫出 api/.bundle-sources.json(每個 src/*.ts 的內容雜湊 + 總指紋),
check 比對指紋。與工具鏈版本無關,而且失敗時直接列出是哪幾個檔案變了。換行做
正規化、路徑統一用 /、檔名排序後才組合,跨平台一致;.gitattributes 另外把 *.ts
釘成 LF 當第二層保險。已用「附加一行到 symbols.ts」反證它抓得到漂移。"
```

---

## Task 3: 合併 PR #91 並確認正式站部署

**Files:** 無程式碼變更。

**Interfaces:**
- Consumes: Task 1 與 Task 2 的成果（兩個 CI 檢查轉綠）
- Produces: `master` 上線的正式站，含 7 天掃描視窗、RWA 定位、無槓桿介面

**背景：** 這一步是整個計畫的目的。在它完成之前，正式站跑的仍是 27 小時視窗的舊前端，領獎台會週期性變空。

- [ ] **Step 1: 推上修好的 commits**

```bash
git push
```

- [ ] **Step 2: 等 CI 並確認全綠**

```bash
gh pr checks 91 --watch
```

Expected: `npm test`、`forge build + test`、`yarn build`、`slither`、`gas snapshot` 全部 pass。若 `gas snapshot` 因為 Task 1 的容差改動而報 gas 位移，依它的提示更新 `.gas-snapshot` 後 commit。

- [ ] **Step 3: 合併**

```bash
gh pr merge 91 --merge
```

Expected: PR 狀態變 MERGED。（若此指令被權限規則擋下，請在 GitHub PR 頁面按 Merge。）

- [ ] **Step 4: 等 Vercel 部署完成**

```bash
gh run list --branch master --limit 5 --json workflowName,conclusion,status
```

並在 https://vercel.com/zuemens-projects/pepelab-onchain-cfd 確認 Production 部署是新的 commit。

- [ ] **Step 5: 確認線上拿到的是新前端**

開 https://pepelab-onchain-cfd.vercel.app/marketplace，捲到頁尾，確認那行字寫的是**實際掃描量與換算後的時間**（約 `302,401 個區塊（約 7.0 天）`），而不是舊版寫死的「~50,000 個區塊（約 7 天）」。這是最快分辨新舊版本的方法。

- [ ] **Step 6: 無需 commit**（本任務不改程式碼）

---

## Task 4: 補種平倉並在正式站驗收領獎台

**Files:** 無程式碼變更。使用既有的 `contracts/script/SeedWhaleCloses.s.sol`。

**Interfaces:**
- Consumes: Task 3 部署完成的正式站
- Produces: 正式站領獎台上有三位交易者

**背景：** 8/28 已經跑過一次，ESG Master / Tesla Maxi / Macro Trader 各有 5 筆平倉（3 勝 2 敗，總損益為正）。那批平倉在 block 46063334 附近。部署新前端後視窗變成 7 天（302,400 塊），那批資料**還在視窗內**，理論上不必重跑。這個任務是驗收；只有在驗收不過時才重跑腳本。腳本是可重複執行的（第二次跑會開新的 5 筆再平掉）。

- [ ] **Step 1: 先算現在的平倉還在不在 7 天視窗內**

```bash
export PATH="$HOME/.foundry/bin:$PATH"
set -a; . agent/.env; set +a
HEAD=$(cast block-number --rpc-url "$BASE_SEPOLIA_RPC_URL")
echo "head=$HEAD  7天視窗起點=$((HEAD-302400))  最後一批平倉≈46063334"
```

Expected: `46063334` 大於視窗起點 → 資料仍在視窗內，跳到 Step 3。

- [ ] **Step 2: （只在 Step 1 判定資料已過期時）重跑種資料**

```bash
cd contracts
set -a; . ./.env.roles; . ../agent/.env; set +a
export ORACLE_OWNER_PK="$KEEPER_PK"
export EXCHANGE_ADDR=0xEf75ECA6514cE96B18382E921aC6190a0cF8c072
export USDC_ADDR=0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035
export ORACLE_ADDR=0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3
forge script script/SeedWhaleCloses.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" -vv        # 先模擬
forge script script/SeedWhaleCloses.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast --slow -vv
```

Expected: `ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`，且每位交易者印出 `closes landed this run: 5`。
**前置條件：** oracle 價格齡必須 < 6 小時（`maxPriceAge = 21600`），否則開倉與平倉都會 revert `StalePrice`。用 Step 3 的第一段指令先確認。

- [ ] **Step 3: 用鏈上事件驗收（不靠瀏覽器）**

```bash
export PATH="$HOME/.foundry/bin:$PATH"
set -a; . agent/.env; set +a
# 3a. oracle 新鮮度
NOW=$(date +%s)
for n in sBTC sETH; do
  H=$(cast keccak "$n")
  cast call 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 "getPrice(bytes32)(uint256,uint256)" $H \
    --rpc-url "$BASE_SEPOLIA_RPC_URL" > /tmp/p.txt
  U=$(sed -n 2p /tmp/p.txt | sed 's/ .*//')
  echo "$n age_h=$(( (NOW - U) / 3600 ))"
done
```

Expected: 兩個都 < 6。

- [ ] **Step 4: 在正式站肉眼驗收**

開 https://pepelab-onchain-cfd.vercel.app/marketplace 並連上錢包（Base Sepolia）。

Expected:
1. 載入時看得到「掃描鏈上事件… N/31」的進度字樣（約 12 秒）。
2. 領獎台出現 **Macro Trader / Tesla Maxi / ESG Master** 三位，勝率顯示 60% (5)。
3. 頁尾寫的是約 7 天，不是 27 小時。

同時抽查另外兩頁：
- `/`（首頁）：第一張功能卡是「代幣化 RWA 現貨」，看得到幣股金債四個指數，tagline 沒有 MemeFi。
- `/exchange`：**看不到任何槓桿倍數按鈕**。

- [ ] **Step 5: 無需 commit**（本任務不改程式碼）

---

## Task 5: 寫下 Demo 當天的 pre-flight 清單

**Files:**
- Create: `docs/RUNBOOK_DEMO_DAY.md`

**Interfaces:**
- Consumes: Task 4 驗收過的正式站
- Produces: 一份任何人照著跑就能在上台前確認系統是活的清單

**背景：** 這個系統有兩個會隨時間自己壞掉的地方——oracle 價格超過 6 小時就擋交易、平倉資料滑出 7 天視窗領獎台就變空。上台前十分鐘才發現來不及修，所以要有清單。

- [ ] **Step 1: 建立 runbook**

Create `docs/RUNBOOK_DEMO_DAY.md`:

````markdown
# Demo Day Pre-flight（上台前 30 分鐘執行）

這個系統有兩個會隨時間自己壞掉的地方，兩個都會在畫面上表現成「東西不見了」而不是報錯：

1. **Oracle 價格超過 6 小時**（`maxPriceAge = 21600`）→ 開倉與平倉一律 revert `StalePrice`，
   `/exchange` 與 `/terminal` 的下單按鈕會擋住。
2. **平倉資料滑出 7 天視窗** → `/marketplace` 的領獎台變空，顯示「還沒有交易者平倉滿 5 筆」。

## 1. Oracle 新鮮度（必查）

```bash
cd ~/pepelab_onchain_cfd
export PATH="$HOME/.foundry/bin:$PATH"
set -a; . agent/.env; set +a
NOW=$(date +%s)
for n in sBTC sETH sGOLD sBOND sAAPL sTSLA; do
  H=$(cast keccak "$n")
  cast call 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 "getPrice(bytes32)(uint256,uint256)" $H \
    --rpc-url "$BASE_SEPOLIA_RPC_URL" > /tmp/p.txt
  U=$(sed -n 2p /tmp/p.txt | sed 's/ .*//')
  echo "$n age_h=$(( (NOW - U) / 3600 ))"
done
```

全部要 **< 6**。若超過，keeper 掛了：到 GitHub Actions 手動觸發 `Base Sepolia Keeper` workflow。

## 2. 領獎台資格（必查）

```bash
HEAD=$(cast block-number --rpc-url "$BASE_SEPOLIA_RPC_URL")
echo "7 天視窗起點 = $((HEAD - 302400))"
```

到 https://pepelab-onchain-cfd.vercel.app/marketplace 連錢包直接看：三位交易者在不在領獎台上。
不在的話跑補種（需要 `contracts/.env.roles` 的 `SEED_MNEMONIC` 與 `KEEPER_PK`）：

```bash
cd contracts
set -a; . ./.env.roles; . ../agent/.env; set +a
export ORACLE_OWNER_PK="$KEEPER_PK"
export EXCHANGE_ADDR=0xEf75ECA6514cE96B18382E921aC6190a0cF8c072
export USDC_ADDR=0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035
export ORACLE_ADDR=0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3
forge script script/SeedWhaleCloses.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast --slow -vv
```

約 90 秒跑完，36 筆交易。跑完重新整理 `/marketplace`。

## 3. 三頁抽查

| 頁面 | 要看到 |
|---|---|
| `/` | 第一張功能卡是「代幣化 RWA 現貨」；幣股金債四個指數有數字；tagline 沒有 MemeFi |
| `/marketplace` | 載入時有「掃描鏈上事件… N/31」；領獎台三位；頁尾寫約 7 天 |
| `/exchange` | **沒有任何槓桿倍數按鈕**；Get Test Tokens 卡在 |

## 4. 講稿裡的三個數字（講錯會被抓）

- 平台保證金畫面上叫 **USDC**（合約 symbol 也是 USDC，`name()` 是 Mock USD Coin）；
  x402 付費用的是 **Circle USDC**，兩者是不同地址，講的時候不要省略「Circle」。
- 加密貨幣 K 線的報價來源是 **Coinbase BTC-USD 現貨**（Bybit 永續是 fallback）。
- 《虛擬資產服務法》2026/6/30 三讀通過：母法規範托管型服務，**衍生性商品未納入主文**
  （金管會附帶決議一年內提辦法與時程），**股票代幣與 RWA 保留發展空間**。
  這是「我們先做現貨、把槓桿收起來」的正當理由——是合規判斷，不是功能沒做完。
````

- [ ] **Step 2: 照著 runbook 實際跑一次第 1 節**

```bash
cd ~/pepelab_onchain_cfd
export PATH="$HOME/.foundry/bin:$PATH"
set -a; . agent/.env; set +a
NOW=$(date +%s)
for n in sBTC sETH sGOLD sBOND sAAPL sTSLA; do
  H=$(cast keccak "$n")
  cast call 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 "getPrice(bytes32)(uint256,uint256)" $H \
    --rpc-url "$BASE_SEPOLIA_RPC_URL" > /tmp/p.txt
  U=$(sed -n 2p /tmp/p.txt | sed 's/ .*//')
  echo "$n age_h=$(( (NOW - U) / 3600 ))"
done
```

Expected: 六個資產都印出 `age_h=` 且數字 < 6。指令有錯就當場修 runbook——一份跑不動的清單比沒有清單更糟。

- [ ] **Step 3: Commit**

```bash
git add docs/RUNBOOK_DEMO_DAY.md
git commit -m "docs: 新增 Demo Day pre-flight 清單

這個系統有兩個會隨時間自己壞掉、而且壞掉時只表現成「東西不見了」的地方:
oracle 價格超過 6 小時會擋住所有開平倉,平倉資料滑出 7 天視窗會讓領獎台變空。
兩個都不會報錯,上台前十分鐘才發現就來不及了。清單裡的指令都實際跑過。"
```

---

## 不做的事（以及為什麼）

這一節是計畫的一部分：避免執行者「順手」把它們做掉。

- **嵌 TradingView widget。** 評審那句「TradingView 畫面建議用 Coinbase 的 BTC Spot USD 報價為準」的重點是**報價基準**，已經改了（`agent/signal-api/src/candles.ts` 首選 Coinbase 現貨）。為了長得像 TradingView 而在 demo 前引入外部 script 依賴，是拿當天的穩定性換外觀。
- **TraderScore 加風險分數 / 資產分散度欄。** 會動到剛修好、剛種完資料的排行榜排序，且需要新的測試。離 demo 兩天，風險大於收益。評審第 7 點（交易英雄榜）已經滿足。
- **重新部署合約把 MockUSDC 的 symbol 換成 USDC。** 原始碼已經改好，但已部署的實例仍是 `mUSDC`，要換就得重新部署整套並清掉現有餘額與部位。畫面上一律顯示 USDC，只有進 BaseScan 或把代幣加進錢包才看得到差異。Demo 前不值得。
- **`/tokens` 加儲備率卡。** 已經有了——`reserveRatioBps()` 顯示在 health 區塊，含「低於下限拒絕 mint」的說明。要做的只是在 demo 時記得講它。

---

## 與程式無關但有期限的事

主辦方要求回覆 8/31 Demo Day 的出席方式（上台但不計分／只當來賓／不出席），**期限是 8/29，也就是今天**。這件事不在任何一個 Task 裡，但它決定上面所有工作有沒有舞台。
