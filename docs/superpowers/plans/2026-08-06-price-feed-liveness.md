# 價格供給鏈修復與誠實化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 Base Sepolia 與 Sepolia 的鏈上價格重新持續更新、讓喂價失敗一定會被看見、並且讓前端與 x402 付費 API 不再把過期價格當成即時價格販售或下單。

**Architecture:** 把目前散落在三份互相漂移的實作(`.github/workflows/*.yml` 的 bash、`scripts/priceKeeper.ts`、`frontend/price_keeper.cjs`)的喂價邏輯,抽成一份「純函式核心 + 薄 I/O 外殼」的 TypeScript keeper,放在既有的 `agent/` npm workspace 底下,讓資料驗證、更新判斷、GuardedOracle 分段逼近這三件會出錯的事第一次可以被單元測試覆蓋。兩個 workflow 改成呼叫同一支 CLI,寫入 0 筆時以非零 exit code 讓 CI 變紅。消費端(前端、x402 API)改成以合約自己的 `maxPriceAge()` 作為新鮮度真相,過期就明確拒絕,而不是靜默顯示或靜默收費。

**Tech Stack:** TypeScript 5.6 + tsx(agent workspace,ESM)、ethers v6、node:assert(agent 既有測試慣例)、Foundry(contracts)、Vite + React 18 + vitest(frontend)、GitHub Actions、Hono + x402-hono(signal-api)。

## Global Constraints

- 本 repo 的預設分支是 **`master`**,不是 `main`。所有 workflow 的 `push.branches` 必須是 `[master]`。
- `agent/` 是 npm workspace,依賴裝在 `agent/node_modules`。**repo 根目錄沒有 `package.json` 也沒有 `node_modules`**,所以任何需要 `ethers` 的腳本都必須放在 `agent/` 底下,並以 `cd agent && npx tsx <path>` 執行。
- agent 的測試慣例是**純 `node:assert` 腳本**,沒有測試框架,執行方式是 `npx tsx <file>.test.ts`(見既有的 `agent/examples/edge-policy.test.ts`)。新增測試沿用這個慣例,不要引入 mocha/jest。
- `frontend/` 是 **yarn-only**(有 `yarn.lock`,`package.json` 無 `test` script、無測試框架)。Task 6 會新增 vitest。
- 所有資產 id 一律用 `ethers.id(symbol)` 現算(等同 workflow 裡的 `cast keccak "$SYM"`),**不得再新增任何硬編碼的 assetId 對照表** —— 目前三份實作各自抄一份是漂移的來源之一。
- 價格一律 **8 位小數**(`MockOracle` / `GuardedOracle` 的慣例),鏈上數值用 `bigint` 運算,禁止用 `number` 做 8 位小數的取捨判斷。
- 「拒絕」優於「夾擠」:任何無法驗證的來源讀數一律跳過並記錄,**不得** clamp 成一個編造的數字。這是 `GuardedOracle.updatePrice` 已經採用的原則,keeper 必須一致。
- 資產符號清單(11 個,順序固定):`sBTC, sETH, sAAPL, sTSLA, sNVDA, sMSFT, sGOOGL, sGOLD, sBOND, sICLN, sESGU`。
- 線上實測基準(2026-08-06 02:25 UTC,供驗收比對):Base Sepolia MockOracle `0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3` 全部資產 age 9.5–44 天;Sepolia MockOracle `0x17CA20A37Cf04F2f589B2573EC95f1411D29d958` age 約 90 分鐘;Sepolia GuardedOracle `0x32A19D04ef2ca5A7DA02Df39419729fA745749A1` 的 `getPrice` **全部 revert `StalePrice`**。

## 已驗證的問題清單(本計畫要解掉的)

| # | 問題 | 證據 |
|---|---|---|
| 1 | Base Sepolia keeper 完全沒有寫入 | 11 個資產 age 9.5–44 天;CI log `gas required exceeds allowance (0)` |
| 2 | keeper 錢包 `0x540aECD3…ef17` 在 Base Sepolia 餘額 0,且不是該鏈 MockOracle 的 owner(owner 是 `0xE80A8136…Eb93`) | `cast balance` / `cast call owner()` |
| 3 | `base-sepolia-keeper.yml` 寫 0 筆仍回報 success | 最近 6 次排程全 success,耗時 14–33 秒 |
| 4 | Base 版仍用已死的 stooq,且缺少 Sepolia 版的非數值防護 | CI log 顯示 `real=$<meta charset=utf-8><title>Stooq</title>… -> 0` |
| 5 | GuardedOracle 偏離上限死鎖,keeper 永遠追不上 | sBTC 卡在 $73,468(mock $64,578,−12.1%)9.5 天;sMSFT 卡在 $389.10(mock $487.46,+25.3%)4.9 天 |
| 6 | GuardedOracle `maxPriceAge`(1h)小於 GitHub cron 的真實節奏(實測 68–169 分鐘) | 最近 12 次排程時間戳 |
| 7 | 前端丟棄 `updatedAt`,把 9.5 天前的價格顯示成綠色 live | `frontend/src/hooks/useLivePrices.ts:103` 只取 `raw[0]` |
| 8 | x402 `/oracle/:asset` 賣的是 Base Sepolia 的過期價,且 `isStale` 門檻(24h)是交易所 `maxPriceAge`(6h)的 4 倍 | `agent/shared/src/aggregate.ts:200` 用 `MockOracle.isStale` |
| 9 | 402 回應的 `resource` 是 `http://` | 實測 402 body |
| 10 | `contracts-ci.yml` / `frontend-ci.yml` 的 push trigger 綁 `main`,而預設分支是 `master` | `gh repo view` + workflow YAML |
| 11 | `GuardedOracle._deviationExceeded` 以 `lo` 為分母,上漲容許 10%、下跌只容許 9.09% | `contracts/src/v2/GuardedOracle.sol:207-211` |

## Out of scope(建議另開計畫)

- **美股/ETF 的交易時段缺口**(週末以週五收盤價開槓桿倉、週一跳空由金庫買單)。這需要決定是「禁止交易」「標示收盤價」還是「加點差」,並且真正的合約層修法要動到 `immutable` 的 exchange,屬於獨立設計題。
- **Oracle adapter 去信任化**:`PythOracleAdapter` 忽略 `conf` 信賴區間、`ChainlinkOracleAdapter` 未檢查 `answeredInRound`、`AggregatorOracleAdapter` 單源時靜默降級、以及把 `GuardedOracle.referenceSource` 真正接上 aggregator。這是「讓 keeper 不再被信任」的方向,和本計畫「讓 keeper 活著且誠實」是不同子系統。
- **x402 分潤的資金流重構**(`payTo` 是 EOA、結算靠另一把私鑰自掏腰包)。本計畫只修正文案誠實度與失敗可見性,不改金流設計。
- **喂價來源的交叉驗證**。本計畫每個資產仍然只有一個來源(加密走 CoinGecko、股票走 Yahoo),`parseFeedValue` 擋得住「來源死掉回垃圾」,擋不住「來源還活著但回錯的數字」。要擋後者需要第二來源與偏離比對,屬於獨立設計題。
- **結算失敗的告警**。付費端點在 settlement 錢包沒錢時仍回 `ok:true` / `settled:false`,買方付了錢而分潤沒上鏈,目前沒有任何監控。本計畫只在 Task 8 修正文案讓這件事可被理解,不建監控。

---

## File Structure

**新增**
- `agent/keeper/core.ts` — 純函式:讀數驗證、更新判斷、偏離上限分段逼近。無 I/O、無 ethers。
- `agent/keeper/core.test.ts` — core 的 node:assert 測試。
- `agent/keeper/feeds.ts` — 純函式:CoinGecko / Yahoo 回應的欄位萃取(輸入是已 parse 的 JSON 或原始文字),外加一層薄的 `fetch` 包裝。
- `agent/keeper/feeds.test.ts` — 用真實記錄下來的回應(含 stooq 的 HTML 404)驗證萃取與拒絕。
- `agent/keeper/run.ts` — CLI 外殼:讀 env、組 provider、跑一輪、寫鏈、決定 exit code。
- `agent/keeper/health.ts` — CLI:只讀,印出每個資產的 age,超過門檻時 exit 1。
- `agent/shared/src/freshness.ts` — 供 x402 API 與 keeper 共用的新鮮度判斷純函式。
- `agent/examples/freshness.test.ts` — 上者的測試(沿用 examples/ 放測試的既有慣例)。
- `frontend/src/lib/pepefi/priceFreshness.ts` — 前端新鮮度純函式。
- `frontend/src/lib/pepefi/priceFreshness.test.ts` — vitest 測試。
- `frontend/vitest.config.ts` — vitest 設定。
- `.github/workflows/oracle-health.yml` — 獨立的價格年齡監控。
- `docs/RUNBOOK_KEEPER.md` — keeper 故障排除與復原手冊(含 Base Sepolia 這次的實際處置)。

**修改**
- `.github/workflows/base-sepolia-keeper.yml` — 改為呼叫 CLI,移除 bash 喂價邏輯。
- `.github/workflows/price-keeper.yml` — 同上。
- `.github/workflows/contracts-ci.yml` / `frontend-ci.yml` — push trigger 改 `master`。
- `frontend/src/hooks/useLivePrices.ts` — 保留 `updatedAt`,輸出 age 與 stale 旗標。
- `frontend/src/pages/pepefi/TradeTerminalPage.tsx` — 顯示年齡、過期時停用下單。
- `frontend/src/pages/pepefi/ExchangePage.tsx` — 同上。
- `frontend/package.json` — 新增 vitest 與 `test` script。
- `agent/shared/src/abis.ts` — `PERPETUAL_EXCHANGE_ABI` 補 `maxPriceAge()`。
- `agent/shared/src/aggregate.ts` — snapshot 帶上 age 與交易用新鮮度。
- `agent/signal-api/src/app.ts` — 付費牆前加新鮮度閘門;修正 `/` 的分潤文案。
- `agent/signal-api/src/vercel-entry.ts` — 修正 `resource` 的 scheme。
- `contracts/src/v2/GuardedOracle.sol` — 偏離上限對稱化。
- `contracts/test/v2/GuardedOracle.t.sol` — 對稱性測試。

**刪除**
- `frontend/price_keeper.cjs` — 漂移的重複實作,含硬編碼 Infura project id 與對股票的隨機漫步。
- `scripts/priceKeeper.ts` — 同上;且根目錄沒有 `node_modules`,它其實跑不起來。

---

### Task 1: keeper 純函式核心

這是整個計畫的地基:目前所有喂價 bug(死掉的來源被當成 0、夾擠出編造價格、偏離上限死鎖)都因為邏輯寫在 bash 裡而無法測試。

**Files:**
- Create: `agent/keeper/core.ts`
- Test: `agent/keeper/core.test.ts`

**Interfaces:**
- Consumes: 無(純函式,不依賴任何既有模組)
- Produces:
  - `parseFeedValue(raw: unknown): { value: number | null; reason: string }`
  - `toPrice8(usd: number): bigint`
  - `planUpdate(a: { target: number; current: number; lastUpdatedSec: number; nowSec: number; deviationThreshold: number; heartbeatSec: number }): { write: boolean; reason: string }`
  - `stepTowards(current8: bigint, target8: bigint, maxDeviationBps: bigint, safetyBps?: bigint): bigint`
  - `deviationAccepted(current8: bigint, next8: bigint, maxDeviationBps: bigint): boolean`

- [ ] **Step 1: 寫失敗的測試**

建立 `agent/keeper/core.test.ts`:

