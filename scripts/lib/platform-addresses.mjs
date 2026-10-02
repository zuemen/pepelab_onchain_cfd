// 平台位址全集：平台（default 租戶）在 repo 裡任何地方用過、提過的位址。
//
// 專屬租戶的部署登記（frontend/src/contracts/deployments/<id>.json）與部署設定
// （deploy/tenants/<id>.json）用它做租戶隔離的比對（ADR-008）。
//
// 為什麼是「全集」而不是一份手寫的角色清單：先前的檢查只比對 addresses.ts 解析出來的
// 角色，退役但只留在註解裡的舊 AgentSessionManager、git 歷史裡換掉的舊 FeeRouter／保險金
// 都不在裡面，所以一份重用它們的租戶登記能通過（PR #228 審查 F2）。這裡改成結構性的：
//   1. 下面 PLATFORM_ADDRESS_SOURCES 列的每一個檔案，**文字裡出現的每一個位址**都算
//      （含註解——註解裡提到的舊合約一樣是平台的合約）；
//   2. 加上機器可讀的退役清單 frontend/src/contracts/retiredPlatformAddresses.json。
// 新增平台合約、換掉舊合約時不需要改這支程式：寫進設定檔或退役清單就自動納入。
//
// 不分鏈：同一個位址在兩條鏈上屬於不同合約的機率可以忽略，不分鏈只會更嚴。
// 零依賴（只用 node 內建模組）。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import { parseJsonStrict } from "./strict-json.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";

/** 文字裡的位址：0x＋40 位十六進位，前後都不能再接十六進位字元（排除 bytes32、交易 hash）。 */
export const ADDRESS_IN_TEXT = /(?<![0-9a-zA-Z])0x[0-9a-fA-F]{40}(?![0-9a-zA-Z])/g;

export const RETIRED_FILE = "frontend/src/contracts/retiredPlatformAddresses.json";

/**
 * 平台位址的來源。`dir` 會遞迴；`exclude` 以相對於 repo 根目錄、正斜線的路徑比對。
 *   - frontend/src/contracts：平台設定（addresses.ts、sessionManager.ts、x402.ts、
 *     legacyExchanges.ts、退役清單…）。排除租戶自己的部署登記、ABI、測試與快照。
 *   - .github/workflows：keeper／健檢／admin 指向的合約。帶 `KEEPER_TENANT:` 的租戶
 *     workflow 不算平台的（它們指向租戶自己的合約，由 check-addresses 以租戶登記比對）。
 *   - agent 設定：.env 範本、agent/shared 與 SDK 的位址表。
 */
export const PLATFORM_ADDRESS_SOURCES = [
  {
    dir: "frontend/src/contracts",
    exclude: [/^frontend\/src\/contracts\/deployments\//, /^frontend\/src\/contracts\/abi\//, /\.test\.[cm]?[jt]sx?$/, /\/__snapshots__\//],
  },
  { dir: ".github/workflows", include: [/\.ya?ml$/], tenantScopedExcluded: true },
  { file: "agent/.env.example" },
  { dir: "agent/shared/src", include: [/\.[cm]?ts$/], exclude: [/\.test\.[cm]?ts$/, /\/__tests__\//] },
  { dir: "agent/sdk/src", include: [/\.[cm]?ts$/], exclude: [/\.test\.[cm]?ts$/, /\/__tests__\//] },
];

/** workflow 是否屬於某個租戶（帶 `KEEPER_TENANT:` 鍵）。 */
export const isTenantScopedWorkflow = (text) => /^\s*KEEPER_TENANT\s*:/m.test(text);

function walkFiles(root, dir) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  const out = [];
  for (const name of readdirSync(abs).sort()) {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) out.push(...walkFiles(root, rel));
    else out.push(rel);
  }
  return out;
}

/** 文字裡所有位址（原樣），附行號。 */
export function addressesInText(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    for (const m of line.matchAll(ADDRESS_IN_TEXT)) out.push({ address: m[0], line: idx + 1 });
  });
  return out;
}

/**
 * 讀並驗證退役清單。格式錯誤直接丟錯（檢查器不能在讀不懂清單時默默少擋）。
 * @returns {{ address: string, role: string, chainId: number|null, source: string }[]}
 */
export function loadRetired(root) {
  const file = join(root, RETIRED_FILE);
  const { value, duplicates } = parseJsonStrict(readFileSync(file, "utf8"));
  const bad = (msg) => {
    throw new Error(`${RETIRED_FILE}: ${msg}`);
  };
  if (duplicates.length) bad(`重複的鍵：${duplicates.join("、")}`);
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("不是 JSON 物件");
  const top = Object.keys(value).sort().join(",");
  if (top !== "$comment,addresses,schemaVersion") bad(`最上層只能有 $comment／schemaVersion／addresses（目前 ${top}）`);
  if (value.schemaVersion !== 1) bad("schemaVersion 必須是 1");
  if (!Array.isArray(value.addresses) || value.addresses.length === 0) bad("addresses 必須是非空陣列");
  const seen = new Set();
  for (const [i, e] of value.addresses.entries()) {
    const keys = Object.keys(e ?? {}).sort().join(",");
    if (keys !== "address,chainId,role,source") bad(`addresses[${i}] 的欄位必須正好是 address／role／chainId／source（目前 ${keys}）`);
    if (typeof e.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(e.address) || e.address.toLowerCase() === ZERO) {
      bad(`addresses[${i}].address 不是非零位址`);
    }
    if (typeof e.role !== "string" || e.role === "") bad(`addresses[${i}].role 必須是非空字串`);
    if (e.chainId !== null && !Number.isSafeInteger(e.chainId)) bad(`addresses[${i}].chainId 必須是整數或 null`);
    if (typeof e.source !== "string" || e.source === "") bad(`addresses[${i}].source 必須是非空字串`);
    const low = e.address.toLowerCase();
    if (seen.has(low)) bad(`addresses[${i}] ${e.address} 重複`);
    seen.add(low);
  }
  return value.addresses;
}

/**
 * 平台位址全集。
 * @returns {Map<string, string[]>}  小寫位址 → 出處（`檔案:行`）
 */
export function platformAddressUniverse(root, sources = PLATFORM_ADDRESS_SOURCES) {
  const universe = new Map();
  const add = (address, where) => {
    const low = address.toLowerCase();
    if (low === ZERO) return;
    if (!universe.has(low)) universe.set(low, []);
    universe.get(low).push(where);
  };
  for (const src of sources) {
    const files = src.file ? (existsSync(join(root, src.file)) ? [src.file] : []) : walkFiles(root, src.dir);
    for (const rel of files) {
      const norm = rel.split(sep).join("/");
      if (src.include && !src.include.some((r) => r.test(norm))) continue;
      if (src.exclude?.some((r) => r.test(norm))) continue;
      const text = readFileSync(join(root, rel), "utf8");
      if (src.tenantScopedExcluded && isTenantScopedWorkflow(text)) continue;
      for (const { address, line } of addressesInText(text)) add(address, `${norm}:${line}`);
    }
  }
  for (const e of loadRetired(root)) add(e.address, `${RETIRED_FILE}（${e.role}）`);
  return universe;
}

/** 測試與錯誤訊息用：出處的前幾個。 */
export const describeSources = (list = []) => list.slice(0, 2).join("、") + (list.length > 2 ? ` 等 ${list.length} 處` : "");

