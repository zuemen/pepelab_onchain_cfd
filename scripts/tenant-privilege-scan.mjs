#!/usr/bin/env node
// VerifyTenant 的權限事件掃描（`_privilegeHistory` → `vm.eth_getLogs`）端到端測試。
//
// 為什麼要有這支：單元測試的 TenantVerifyHarness 把 `_privilegeHistory` 換成
// `vm.getRecordedLogs()`（測試沒有 RPC 可以打），所以真正上鏈時走的那條路——分段
// eth_getLogs、TENANT_PRIVILEGE_SCAN_MAX_BLOCKS／_REQUIRED 的分支——在 CI 裡一次都沒跑過。
// tenant-verify.yml 對公開 RPC 跑，但目前沒有任何 status=deployed 的租戶，所以也沒跑到。
//
// 做法：起一條本機 anvil（chainId 31337，broadcast 產物已被 contracts/.gitignore 排除），
// 用 anvil 的公開測試帳號真的廣播 DeployTenant，再對同一條鏈跑 VerifyTenant：
//   1. 乾淨的租戶：掃描必須成功，而且真的分了段（eth_getLogs 次數 > 來源合約數）；
//      設定用 schema v4 的 params.kycRegistry="vc"（VCKycRegistry）＋assets.additionalRwa=["sGOLD"]，
//      所以 KYC 這一路掃的是 IssuerSet 事件；admin 再指派一個發證者，驗證必須通過、只印 NOTE；
//   2. admin 把 GuardedOracle 的 KEEPER_ROLE 給一個不在任何已知名單上的位址——
//      a. 不讀歷史（MAX_BLOCKS=1、不要求）：驗證照樣通過，只印 NOTE —— 證明只有掃描看得到它；
//      b. 讀歷史：驗證必須以 "unexpected KEEPER_ROLE" 失敗；
//      c. MAX_BLOCKS=1 且 REQUIRED=true：必須拒絕，而不是靜默跳過。
//
//   node scripts/tenant-privilege-scan.mjs        （需要 PATH 上有 anvil／forge／cast）
//
// 只用 anvil 預設助記詞的公開測試金鑰，只打 127.0.0.1。寫進 deploy/tenants/ 的設定檔與
// cache/tenants/ 的紀錄在結束時刪掉。
//
// 連到的一定是自己起的 anvil：啟動前埠上已經有人回應就中止；anvil 子程序提早結束（例如埠
// 被占用）就立刻失敗；送任何交易前先確認 eth_chainId = 0x7a69 且 web3_clientVersion 是 anvil。
//
// contracts/broadcast/<script>/31337/ 是開發者自己在本機 anvil 部署時也會用到的目錄（已被
// .gitignore 排除）。開始前若已存在，先改名成 31337.bak-tenant-privilege-scan，結束時刪掉這次
// 產生的、再改名回來；程序被強制終止而沒還原時，備份會留在那個名字底下（下次執行會拒絕開始）。
//
// 每個 forge／cast 呼叫最多 10 分鐘（SCAN_STEP_TIMEOUT_MS 可調），逾時視為失敗。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS = join(ROOT, "contracts");
const PORT = Number(process.env.SCAN_ANVIL_PORT ?? 8547);
const RPC = `http://127.0.0.1:${PORT}`;
const TENANT = "ci-privilege-scan";
const CONFIG = join(ROOT, "deploy", "tenants", `${TENANT}.json`);
const RECORD = join(CONTRACTS, "cache", "tenants", `${TENANT}.deployed.json`);
const CHUNK = 7; // 小到讓整段部署歷史一定要分很多段（實際區塊數見輸出）
const STEP_TIMEOUT_MS = Number(process.env.SCAN_STEP_TIMEOUT_MS ?? 10 * 60 * 1000);
const BROADCAST_SCRIPTS = ["DeployTenant.s.sol", "VerifyTenant.s.sol", "MockUSDC.sol", "MockOracle.sol"];
const BACKUP_SUFFIX = ".bak-tenant-privilege-scan";