```ts
// 純函式測試：keeper 的資料驗證與偏離上限邏輯。
//   cd agent && npx tsx keeper/core.test.ts
import assert from "node:assert";
import {
  parseFeedValue,
  toPrice8,
  planUpdate,
  stepTowards,
  deviationAccepted,
} from "./core.ts";

// ── parseFeedValue：拒絕垃圾,不夾擠 ──────────────────────────────────────
assert.equal(parseFeedValue("64578.12").value, 64578.12);
assert.equal(parseFeedValue(" 311 ").value, 311);
assert.equal(parseFeedValue(311).value, 311);

// 這是 2026-07-27 真實把股價寫壞的那個回應：stooq 的 HTML 404。
const STOOQ_404 =
  '<meta charset=utf-8><title>Stooq</title><center style=font-family:arial>' +
  "<p style=font-size:x-large>The page you requested does not exist";
assert.equal(parseFeedValue(STOOQ_404).value, null);
assert.ok(parseFeedValue(STOOQ_404).reason.startsWith("non-numeric"));

assert.equal(parseFeedValue("").value, null);
assert.equal(parseFeedValue("N/D").value, null);
assert.equal(parseFeedValue("0").value, null);
assert.equal(parseFeedValue("-5").value, null);
assert.equal(parseFeedValue("NaN").value, null);
assert.equal(parseFeedValue(null).value, null);
assert.equal(parseFeedValue(undefined).value, null);

// ── toPrice8 ────────────────────────────────────────────────────────────
assert.equal(toPrice8(1), 100000000n);
assert.equal(toPrice8(64578.12), 6457812000000n);

// ── planUpdate ──────────────────────────────────────────────────────────
// 鏈上還沒有價格 → 一定要寫
assert.equal(
  planUpdate({ target: 100, current: 0, lastUpdatedSec: 0, nowSec: 1000, deviationThreshold: 0.001, heartbeatSec: 300 }).write,
  true,
);
// 偏離超過門檻 → 寫
assert.equal(
  planUpdate({ target: 101, current: 100, lastUpdatedSec: 990, nowSec: 1000, deviationThreshold: 0.001, heartbeatSec: 300 }).write,
  true,
);
// 偏離不足但超過 heartbeat → 寫
assert.equal(
  planUpdate({ target: 100, current: 100, lastUpdatedSec: 0, nowSec: 1000, deviationThreshold: 0.001, heartbeatSec: 300 }).write,
  true,
);
// 偏離不足且在 heartbeat 內 → 不寫
assert.equal(
  planUpdate({ target: 100, current: 100, lastUpdatedSec: 990, nowSec: 1000, deviationThreshold: 0.001, heartbeatSec: 300 }).write,
  false,
);

// ── deviationAccepted：必須與 GuardedOracle._deviationExceeded 同義 ──────
// 合約條件:(hi-lo)*10000 > bps*lo 即拒絕。
assert.equal(deviationAccepted(100n, 110n, 1000n), true);   // 上漲剛好 10%,可過
assert.equal(deviationAccepted(100n, 111n, 1000n), false);
assert.equal(deviationAccepted(100n, 90n, 1000n), false);   // 下跌 10% 反而被拒(合約現況)
assert.equal(deviationAccepted(100n, 91n, 1000n), true);
assert.equal(deviationAccepted(0n, 500n, 1000n), true);     // 無前價 → 不限制
assert.equal(deviationAccepted(100n, 999n, 0n), true);      // cap 0 → 不限制

// ── stepTowards：目標在上限內就直接寫目標 ────────────────────────────────
assert.equal(stepTowards(100_00000000n, 101_00000000n, 1000n), 101_00000000n);

// ── stepTowards：解掉線上真實的死鎖(sBTC 向下、sMSFT 向上) ─────────────
// sBTC：GuardedOracle 卡在 $73,468,MockOracle 為 $64,578(−12.1%,超過 10% cap)。
const sbtcCurrent = 7346800000000n; // $73,468
const sbtcTarget = 6457800000000n;  // $64,578
const sbtcStep = stepTowards(sbtcCurrent, sbtcTarget, 1000n);
assert.ok(sbtcStep < sbtcCurrent, "應該往目標方向走");
assert.ok(sbtcStep > sbtcTarget, "一步走不到,應停在上限內");
assert.equal(deviationAccepted(sbtcCurrent, sbtcStep, 1000n), true, "這一步必須能被合約接受");

// sMSFT：卡在 $389.10,MockOracle 為 $487.46(+25.3%)。
const msftCurrent = 38910000000n;
const msftTarget = 48746000000n;
const msftStep = stepTowards(msftCurrent, msftTarget, 1000n);
assert.ok(msftStep > msftCurrent && msftStep < msftTarget);
assert.equal(deviationAccepted(msftCurrent, msftStep, 1000n), true);

// ── stepTowards：連續走幾輪必須收斂,而不是永遠卡住 ──────────────────────
let p = sbtcCurrent;
let rounds = 0;
while (p !== sbtcTarget && rounds < 20) {
  const next = stepTowards(p, sbtcTarget, 1000n);
  assert.equal(deviationAccepted(p, next, 1000n), true, `第 ${rounds} 輪被合約拒絕`);
  assert.notEqual(next, p, "不得原地踏步");
  p = next;
  rounds += 1;
}
assert.equal(p, sbtcTarget, "應在有限輪數內追上目標");
assert.ok(rounds <= 5, `收斂太慢:${rounds} 輪`);

console.log("core.test.ts ✓ all assertions passed");
```

- [ ] **Step 2: 執行測試,確認失敗**

```bash
cd agent && npx tsx keeper/core.test.ts
```

Expected: FAIL — `Cannot find module './core.ts'`

- [ ] **Step 3: 寫最小實作**

建立 `agent/keeper/core.ts`:

```ts
// Keeper 的純函式核心：資料驗證、更新判斷、偏離上限分段逼近。
// 這裡不做任何 I/O，也不 import ethers —— 這樣它才能被單元測試覆蓋。
//
// 為什麼存在：2026-07-27 stooq 開始回 HTML 404，而當時的 bash 守衛只檢查
// 空字串 / "N/D" / "0"，HTML 通過守衛、被 awk 強制轉成 0、再被下限夾擠成前價的
// 55%，每 15 分鐘複利一次。把這段邏輯搬進可測試的函式，是不讓同類錯誤再發生的
// 唯一辦法。

/** 只接受純數值字面量：任何 HTML、錯誤訊息、空值、零與負數一律拒絕。 */
const NUMERIC = /^[0-9]+(\.[0-9]+)?$/;

export interface ParsedFeed {
  value: number | null;
  reason: string;
}

export function parseFeedValue(raw: unknown): ParsedFeed {
  if (raw === null || raw === undefined) return { value: null, reason: "empty" };
  const s = String(raw).trim();
  if (s === "" || s === "N/D") return { value: null, reason: "empty" };
  if (!NUMERIC.test(s)) {
    return { value: null, reason: `non-numeric: ${s.slice(0, 40)}` };
  }
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) {
    return { value: null, reason: `non-positive: ${s}` };
  }
  return { value: n, reason: "ok" };
}

/** USD → 8 位小數整數（MockOracle / GuardedOracle 的慣例）。 */
export function toPrice8(usd: number): bigint {
  return BigInt(Math.round(usd * 1e8));
}

export interface UpdatePlan {
  write: boolean;
  reason: string;
}

/**
 * 是否該送出這筆更新。偏離門檻省 gas，heartbeat 保證合約端的
 * `maxPriceAge` 檢查不會因為價格沒動就過期。
 */
export function planUpdate(a: {
  target: number;
  current: number;
  lastUpdatedSec: number;
  nowSec: number;
  deviationThreshold: number;
  heartbeatSec: number;
}): UpdatePlan {
  if (a.current <= 0) return { write: true, reason: "seed (no on-chain price)" };

  const dev = Math.abs(a.target - a.current) / a.current;
  if (dev >= a.deviationThreshold) {
    return { write: true, reason: `deviation ${(dev * 100).toFixed(3)}%` };
  }

  const age = a.nowSec - a.lastUpdatedSec;
  if (age >= a.heartbeatSec) {
    return { write: true, reason: `heartbeat ${age}s` };
  }

  return {
    write: false,
    reason: `within band (dev ${(dev * 100).toFixed(3)}%, age ${age}s)`,
  };
}

/**
 * GuardedOracle.updatePrice 會用 `(hi-lo)*10000 > bps*lo` 判斷是否超出上限。
 * 注意分母是「兩者中較小的那個」，所以上下方向的容許幅度並不對稱：
 *   向上：new <= current * (1 + bps/10000)
 *   向下：new >= current * 10000 / (10000 + bps)
 * 這個函式必須與合約完全同義，否則 keeper 會送出注定被拒絕的交易。
 */
export function deviationAccepted(
  current8: bigint,
  next8: bigint,
  maxDeviationBps: bigint,
): boolean {
  if (maxDeviationBps === 0n || current8 === 0n) return true;
  const hi = next8 > current8 ? next8 : current8;
  const lo = next8 > current8 ? current8 : next8;
  return (hi - lo) * 10_000n <= maxDeviationBps * lo;
}

/**
 * 回傳「這一輪該寫進 GuardedOracle 的價格」。
 *
 * 目標在上限內就直接寫目標；超出上限則走到上限邊緣，下一輪再往前走一段。
 * 這是死鎖的解法：先前的 keeper 每次都寫全額目標價，一旦落後超過 cap 就
 * 每次都被 `DeviationTooLarge` 打回，於是永遠追不上（線上 sBTC 卡了 9.5 天、
 * sMSFT 卡了 4.9 天，最後只能由 admin 把 cap 設成 0 手動修正）。
 *
 * safetyBps 是留給「讀取與送出之間價格又動了」的緩衝，預設 50 bps。
 */
export function stepTowards(
  current8: bigint,
  target8: bigint,
  maxDeviationBps: bigint,
  safetyBps = 50n,
): bigint {
  if (maxDeviationBps === 0n || current8 === 0n) return target8;

  const bps =
    maxDeviationBps > safetyBps ? maxDeviationBps - safetyBps : maxDeviationBps;

  if (target8 > current8) {
    const max = current8 + (current8 * bps) / 10_000n;
    return target8 <= max ? target8 : max;
  }
  // 向下：整數除法會往下取整，取整後可能剛好跌破上限，故 +1n 保守修正。
  const min = (current8 * 10_000n) / (10_000n + bps) + 1n;
  return target8 >= min ? target8 : min;
}
```

- [ ] **Step 4: 執行測試,確認通過**

```bash
cd agent && npx tsx keeper/core.test.ts
```

Expected: PASS — 印出 `core.test.ts ✓ all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add agent/keeper/core.ts agent/keeper/core.test.ts
git commit -m "feat(keeper): testable core for feed validation and deviation stepping"
```

---

### Task 2: 價格來源萃取(把死掉的來源變成可測試的事實)

**Files:**
- Create: `agent/keeper/feeds.ts`
- Test: `agent/keeper/feeds.test.ts`

**Interfaces:**
- Consumes: `parseFeedValue` from `agent/keeper/core.ts`
- Produces:
  - `extractCoinGecko(json: unknown, id: string): { value: number | null; reason: string }`
  - `extractYahoo(json: unknown): { value: number | null; reason: string }`
  - `SOURCES: Record<string, { kind: "coingecko"; id: string } | { kind: "yahoo"; symbol: string }>`
  - `fetchPrice(symbol: string, fetchImpl?: typeof fetch): Promise<{ value: number | null; reason: string; source: string }>`

- [ ] **Step 1: 寫失敗的測試**

建立 `agent/keeper/feeds.test.ts`:

```ts
// 純函式測試：價格來源回應的萃取與拒絕。
//   cd agent && npx tsx keeper/feeds.test.ts
import assert from "node:assert";
import { extractCoinGecko, extractYahoo, SOURCES } from "./feeds.ts";

// ── CoinGecko simple/price ──────────────────────────────────────────────
assert.equal(extractCoinGecko({ bitcoin: { usd: 64578 } }, "bitcoin").value, 64578);
assert.equal(extractCoinGecko({ bitcoin: {} }, "bitcoin").value, null);
assert.equal(extractCoinGecko({}, "bitcoin").value, null);
// 速率限制時 CoinGecko 回的是錯誤物件，不是價格。
assert.equal(
  extractCoinGecko({ status: { error_code: 429, error_message: "rate limited" } }, "bitcoin").value,
  null,
);

// ── Yahoo chart ─────────────────────────────────────────────────────────
const YAHOO_OK = {
  chart: { result: [{ meta: { regularMarketPrice: 311.0, regularMarketTime: 1785977652 } }] },
};
assert.equal(extractYahoo(YAHOO_OK).value, 311);

// Yahoo 沒有 UA 時回 401，body 是錯誤物件而非圖表。
const YAHOO_401 = { finance: { error: { code: "Unauthorized", description: "Invalid Crumb" } } };
assert.equal(extractYahoo(YAHOO_401).value, null);

// 有結構但沒有價格 —— 這是最危險的一種：型別對、內容缺。
assert.equal(extractYahoo({ chart: { result: [{ meta: {} }] } }).value, null);
assert.equal(extractYahoo({ chart: { result: [] } }).value, null);
assert.equal(extractYahoo({ chart: { result: null } }).value, null);

// 若來源整個換成 HTML（stooq 的死法），parse 之前就會炸，這裡確認我們接得住。
assert.equal(extractYahoo("<html>404</html>").value, null);

// ── SOURCES：11 個資產一個都不能少,且不得再出現硬編碼 assetId ────────────
const EXPECTED = ["sBTC","sETH","sAAPL","sTSLA","sNVDA","sMSFT","sGOOGL","sGOLD","sBOND","sICLN","sESGU"];
assert.deepEqual(Object.keys(SOURCES).sort(), [...EXPECTED].sort());
// 沒有任何資產可以落到「隨機漫步」——那是被刪掉的舊行為。
for (const [sym, src] of Object.entries(SOURCES)) {
  assert.ok(src.kind === "coingecko" || src.kind === "yahoo", `${sym} 來源不明`);
}

console.log("feeds.test.ts ✓ all assertions passed");
```

