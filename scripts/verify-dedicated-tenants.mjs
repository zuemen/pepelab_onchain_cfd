#!/usr/bin/env node
// CI：對每一個已登記、而且有鏈上位址的專屬租戶，以公開唯讀 RPC 的 fork 跑 VerifyTenant。
//
// 為什麼要在 CI 跑：check-addresses.mjs／check-tenant-deploy.mjs 只看檔案——位址的格式、
// 不與平台共用、與部署紀錄一致。合約之間的綁定（sessionManager.exchange()==exchange…）、
// 所有權最後歸誰、部署者是否真的什麼都沒留下、oracle 的限速與風控參數是否還等於設定，
// 只有讀鏈才知道。這些由 contracts/script/VerifyTenant.s.sol 檢查；這支腳本讓每個 PR 與每天
// 的排程都自動跑一次（PR #228 審查 F2），而不是「部署的人記得跑一次」。
// 它是 CI 檢查：只有在 repo 設定 branch protection／ruleset、把 tenant-verify 列為 required
// check 之後才會擋合併。目前 master 沒有設定（擁有者的待辦，見 docs/TENANT_OPERATIONS.md §1.6）。
//
// 不需要任何 secret：只讀公開 RPC、不送交易、不帶金鑰。RPC 連不上就**失敗**（不是略過）：
// 一個沒驗證到的租戶不能被當成驗證過。
//
// 「已登記、有鏈上位址」＝frontend/src/contracts/deployments/<id>.json 是 kind=dedicated。
// check-tenant-deploy.mjs 已保證這樣的租戶有 status=deployed 的 deploy/tenants/<id>.json 與
// <id>.deployed.json；這裡再確認一次，缺了就失敗。
//
// 用法：node scripts/verify-dedicated-tenants.mjs            # CI
//       node scripts/verify-dedicated-tenants.mjs --list     # 只列出會驗證的租戶

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { listDedicatedTenantIds } from "./lib/tenant-keeper.mjs";

/** 公開、免金鑰的唯讀 RPC（每條鏈一個）。只用來讀；不在這裡放任何帶金鑰的網址。 */
export const PUBLIC_RPC = {
  84532: "https://sepolia.base.org",
  8453: "https://mainnet.base.org",
};

/** 每個要驗證的租戶：{ id, chainId, rpc }。缺檔或狀態不對直接丟錯（不略過）。 */
export function plan(root) {
  return listDedicatedTenantIds(root).map((id) => {
    const cfgFile = join(root, "deploy/tenants", `${id}.json`);
    const recFile = join(root, "deploy/tenants", `${id}.deployed.json`);
    if (!existsSync(cfgFile) || !existsSync(recFile)) {
      throw new Error(`${id}：前端登記是 dedicated，但 deploy/tenants/ 缺少 ${id}.json 或 ${id}.deployed.json`);
    }
    const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
    if (cfg.status !== "deployed") throw new Error(`${id}：deploy/tenants/${id}.json 的 status 是 ${cfg.status}，不是 deployed`);
    const chainId = cfg.network?.chainId;
    const rpc = PUBLIC_RPC[chainId];
    if (!rpc) throw new Error(`${id}：chain ${chainId} 沒有設定公開 RPC`);
    return { id, chainId, rpc };
  });
}

async function rpcChainId(rpc) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  return Number.parseInt(body.result, 16);
}

/**
 * @param {object} p
 * @param {(t: {id:string, chainId:number, rpc:string}) => number} [p.runVerify]  測試用；預設跑 forge
 * @param {(rpc: string) => Promise<number>} [p.chainIdOf]                         測試用；預設打 RPC
 * @returns {Promise<string[]>} 問題清單（空＝全部通過）
 */
export async function verifyAll({ root, log = console.log, runVerify, chainIdOf = rpcChainId }) {
  const targets = plan(root);
  log(`專屬租戶 ${targets.length} 個${targets.length ? `：${targets.map((t) => t.id).join("、")}` : "——沒有要驗證的鏈上部署"}`);
  const run =
    runVerify ??
    ((t) =>
      spawnSync("forge", ["script", "script/VerifyTenant.s.sol:VerifyTenant", "--fork-url", t.rpc, "-vv"], {
        cwd: join(root, "contracts"),
        env: { ...process.env, TENANT: t.id },
        stdio: "inherit",
      }).status);
  const problems = [];
  for (const t of targets) {
    let got;
    try {
      got = await chainIdOf(t.rpc);
    } catch (e) {
      problems.push(`${t.id}：公開 RPC ${t.rpc} 連不上（${e.message}）——沒有驗證到的租戶不算通過`);
      continue;
    }
    if (got !== t.chainId) {
      problems.push(`${t.id}：RPC ${t.rpc} 回報 chainId ${got}，設定是 ${t.chainId}`);
      continue;
    }
    log(`=== VerifyTenant ${t.id}（chain ${t.chainId}，${t.rpc}）===`);
    const status = run(t);
    if (status !== 0) problems.push(`${t.id}：VerifyTenant 失敗（exit ${status}）`);
  }
  if (problems.length) for (const p of problems) log(`::error::${p}`);
  else log(`專屬租戶鏈上驗證通過 ✓（${targets.length} 個）`);
  return problems;
}

async function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (argv.includes("--list")) {
    for (const t of plan(root)) console.log(`${t.id}\t${t.chainId}\t${t.rpc}`);
    return 0;
  }
  return (await verifyAll({ root })).length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`::error::verify-dedicated-tenants 中止：${e.message}`);
      process.exit(2);
    },
  );
}
