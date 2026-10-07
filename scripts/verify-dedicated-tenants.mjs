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

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { listDedicatedTenantIds } from "./lib/tenant-keeper.mjs";

/**
 * 公開、免金鑰的唯讀 RPC（每條鏈依序嘗試）。只用來讀；不在這裡放任何帶金鑰的網址。
 * 不只一個：sepolia.base.org 會拒絕 GitHub Actions runner 上的 forge（HTTP 401「rejected due to request
 * filter settings」），也會對權限歷史掃描的 eth_getLogs 限流。依序嘗試；某個節點因為連線／限流失敗
 * （不是驗證失敗）就換下一個，全部不行才失敗（仍不略過）。
 * logChunk：該節點 eth_getLogs 一次可查的區塊數（VerifyTenant 的 TENANT_LOG_CHUNK_BLOCKS）；
 * 越大呼叫次數越少、越不會被限流。
 */
export const PUBLIC_RPC = {
  84532: [
    { url: "https://base-sepolia-rpc.publicnode.com", logChunk: 10_000 },
    { url: "https://sepolia.base.org", logChunk: 1_000 },
    { url: "https://base-sepolia.drpc.org", logChunk: 1_000 },
  ],
  8453: [
    { url: "https://base-rpc.publicnode.com", logChunk: 10_000 },
    { url: "https://mainnet.base.org", logChunk: 1_000 },
  ],
};

/**
 * forge **stderr** 裡代表「這個節點不能用」的訊息（連線、401、限流、getLogs 被拒）。
 * 只比對 stderr：stdout 的 Logs 會印出 VerifyTenant 的檢查名稱（例如「oracle rate limit is on」），
 * 拿整份輸出比對會把真的驗證失敗誤判成節點問題。不放泛用的「rate limit」：限流由 HTTP 429 與
 * VerifyTenant 自己的「eth_getLogs refused」涵蓋。其他失敗是真的驗證失敗，不重試。
 */
export const RPC_UNUSABLE = [
  /HTTP error (401|403|429|5\d\d)/i,
  /failed to determine network family/i,
  /eth_getLogs refused/i,
  /error sending request/i,
];

/** 單一節點跑 VerifyTenant 的上限（job 是 30 分鐘；卡住的節點要留時間給下一個）。 */
export const FORGE_TIMEOUT_MS = 12 * 60 * 1000;

/** 邊跑邊印（CI log 即時），同時收集 stderr 判斷是不是節點問題。 */
function runForge(root, t) {
  return new Promise((resolve) => {
    const child = spawn("forge", ["script", "script/VerifyTenant.s.sol:VerifyTenant", "--fork-url", t.rpc, "-vv"], {
      cwd: join(root, "contracts"),
      env: { ...process.env, TENANT: t.id, TENANT_LOG_CHUNK_BLOCKS: String(t.logChunk) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, FORGE_TIMEOUT_MS);
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => {
      process.stderr.write(d);
      if (stderr.length < 1_000_000) stderr += d;
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ status: null, stderr: `error sending request: ${e.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // 逾時當成節點問題（換下一個）：卡住的是 RPC，不是驗證結果。
      resolve({ status: code, stderr: timedOut ? `${stderr}\nerror sending request: forge 逾時 ${FORGE_TIMEOUT_MS / 60000} 分鐘` : stderr });
    });
  });
}

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
    const rpcs = PUBLIC_RPC[chainId];
    if (!rpcs?.length) throw new Error(`${id}：chain ${chainId} 沒有設定公開 RPC`);
    return { id, chainId, rpcs };
  });
}

/** 用 cast 探測（與 forge 同一套 HTTP 客戶端；node fetch 通、forge 被擋的情況才探得到）。 */
async function rpcChainId(rpc) {
  const r = spawnSync("cast", ["chain-id", "--rpc-url", rpc], { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error((r.stderr || r.error?.message || `exit ${r.status}`).trim().split("\n").pop());
  return Number.parseInt(r.stdout.trim(), 10);
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
  const run = runVerify ?? ((t) => runForge(root, t));
  const problems = [];
  for (const t of targets) {
    const failures = [];
    let verdict = null; // "pass" | 真的驗證失敗的訊息
    for (const { url, logChunk } of t.rpcs) {
      let got;
      try {
        got = await chainIdOf(url);
      } catch (e) {
        failures.push(`${url} 連不上（${e.message}）`);
        continue;
      }
      if (got !== t.chainId) {
        failures.push(`${url} 回報 chainId ${got}，設定是 ${t.chainId}`);
        continue;
      }
      log(`=== VerifyTenant ${t.id}（chain ${t.chainId}，${url}）===`);
      const raw = await run({ ...t, rpc: url, logChunk });
      const { status, stderr = "" } = typeof raw === "number" ? { status: raw } : raw;
      if (status === 0) {
        verdict = "pass";
        break;
      }
      const unusable = RPC_UNUSABLE.find((re) => re.test(stderr));
      if (unusable) {
        failures.push(`${url} 在驗證途中不能用（${stderr.match(unusable)[0]}）`);
        continue;
      }
      verdict = `${t.id}：VerifyTenant 失敗（exit ${status}）`;
      break;
    }
    for (const f of failures) log(`略過 ${f}`);
    if (verdict === null) problems.push(`${t.id}：沒有可用的公開 RPC（${failures.join("；")}）——沒有驗證到的租戶不算通過`);
    else if (verdict !== "pass") problems.push(verdict);
  }
  if (problems.length) for (const p of problems) log(`::error::${p}`);
  else log(`專屬租戶鏈上驗證通過 ✓（${targets.length} 個）`);
  return problems;
}

async function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (argv.includes("--list")) {
    for (const t of plan(root)) console.log(`${t.id}\t${t.chainId}\t${t.rpcs.map((r) => r.url).join(",")}`);
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