- [ ] **Step 2: 執行測試,確認失敗**

```bash
cd agent && npx tsx keeper/feeds.test.ts
```

Expected: FAIL — `Cannot find module './feeds.ts'`

- [ ] **Step 3: 寫最小實作**

建立 `agent/keeper/feeds.ts`:

```ts
// 價格來源：CoinGecko（加密）+ Yahoo chart（股票 / ETF / 黃金）。
//
// stooq 已於 2026-07-27 起對所有 symbol 回 HTML 404，且沒有恢復跡象，故完全移除，
// 不留 fallback —— 一個永遠失敗的 fallback 只會讓日誌變吵，並讓人以為還有第二來源。
//
// 萃取邏輯與網路呼叫分離：extract* 是純函式，可以拿真實壞掉的回應直接測試。
import { parseFeedValue, type ParsedFeed } from "./core.ts";

export type Source =
  | { kind: "coingecko"; id: string }
  | { kind: "yahoo"; symbol: string };

export const SOURCES: Record<string, Source> = {
  sBTC: { kind: "coingecko", id: "bitcoin" },
  sETH: { kind: "coingecko", id: "ethereum" },
  sAAPL: { kind: "yahoo", symbol: "AAPL" },
  sTSLA: { kind: "yahoo", symbol: "TSLA" },
  sNVDA: { kind: "yahoo", symbol: "NVDA" },
  sMSFT: { kind: "yahoo", symbol: "MSFT" },
  sGOOGL: { kind: "yahoo", symbol: "GOOGL" },
  sGOLD: { kind: "yahoo", symbol: "GC=F" },
  sBOND: { kind: "yahoo", symbol: "TLT" },
  sICLN: { kind: "yahoo", symbol: "ICLN" },
  sESGU: { kind: "yahoo", symbol: "ESGU" },
};

export function extractCoinGecko(json: unknown, id: string): ParsedFeed {
  if (typeof json !== "object" || json === null) {
    return { value: null, reason: "coingecko: non-object response" };
  }
  const entry = (json as Record<string, unknown>)[id];
  if (typeof entry !== "object" || entry === null) {
    return { value: null, reason: `coingecko: no entry for ${id}` };
  }
  return parseFeedValue((entry as Record<string, unknown>).usd);
}

export function extractYahoo(json: unknown): ParsedFeed {
  if (typeof json !== "object" || json === null) {
    return { value: null, reason: "yahoo: non-object response" };
  }
  const chart = (json as Record<string, unknown>).chart;
  if (typeof chart !== "object" || chart === null) {
    return { value: null, reason: "yahoo: no chart field" };
  }
  const result = (chart as Record<string, unknown>).result;
  if (!Array.isArray(result) || result.length === 0) {
    return { value: null, reason: "yahoo: empty result" };
  }
  const meta = (result[0] as Record<string, unknown> | undefined)?.meta;
  if (typeof meta !== "object" || meta === null) {
    return { value: null, reason: "yahoo: no meta" };
  }
  return parseFeedValue((meta as Record<string, unknown>).regularMarketPrice);
}

/** 網路取價。任何失敗都回 value:null，永遠不丟例外、永遠不編造數字。 */
export async function fetchPrice(
  symbol: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ParsedFeed & { source: string }> {
  const src = SOURCES[symbol];
  if (!src) return { value: null, reason: `unknown symbol ${symbol}`, source: "none" };

  try {
    if (src.kind === "coingecko") {
      const res = await fetchImpl(
        `https://api.coingecko.com/api/v3/simple/price?ids=${src.id}&vs_currencies=usd`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok) {
        return { value: null, reason: `coingecko HTTP ${res.status}`, source: "coingecko" };
      }
      return { ...extractCoinGecko(await res.json(), src.id), source: "coingecko" };
    }

    // Yahoo 的 chart 端點沒有瀏覽器 User-Agent 會回 401。
    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/` +
      `${encodeURIComponent(src.symbol)}?interval=1d&range=1d`;
    const res = await fetchImpl(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { value: null, reason: `yahoo HTTP ${res.status}`, source: "yahoo" };
    }
    return { ...extractYahoo(await res.json()), source: "yahoo" };
  } catch (e) {
    return { value: null, reason: `fetch failed: ${(e as Error).message}`, source: src.kind };
  }
}
```

- [ ] **Step 4: 執行測試,確認通過**

```bash
cd agent && npx tsx keeper/feeds.test.ts
```

Expected: PASS — 印出 `feeds.test.ts ✓ all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add agent/keeper/feeds.ts agent/keeper/feeds.test.ts
git commit -m "feat(keeper): tested feed extractors, drop the dead stooq source"
```

---

### Task 3: keeper CLI(取代三份漂移的實作)

**Files:**
- Create: `agent/keeper/run.ts`
- Delete: `frontend/price_keeper.cjs`
- Delete: `scripts/priceKeeper.ts`

**Interfaces:**
- Consumes: `parseFeedValue` / `toPrice8` / `planUpdate` / `stepTowards` / `deviationAccepted`(Task 1)、`SOURCES` / `fetchPrice`(Task 2)
- Produces: CLI `cd agent && npx tsx keeper/run.ts`,exit code 0 = 有寫入或全部都在容忍帶內,exit code 1 = 有可用價格卻一筆都沒寫成功

- [ ] **Step 1: 寫實作**

這一步沒有單元測試 —— 它是薄的 I/O 外殼,所有會出錯的判斷都已經在 Task 1、2 被覆蓋。它的驗收在 Step 2 的 dry-run。

建立 `agent/keeper/run.ts`:

```ts
// Keeper CLI：把外部價格寫進 MockOracle，並把同一個值分段鏡射進 GuardedOracle。
//
// 取代三份互相漂移的舊實作：
//   - .github/workflows/*.yml 裡的 bash（無法測試，曾把股價寫成前價的 55%）
//   - scripts/priceKeeper.ts（repo 根目錄沒有 node_modules，其實跑不起來）
//   - frontend/price_keeper.cjs（對股票用 Math.random() 隨機漫步，且硬編碼 RPC 金鑰）
//
// 用法：
//   cd agent
//   KEEPER_CHAIN=base-sepolia npx tsx keeper/run.ts
//   KEEPER_CHAIN=base-sepolia DRY_RUN=1 npx tsx keeper/run.ts   # 只讀不寫
import { ethers } from "ethers";
import { toPrice8, planUpdate, stepTowards, deviationAccepted } from "./core.ts";
import { fetchPrice } from "./feeds.ts";

const SYMBOLS = [
  "sBTC", "sETH", "sAAPL", "sTSLA", "sNVDA",
  "sMSFT", "sGOOGL", "sGOLD", "sBOND", "sICLN", "sESGU",
] as const;

const DEVIATION_THRESHOLD = Number(process.env.KEEPER_DEVIATION ?? "0.001"); // 0.1%
const HEARTBEAT_SEC = Number(process.env.KEEPER_HEARTBEAT ?? "900");         // 15 分鐘
const DRY_RUN = process.env.DRY_RUN === "1";

const CHAIN = (process.env.KEEPER_CHAIN ?? "base-sepolia").trim();
const CHAIN_ID = CHAIN === "sepolia" ? 11155111 : 84532;

const RPC_URL = (process.env.KEEPER_RPC_URL ?? "").trim();
const PRIVATE_KEY = (process.env.KEEPER_PRIVATE_KEY ?? "").trim();
const ORACLE_ADDR = (process.env.KEEPER_ORACLE_ADDRESS ?? "").trim();
const GUARDED_ADDR = (process.env.KEEPER_GUARDED_ORACLE ?? "").trim();

if (!RPC_URL) {
  console.error("::error::KEEPER_RPC_URL 未設");
  process.exit(1);
}
if (!DRY_RUN && (!PRIVATE_KEY.startsWith("0x") || PRIVATE_KEY.length !== 66)) {
  console.error("::error::KEEPER_PRIVATE_KEY 未設或格式錯誤");
  process.exit(1);
}
if (!ethers.isAddress(ORACLE_ADDR)) {
  console.error("::error::KEEPER_ORACLE_ADDRESS 未設或不是合法地址");
  process.exit(1);
}

const ORACLE_ABI = [
  "function updatePrice(bytes32 assetId, uint256 newPrice) external",
  "function getPrice(bytes32 assetId) view returns (uint256 price, uint256 updatedAt)",
];
const GUARDED_ABI = [
  "function updatePrice(bytes32 assetId, uint256 newPrice) external",
  "function peek(bytes32 assetId) view returns (uint256 price, uint256 updatedAt, bool exists, bool frozen)",
  "function maxDeviationBps() view returns (uint256)",
];

async function main(): Promise<void> {
  // batchMaxCount:1 —— 公共節點對 JSON-RPC batch 的處理不穩，逐筆送最可靠。
  const provider = new ethers.JsonRpcProvider(
    RPC_URL,
    { chainId: CHAIN_ID, name: CHAIN },
    { batchMaxCount: 1, staticNetwork: true },
  );

  const onChainId = Number((await provider.getNetwork()).chainId);
  if (onChainId !== CHAIN_ID) {
    console.error(`::error::RPC 指向 chainId ${onChainId}，預期 ${CHAIN_ID}`);
    process.exit(1);
  }

  const signer = DRY_RUN ? null : new ethers.Wallet(PRIVATE_KEY, provider);

  // 沒油就直接停 —— 這正是 Base Sepolia keeper 靜默失敗 9.5 天的原因，
  // 當時每筆 cast send 都以 "gas required exceeds allowance (0)" 失敗，
  // 而 `|| echo` 把它吞掉，CI 依然全綠。
  if (signer) {
    const bal = await provider.getBalance(signer.address);
    console.log(`keeper ${signer.address} balance=${ethers.formatEther(bal)} ETH`);
    if (bal === 0n) {
      console.error(`::error::keeper 錢包在 ${CHAIN} 上餘額為 0，無法送出任何交易`);
      process.exit(1);
    }
  }

  const oracle = new ethers.Contract(ORACLE_ADDR, ORACLE_ABI, signer ?? provider);
  const guarded =
    GUARDED_ADDR && ethers.isAddress(GUARDED_ADDR)
      ? new ethers.Contract(GUARDED_ADDR, GUARDED_ABI, signer ?? provider)
      : null;
  const guardedCap: bigint = guarded ? await guarded.maxDeviationBps() : 0n;

  const nowSec = Math.floor(Date.now() / 1000);
  let wrote = 0;
  let failed = 0;
  let available = 0;   // 拿到合法價格的資產數
  let skipped = 0;     // 來源壞掉而跳過的資產數

  for (const symbol of SYMBOLS) {
    const assetId = ethers.id(symbol); // == cast keccak "$SYM"
    const feed = await fetchPrice(symbol);

    if (feed.value === null) {
      // 拒絕而不是夾擠：夾擠出來的價格讀者無法分辨真假。
      console.log(`${symbol.padEnd(6)} 來源無效，跳過 (${feed.source}: ${feed.reason})`);
      skipped += 1;
      continue;
    }
    available += 1;

    let current = 0;
    let lastUpdated = 0;
    try {
      const [raw, at] = (await oracle.getPrice(assetId)) as [bigint, bigint];
      current = Number(raw) / 1e8;
      lastUpdated = Number(at);
    } catch {
      // 資產還沒被 addAsset：current 留 0，planUpdate 會判為 seed。
    }

    const plan = planUpdate({
      target: feed.value,
      current,
      lastUpdatedSec: lastUpdated,
      nowSec,
      deviationThreshold: DEVIATION_THRESHOLD,
      heartbeatSec: HEARTBEAT_SEC,
    });

    const ageMin = lastUpdated > 0 ? ((nowSec - lastUpdated) / 60).toFixed(1) : "n/a";
    console.log(
      `${symbol.padEnd(6)} live=$${feed.value.toFixed(2).padStart(10)} ` +
      `chain=$${current.toFixed(2).padStart(10)} age=${ageMin}m → ${plan.write ? "WRITE" : "skip"} (${plan.reason})`,
    );

    if (!plan.write || DRY_RUN) continue;

    const price8 = toPrice8(feed.value);
    try {
      const tx = await oracle.updatePrice(assetId, price8);
      await tx.wait();
      wrote += 1;
      console.log(`  → MockOracle ✓ ${tx.hash}`);
    } catch (e) {
      failed += 1;
      console.error(`  → MockOracle ✗ ${(e as Error).message.slice(0, 140)}`);
      continue;
    }

    if (guarded) await mirror(guarded, assetId, symbol, price8, guardedCap);
  }

  console.log(`\navailable=${available} skipped=${skipped} wrote=${wrote} failed=${failed}`);

  // 有價格可寫卻一筆都沒成功 = keeper 壞了。這一定要讓 CI 變紅。
  if (available > 0 && wrote === 0 && failed > 0) {
    console.error(
      `::error::Keeper 寫入 0 筆（${failed} 筆失敗）。檢查簽章者權限與錢包餘額。`,
    );
    process.exit(1);
  }
  if (skipped === SYMBOLS.length) {
    console.error("::error::所有價格來源都無效 —— 來源可能已下線。");
    process.exit(1);
  }
  if (failed > 0) console.log(`::warning::寫入 ${wrote} 筆，${failed} 筆失敗。`);
}

/**
 * 把價格鏡射進 GuardedOracle，超出偏離上限時走一步而不是放棄。
 * 舊 keeper 每次都寫全額目標價，落後超過上限後就永遠被 DeviationTooLarge 打回。
 */
async function mirror(
  guarded: ethers.Contract,
  assetId: string,
  symbol: string,
  target8: bigint,
  cap: bigint,
): Promise<void> {
  try {
    const [price, , exists, frozen] = (await guarded.peek(assetId)) as [
      bigint, bigint, boolean, boolean,
    ];
    if (!exists) return;
    if (frozen) {
      console.log(`  → GuardedOracle 已凍結，略過鏡射`);
      return;
    }

    const next = stepTowards(price, target8, cap);
    if (next === price) {
      console.log(`  → GuardedOracle 已是目標值`);
      return;
    }
    if (!deviationAccepted(price, next, cap)) {
      // 到不了這裡；到了代表 stepTowards 與合約失去同步，必須大聲。
      console.error(`::error::${symbol} stepTowards 產生會被拒絕的值 ${next}（cap=${cap}）`);
      return;
    }

    const tx = await guarded.updatePrice(assetId, next);
    await tx.wait();
    const partial = next !== target8 ? "（分段逼近，下一輪繼續）" : "";
    console.log(`  → GuardedOracle ✓ ${next} ${partial}`);
  } catch (e) {
    console.log(`  → GuardedOracle 鏡射失敗：${(e as Error).message.slice(0, 120)}`);
  }
}

main().catch((e) => {
  console.error("::error::keeper 未預期地中止：", e);
  process.exit(1);
});
```

