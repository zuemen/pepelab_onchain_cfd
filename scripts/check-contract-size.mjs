#!/usr/bin/env node
// 主合約成長門檻：PerpetualExchange 的 runtime bytecode 不得超過釘選的預算。
//
// 為什麼存在：EIP-170 的上限是 24,576 B，主合約已經貼著上限（組合保證金模式就是因為
// 塞不下才從原始碼移除，見 docs/KNOWN_LIMITATIONS.md）。只看 EIP-170 的話，每個 PR 都
// 可以悄悄多吃幾十個 byte，等到真的爆掉時已經沒有空間做必要的安全修正。所以這裡釘一個
// 比 EIP-170 更緊的預算：超過就紅。
//
// 規則（釘選值在 scripts/contract-size-budget.json）：
//   - 要提高預算，**同一個 PR** 修改 maxRuntimeBytes，並在 history 尾端追加一筆
//     { bytes, date, reason }。history 最後一筆的 bytes 必須等於 maxRuntimeBytes，每一筆都要有 reason。
//   - history 只能追加（--base <git ref>，CI 用 PR 的 base）：既有紀錄不得被改或刪；放寬預算時
//     必須有新的紀錄，而且新紀錄的 reason 不得沿用舊的——「改數字、沿用舊理由」會被擋下。
//   - 預算不得超過 EIP-170（24,576 B）。
//   - 合約變小時不強制下修；檢查會印出餘裕，下修預算是好事，同樣追加一筆紀錄。
//
// 讀的是 forge build 的產物（contracts/out/<File>.sol/<Name>.json 的 deployedBytecode.object），
// 與 `forge build --sizes` 的 Runtime Size 同一個數字。產物取決於編譯器：contracts/foundry.toml
// 釘選 solc_version，換版本要是一個看得見的 commit。
//
// 零依賴，只讀檔案（--base 時另外呼叫 `git show`），不連網。
// CI：.github/workflows/contract-size.yml（沒有路徑過濾、每個 PR 都跑，可設為 required check）。
// 用法：
//   node scripts/check-contract-size.mjs [--out <contracts/out 路徑>] [--base <git ref>]
//   node scripts/check-contract-size.mjs --history-only --base <git ref>   # 只檢查釘選表（不需要 forge build）
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EIP170_LIMIT = 24576;
export const BUDGET_FILE = "scripts/contract-size-budget.json";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

export function loadBudgets(text = readFileSync(join(ROOT, BUDGET_FILE), "utf8")) {
  const data = JSON.parse(text);
  if (!data || typeof data.budgets !== "object") throw new Error(`${BUDGET_FILE} 沒有 budgets`);
  return data.budgets;
}

/** 釘選表（PR 修改後的版本）。 */
export const BUDGETS = loadBudgets();

/** 預算表本身的一致性：回傳問題清單。 */
export function checkBudgetTable(budgets = BUDGETS) {
  const problems = [];
  for (const [name, b] of Object.entries(budgets)) {
    if (!Number.isInteger(b.maxRuntimeBytes) || b.maxRuntimeBytes <= 0) {
      problems.push(`${name}：maxRuntimeBytes 必須是正整數`);
      continue;
    }
    if (b.maxRuntimeBytes > EIP170_LIMIT) {
      problems.push(`${name}：預算 ${b.maxRuntimeBytes} B 超過 EIP-170 上限 ${EIP170_LIMIT} B，那樣的合約根本部署不上去`);
    }
    if (typeof b.artifact !== "string" || !/^[A-Za-z0-9_]+\.sol\/[A-Za-z0-9_]+\.json$/.test(b.artifact)) {
      problems.push(`${name}：artifact 必須是 <File>.sol/<Name>.json`);
    }
    if (!Array.isArray(b.history) || b.history.length === 0) {
      problems.push(`${name}：history 不可為空；每次調整預算都要記一筆 { bytes, date, reason }`);
      continue;
    }
    b.history.forEach((h, i) => {
      if (!Number.isInteger(h.bytes)) problems.push(`${name}：history[${i}].bytes 必須是整數`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date ?? "")) problems.push(`${name}：history[${i}].date 必須是 YYYY-MM-DD`);
      if (typeof h.reason !== "string" || h.reason.trim().length < 10) {
        problems.push(`${name}：history[${i}] 沒有寫理由（reason 至少 10 個字）——放寬預算必須說明為什麼`);
      }
    });
    const last = b.history[b.history.length - 1];
    if (last.bytes !== b.maxRuntimeBytes) {
      problems.push(
        `${name}：maxRuntimeBytes ${b.maxRuntimeBytes} 與 history 最後一筆 ${last.bytes} 不同——改預算時要在 history 追加一筆並寫理由`,
      );
    }
  }
  return problems;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * history 只能追加（與 base 比）。base 為 null（base 還沒有釘選表）時不檢查。
 * 放寬預算必須追加新紀錄，而且新紀錄的理由不得與既有紀錄相同。
 */
