// 平台位址全集：平台（default 租戶）在 repo 裡任何地方用過、提過的位址。
//
// 專屬租戶的部署登記（frontend/src/contracts/deployments/<id>.json）與部署設定
// （deploy/tenants/<id>.json）用它做租戶隔離的比對（ADR-008）。
//
// 為什麼是「全集」而不是一份手寫的角色清單或來源目錄：手列來源目錄時，只寫在
// contracts/script、scripts/*.sh、docs/ 的平台角色 EOA（owner／admin／guardian／risk），
// 以及只出現在 ops/monitoring、contracts/broadcast 的平台合約都不在裡面（PR #228 複審 A1、A2）。
// 這裡改成結構性的「預設全收、排除要寫理由」：
//   1. repo 裡**所有被 git 追蹤（或新增但未被 .gitignore 忽略）的文字檔**，文字裡出現的每一個
//      位址都算（含註解；ops/monitoring 與廣播紀錄裡補零成 32 位元組的位址也抽出來）；
//   2. 只排除 UNIVERSE_EXCLUDES 列的檔案（租戶自己的檔案、測試 fixture、第三方 lib、
//      lockfile、產生的 bundle），每一條都寫了理由；
//   3. 再扣掉 WELL_KNOWN_NON_PLATFORM 的具名白名單（零位址、預編譯合約、官方 USDC、Permit2、
//      Anvil 預設帳號），每一筆都寫了理由；
//   4. 加上機器可讀的退役清單 frontend/src/contracts/retiredPlatformAddresses.json
//      （只留在 git 歷史裡的舊合約）。
// 新增平台合約、換掉舊合約時不需要改這支程式：寫進 repo 任何地方就自動納入。
//
// 不分鏈：同一個位址在兩條鏈上屬於不同合約的機率可以忽略，不分鏈只會更嚴。
// 檔案清單取自 `git ls-files`（CI 一定有 git；拿不到清單時直接丟錯，不會默默少擋）。
// 零依賴（只用 node 內建模組）。

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseJsonStrict } from "./strict-json.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";

/** 文字裡的位址：0x＋40 位十六進位，前後都不能再接十六進位字元（排除 bytes32、交易 hash）。 */
export const ADDRESS_IN_TEXT = /(?<![0-9a-zA-Z])0x[0-9a-fA-F]{40}(?![0-9a-zA-Z])/g;
/**
 * 補零成 32 位元組的位址（ops/monitoring/deployed.json 的 reads、廣播紀錄的 log topic）：
 * 0x＋24 個 0＋40 位。只收高 32 位元不全為 0 的值——小整數（金額、秒數、旗標）補零後也長這樣，
 * 而真正的位址前 8 個十六進位字元全為 0 的機率是 2^-32。
 */
export const PADDED_ADDRESS_IN_TEXT = /(?<![0-9a-zA-Z])0x0{24}([0-9a-fA-F]{40})(?![0-9a-zA-Z])/g;

export const RETIRED_FILE = "frontend/src/contracts/retiredPlatformAddresses.json";

/**
 * 不納入全集的檔案（相對 repo 根目錄、正斜線）。清單刻意最小；每一條都要有理由。
 * 另外：帶 `KEEPER_TENANT:` 的租戶 workflow 不算平台的（isTenantScopedWorkflow）。
 */