- [ ] **Step 2: 對 Sepolia 做 dry-run,確認讀得到鏈上狀態且不寫入**

```bash
cd agent && KEEPER_CHAIN=sepolia DRY_RUN=1 \
  KEEPER_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
  KEEPER_ORACLE_ADDRESS=0x17CA20A37Cf04F2f589B2573EC95f1411D29d958 \
  KEEPER_GUARDED_ORACLE=0x32A19D04ef2ca5A7DA02Df39419729fA745749A1 \
  npx tsx keeper/run.ts
```

Expected: 印出 11 行,每行都有 `live=$…`、`chain=$…`、`age=…m`。sBTC/sETH 來源是 CoinGecko、其餘是 Yahoo,**不得出現任何 "Random Walk"**。最後一行 `available=11 skipped=0 wrote=0 failed=0`,exit code 0。

- [ ] **Step 3: 刪掉兩份漂移的舊實作**

```bash
git rm frontend/price_keeper.cjs scripts/priceKeeper.ts
```

- [ ] **Step 4: 確認沒有殘留引用**

```bash
cd /c/Users/sanketsu/pepelab_onchain_cfd && grep -rn "price_keeper\|priceKeeper" --include="*.ts" --include="*.tsx" --include="*.yml" --include="*.md" --include="*.json" . | grep -v node_modules
```

Expected: 只剩 `docs/` 裡的歷史敘述。若 `docs/KNOWN_LIMITATIONS.md` 或 `docs/NEXT_STEPS.md` 提到 `priceKeeper.ts`,把該處改成 `agent/keeper/run.ts`。

- [ ] **Step 5: 記下必須輪替的憑證**

`frontend/price_keeper.cjs:49` 有一組硬編碼的 Infura project id
(`https://sepolia.infura.io/v3/7cdfb492…`)。**刪檔不會把它從 git 歷史裡移除**,
這個 repo 是公開的,所以該 project id 必須視為已外洩。

在 `docs/RUNBOOK_KEEPER.md`(Task 6 會建立;若尚未建立則先建一個只含此節的檔案)
加入:

```markdown
## 待輪替的憑證

- Infura project id `7cdfb4923cee46ed9238a5181e4e9a4d` —— 曾硬編碼在
  `frontend/price_keeper.cjs`,雖已刪檔,仍留在 git 歷史中。請到 Infura
  儀表板刪除該 project 或重置金鑰。刪除檔案不等於撤銷憑證。
```

- [ ] **Step 6: Commit**

```bash
git add agent/keeper/run.ts docs/
git commit -m "feat(keeper): single tested keeper CLI, delete two drifted copies

frontend/price_keeper.cjs 對 9 個非加密資產用 Math.random() 隨機漫步寫進同一顆
會結算的 oracle，並硬編碼了一組 Infura project id；scripts/priceKeeper.ts 放在
沒有 node_modules 的 repo 根目錄，實際上跑不起來。兩者的基準價還互相矛盾
（sNVDA 一邊 135、一邊 1100），正是 2026-07-27 那批錯誤種子價的來源。"
```

---

### Task 4: 兩個 keeper workflow 改用 CLI,並修正 CI 的分支觸發

**Files:**
- Modify: `.github/workflows/base-sepolia-keeper.yml`
- Modify: `.github/workflows/price-keeper.yml`
- Modify: `.github/workflows/contracts-ci.yml:9`
- Modify: `.github/workflows/frontend-ci.yml:8`

**Interfaces:**
- Consumes: `agent/keeper/run.ts` CLI 與其 env 介面(Task 3)
- Produces: 兩個排程 workflow,寫入 0 筆時 job 失敗

- [ ] **Step 1: 改寫 Base Sepolia keeper**

把 `.github/workflows/base-sepolia-keeper.yml` 整份換成:

```yaml
name: Base Sepolia Keeper

# 用 agent/keeper/run.ts（單一實作、有單元測試）刷新 MockOracle，並 crank
# settleFunding。
#
# 2026-08-06 之前這個 workflow 用一段行內 bash：每個 cast send 後面掛 `|| echo`，
# 於是 keeper 錢包餘額為 0、每筆交易在 gas estimation 就失敗的情況下，仍然連續
# 10 天回報 success，而鏈上價格停在 9.5–44 天前。現在寫入 0 筆會讓 job 失敗。
#
# Secrets:
#   BASE_SEPOLIA_RPC_URL   Base Sepolia RPC endpoint
#   KEEPER_PRIVATE_KEY     必須是 MockOracle 的 owner，且在 Base Sepolia 上有測試 ETH
on:
  schedule:
    # 名目 15 分鐘。GitHub 排程是 best-effort，實測真實間隔為 68–169 分鐘，
    # 所以下游的 maxPriceAge 必須以「約 90 分鐘」而不是 15 分鐘來設定。
    - cron: '*/15 * * * *'
  workflow_dispatch:

jobs:
  keep:
    runs-on: ubuntu-latest
    env:
      KEEPER_CHAIN: base-sepolia
      KEEPER_RPC_URL: ${{ secrets.BASE_SEPOLIA_RPC_URL }}
      KEEPER_PRIVATE_KEY: ${{ secrets.KEEPER_PRIVATE_KEY }}
      KEEPER_ORACLE_ADDRESS: "0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3"
      EXCHANGE: "0xEf75ECA6514cE96B18382E921aC6190a0cF8c072"
    steps:
      - uses: actions/checkout@v4

      - name: Fail fast when secrets are missing
        run: |
          set -euo pipefail
          if [ -z "${KEEPER_RPC_URL:-}" ] || [ -z "${KEEPER_PRIVATE_KEY:-}" ]; then
            echo "::error::缺少 BASE_SEPOLIA_RPC_URL 或 KEEPER_PRIVATE_KEY —— 喂價無法運作。"
            exit 1
          fi

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install agent deps
        working-directory: agent
        run: npm install --no-audit --no-fund

      - name: Refresh prices
        working-directory: agent
        run: npx tsx keeper/run.ts

      - name: Install Foundry
        uses: foundry-rs/foundry-toolchain@v1
        with:
          version: stable

      - name: Crank settleFunding
        run: |
          set -uo pipefail
          for SYM in sBTC sETH sAAPL sTSLA; do
            KEY=$(cast keccak "$SYM")
            if cast send "$EXCHANGE" "settleFunding(bytes32)" "$KEY" \
                 --rpc-url "$KEEPER_RPC_URL" --private-key "$KEEPER_PRIVATE_KEY" >/dev/null 2>&1; then
              echo "$SYM: funding settled"
            else
              echo "$SYM: funding interval 未到，略過"
            fi
          done
```

- [ ] **Step 2: 改寫 Sepolia keeper**

把 `.github/workflows/price-keeper.yml` 整份換成:

```yaml
name: Oracle Price Keeper (Sepolia)

# 與 Base Sepolia keeper 共用 agent/keeper/run.ts。GuardedOracle 的鏡射由 CLI
# 以分段逼近方式處理：超出 maxDeviationBps 時走一步而不是整筆放棄，避免像
# 2026-07-27 那樣一旦落後就永遠追不上、只能由 admin 把上限設成 0 手動修正。
on:
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:

jobs:
  update-prices:
    runs-on: ubuntu-latest
    env:
      KEEPER_CHAIN: sepolia
      KEEPER_RPC_URL: ${{ secrets.KEEPER_RPC_URL }}
      KEEPER_PRIVATE_KEY: ${{ secrets.KEEPER_PRIVATE_KEY }}
      KEEPER_ORACLE_ADDRESS: "0x17CA20A37Cf04F2f589B2573EC95f1411D29d958"
      KEEPER_GUARDED_ORACLE: "0x32A19D04ef2ca5A7DA02Df39419729fA745749A1"
    steps:
      - uses: actions/checkout@v4

      - name: Fail fast when secrets are missing
        run: |
          set -euo pipefail
          if [ -z "${KEEPER_RPC_URL:-}" ] || [ -z "${KEEPER_PRIVATE_KEY:-}" ]; then
            echo "::error::缺少 KEEPER_RPC_URL 或 KEEPER_PRIVATE_KEY —— 喂價無法運作。"
            exit 1
          fi

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install agent deps
        working-directory: agent
        run: npm install --no-audit --no-fund

      - name: Refresh prices (MockOracle + GuardedOracle mirror)
        working-directory: agent
        run: npx tsx keeper/run.ts
```

- [ ] **Step 3: 修正兩個 CI 的 push 分支**

`.github/workflows/contracts-ci.yml` 第 9 行與 `.github/workflows/frontend-ci.yml` 第 8 行:

```yaml
    branches: [master]
```

原本是 `[main]`,但這個 repo 的預設分支是 `master`(`gh repo view --json defaultBranchRef` 回 `master`),所以 push trigger 從來沒有觸發過 —— 和 keeper 一樣是「看起來有、實際上沒跑」。

- [ ] **Step 4: 本機驗證 YAML 可解析,且沒有殘留的 stooq**

```bash
cd /c/Users/sanketsu/pepelab_onchain_cfd
for f in .github/workflows/*.yml; do python -c "import yaml,sys;yaml.safe_load(open(sys.argv[1],encoding='utf-8'));print('ok',sys.argv[1])" "$f"; done
grep -rn "stooq" .github/workflows/ || echo "no stooq left ✓"
grep -rn "branches: \[main\]" .github/workflows/ || echo "no main-branch triggers left ✓"
```

Expected: 5 個 `ok`、`no stooq left ✓`、`no main-branch triggers left ✓`

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/
git commit -m "fix(ci): keepers call the tested CLI and fail loudly; CI triggers on master

base-sepolia-keeper 之前把每筆 cast send 的失敗用 || echo 吞掉，於是在 keeper
錢包沒油的情況下連續 10 天回報 success，而鏈上價格停在 9.5–44 天前。
contracts-ci / frontend-ci 的 push trigger 綁在 main，但預設分支是 master。"
```

---

### Task 5: 價格年齡監控(誰來看著 keeper)

即使 keeper 修好了,它下次死掉時仍然只有「job 變紅」這一個訊號,而 job 也可能根本沒被排到。這個 task 讓「鏈上價格過期」本身成為告警來源,與 keeper 是否執行無關。

**Files:**
- Create: `agent/keeper/health.ts`
- Create: `.github/workflows/oracle-health.yml`

**Interfaces:**
- Consumes: 無(只讀鏈)
- Produces: CLI `cd agent && npx tsx keeper/health.ts`,任何資產超過門檻即 exit 1

- [ ] **Step 1: 寫實作**

建立 `agent/keeper/health.ts`:

```ts
// 只讀的健康檢查：比對每個資產的鏈上 updatedAt 與交易所自己的 maxPriceAge。
//
// 為什麼獨立於 keeper：keeper 沒被排到、被 GitHub 靜默跳過、或整個 workflow 被
// 停用時，它自己不會發出任何訊號。這支腳本只看鏈上事實，所以上述任何一種失敗
// 都會被它抓到。
import { ethers } from "ethers";