export function checkAppendOnly(base, current) {
  const problems = [];
  if (!base) return problems;
  for (const [name, b] of Object.entries(base)) {
    const c = current[name];
    if (!c) {
      problems.push(`${name}：預算被整筆刪除（base 有、現在沒有）——門檻不能靠刪除放寬`);
      continue;
    }
    const bh = b.history ?? [];
    const ch = c.history ?? [];
    for (let i = 0; i < bh.length; i++) {
      if (!same(bh[i], ch[i])) {
        problems.push(`${name}：history[${i}] 被修改或刪除——history 只能在尾端追加`);
        break;
      }
    }
    if (c.maxRuntimeBytes > b.maxRuntimeBytes) {
      const added = ch.slice(bh.length);
      if (added.length === 0) {
        problems.push(`${name}：預算從 ${b.maxRuntimeBytes} 放寬到 ${c.maxRuntimeBytes}，卻沒有在 history 追加新紀錄`);
      } else {
        const old = new Set(bh.map((h) => String(h.reason ?? "").trim()));
        for (const h of added) {
          if (old.has(String(h.reason ?? "").trim())) problems.push(`${name}：新紀錄（${h.date}）沿用了既有的理由——放寬要寫這次的理由`);
        }
      }
    }
  }
  return problems;
}

/** base 版本的釘選表；base 沒有這個檔（例如釘選表剛引入）回傳 null。 */
export function loadBaseBudgets(ref, exec = execFileSync) {
  let text;
  try {
    text = exec("git", ["show", `${ref}:${BUDGET_FILE}`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  return loadBudgets(text);
}

/** deployedBytecode.object（含 0x、可能含 library 佔位）的 byte 數。 */
export function runtimeSize(object) {
  if (typeof object !== "string") throw new Error("deployedBytecode.object 不是字串");
  const hex = object.replace(/^0x/, "");
  if (hex.length % 2 !== 0) throw new Error("deployedBytecode.object 的 hex 長度是奇數");
  if (hex.length === 0) throw new Error("deployedBytecode.object 是空的（抽象合約或介面？）");
  return hex.length / 2;
}

/** 依產物檢查每個預算。回傳 { problems, rows }。 */
export function checkSizes({ outDir, budgets = BUDGETS }) {
  const problems = checkBudgetTable(budgets);
  const rows = [];
  for (const [name, b] of Object.entries(budgets)) {
    const file = join(outDir, b.artifact);
    if (!existsSync(file)) {
      problems.push(`${name}：找不到編譯產物 ${file}（先跑 forge build）`);
      continue;
    }
    let size;
    let compiler = null;
    try {
      const art = JSON.parse(readFileSync(file, "utf8"));
      size = runtimeSize(art?.deployedBytecode?.object);
      compiler = art?.metadata?.compiler?.version ?? null;
    } catch (e) {
      problems.push(`${name}：讀不到 runtime bytecode（${e.message}）`);
      continue;
    }
    rows.push({ name, size, budget: b.maxRuntimeBytes, headroom: b.maxRuntimeBytes - size, eip170Headroom: EIP170_LIMIT - size, compiler });
    if (size > b.maxRuntimeBytes) {
      problems.push(
        `${name}：runtime ${size} B 超過釘選預算 ${b.maxRuntimeBytes} B（多 ${size - b.maxRuntimeBytes} B）。` +
          `先嘗試在別處省下空間；真的需要放寬，就在同一個 PR 修改 ${BUDGET_FILE} 的 ${name}，` +
          `並在 history 追加一筆寫明理由。`,
      );
    }
  }
  return { problems, rows };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n) => {
    const k = args.indexOf(n);
    return k >= 0 ? args[k + 1] : undefined;
  };
  const base = opt("--base");
  const problems = [];
  if (base) {
    const baseBudgets = loadBaseBudgets(base);
    if (baseBudgets === null) console.log(`base ${base} 沒有 ${BUDGET_FILE}，不做只能追加的檢查`);
    problems.push(...checkAppendOnly(baseBudgets, BUDGETS));
  }
  if (args.includes("--history-only")) {
    problems.push(...checkBudgetTable(BUDGETS));
  } else {
    const outDir = resolve(opt("--out") ?? join(ROOT, "contracts", "out"));
    const r = checkSizes({ outDir });
    problems.push(...r.problems);
    for (const row of r.rows) {
      console.log(
        `${row.name}: runtime ${row.size} B／預算 ${row.budget} B（餘裕 ${row.headroom} B；距 EIP-170 ${row.eip170Headroom} B；solc ${row.compiler ?? "?"}）`,
      );
    }
  }
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  console.log("合約大小門檻：通過");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