export const UNIVERSE_EXCLUDES = [
  {
    // docs/ 與 broadcast/ 只排除「某個租戶 id 底下」的檔案：id 必須是 slug、不可是平台的 default；
    // 目錄直下的檔案與不合格的 id 照樣算平台的，另由 check-tenant-deploy.mjs 的 checkTenantDirs 報錯。
    re: /^(deploy\/tenants\/|(?:docs|contracts\/broadcast)\/tenants\/(?!default\/)[a-z0-9]+(?:-[a-z0-9]+)*\/)/,
    why:
      "租戶自己的設定、紀錄、廣播紀錄與文件（deploy/tenants/、docs/tenants/<id>/、contracts/broadcast/tenants/<id>/）；" +
      "這些位址另由 check-tenant-deploy.mjs 併入該租戶做跨租戶比對。租戶廣播一律以 FOUNDRY_BROADCAST=broadcast/tenants/<id> 寫到這裡，" +
      "否則部署者與整組合約會被當成平台位址",
  },
  {
    re: /^frontend\/src\/contracts\/deployments\/(?!default\.json$)/,
    why: "租戶自己的前端部署登記（default.json 是平台的，仍納入）",
  },
  { re: /(^|\/)(test|tests|testing|__tests__|__snapshots__|__mocks__|fixtures)\//, why: "測試 fixture 與快照（虛構位址）" },
  { re: /\.(test|spec)\.[cm]?[jt]sx?$/, why: "測試檔（虛構位址）" },
  { re: /\.t\.sol$/, why: "Foundry 測試檔（虛構位址）" },
  { re: /^contracts\/lib\//, why: "第三方函式庫（forge-std、OpenZeppelin）" },
  { re: /(^|\/)node_modules\//, why: "第三方套件" },
  {
    re: /(^|\/)(yarn\.lock|package-lock\.json|pnpm-lock\.yaml|npm-shrinkwrap\.json|foundry\.lock)$/,
    why: "lockfile（套件雜湊）",
  },
  {
    re: /^agent\/signal-api\/api\/index\.js$/,
    why: "esbuild 產生的部署 bundle（內含第三方套件的各鏈常數；平台位址的原始碼在 agent/ 其他檔案，照樣納入）",
  },
  { re: /(^|\/)dist\//, why: "建置產物" },
  { re: /\.min\.js$/, why: "壓縮後的建置產物" },
];

/** 某個 repo 相對路徑（正斜線）是否被排除；回傳理由或 null。 */
export function excludedReason(rel) {
  const hit = UNIVERSE_EXCLUDES.find((e) => e.re.test(rel));
  return hit ? hit.why : null;
}

const PRECOMPILES = [
  ...Array.from({ length: 0x11 }, (_, i) => i + 1), // 0x01–0x11：以太坊預編譯（含 Cancun 0x0a、Prague BLS 0x0b–0x11）
  0x100, // RIP-7212 P256VERIFY（Base／OP Stack）
].map((n) => ({
  address: `0x${n.toString(16).padStart(40, "0")}`,
  name: `precompile 0x${n.toString(16)}`,
  why: "EVM 預編譯合約，每條鏈都有、不屬於任何人",
}));

/** Anvil／Hardhat 預設助記詞的前 10 個帳號：私鑰公開，任何人都能簽章。 */
export const ANVIL_DEFAULT_ACCOUNTS = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
  "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
];

/**
 * 出現在 repo 裡、但**不是平台的**眾所周知位址。從全集扣掉，避免把公共設施或第三方合約算成
 * 「平台用過」。逐筆寫理由。從全集扣掉**不代表**租戶可以用：
 *   - 零位址本來就被每一個位址欄位擋下；
 *   - Anvil 預設帳號另由 publicKeyAccountProblem() 擋（私鑰公開）；
 *   - USDC 等共用元件只能經由 shared 白名單（平台在該鏈的指定角色）出現。
 */
export const WELL_KNOWN_NON_PLATFORM = [
  { address: ZERO, name: "zero address", why: "零位址；每個位址欄位另外都擋零位址" },
  ...PRECOMPILES,
  {
    address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    name: "Circle USDC（Base Sepolia）",
    why: "Circle 發行的官方測試網 USDC（x402 付款幣），不是平台部署的合約",
  },
  {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    name: "Circle USDC（Base 主網）",
    why: "Circle 發行的官方 USDC，不是平台部署的合約",
  },
  {
    address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
    name: "Circle USDC（Ethereum Sepolia）",
    why: "Circle 發行的官方測試網 USDC，不是平台部署的合約",
  },
  {
    address: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    name: "Uniswap Permit2",
    why: "各鏈同一位址的公共合約（CREATE2），不屬於平台",
  },
  ...ANVIL_DEFAULT_ACCOUNTS.map((address, i) => ({
    address,
    name: `Anvil 預設帳號 #${i}`,
    why: "本機開發鏈的公開測試帳號，不是平台的角色；租戶也不得使用（publicKeyAccountProblem）",
  })),
];

const WELL_KNOWN = new Map(WELL_KNOWN_NON_PLATFORM.map((e) => [e.address.toLowerCase(), e]));
const ANVIL = new Map(ANVIL_DEFAULT_ACCOUNTS.map((a, i) => [a.toLowerCase(), i]));

/** 白名單裡的位址 → 條目；不在白名單回傳 undefined。 */
export const wellKnownEntry = (address) => WELL_KNOWN.get(String(address).toLowerCase());

/** 私鑰公開的帳號不得作為租戶的角色、部署者或合約位址。回傳錯誤訊息或 null。 */
export function publicKeyAccountProblem(path, value) {
  const i = ANVIL.get(String(value).toLowerCase());
  return i === undefined
    ? null
    : `${path}=${value} 是 Anvil 預設帳號 #${i}（私鑰公開，任何人都能簽章）——不得作為租戶的角色、部署者或合約`;
}

/** workflow 是否屬於某個租戶（帶 `KEEPER_TENANT:` 鍵）。 */
export const isTenantScopedWorkflow = (text) => /^\s*KEEPER_TENANT\s*:/m.test(text);

/** 文字裡所有位址（原樣），附行號。含補零成 32 位元組的位址。 */
export function addressesInText(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    for (const m of line.matchAll(ADDRESS_IN_TEXT)) out.push({ address: m[0], line: idx + 1 });
    for (const m of line.matchAll(PADDED_ADDRESS_IN_TEXT)) {
      if (!/^0{8}/.test(m[1])) out.push({ address: `0x${m[1]}`, line: idx + 1 });
    }
  });
  return out;
}

/** repo 的檔案清單（被追蹤的＋未被忽略的新檔），相對路徑、正斜線。拿不到就丟錯。 */
export function repoFiles(root) {
  let out;
  try {
    out = execFileSync(
      "git",
      ["-C", root, "-c", "core.quotepath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    throw new Error(`平台位址全集：無法以 git ls-files 列出 ${root} 的檔案（${String(e.message).split("\n")[0]}）`);
  }
  return [...new Set(out.split("\0").filter(Boolean))].sort();
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
 * @param {string} root  repo 根目錄
 * @param {{ files?: string[] }} [opts]  測試用：直接給檔案清單（相對路徑），不呼叫 git
 * @returns {Map<string, string[]>}  小寫位址 → 出處（`檔案:行`）
 */
export function platformAddressUniverse(root, { files } = {}) {
  const universe = new Map();
  const add = (address, where) => {
    const low = address.toLowerCase();
    if (WELL_KNOWN.has(low)) return;
    if (!universe.has(low)) universe.set(low, []);
    universe.get(low).push(where);
  };
  for (const rel of files ?? repoFiles(root)) {
    if (excludedReason(rel)) continue;
    let buf;
    try {
      if (!statSync(join(root, rel)).isFile()) continue; // submodule 的 gitlink、已刪除的檔案
      buf = readFileSync(join(root, rel));
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // 二進位檔（圖片、字型）
    const text = buf.toString("utf8");
    if (rel.startsWith(".github/workflows/") && isTenantScopedWorkflow(text)) continue;
    for (const { address, line } of addressesInText(text)) add(address, `${rel}:${line}`);
  }
  for (const e of loadRetired(root)) add(e.address, `${RETIRED_FILE}（${e.role}）`);
  return universe;
}

/** 測試與錯誤訊息用：出處的前幾個。 */
// 廣播紀錄排在最後：同一個位址若也出現在腳本、文件或設定裡，那些出處比較好讀。
export const describeSources = (list = []) => {
  const ordered = [...list.filter((s) => !s.startsWith("contracts/broadcast/")), ...list.filter((s) => s.startsWith("contracts/broadcast/"))];
  return ordered.slice(0, 2).join("、") + (ordered.length > 2 ? ` 等 ${ordered.length} 處` : "");
};