const SYMBOLS = [
  "sBTC", "sETH", "sAAPL", "sTSLA", "sNVDA",
  "sMSFT", "sGOOGL", "sGOLD", "sBOND", "sICLN", "sESGU",
] as const;

const CHAIN = (process.env.KEEPER_CHAIN ?? "base-sepolia").trim();
const CHAIN_ID = CHAIN === "sepolia" ? 11155111 : 84532;
const RPC_URL = (process.env.KEEPER_RPC_URL ?? "").trim();
const ORACLE_ADDR = (process.env.KEEPER_ORACLE_ADDRESS ?? "").trim();
const EXCHANGE_ADDR = (process.env.KEEPER_EXCHANGE_ADDRESS ?? "").trim();

// 沒有 exchange 可問時的後備門檻：實測 GitHub 排程真實間隔 68–169 分鐘，
// 取 3 小時給兩次錯過排程的餘裕。
const FALLBACK_MAX_AGE_SEC = Number(process.env.HEALTH_MAX_AGE ?? "10800");

const ORACLE_ABI = [
  "function getPrice(bytes32 assetId) view returns (uint256 price, uint256 updatedAt)",
];
const EXCHANGE_ABI = ["function maxPriceAge() view returns (uint256)"];

async function main(): Promise<void> {
  if (!RPC_URL || !ethers.isAddress(ORACLE_ADDR)) {
    console.error("::error::需要 KEEPER_RPC_URL 與 KEEPER_ORACLE_ADDRESS");
    process.exit(1);
  }
  const provider = new ethers.JsonRpcProvider(
    RPC_URL, { chainId: CHAIN_ID, name: CHAIN }, { batchMaxCount: 1, staticNetwork: true },
  );

  let maxAge = FALLBACK_MAX_AGE_SEC;
  if (ethers.isAddress(EXCHANGE_ADDR)) {
    try {
      const exchange = new ethers.Contract(EXCHANGE_ADDR, EXCHANGE_ABI, provider);
      maxAge = Number(await exchange.maxPriceAge());
    } catch {
      console.log(`讀不到 exchange.maxPriceAge()，改用後備門檻 ${FALLBACK_MAX_AGE_SEC}s`);
    }
  }

  const oracle = new ethers.Contract(ORACLE_ADDR, ORACLE_ABI, provider);
  const now = Math.floor(Date.now() / 1000);
  const stale: string[] = [];

  console.log(`chain=${CHAIN} oracle=${ORACLE_ADDR} maxPriceAge=${maxAge}s`);
  for (const symbol of SYMBOLS) {
    try {
      const [price, at] = (await oracle.getPrice(ethers.id(symbol))) as [bigint, bigint];
      const age = now - Number(at);
      const bad = age > maxAge;
      if (bad) stale.push(`${symbol}(${(age / 3600).toFixed(1)}h)`);
      console.log(
        `${bad ? "STALE" : "  ok "} ${symbol.padEnd(6)} $${(Number(price) / 1e8).toFixed(2).padStart(10)} age=${(age / 3600).toFixed(1)}h`,
      );
    } catch (e) {
      stale.push(`${symbol}(unreadable)`);
      console.log(`STALE ${symbol.padEnd(6)} 讀取失敗：${(e as Error).message.slice(0, 80)}`);
    }
  }

  if (stale.length > 0) {
    console.error(
      `::error::${stale.length}/${SYMBOLS.length} 個資產超過 maxPriceAge：${stale.join(", ")}。` +
      `交易所會對這些資產 revert StalePrice —— 開倉、平倉、清算全部無法執行。`,
    );
    process.exit(1);
  }
  console.log("所有資產都在 maxPriceAge 之內 ✓");
}

main().catch((e) => {
  console.error("::error::健康檢查中止：", e);
  process.exit(1);
});
```

- [ ] **Step 2: 對 Base Sepolia 執行,確認它抓得到目前的故障**

```bash
cd agent && KEEPER_CHAIN=base-sepolia \
  KEEPER_RPC_URL=https://sepolia.base.org \
  KEEPER_ORACLE_ADDRESS=0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 \
  KEEPER_EXCHANGE_ADDRESS=0xEf75ECA6514cE96B18382E921aC6190a0cF8c072 \
  npx tsx keeper/health.ts; echo "exit=$?"
```

Expected: `maxPriceAge=21600s`,11 行全部標示 `STALE`,最後 `::error::11/11 個資產超過 maxPriceAge`,`exit=1`。這確認健康檢查對真實故障會叫。

- [ ] **Step 3: 建立監控 workflow**

建立 `.github/workflows/oracle-health.yml`:

```yaml
name: Oracle Health

# 獨立於 keeper 的鏈上事實檢查。keeper 沒被排到、被停用、或悄悄寫入 0 筆時，
# 它自己不會發出訊號；這個 job 只看鏈上的 updatedAt，所以上述任何一種都會被抓到。
# job 失敗會觸發 GitHub 對 repo 管理者的預設通知。
on:
  schedule:
    - cron: '0 */3 * * *'
  workflow_dispatch:

jobs:
  base-sepolia:
    runs-on: ubuntu-latest
    env:
      KEEPER_CHAIN: base-sepolia
      KEEPER_RPC_URL: ${{ secrets.BASE_SEPOLIA_RPC_URL }}
      KEEPER_ORACLE_ADDRESS: "0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3"
      KEEPER_EXCHANGE_ADDRESS: "0xEf75ECA6514cE96B18382E921aC6190a0cF8c072"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - working-directory: agent
        run: npm install --no-audit --no-fund
      - working-directory: agent
        run: npx tsx keeper/health.ts

  sepolia:
    runs-on: ubuntu-latest
    env:
      KEEPER_CHAIN: sepolia
      KEEPER_RPC_URL: ${{ secrets.KEEPER_RPC_URL }}
      KEEPER_ORACLE_ADDRESS: "0x17CA20A37Cf04F2f589B2573EC95f1411D29d958"
      HEALTH_MAX_AGE: "10800"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - working-directory: agent
        run: npm install --no-audit --no-fund
      - working-directory: agent
        run: npx tsx keeper/health.ts
```

- [ ] **Step 4: 驗證 YAML**

```bash
cd /c/Users/sanketsu/pepelab_onchain_cfd && python -c "import yaml;yaml.safe_load(open('.github/workflows/oracle-health.yml',encoding='utf-8'));print('ok')"
```

Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add agent/keeper/health.ts .github/workflows/oracle-health.yml
git commit -m "feat(keeper): chain-fact health check independent of the keeper job"
```

---

### Task 6: 復原 Base Sepolia 的寫入權(需要人工執行)

這個 task 的程式部分可以由 agent 完成,但**兩個實際動作需要私鑰,必須由人執行**。Agent 應該完成文件與驗證腳本,然後停下來要求人工執行,拿到 tx hash 後再把驗證結果補進文件。

**Files:**
- Create: `docs/RUNBOOK_KEEPER.md`

**Interfaces:**
- Consumes: `agent/keeper/health.ts`(Task 5)
- Produces: 一份可重複執行的復原程序 + 一份實測紀錄

- [ ] **Step 1: 寫 runbook**

建立 `docs/RUNBOOK_KEEPER.md`:

```markdown
# Keeper Runbook

## 症狀:交易所對所有資產 revert `StalePrice`

`PerpetualExchange` 的 `_freshPrice` / `_requireFresh` 會在
`block.timestamp > updatedAt + maxPriceAge` 時 revert,而**開倉、平倉、清算三條
路徑都會經過它**。所以喂價一停,不只不能開新倉 —— 已開的倉也關不掉、水下的倉也
清算不了。

用鏈上事實確認,不要看 CI 是不是綠的:

```bash
cd agent && KEEPER_CHAIN=base-sepolia \
  KEEPER_RPC_URL=https://sepolia.base.org \
  KEEPER_ORACLE_ADDRESS=0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 \
  KEEPER_EXCHANGE_ADDRESS=0xEf75ECA6514cE96B18382E921aC6190a0cF8c072 \
  npx tsx keeper/health.ts
```

## 2026-08-06 的事故:Base Sepolia 停擺 9.5 天

**現象**:11 個資產全部過期(加密 9.5 天、股票 44 天),`maxPriceAge` 為 6 小時,
`liquidatePosition(0)` 模擬回 `StalePrice(sBTC, 1785162620)`。CI 上的
`Base Sepolia Keeper` 連續 10 天回報 success,每次執行 14–33 秒。

**兩個各自獨立、都足以致命的原因**:

1. CI 使用的 keeper key `0x540aECD37E7A7885824e7b7e996eBddfb842ef17` 在 Base
   Sepolia 上餘額為 0 → 每筆 `updatePrice` 在 gas estimation 就失敗
   (`gas required exceeds allowance (0)`)。
2. 就算加了油也不行:Base Sepolia 的 `MockOracle.owner()` 是舊部署者
   `0xE80A81360608C1342e66743F70a00f75d792Eb93`,而 `updatePrice` 是
   `onlyOwner`。2026-07-27 的角色分離只在 Sepolia 轉移了 MockOracle 所有權。

**為什麼十天沒人發現**:workflow 每個 `cast send` 後面掛 `|| echo`,失敗被吞掉,
job 依然 success。已於 Task 4 修正 —— 現在寫入 0 筆會讓 job 失敗。

## 復原程序

以下兩步需要 `0xE80A8136…Eb93` 的私鑰,由人工執行。

**Step A — 給 keeper 加油**

```bash
cast send 0x540aECD37E7A7885824e7b7e996eBddfb842ef17 \
  --value 0.05ether \
  --rpc-url https://sepolia.base.org \
  --private-key $DEPLOYER_PK
```

**Step B — 把 Base Sepolia MockOracle 的所有權轉給 keeper**

```bash
cast send 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 \
  "transferOwnership(address)" 0x540aECD37E7A7885824e7b7e996eBddfb842ef17 \
  --rpc-url https://sepolia.base.org \
  --private-key $DEPLOYER_PK
```

**Step C — 驗證(不需要私鑰)**

```bash
cast call 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 "owner()(address)" \
  --rpc-url https://sepolia.base.org
cast balance 0x540aECD37E7A7885824e7b7e996eBddfb842ef17 --rpc-url https://sepolia.base.org
```

owner 應為 `0x540aECD3…ef17`,餘額應大於 0。

**Step D — 手動觸發 keeper 並確認**

```bash
gh workflow run base-sepolia-keeper.yml
gh run watch
```

然後重跑上面的 health check,應該全部 `ok`。

## 症狀:Sepolia 的 V2 金庫整個不能用

`AssetVaultV2.outstandingValue()` 直接呼叫 `GuardedOracle.getPrice`,而
GuardedOracle 是 fail-closed 的 —— 超過 `maxPriceAge` 就 revert `StalePrice`,
連帶 `reserveRatioBps()` 與 `mint()` 一起壞掉。

`GuardedOracle.maxPriceAge` 目前是 **3600 秒(1 小時)**,而 GitHub 排程的真實
間隔實測是 **68–169 分鐘**(2026-08-05 的 12 次排程)。也就是說這不是偶發過期,
而是**設定值小於實際節奏所導致的結構性過期** —— 即使 keeper 完全正常運作,
GuardedOracle 大部分時間仍然是 stale 的。

2026-08-06 02:25 UTC 實測:`getPrice` 對 sBTC / sMSFT / sAAPL 全部 revert。

**Step E — 把 maxPriceAge 調成符合真實節奏(需要 admin key
`0x2a588AeA3271B159c9188d95E0d10614711f83e3`)**

```bash
# 維持偏離上限 1000 bps 不變，只把 maxPriceAge 從 3600 改成 10800（3 小時），
# 給兩次錯過排程的餘裕。
cast send 0x32A19D04ef2ca5A7DA02Df39419729fA745749A1 \
  "setRiskParams(uint256,uint256)" 1000 10800 \
  --rpc-url $SEPOLIA_RPC --private-key $GUARDED_ADMIN_PK