// anvil 預設助記詞 "test test … junk" 的帳號 0–7。公開的測試金鑰，不是任何人的資產。
const A = [
  ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"],
  ["0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"],
  ["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"],
  ["0x90F79bf6EB2c4f870365E785982E1f101E93b906"],
  ["0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"],
  ["0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"],
  ["0x976EA74026E726554dB657fA54763abd0C3a0aa9"],
  ["0x14dC79964da2C08b23698B3D3cc7Ca32193d9955"],
];
const [DEPLOYER, DEPLOYER_KEY] = A[0];
const [ADMIN, ADMIN_KEY] = A[1];
const STRANGER = A[7][0];
const ASSETS = ["sAAPL", "sGOLD", "sBOND"];

function run(cmd, args, { env = {}, expectFail = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: CONTRACTS,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: STEP_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (r.error?.code === "ETIMEDOUT") {
    throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} … 逾時（超過 ${STEP_TIMEOUT_MS / 1000} 秒），視為失敗`);
  }
  if (r.error) throw r.error;
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (!expectFail && r.status !== 0) {
    throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} … 失敗（exit ${r.status}）：\n${out.slice(-4000)}`);
  }
  if (expectFail && r.status === 0) {
    throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} … 應該失敗卻成功：\n${out.slice(-4000)}`);
  }
  return out;
}

const cast = (...args) => run("cast", [...args, "--rpc-url", RPC]).trim();
const keccak = (text) => run("cast", ["keccak", text]).trim();

function deployed(out) {
  const m = out.match(/Deployed to: (0x[0-9a-fA-F]{40})/);
  if (!m) throw new Error(`forge create 沒有印出位址：\n${out}`);
  return m[1];
}

async function rpc(method) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

// 啟動 anvil 之前：埠上已經有東西在聽，就不是我們的鏈——直接中止。
function portInUse() {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port: PORT });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => resolve(false));
  });
}

// anvil 子程序提早結束或起不來時 reject；之後每一步都先看 anvilGone。
let anvilGone = null;
let anvilStderr = "";
function watchAnvil(child) {
  return new Promise((_, reject) => {
    child.stderr?.on("data", (d) => { anvilStderr = (anvilStderr + d).slice(-4000); });
    child.once("error", (e) => {
      anvilGone = `anvil 無法啟動：${e.message}`;
      reject(new Error(anvilGone));
    });
    child.once("exit", (code, signal) => {
      anvilGone = `anvil 提早結束（exit ${code ?? signal}）——${PORT} 埠可能被占用。` +
        (anvilStderr ? `
