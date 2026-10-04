#!/usr/bin/env node
// 主合約成長門檻：PerpetualExchange 的 runtime bytecode 不得超過釘選的預算。
//
// 為什麼存在：EIP-170 的上限是 24,576 B，主合約已經貼著上限（組合保證金模式就是因為
// 塞不下才從原始碼移除，見 docs/KNOWN_LIMITATIONS.md）。只看 EIP-170 的話，每個 PR 都
// 可以悄悄多吃幾十個 byte，等到真的爆掉時已經沒有空間做必要的安全修正。所以這裡釘一個
// 比 EIP-170 更緊的預算：超過就紅。
//
// 規則：
//   - 要提高預算，**同一個 PR** 修改下面 BUDGETS 的 maxRuntimeBytes，並在 history 加一筆
//     { bytes, date, reason }，reason 寫清楚為什麼值得多花這些 byte。history 最後一筆的 bytes
//     必須等於 maxRuntimeBytes，每一筆都要有 reason——沒寫理由的放寬會讓檢查失敗。
//   - 預算不得超過 EIP-170（24,576 B）。
//   - 合約變小時不強制下修；檢查會印出餘裕，下修預算是好事，同樣在 history 記一筆。
//
// 讀的是 forge build 的產物（contracts/out/<File>.sol/<Name>.json 的
// deployedBytecode.object），與 `forge build --sizes` 的 Runtime Size 同一個數字。
// immutable 與 library 位置在產物裡已經佔了位（佔位字元也是 2 hex／byte），長度與鏈上一致。
//
// 零依賴，只讀檔案，不連網。CI：.github/workflows/contracts-ci.yml 在 forge build 之後執行。
// 用法：
//   node scripts/check-contract-size.mjs [--out <contracts/out 路徑>]
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EIP170_LIMIT = 24576;

/**
 * 釘選的預算。改這裡＝改門檻，PR 的 diff 會讓審查者看到。
 * history 由舊到新；最後一筆的 bytes 必須等於 maxRuntimeBytes。
 */
export const BUDGETS = {
  PerpetualExchange: {
    artifact: "PerpetualExchange.sol/PerpetualExchange.json",
    maxRuntimeBytes: 23911,
    history: [
      {
        bytes: 23911,
        date: "2026-10-04",
        reason:
          "初始釘選：等於 master e85cecb 的 runtime 大小（forge build，via_ir、optimizer_runs 200）。" +
          "距 EIP-170 尚有 665 B，保留給必要的安全修正；任何新增功能都要先在別處省下空間。",
      },
    ],
  },
};

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
        `${name}：maxRuntimeBytes ${b.maxRuntimeBytes} 與 history 最後一筆 ${last.bytes} 不同——改預算時要在 history 加一筆並寫理由`,
      );
    }
  }
  return problems;
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
    try {
      size = runtimeSize(JSON.parse(readFileSync(file, "utf8"))?.deployedBytecode?.object);
    } catch (e) {
      problems.push(`${name}：讀不到 runtime bytecode（${e.message}）`);
      continue;
    }
    rows.push({ name, size, budget: b.maxRuntimeBytes, headroom: b.maxRuntimeBytes - size, eip170Headroom: EIP170_LIMIT - size });
    if (size > b.maxRuntimeBytes) {
      problems.push(
        `${name}：runtime ${size} B 超過釘選預算 ${b.maxRuntimeBytes} B（多 ${size - b.maxRuntimeBytes} B）。` +
          `先嘗試在別處省下空間；真的需要放寬，就在同一個 PR 修改 scripts/check-contract-size.mjs 的 BUDGETS.${name}，` +
          `並在 history 寫明理由。`,
      );
    }
  }
  return { problems, rows };
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const k = args.indexOf("--out");
  const outDir = resolve(k >= 0 ? args[k + 1] : join(here, "..", "contracts", "out"));
  const { problems, rows } = checkSizes({ outDir });
  for (const r of rows) {
    console.log(
      `${r.name}: runtime ${r.size} B／預算 ${r.budget} B（餘裕 ${r.headroom} B；距 EIP-170 ${r.eip170Headroom} B）`,
    );
  }
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`);
    process.exit(1);
  }
  console.log("合約大小門檻：通過");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