```

驗證(不需要私鑰):

```bash
cast call 0x32A19D04ef2ca5A7DA02Df39419729fA745749A1 "maxPriceAge()(uint256)" --rpc-url $SEPOLIA_RPC
cast call 0x32A19D04ef2ca5A7DA02Df39419729fA745749A1 \
  "getPrice(bytes32)(uint256,uint256)" $(cast keccak "sAAPL") --rpc-url $SEPOLIA_RPC
```

`maxPriceAge` 應為 10800,`getPrice` 應回值而不是 revert。

**這是放寬,不是修好。** 真正的解法是讓喂價節奏可靠(不依賴 GitHub 排程),
在那之前把門檻設在低於實際節奏的位置,只會讓 V2 長期處於故障狀態而沒有任何
額外的安全收益 —— fail-closed 的價值在於「資料真的舊了就停下來」,不是在於
「因為排程被節流所以停下來」。

## 替代方案(若不想轉移所有權)

把 GitHub secret `KEEPER_PRIVATE_KEY` 改回部署者的私鑰。這樣 Base Sepolia 會立刻
恢復,但代價是回到「一把 key 同時持有資金與所有角色」,也就是 2026-07-27 角色分離
要解決的問題。轉移所有權才是與該次決定一致的做法。

## 為什麼股票在事故期間沒有被寫壞

Base 版 workflow 缺少 Sepolia 版的非數值防護,stooq 的 HTML 404 會被 `awk` 強制
轉成 0,理論上會寫 `updatePrice(key, 0)`。沒有寫壞是因為 `MockOracle` 自己拒收 0
(`InvalidPrice`)—— 那是意外,不是控制。Task 2 的 `parseFeedValue` 才是控制。
```

- [ ] **Step 2: 停下來,請人工執行 Step A、Step B、Step E**

Agent 在此停止並回報:「runbook 已就緒。Step A/B 需要部署者
`0xE80A81360608C1342e66743F70a00f75d792Eb93` 的私鑰(加油 + 轉移 Base Sepolia
MockOracle 所有權);Step E 需要 GuardedOracle 的 admin key
`0x2a588AeA3271B159c9188d95E0d10614711f83e3`(把 maxPriceAge 調成 3 小時)。
請執行後把三筆 tx hash 給我。」

- [ ] **Step 3: 人工執行後,驗證三件事都生效**

```bash
# A/B：Base Sepolia keeper 現在有油、而且是 oracle 的 owner
cast call 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 "owner()(address)" --rpc-url https://sepolia.base.org
cast balance 0x540aECD37E7A7885824e7b7e996eBddfb842ef17 --rpc-url https://sepolia.base.org
# E：Sepolia GuardedOracle 的門檻已符合真實排程節奏
cast call 0x32A19D04ef2ca5A7DA02Df39419729fA745749A1 "maxPriceAge()(uint256)" \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com
```

Expected: owner 為 `0x540aECD37E7A7885824e7b7e996eBddfb842ef17`、餘額 > 0、
`maxPriceAge` 為 `10800`

- [ ] **Step 4: 觸發 keeper 並確認鏈上恢復**

```bash
gh workflow run base-sepolia-keeper.yml && gh run watch
cd agent && KEEPER_CHAIN=base-sepolia \
  KEEPER_RPC_URL=https://sepolia.base.org \
  KEEPER_ORACLE_ADDRESS=0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 \
  KEEPER_EXCHANGE_ADDRESS=0xEf75ECA6514cE96B18382E921aC6190a0cF8c072 \
  npx tsx keeper/health.ts; echo "exit=$?"
```

Expected: `所有資產都在 maxPriceAge 之內 ✓`,`exit=0`

- [ ] **Step 5: 把實測結果補進 runbook 並 commit**

在 `docs/RUNBOOK_KEEPER.md` 末尾加一節「2026-08-XX 復原紀錄」,寫入實際的 tx hash、
執行後的 owner、餘額、以及 health check 的輸出。

```bash
git add docs/RUNBOOK_KEEPER.md
git commit -m "docs(ops): keeper runbook and the Base Sepolia recovery record"
```

---

### Task 7: 前端顯示價格年齡,並在過期時擋下單

**Files:**
- Create: `frontend/src/lib/pepefi/priceFreshness.ts`
- Create: `frontend/src/lib/pepefi/priceFreshness.test.ts`
- Create: `frontend/vitest.config.ts`
- Modify: `frontend/package.json`
- Modify: `frontend/src/hooks/useLivePrices.ts`
- Modify: `frontend/src/pages/pepefi/TradeTerminalPage.tsx:242-246`

**Interfaces:**
- Consumes: `useLivePrices()` 既有的回傳形狀
- Produces:
  - `classifyFreshness(a: { updatedAtSec?: number; nowSec: number; maxPriceAgeSec: number }): { level: "live" | "aging" | "stale" | "unknown"; ageSec: number | null; label: string }`
  - `LivePrice` 新增欄位:`settlementUpdatedAt?: number`、`freshness: FreshnessLevel`、`ageSec: number | null`

- [ ] **Step 1: 安裝 vitest 並寫失敗的測試**

```bash
cd frontend && yarn add -D vitest@^2
```

在 `frontend/package.json` 的 `scripts` 加一行(放在 `"lint"` 之前):

```json
    "test": "vitest run",
```

建立 `frontend/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

建立 `frontend/src/lib/pepefi/priceFreshness.test.ts`:

```ts
import { describe, it, expect } from 'vitest'

import { classifyFreshness } from './priceFreshness'

describe('classifyFreshness', () => {
  const maxPriceAgeSec = 21600 // Base Sepolia 交易所實際值：6 小時

  it('沒有 updatedAt 時回 unknown,而不是假裝是 live', () => {
    const r = classifyFreshness({ updatedAtSec: undefined, nowSec: 1000, maxPriceAgeSec })
    expect(r.level).toBe('unknown')
    expect(r.ageSec).toBeNull()
  })

  it('剛更新的價格是 live', () => {
    const r = classifyFreshness({ updatedAtSec: 1000, nowSec: 1060, maxPriceAgeSec })
    expect(r.level).toBe('live')
    expect(r.ageSec).toBe(60)
  })

  it('超過一半 maxPriceAge 進入 aging', () => {
    const r = classifyFreshness({ updatedAtSec: 0, nowSec: 12000, maxPriceAgeSec })
    expect(r.level).toBe('aging')
  })

  it('超過 maxPriceAge 就是 stale —— 這時合約會 revert StalePrice', () => {
    const r = classifyFreshness({ updatedAtSec: 0, nowSec: 21601, maxPriceAgeSec })
    expect(r.level).toBe('stale')
  })

  it('2026-08-06 的線上情況：9.5 天前的 sBTC 必須是 stale', () => {
    const r = classifyFreshness({ updatedAtSec: 1785162620, nowSec: 1785982648, maxPriceAgeSec })
    expect(r.level).toBe('stale')
    expect(r.label).toContain('9.5')
  })

  it('未來時間戳不會產生負數年齡', () => {
    const r = classifyFreshness({ updatedAtSec: 2000, nowSec: 1000, maxPriceAgeSec })
    expect(r.ageSec).toBe(0)
    expect(r.level).toBe('live')
  })

  it('label 對不同量級用不同單位', () => {
    expect(classifyFreshness({ updatedAtSec: 940, nowSec: 1000, maxPriceAgeSec }).label).toBe('60 秒前')
    expect(classifyFreshness({ updatedAtSec: 0, nowSec: 600, maxPriceAgeSec }).label).toBe('10.0 分鐘前')
    expect(classifyFreshness({ updatedAtSec: 0, nowSec: 7200, maxPriceAgeSec }).label).toBe('2.0 小時前')
    expect(classifyFreshness({ updatedAtSec: 0, nowSec: 172800, maxPriceAgeSec }).label).toBe('2.0 天前')
  })
})
```

- [ ] **Step 2: 執行測試,確認失敗**

```bash
cd frontend && yarn test
```

Expected: FAIL — `Failed to resolve import "./priceFreshness"`

- [ ] **Step 3: 寫最小實作**

建立 `frontend/src/lib/pepefi/priceFreshness.ts`:

```ts
// 價格新鮮度分級。
//
// 在這之前 useLivePrices 讀了 oracle 的 updatedAt 卻只取 [0] 把它丟掉，於是
// 9.5 天前寫入的價格在 UI 上仍然是綠色的「live · on-chain oracle」，使用者按下
// 下單才會吃到合約的 StalePrice revert。分級的門檻直接對齊合約自己的
// maxPriceAge，讓 UI 說的「可交易」和鏈上真正接受的一致。

export type FreshnessLevel = 'live' | 'aging' | 'stale' | 'unknown'

export interface Freshness {
  level: FreshnessLevel
  ageSec: number | null
  label: string
}

function humanize(ageSec: number): string {
  if (ageSec < 90) return `${ageSec} 秒前`
  if (ageSec < 3600) return `${(ageSec / 60).toFixed(1)} 分鐘前`
  if (ageSec < 86400) return `${(ageSec / 3600).toFixed(1)} 小時前`
  return `${(ageSec / 86400).toFixed(1)} 天前`
}

export function classifyFreshness(a: {
  updatedAtSec?: number
  nowSec: number
  maxPriceAgeSec: number
}): Freshness {
  if (!a.updatedAtSec || a.updatedAtSec <= 0) {
    return { level: 'unknown', ageSec: null, label: '年齡未知' }
  }
  // 節點時間與瀏覽器時間可能有幾秒差距，不讓它變成負數年齡。
  const ageSec = Math.max(0, a.nowSec - a.updatedAtSec)
  const label = humanize(ageSec)

  if (ageSec > a.maxPriceAgeSec) return { level: 'stale', ageSec, label }
  if (ageSec > a.maxPriceAgeSec / 2) return { level: 'aging', ageSec, label }
  return { level: 'live', ageSec, label }
}

