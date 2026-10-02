// 租戶 keeper workflow 的唯一產生方式：範本＋租戶 id（ADR-008、PR #228 審查 F3）。
//
//   ops/tenant-keeper/keeper.template.yml   範本（整檔 sha256 釘在 check-workflow-guards.mjs）
//   ops/tenant-keeper/load-env.mjs          執行期從部署登記讀位址（同樣釘選）
//   .github/workflows/keeper-<id>.yml       產生的結果：範本裡的 __TENANT_ID__ 換成 <id>，其餘一字不改
//
// check-workflow-guards.mjs 對每一支 keeper-<id>.yml 重新產生一次、逐位元比對。所以新增租戶
// 不必改任何釘選雜湊，也不可能藉由租戶的 workflow 偷改守門 step——要改行為只能改範本，
// 而範本本身是釘選的。
//
// 零依賴（只用 node 內建模組）。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseJsonStrict } from "./strict-json.mjs";

/**
 * 租戶 id 的格式。比部署登記的檔名規則更嚴：小寫字母開頭、2–31 個字元、只有小寫英數與連字號。
 * 它會被代入 YAML（workflow 名稱、environment、concurrency group、env 值），所以不允許任何
 * 引號、空白、冒號、`${{`——代入的結果不可能改變 YAML 的結構。
 */
export const TENANT_KEEPER_ID = /^[a-z][a-z0-9-]{1,30}$/;
/**
 * 不能當租戶 id 的名字（複審 G6）：會產生 keeper-keeper、keeper-settlement 這類容易與平台
 * environment（keeper、settlement、admin-approval）混淆的名稱，或與平台／default 租戶同名。
 */
export const RESERVED_TENANT_IDS = ["keeper", "settlement", "admin", "admin-approval", "platform", "default"];
const isTenantKeeperId = (id) => typeof id === "string" && TENANT_KEEPER_ID.test(id) && !RESERVED_TENANT_IDS.includes(id);
export const PLACEHOLDER = "__TENANT_ID__";
export const TEMPLATE_FILE = "ops/tenant-keeper/keeper.template.yml";
export const LOADER_FILE = "ops/tenant-keeper/load-env.mjs";
export const KEEPER_JOB = "keep";

export const tenantKeeperFileName = (id) => `keeper-${id}.yml`;
export const tenantKeeperEnvironment = (id) => `keeper-${id}`;

/** `keeper-<id>.yml` → id；不是這個形狀（或 id 格式不合）回 null。 */
export function tenantIdOfKeeperFile(name) {
  const m = /^keeper-(.+)\.yml$/.exec(name);
  return m && isTenantKeeperId(m[1]) ? m[1] : null;
}

/** 範本代入 id。id 格式不合就丟錯（產生器與檢查器共用這一個函式）。 */
export function renderTenantKeeper(templateText, id) {
  if (!isTenantKeeperId(id)) {
    throw new Error(`租戶 id「${id}」格式不合（必須符合 ${TENANT_KEEPER_ID}，且不是保留字 ${RESERVED_TENANT_IDS.join("、")}）`);
  }
  if (!templateText.includes(PLACEHOLDER)) throw new Error(`範本裡沒有 ${PLACEHOLDER}`);
  return templateText.split(PLACEHOLDER).join(id);
}

/** 已登記的專屬租戶 id：frontend/src/contracts/deployments/<id>.json 且 kind=dedicated。 */
export function listDedicatedTenantIds(root) {
  const dir = join(root, "frontend/src/contracts/deployments");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const id = f.slice(0, -".json".length);
    let dep;
    try {
      dep = parseJsonStrict(readFileSync(join(dir, f), "utf8")).value;
    } catch {
      continue; // 壞掉的登記檔由 check-addresses.mjs 報；在這裡它就是「沒有登記」
    }
    if (dep && dep.kind === "dedicated" && dep.tenant === id) out.push(id);
  }
  return out;
}

/** check-workflow-guards.mjs 用的租戶 keeper 設定（從 repo 讀）。 */
export function loadTenantKeeperContext(root) {
  return {
    templateText: readFileSync(join(root, TEMPLATE_FILE), "utf8"),
    loaderText: readFileSync(join(root, LOADER_FILE), "utf8"),
    tenants: listDedicatedTenantIds(root),
  };
}