anvil stderr：
${anvilStderr}` : "");
      reject(new Error(anvilGone));
    });
  });
}

async function waitForRpc() {
  for (let i = 0; i < 100; i++) {
    if (anvilGone) throw new Error(anvilGone);
    try {
      await rpc("eth_chainId");
      return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`anvil 沒有在 ${RPC} 起來`);
}

// 送任何交易之前：確認回應的是 anvil、chainId 31337，而且我們的子程序還活著。
async function assertOwnAnvil() {
  const chainId = await rpc("eth_chainId");
  const client = await rpc("web3_clientVersion");
  if (chainId !== "0x7a69" || typeof client !== "string" || !client.toLowerCase().startsWith("anvil")) {
    throw new Error(`${RPC} 不是本腳本起的 anvil（eth_chainId=${chainId}、web3_clientVersion=${client}），中止、不送任何交易`);
  }
  if (anvilGone) throw new Error(anvilGone);
  console.log(`✓ connected to own anvil at ${RPC} (${client})`);
}

function backupBroadcasts() {
  for (const s of BROADCAST_SCRIPTS) {
    const dir = join(CONTRACTS, "broadcast", s, "31337");
    if (existsSync(dir + BACKUP_SUFFIX)) {
      throw new Error(`${dir + BACKUP_SUFFIX} 已存在（上次執行沒有還原？）。請先手動確認並改回 31337，再重跑。`);
    }
  }
  const moved = [];
  for (const s of BROADCAST_SCRIPTS) {
    const dir = join(CONTRACTS, "broadcast", s, "31337");
    if (existsSync(dir)) {
      renameSync(dir, dir + BACKUP_SUFFIX);
      moved.push(dir);
      console.log(`  (備份既有的 ${dir} → ${BACKUP_SUFFIX}，結束時還原)`);
    }
  }
  return moved;
}

function restoreBroadcasts(moved) {
  for (const s of BROADCAST_SCRIPTS) {
    rmSync(join(CONTRACTS, "broadcast", s, "31337"), { recursive: true, force: true });
  }
  for (const dir of moved) {
    renameSync(dir + BACKUP_SUFFIX, dir);
    console.log(`  (已還原 ${dir})`);
  }
}

function verify(env, opts) {
  return run(
    "forge",
    ["script", "script/VerifyTenant.s.sol:VerifyTenant", "--rpc-url", RPC, "-vv"],
    { env: { TENANT, TENANT_RECORD: `cache/tenants/${TENANT}.deployed.json`, ...env }, ...opts },
  );
}

function assertIncludes(out, needle, what) {
  if (!out.includes(needle)) throw new Error(`${what}：輸出裡沒有「${needle}」\n${out.slice(-4000)}`);
  console.log(`✓ ${what}`);
}

if (await portInUse()) {
  console.error(`127.0.0.1:${PORT} 已經有程式在聽（不是本腳本起的 anvil），中止、不送任何交易。可用 SCAN_ANVIL_PORT 換埠。`);
  process.exit(1);
}
const moved = backupBroadcasts();
const anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "31337", "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
const anvilDied = watchAnvil(anvil);
anvilDied.catch(() => {});
let failed = false;
try {
  await Promise.race([waitForRpc(), anvilDied]);
  await assertOwnAnvil();

  // ── 共用元件：結算代幣與價格來源（DeployTenant 從它讀種子價） ─────────────
  const usdc = deployed(run("forge", ["create", "src/MockUSDC.sol:MockUSDC", "--broadcast",
    "--rpc-url", RPC, "--private-key", DEPLOYER_KEY]));
  const source = deployed(run("forge", ["create", "src/MockOracle.sol:MockOracle", "--broadcast",
    "--rpc-url", RPC, "--private-key", DEPLOYER_KEY]));
  for (const [i, sym] of ASSETS.entries()) {
    const id = keccak(sym);
    cast("send", source, "addAsset(bytes32,uint256)", id, String((i + 1) * 100e8), "--private-key", DEPLOYER_KEY);
  }
  // 保險金庫種子（1 顆）從部署者出。
  cast("send", usdc, "mint(address,uint256)", DEPLOYER, "1000000000000000000", "--private-key", DEPLOYER_KEY);

  writeFileSync(CONFIG, JSON.stringify({
    schemaVersion: 4,
    tenantId: TENANT,
    status: "ready",
    frontendTenant: TENANT,
    network: { chainId: 31337 },
    roles: { admin: ADMIN, risk: A[2][0], guardian: A[3][0], keeper: A[4][0], marketOperator: A[5][0], treasury: A[6][0] },
    shared: { settlementToken: usdc, priceSource: source, referenceSource: "none" },
    params: {
      oracleKind: "guarded", oracleMaxDeviationBps: 1000, oracleWindowSeconds: 3600, oracleWindowDeviationBps: 2500,
      oiCapNonRwaUsdc: 1000, oiCapRwaUsdc: 500, maxProfitBps: 50000, maxLeverage: 5,
      liquidationPenaltyBps: 2000, markPremiumCapBps: 0, vaultFeeShareBps: 0,
      deployVault: true, vaultRedeemFeeBps: 30, vaultMinReserveRatioBps: 11000,
      kycRegistry: "vc",
    },
    assets: { registered: ASSETS, additionalRwa: ["sGOLD"] },
  }, null, 2));

  run("forge", ["script", "script/DeployTenant.s.sol:DeployTenant", "--rpc-url", RPC,
    "--private-key", DEPLOYER_KEY, "--broadcast", "--slow"],
    { env: { TENANT, ALLOW_EOA_ADMIN: "true" } });
  if (!existsSync(RECORD)) throw new Error(`DeployTenant 沒有寫出 ${RECORD}`);
  console.log("✓ DeployTenant broadcast on anvil");

  // ── 1. 乾淨的租戶：真的分段掃描 ───────────────────────────────────────────
  const clean = verify({ TENANT_LOG_CHUNK_BLOCKS: String(CHUNK), TENANT_PRIVILEGE_SCAN_REQUIRED: "true" });
  const m = clean.match(/privilege history read: blocks \/ eth_getLogs calls \/ grant events (\d+) (\d+) (\d+)/);
  if (!m) throw new Error(`沒有讀到掃描摘要：\n${clean.slice(-4000)}`);
  const [blocks, calls, grants] = m.slice(1).map(Number);
  // 來源合約：exchange、KYC、ESG、oracle、資產金庫＋每個資產代幣。
  const sources = 5 + ASSETS.length;
  if (!(blocks > CHUNK && calls === Math.ceil(blocks / CHUNK) * sources && grants > 0)) {
    throw new Error(`掃描數字不對：blocks=${blocks} calls=${calls} grants=${grants}（預期分段 ${CHUNK}、來源 ${sources} 個）`);
  }
  console.log(`✓ clean tenant: ${blocks} blocks in ${Math.ceil(blocks / CHUNK)} chunks, ${calls} eth_getLogs calls, ${grants} grant events`);

  // ── 1b. admin 指派 VC 發證者：上線後的營運任命，掃描讀到 IssuerSet，只印 NOTE ──────
  const issuerRecord = JSON.parse(readFileSync(RECORD, "utf8"));
  cast("send", issuerRecord.contracts.KYCRegistry, "setIssuer(address,bytes32,bool)", STRANGER,
    keccak("QUALIFIED_INVESTOR"), "true", "--private-key", ADMIN_KEY);
  const appointed = verify({ TENANT_LOG_CHUNK_BLOCKS: String(CHUNK), TENANT_PRIVILEGE_SCAN_REQUIRED: "true" });
  assertIncludes(appointed, "NOTE trusted credential issuer", "an issuer the admin appointed is reported, not failed");
  console.log("✓ VC issuer appointment read from IssuerSet events (NOTE)");

  // ── 2. 鏈上多一個陌生的 KEEPER ────────────────────────────────────────────
  const record = JSON.parse(readFileSync(RECORD, "utf8"));
  const oracle = record.contracts.Oracle;
  const keeperRole = keccak("KEEPER_ROLE");
  cast("send", oracle, "grantRole(bytes32,address)", keeperRole, STRANGER, "--private-key", ADMIN_KEY);

  const blind = verify({ TENANT_PRIVILEGE_SCAN_MAX_BLOCKS: "1" });
  assertIncludes(blind, "privilege history not read", "without the scan the stranger goes unnoticed (NOTE only)");

  const caught = verify({ TENANT_LOG_CHUNK_BLOCKS: String(CHUNK), TENANT_PRIVILEGE_SCAN_REQUIRED: "true" }, { expectFail: true });
  assertIncludes(caught, "unexpected KEEPER_ROLE", "the eth_getLogs scan catches the stranger");

  const refused = verify({ TENANT_PRIVILEGE_SCAN_MAX_BLOCKS: "1", TENANT_PRIVILEGE_SCAN_REQUIRED: "true" }, { expectFail: true });
  assertIncludes(refused, "TENANT_PRIVILEGE_SCAN_REQUIRED=true", "SCAN_REQUIRED refuses a history it cannot read");

  console.log("\n✅ VerifyTenant privilege scan exercised against a real RPC");
} catch (e) {
  failed = true;
  console.error(e.message ?? e);
} finally {
  anvil.removeAllListeners("exit");
  anvil.kill();
  rmSync(CONFIG, { force: true });
  rmSync(RECORD, { force: true });
  restoreBroadcasts(moved);
}
// 不用 process.exit()：Windows 上 fetch／子程序的 handle 還在關閉時硬退會觸發 libuv 斷言。
process.exitCode = failed ? 1 : 0;