/** 合約會拒絕的價格，UI 也不該讓使用者送出交易。 */
export function blocksTrading(f: Freshness): boolean {
  return f.level === 'stale' || f.level === 'unknown'
}
```

- [ ] **Step 4: 執行測試,確認通過**

```bash
cd frontend && yarn test
```

Expected: PASS — 7 passed

- [ ] **Step 5: 把 updatedAt 接進 useLivePrices**

修改 `frontend/src/hooks/useLivePrices.ts`。三處改動:

其一,在檔案頂端的 import 區加入:

```ts
import { classifyFreshness, type Freshness } from 'src/lib/pepefi/priceFreshness'
```

其二,`LivePrice` 介面(第 31–38 行)改成:

```ts
export interface LivePrice {
  usd:       number        // best display price (live source preferred)
  fetchedAt: number
  isMock:    boolean
  source:    PriceSource
  /** On-chain oracle price = the actual settlement/index price (if available). */
  settlementUsd?: number
  /** 結算價的鏈上 updatedAt（秒）。沒有它就無法判斷「即時」是不是真的即時。 */
  settlementUpdatedAt?: number
  /** 以交易所自己的 maxPriceAge 為準的新鮮度分級。 */
  freshness: Freshness
}
```

其三,`tick` 內讀取 oracle 的區塊(第 98–120 行)改成同時保留 `updatedAt`,並在
迴圈外先取得 `maxPriceAge`:

```ts
    const tick = async () => {
      // 1) Free, keyless display quotes (crypto + PEPE) — always tries to be live.
      const cg = await fetchCoinGecko(pepeAddr)
      const next: Record<string, LivePrice> = {}
      const nowSec = Math.floor(Date.now() / 1000)

      // 交易所自己的 maxPriceAge 才是「可不可以交易」的真相；讀不到就用 6 小時，
      // 那是 Base Sepolia 上實際部署的值。
      let maxPriceAgeSec = 21600
      if (contracts?.perp) {
        try {
          maxPriceAgeSec = Number(await contracts.perp.maxPriceAge())
        } catch { /* 舊部署沒有這個 getter → 保留預設 */ }
      }

      for (const id of Object.values(ASSET_IDS)) {
        // On-chain oracle = settlement price (source of truth for open/close).
        let settlement: number | undefined
        let settlementAt: number | undefined
        if (contracts?.oracle) {
          try {
            const raw = (await contracts.oracle.getPrice(id)) as unknown as [bigint, bigint]
            settlement = Number(raw[0]) / 1e8
            settlementAt = Number(raw[1])
          } catch { /* asset not on oracle */ }
        }

        const freshness = classifyFreshness({
          updatedAtSec: settlementAt,
          nowSec,
          maxPriceAgeSec,
        })

        const cgPrice = cg[id]
        if (cgPrice !== undefined) {
          // Crypto with a live CoinGecko quote → show it; keep oracle as settlement.
          next[id] = {
            usd: cgPrice, fetchedAt: Date.now(), isMock: false, source: 'coingecko',
            settlementUsd: settlement, settlementUpdatedAt: settlementAt, freshness,
          }
        } else if (settlement !== undefined) {
          // Stocks / RWA → on-chain oracle is the live display + settlement.
          next[id] = {
            usd: settlement, fetchedAt: Date.now(), isMock: false, source: 'oracle',
            settlementUsd: settlement, settlementUpdatedAt: settlementAt, freshness,
          }
        } else {
          const fallback = MOCK_INITIAL[id] ?? 100
          const w = 1 + (Math.random() - 0.5) * 0.004
          next[id] = {
            usd: fallback * w, fetchedAt: Date.now(), isMock: true, source: 'mock',
            freshness: { level: 'unknown', ageSec: null, label: '模擬價格' },
          }
        }
      }
```

同一檔案內 `wiggleMock`(第 40–51 行)產生的兩處物件、以及 `tick` 尾端 PEPE 的兩處
物件也要補上 `freshness`,一律用:

```ts
        freshness: { level: 'unknown', ageSec: null, label: '模擬價格' },
```

- [ ] **Step 6: 讓 TradeTerminalPage 顯示年齡並在 stale 時擋下單**

修改 `frontend/src/pages/pepefi/TradeTerminalPage.tsx`。

其一,import 區加入:

```tsx
import { blocksTrading } from 'src/lib/pepefi/priceFreshness'
```

其二,第 242–246 行的來源徽章改成同時顯示年齡與分級:

```tsx
        <Box sx={{ ml: 'auto', ...labelCss, color:
          live[selAsset]?.freshness.level === 'stale' ? C.red
          : live[selAsset]?.freshness.level === 'aging' ? C.mut
          : live[selAsset]?.isMock ? C.mut : C.green }}>
          ● {live[selAsset]?.source === 'coingecko' ? 'display · coingecko'
            : live[selAsset]?.source === 'oracle' ? 'display · on-chain oracle'
            : 'simulated feed'}
          {' · index '}{live[selAsset]?.freshness.label ?? '年齡未知'}
        </Box>
```

其三,在下單按鈕上加 stale 阻擋。先定位送單按鈕 —— 這個 repo 的 `master` 比本地
新,上游把交易終端拆進了 `frontend/src/sections/terminal/`,所以按鈕可能在
`TradeTerminalPage.tsx` 也可能在 `sections/terminal/ticket/OrderTicket.tsx`:

```bash
cd frontend && grep -rn "openPosition\|下單\|Place order\|submitOrder" src/pages/pepefi/TradeTerminalPage.tsx src/sections/terminal 2>/dev/null
```

在 grep 指到的那個送單元件裡,把 `disabled` 改成同時包含:

```tsx
disabled={/* 既有條件 */ || blocksTrading(live[selAsset]?.freshness ?? { level: 'unknown', ageSec: null, label: '' })}
```

並在按鈕上方加一行說明,讓停用的理由是可見的:

```tsx
{blocksTrading(live[selAsset]?.freshness ?? { level: 'unknown', ageSec: null, label: '' }) && (
  <Box sx={{ ...labelCss, color: C.red, mb: 1 }}>
    指數價格已超過合約的 maxPriceAge（{live[selAsset]?.freshness.label}），
    鏈上會以 StalePrice 拒絕交易。等待 keeper 更新後再下單。
  </Box>
)}
```

- [ ] **Step 7: 型別檢查與建置**

```bash
cd frontend && npx tsc --noEmit && yarn test && yarn build
```

Expected: tsc 無錯誤、7 passed、build 成功

- [ ] **Step 8: Commit**

```bash
git add frontend/src/lib/pepefi/priceFreshness.ts frontend/src/lib/pepefi/priceFreshness.test.ts \
        frontend/vitest.config.ts frontend/package.json frontend/yarn.lock \
        frontend/src/hooks/useLivePrices.ts frontend/src/pages/pepefi/TradeTerminalPage.tsx
git commit -m "fix(ui): surface index price age and block trading past maxPriceAge

useLivePrices 讀了 oracle 的 updatedAt 卻丟掉，於是 9.5 天前的價格在 UI 上是
綠色的 live，使用者按下下單才吃到 StalePrice revert。"
```

---

### Task 8: x402 付費前先擋過期資料,並修正 402 的 resource

**Files:**
- Create: `agent/shared/src/freshness.ts`
- Create: `agent/examples/freshness.test.ts`
- Modify: `agent/shared/src/index.ts`
- Modify: `agent/shared/src/abis.ts`
- Modify: `agent/shared/src/aggregate.ts:193-226`
- Modify: `agent/signal-api/src/app.ts`
- Modify: `agent/signal-api/src/vercel-entry.ts`

**Interfaces:**
- Consumes: `getOracleSnapshot`(既有)、`Contracts`(既有)
- Produces:
  - `classifyTradeFreshness(a: { updatedAtSec: number; nowSec: number; maxPriceAgeSec: number }): { fresh: boolean; ageSec: number; maxPriceAgeSec: number }`
  - `OracleSnapshot` 新增欄位:`ageSec`、`maxPriceAgeSec`、`tradableNow`

- [ ] **Step 1: 寫失敗的測試**

建立 `agent/examples/freshness.test.ts`:

```ts
// 純函式測試：付費 API 的新鮮度判準必須與交易所一致。
//   cd agent && npx tsx examples/freshness.test.ts
import assert from "node:assert";
import { classifyTradeFreshness } from "@pepelab/shared";

// 交易所（Base Sepolia 實測值）：maxPriceAge = 21600 秒 = 6 小時
const MAX = 21600;

assert.equal(classifyTradeFreshness({ updatedAtSec: 1000, nowSec: 1060, maxPriceAgeSec: MAX }).fresh, true);
assert.equal(classifyTradeFreshness({ updatedAtSec: 0, nowSec: MAX, maxPriceAgeSec: MAX }).fresh, true);
assert.equal(classifyTradeFreshness({ updatedAtSec: 0, nowSec: MAX + 1, maxPriceAgeSec: MAX }).fresh, false);

// 這是最重要的一條：MockOracle.isStale 的門檻是 24 小時，交易所是 6 小時。
// 落在兩者之間時，舊的 snapshot 會說「不 stale、建議做多」，agent 照做，
// 然後 openPositionForSession 直接 revert StalePrice。
const between = classifyTradeFreshness({ updatedAtSec: 0, nowSec: 12 * 3600, maxPriceAgeSec: MAX });
assert.equal(between.fresh, false, "6–24 小時之間必須判為不可交易");
assert.equal(between.ageSec, 12 * 3600);

// 2026-08-06 的線上情況：Base Sepolia sBTC 9.5 天沒更新
const live = classifyTradeFreshness({ updatedAtSec: 1785162620, nowSec: 1785982648, maxPriceAgeSec: MAX });
assert.equal(live.fresh, false);
assert.ok(live.ageSec > 9 * 86400);

// 未來時間戳不產生負數
assert.equal(classifyTradeFreshness({ updatedAtSec: 2000, nowSec: 1000, maxPriceAgeSec: MAX }).ageSec, 0);

console.log("freshness.test.ts ✓ all assertions passed");
```

- [ ] **Step 2: 執行測試,確認失敗**

```bash
cd agent && npx tsx examples/freshness.test.ts
```

Expected: FAIL — `classifyTradeFreshness is not exported` 或 module 解析錯誤

- [ ] **Step 3: 寫最小實作並匯出**

建立 `agent/shared/src/freshness.ts`:

```ts
// 「這筆價格現在能不能拿來交易」的單一判準。
//
// 之前 getOracleSnapshot 用的是 MockOracle.isStale（24 小時），而
// PerpetualExchange 的 maxPriceAge 是 6 小時。落在兩者之間時，付費端點會回
// 「不 stale、建議做多」，買方的 agent 照做，然後開倉在鏈上 revert StalePrice。
// 付費 API 的判準必須是合約的判準。

export interface TradeFreshness {
  fresh: boolean;
  ageSec: number;
  maxPriceAgeSec: number;
}

export function classifyTradeFreshness(a: {
  updatedAtSec: number;
  nowSec: number;
  maxPriceAgeSec: number;
}): TradeFreshness {
  const ageSec = Math.max(0, a.nowSec - a.updatedAtSec);
  return {
    fresh: ageSec <= a.maxPriceAgeSec,
    ageSec,
    maxPriceAgeSec: a.maxPriceAgeSec,
  };
}
```

在 `agent/shared/src/index.ts` 末尾加一行:

```ts
export * from "./freshness.ts";
```

在 `agent/shared/src/abis.ts` 的 `PERPETUAL_EXCHANGE_ABI` 陣列中加入:

```ts
  "function maxPriceAge() view returns (uint256)",
```

- [ ] **Step 4: 執行測試,確認通過**

```bash
cd agent && npx tsx examples/freshness.test.ts
```

Expected: PASS — `freshness.test.ts ✓ all assertions passed`

- [ ] **Step 5: 讓 snapshot 帶上交易用新鮮度**

修改 `agent/shared/src/aggregate.ts` 的 `getOracleSnapshot`(第 193–226 行)。
在 `Promise.all` 陣列末尾加入 `maxPriceAge` 讀取,並把結果併進 `base`:

```ts
export async function getOracleSnapshot(
  c: Contracts,
  symbol: string,
): Promise<OracleSnapshot> {
  const assetId = assetIdOf(symbol);
  const [priceRes, isStale, fundingBps, longOI, shortOI, maxPriceAge] = await Promise.all([
    c.oracle.getPrice(assetId) as Promise<[bigint, bigint]>,
    c.oracle.isStale(assetId) as Promise<boolean>,
    c.perp.getFundingRate(assetId) as Promise<bigint>,
    c.perp.globalLongNotional(assetId) as Promise<bigint>,
    c.perp.globalShortNotional(assetId) as Promise<bigint>,
    c.perp.maxPriceAge() as Promise<bigint>,
  ]);
  const [price, updatedAt] = priceRes;
  const direction =
    fundingBps > 0n ? "longs_pay" : fundingBps < 0n ? "shorts_pay" : "balanced";

  // isStale 是 MockOracle 的 24 小時門檻；交易能不能成立由交易所的 maxPriceAge
  // 決定，兩者差 4 倍，所以兩個都要回，並且明講哪個才是可交易的判準。
  const tf = classifyTradeFreshness({
    updatedAtSec: Number(updatedAt),
    nowSec: Math.floor(Date.now() / 1000),
    maxPriceAgeSec: Number(maxPriceAge),
  });

  const base = {
    asset: symbol,
    assetId,
    price: fmtPrice8(price),
    updatedAt: fmtTime(updatedAt),
    isStale,
    ageSec: tf.ageSec,
    maxPriceAgeSec: tf.maxPriceAgeSec,
    tradableNow: tf.fresh,
    fundingRateBps: Number(fundingBps),
    fundingRatePercent: bpsToPercent(fundingBps),
    fundingDirection: direction as OracleSnapshot["fundingDirection"],
    longOpenInterest: fmtUsdc18(longOI),
    shortOpenInterest: fmtUsdc18(shortOI),
  };
  const enriched = enrichOracle(base, {
    Kf: numEnv("X402_EDGE_KF"),
    entryThreshold: numEnv("X402_EDGE_ENTRY"),
  });
  return { ...base, ...enriched };
}
```

同檔案頂端的 import 加入 `classifyTradeFreshness`;`OracleSnapshot` 型別定義加上
三個新欄位:

```ts
  ageSec: number;
  maxPriceAgeSec: number;
  tradableNow: boolean;
```

- [ ] **Step 6: 在付費牆之前加新鮮度閘門**

修改 `agent/signal-api/src/app.ts`。

其一,import 區加入 `classifyTradeFreshness` 與 `assetIdOf`:

```ts
  classifyTradeFreshness,
  assetIdOf,
```

其二,**在 `app.use(paymentMiddleware(...))` 這一行之前**插入以下區塊(位置在
`// ── x402 付費牆` 註解的正上方)。順序很重要:Hono 依註冊順序執行,閘門必須先跑,
買方才不會為了一份已知過期的資料付錢。

```ts
  // ── 付費前的新鮮度閘門 ────────────────────────────────────────────────────
  //
  // /oracle/:asset 賣的是價格。當鏈上價格已超過交易所自己的 maxPriceAge 時，
  // 這份資料既不能用來交易（openPosition 會 revert StalePrice），也沒有市場意義。
  // x402 沒有退費機制，所以必須在 402 之前擋下來，而不是收了錢再回一個 isStale:true。
  //
  // 2026-08-06 的實況：Base Sepolia 的 oracle 已 9.5–44 天未更新，這個端點會用
  // $0.005 賣出 sAAPL $199.15（真實 $311）。
  app.use("/oracle/*", async (c, next) => {
    const asset = c.req.path.split("/")[2];
    if (!asset) return next();
    try {
      const assetId = assetIdOf(asset);
      const [[, updatedAt], maxPriceAge] = await Promise.all([
        contracts.oracle.getPrice(assetId) as Promise<[bigint, bigint]>,
        contracts.perp.maxPriceAge() as Promise<bigint>,
      ]);
      const tf = classifyTradeFreshness({
        updatedAtSec: Number(updatedAt),
        nowSec: Math.floor(Date.now() / 1000),
        maxPriceAgeSec: Number(maxPriceAge),
      });
      if (!tf.fresh) {
        return c.json(
          {
            ok: false,
            error: "price_stale",
            message:
              `${asset} 的鏈上價格已 ${Math.round(tf.ageSec / 3600)} 小時未更新，` +
              `超過交易所的 maxPriceAge（${tf.maxPriceAgeSec} 秒）。此時開倉會 revert ` +
              `StalePrice，故不販售這份快照。`,
            asset,
            ageSec: tf.ageSec,
            maxPriceAgeSec: tf.maxPriceAgeSec,
          },
          503,
        );
      }
    } catch {
      // 讀不到（資產不存在、RPC 抖動）→ 交給下游處理，不要因為監測失敗就擋住服務。
    }
    return next();
  });
```

其三,修正 `/` 的分潤文案(第 125 行)。目前寫 `FeeRouter 70/20/10 …, settled
on-chain`,但 402 回應的 `payTo` 是一個 EOA,分潤是由另一把私鑰事後自行支付的:

```ts
      revenueModel:
        `x402 付款直接進 payTo（${PAY_TO}）；70/20/10 分潤由平台另行透過 ` +
        `FeeRouter.routeExternalRevenue 上鏈結算，累計可於 /revenue 查詢。` +
        `兩者是不同的兩筆交易。`,
```

- [ ] **Step 7: 修正 402 回應的 resource scheme**

修改 `agent/signal-api/src/vercel-entry.ts`,把最後一行 `export default handle(app);`
換成:

```ts
const inner = handle(app);

// Vercel 在邊緣終止 TLS，抵達 Node runtime 的 socket 不是加密的，而
// @hono/node-server 是用 `incoming.socket.encrypted ? "https" : "http"` 決定
// scheme（dist/index.mjs:194）。結果是 x402 的 402 回應把 resource 寫成
// http://…，而 resource 是付款方會一起驗證的欄位。
export default function handler(req: any, res: any) {
  const proto = String(req.headers["x-forwarded-proto"] ?? "");
  if (proto.includes("https") && req.socket && !req.socket.encrypted) {
    Object.defineProperty(req.socket, "encrypted", {
      value: true,
      configurable: true,
    });
  }
  return inner(req, res);
}
```

- [ ] **Step 8: 重新打包 Vercel bundle 並型別檢查**

```bash
cd agent/signal-api && node build-vercel.mjs && cd .. && npm run typecheck
```

Expected: `✓ bundled api/index.js (self-contained ESM)`,typecheck 無錯誤

- [ ] **Step 9: 部署後以線上端點驗證三件事**

部署到 Vercel 之後執行:

```bash
API=https://agent-git-master-zuemens-projects.vercel.app
# 1) 過期時不再收費，回 503 而不是 402
curl -s -o /dev/null -w "oracle status=%{http_code}\n" $API/oracle/sBTC
# 2) 402 的 resource 是 https
curl -s $API/signals/0xE80A81360608C1342e66743F70a00f75d792Eb93 | grep -o '"resource":"[^"]*"'
# 3) 分潤文案已更正
curl -s $API/ | grep -o '"revenueModel":"[^"]*"'
```

Expected:
- Base Sepolia 尚未修復時 `oracle status=503`;Task 6 修復後應回 `402`
- resource 以 `https://` 開頭
- revenueModel 明確說明是兩筆不同的交易

- [ ] **Step 10: Commit**

```bash
git add agent/shared/src/freshness.ts agent/shared/src/index.ts agent/shared/src/abis.ts \
        agent/shared/src/aggregate.ts agent/examples/freshness.test.ts \
        agent/signal-api/src/app.ts agent/signal-api/src/vercel-entry.ts \
        agent/signal-api/api/index.js
git commit -m "fix(x402): refuse to sell stale prices before charging, https resource

付費端點的新鮮度判準原本是 MockOracle.isStale（24h），交易所是 maxPriceAge（6h），
落在中間時 API 會建議下單而鏈上會 revert。x402 沒有退費，所以閘門必須在 402 之前。"
```

---

### Task 9: GuardedOracle 偏離上限對稱化

Task 1 的 `stepTowards` 已經讓 keeper 在現行合約下不再死鎖,所以這個 task 不是
復原線上服務的必要條件。它修的是規則本身的方向性錯誤:目前上漲容許 10%、下跌只
容許 9.09%,也就是**崩盤時更容易被擋下**,而崩盤正是最需要價格跟上、最需要清算
啟動的時候。

**Files:**
- Modify: `contracts/src/v2/GuardedOracle.sol:207-211`
- Test: `contracts/test/v2/GuardedOracle.t.sol`

**Interfaces:**
- Consumes: 無
- Produces: `_deviationExceeded` 改以「舊價」為分母,上下對稱

- [ ] **Step 1: 寫失敗的測試**

在 `contracts/test/v2/GuardedOracle.t.sol` 的 `GuardedOracleTest` 合約內加入以下
三個測試。該檔既有的 fixture 是 `GuardedOracle oracle`、`address admin =
address(this)`、`address keeper = makeAddr("keeper")`,已在 `setUp()` 授予
`KEEPER_ROLE`,直接沿用即可。既有的 `bytes32 constant ID = keccak256("sBTC")`
另有用途,所以下面用不同的 assetId 以免互相干擾:

```solidity
    /// 上下方向的容許幅度必須一致。舊實作以「較小值」為分母，於是 +10% 可過、
    /// -10% 被拒（實際只容許 -9.09%）——在崩盤時最容易擋住最該通過的更新。
    function test_deviationCapIsSymmetric() public {
        bytes32 id = keccak256("sSYM");
        vm.prank(admin);
        oracle.addAsset(id, 100e8);

        // cap = 1000 bps = 10%
        vm.prank(keeper);
        oracle.updatePrice(id, 110e8);      // +10% 應通過
        (uint256 p,) = oracle.getPrice(id);
        assertEq(p, 110e8);

        vm.prank(keeper);
        oracle.updatePrice(id, 99e8);       // 110 → 99 是 -10%，必須同樣通過
        (p,) = oracle.getPrice(id);
        assertEq(p, 99e8);
    }

    function test_deviationCapStillRejectsBeyondCap() public {
        bytes32 id = keccak256("sSYM2");
        vm.prank(admin);
        oracle.addAsset(id, 100e8);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(GuardedOracle.DeviationTooLarge.selector, id, 111e8, 100e8)
        );
        oracle.updatePrice(id, 111e8);      // +11% 仍應被拒

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(GuardedOracle.DeviationTooLarge.selector, id, 89e8, 100e8)
        );
        oracle.updatePrice(id, 89e8);       // -11% 仍應被拒
    }

    /// 一個 12% 的下跌現在需要兩步走完，而且每一步都必須被接受——這正是 keeper
    /// 的 stepTowards 所依賴的性質。
    function test_largeDropReachableInTwoSteps() public {
        bytes32 id = keccak256("sSYM3");
        vm.prank(admin);
        oracle.addAsset(id, 100e8);

        vm.prank(keeper);
        oracle.updatePrice(id, 90.5e8);     // 第一步 −9.5%
        vm.prank(keeper);
        oracle.updatePrice(id, 88e8);       // 第二步走到目標
        (uint256 p,) = oracle.getPrice(id);
        assertEq(p, 88e8);
    }
```

- [ ] **Step 2: 執行測試,確認失敗**

```bash
cd contracts && forge test --match-test test_deviationCapIsSymmetric -vv
```

Expected: FAIL — `updatePrice(id, 99e8)` 以 `DeviationTooLarge` revert(110 → 99 是
−10%,但舊公式以 99 為分母算成 11.1%)

- [ ] **Step 3: 修正合約**

修改 `contracts/src/v2/GuardedOracle.sol` 的 `_deviationExceeded`(第 207–211 行):

```solidity
    /// @dev 以「舊價」為分母，讓上下方向的容許幅度一致。
    ///
    ///      先前以兩者中較小的值為分母，於是 +10% 可過而 −10% 被拒（實際只容許
    ///      −9.09%）。方向是反的：崩盤時最需要價格跟上、最需要清算啟動，而那正是
    ///      舊公式最容易擋下更新的時候。它也造成 keeper 的追價死鎖——一旦落後超過
    ///      上限，每一次全額更新都被拒絕，最後只能由 admin 把上限設成 0 手動修正
    ///      （見 docs/ROLE_SEPARATION.md 的 2026-07-27 紀錄）。
    function _deviationExceeded(uint256 oldPrice, uint256 newPrice, uint256 bps)
        internal pure returns (bool)
    {
        if (oldPrice == 0) return false;
        uint256 diff = oldPrice > newPrice ? oldPrice - newPrice : newPrice - oldPrice;
        return diff * BPS_DENOM > bps * oldPrice;
    }
```

注意呼叫端第 148 行 `_deviationExceeded(refPrice, newPrice, maxDeviationBps)` 的
第一個參數已經是「參考價」,語意上就是分母,不需要改動。

- [ ] **Step 4: 執行全套合約測試**

```bash
cd contracts && forge test --match-contract GuardedOracle -vv && forge test
```

Expected: 三個新測試 PASS,且既有全套測試沒有回歸失敗。若既有的
`test_attackerCanStillWalkPriceGradually` 對步幅有硬編碼期望值,更新該期望值並在
測試註解說明是因為分母改變,不要放寬斷言。

- [ ] **Step 5: 記錄部署現況並 commit**

在 `docs/VAULT_VERSIONS.md` 加一段(若該檔不存在此小節則新增於末尾):

```markdown
## GuardedOracle 偏離上限對稱化(2026-08-XX)

`_deviationExceeded` 改以舊價為分母,上下方向容許幅度一致。

**線上實例尚未套用。** `0x32A19D04…49A1`(Sepolia)是已部署的不可升級合約,
換用新版需要重新部署並以 `AssetVaultV2.setOracle` 遷移。在遷移之前,keeper 的
`stepTowards`(`agent/keeper/core.ts`)刻意複製了**舊合約**的不對稱公式,所以
它送出的每一步都能被線上實例接受。遷移時必須同步檢查該函式。
```

```bash
git add contracts/src/v2/GuardedOracle.sol contracts/test/v2/GuardedOracle.t.sol docs/VAULT_VERSIONS.md
git commit -m "fix(oracle): symmetric deviation cap, denominated on the previous price

舊公式以兩者中較小值為分母，於是 +10% 可過而 −10% 被拒。方向是反的：崩盤時
最需要價格跟上、最需要清算啟動。它也是 keeper 追價死鎖的成因。"
```

---

## 完成後的整體驗收

依序執行,全部通過才算完成:

```bash
# 1. 所有純函式測試
cd agent && npx tsx keeper/core.test.ts && npx tsx keeper/feeds.test.ts && npx tsx examples/freshness.test.ts

# 2. 合約
cd ../contracts && forge test

# 3. 前端
cd ../frontend && npx tsc --noEmit && yarn test && yarn build

# 4. 兩條鏈的鏈上事實
cd ../agent
KEEPER_CHAIN=base-sepolia KEEPER_RPC_URL=https://sepolia.base.org \
  KEEPER_ORACLE_ADDRESS=0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3 \
  KEEPER_EXCHANGE_ADDRESS=0xEf75ECA6514cE96B18382E921aC6190a0cF8c072 \
  npx tsx keeper/health.ts
KEEPER_CHAIN=sepolia KEEPER_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
  KEEPER_ORACLE_ADDRESS=0x17CA20A37Cf04F2f589B2573EC95f1411D29d958 \
  npx tsx keeper/health.ts

# 5. Sepolia 的 GuardedOracle 死鎖已解（sBTC 應可讀，不再 revert）
cast call 0x32A19D04ef2ca5A7DA02Df39419729fA745749A1 \
  "getPrice(bytes32)(uint256,uint256)" $(cast keccak "sBTC") \
  --rpc-url https://ethereum-sepolia-rpc.publicnode.com

# 6. 線上交易所不再對 sBTC 回 StalePrice
cast call 0xEf75ECA6514cE96B18382E921aC6190a0cF8c072 "liquidatePosition(uint256)" 0 \
  --rpc-url https://sepolia.base.org
```

第 6 步的預期:**不應**再出現 `0xfa53fd94`(`StalePrice(bytes32,uint256)`)。回
其他 revert(例如部位不符合清算條件)是正確的,那代表價格檢查已經通過。
