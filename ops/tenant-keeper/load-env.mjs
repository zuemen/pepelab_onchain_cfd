#!/usr/bin/env node
// 租戶 keeper workflow 的位址來源：從**已審查、CI 比對過**的登記檔讀出這個租戶的合約，
// 以 `KEY=value` 一行一個印到 stdout（workflow 把它接到 $GITHUB_ENV）。
//
// 為什麼不把位址寫在 workflow 裡：租戶的 workflow 是由範本產生、與範本逐位元相同的檔案
// （scripts/check-workflow-guards.mjs），裡面只有租戶 id。位址只有一個來源——
//   frontend/src/contracts/deployments/<id>.json  前端部署登記（check-addresses.mjs 檢查租戶隔離）
//   deploy/tenants/<id>.json                       部署設定（check-tenant-deploy.mjs 檢查角色與參數）
// 兩份都必須是「已部署」的狀態，否則失敗，不印任何東西。
//
// 這支檔案的 sha256 與範本一起釘在 check-workflow-guards.mjs（TENANT_KEEPER_PINS）：它決定
// 持有私鑰的 job 對哪些合約送交易，改它與改 workflow 同等。
//
// 只用 node 內建模組；輸出的每一個值都先驗證格式（位址、資產代號、數字），所以印到
// $GITHUB_ENV 的內容不可能夾帶換行或其他變數。
//
// 用法：node ops/tenant-keeper/load-env.mjs <tenant-id> [--root <repo root>]

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ID = /^[a-z][a-z0-9-]{1,30}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const SYMBOL = /^s[A-Z]{2,6}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
/** 前端與 keeper 目前只支援的專屬部署鏈（與 tenantDeployment.ts 的 DEDICATED_CHAIN_ID 相同）。 */
const CHAIN = { 84532: "base-sepolia" };

export function tenantKeeperEnv(root, id) {
  if (!ID.test(id ?? "")) throw new Error(`租戶 id「${id}」格式不合`);
  const read = (rel) => {
    try {
      return JSON.parse(readFileSync(join(root, rel), "utf8"));
    } catch (e) {
      throw new Error(`${rel}：讀不到或不是合法 JSON（${e.message}）`);
    }
  };
  const reg = read(`frontend/src/contracts/deployments/${id}.json`);
  const cfg = read(`deploy/tenants/${id}.json`);
  const addr = (where, v) => {
    if (typeof v !== "string" || !ADDR.test(v) || v.toLowerCase() === ZERO) throw new Error(`${where} 不是非零位址`);
    return v;
  };

  if (reg.kind !== "dedicated" || reg.tenant !== id) {
    throw new Error(`frontend/src/contracts/deployments/${id}.json 不是這個租戶的 dedicated 登記——kind=platform 的租戶沒有自己的 keeper`);
  }
  if (cfg.tenantId !== id || cfg.status !== "deployed") {
    throw new Error(`deploy/tenants/${id}.json 不是已部署（status=deployed）的設定`);
  }
  if (!(reg.chainId in CHAIN) || cfg.network?.chainId !== reg.chainId) {
    throw new Error(`鏈不一致或不支援：登記 ${reg.chainId}、設定 ${cfg.network?.chainId}`);
  }
  if (reg.oracleKind !== cfg.params?.oracleKind) throw new Error("oracleKind 在登記與設定之間不一致");

  const c = reg.contracts ?? {};
  const out = [
    // exchange 讀的那一顆 oracle（guarded 租戶的 exchange 與金庫讀同一顆，不設 KEEPER_GUARDED_ORACLE）。
    ["KEEPER_ORACLE_ADDRESS", addr("contracts.Oracle", c.Oracle)],
    ["EXCHANGE", addr("contracts.PerpetualExchange", c.PerpetualExchange)],
    // keeper 私鑰推出來的地址必須等於這個（workflow 的下一步核對），擋住拿錯金鑰。
    ["KEEPER_EXPECTED_ADDRESS", addr("roles.keeper", cfg.roles?.keeper)],
  ];
  if (c.AssetVaultV2 !== undefined) out.push(["KEEPER_VAULT_ADDRESS", addr("contracts.AssetVaultV2", c.AssetVaultV2)]);
  if (!["guarded", "mock"].includes(reg.oracleKind)) throw new Error("oracleKind 必須是 guarded 或 mock");
  // workflow 用它決定要不要讀鏈上的 referenceSource()（MockOracle 沒有參考來源）。
  out.push(["KEEPER_ORACLE_KIND", reg.oracleKind]);
  const ref = cfg.shared?.referenceSource;
  // 設定的值只是「預期」：workflow 的下一步把它與租戶 oracle 鏈上的 referenceSource() 比對，
  // 不相等就停（複審 G4）。
  if (ref !== "none") {
    if (reg.oracleKind !== "guarded") throw new Error("oracleKind=mock 的租戶沒有參考來源，shared.referenceSource 必須是 none");
    out.push(["KEEPER_RELAY_SOURCE", addr("shared.referenceSource", ref)]);
  }
  if (reg.oracleKind === "guarded") {
    // keeper 的熔斷門檻與租戶 oracle 的單次上限一致（TENANT_OPERATIONS §1.5）。範圍同 PARAM_RANGES（複審 C1）。
    const bps = cfg.params?.oracleMaxDeviationBps;
    if (!Number.isSafeInteger(bps) || bps < 100 || bps > 1000) throw new Error("params.oracleMaxDeviationBps 不在 100–1000");
    out.push(["KEEPER_BREAKER_DEVIATION", String(bps / 10_000)]);
  }
  const syms = cfg.assets?.registered;
  if (!Array.isArray(syms) || syms.length === 0 || !syms.every((s) => typeof s === "string" && SYMBOL.test(s))) {
    throw new Error("assets.registered 不是資產代號清單");
  }
  out.push(["FUNDING_SYMBOLS", syms.join(" ")]);
  return out;
}

function main(argv) {
  const r = argv.indexOf("--root");
  const root = r >= 0 ? resolve(argv[r + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const id = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--root");
  for (const [k, v] of tenantKeeperEnv(root, id)) console.log(`${k}=${v}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`::error::tenant keeper env：${e.message}`);
    process.exit(1);
  }
}
