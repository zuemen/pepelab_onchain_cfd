#!/usr/bin/env node
// 平台 cutover 全程演練：在 Base Sepolia 實況的 anvil fork 上，以**真的交易**依序跑完
// docs/OWNER_ACTIONS.md 第 5 步的每一支部署腳本，每一步之後讀回核對。**不需要、也不讀任何私鑰**。
//
// 為什麼要有這支：test/fork/*.t.sol 在測試行程裡呼叫腳本（vm.prank／broadcasterOverride），
// 而且 CI 平常不帶 --fork-url，四支 fork 測試一律 skip。真正 broadcast 時才會走的路——
// forge script 的 broadcast（ExchangeOpsLib 以 CREATE2 部署並 link、--slow 逐筆送出）、
// 腳本之間的位址交接（上一支印出的位址是下一支的輸入）、timelock 排程→等待→執行——
// 以前只有擁有者動手那天才第一次跑到。這裡在 anvil 上照順序跑一遍：
//
//   0. keeper heartbeat（以 keeper 身分把現價原樣重寫一次，同 OWNER_ACTIONS「先 dispatch keeper」）
//   1. Redeploy130Hardened（先 PREFLIGHT_ONLY）→ 2. Verify130
//   3. RedeployGuardedOracle → 4. UpgradeVaultToV2_5
//   5. DeploySessionCredentialAnchor（綁新的 AgentSessionManager；平台從未部署過）
//   6. DeployGovernance → 7. HandoverToTimelock phase 1
//   8. RedeployInsuranceStack（TIMELOCK）→ VERIFY_ONLY → timelock scheduleBatch → 等 minDelay →
//      ReduceOnly → executeBatch → 回 Active → 讀回 exchange／TraderStake 的新指標
//   9. DeployPepeIncentives（綁最終 CopyTracker）→ 10. DeployAMM（MockUSDC owner 簽）
//   11. HandoverToTimelock phase 2 → VerifyHandover
//
// 演練專用、真實部署**不可**照抄的值：GUARDIAN／TREASURY／timelock 的 proposer、executor 是演練用的
// 空白地址（真實部署要用另一把熱錢包、treasury 與 Safe）；ALLOW_EOA_ROLES=true；部署者 MockUSDC
// 不足 1 枚時由 MockUSDC owner 補發（真實部署要用新資金）。這些都會印在結果裡。
//
// 用法：node scripts/cutover-rehearsal.mjs      （PATH 上要有 anvil／forge／cast；需要能連公開 RPC）
//   REHEARSAL_RPC=<url>        指定 fork 來源（預設依序試 PUBLIC_RPC）
//   REHEARSAL_ANVIL_PORT=8549  本機 anvil 埠
//   GITHUB_STEP_SUMMARY        有設定時把結果表寫進去（CI）
//
// 只打 127.0.0.1 上自己起的 anvil（啟動前埠上已有人回應就中止；送交易前確認 chainId=84532 且
// client 是 anvil）。broadcast 產物寫在 contracts/cache/rehearsal/（.gitignore 已排除），
// 不碰 contracts/broadcast/ 裡收進版控的部署紀錄。

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS = join(ROOT, "contracts");
const PORT = Number(process.env.REHEARSAL_ANVIL_PORT ?? 8549);
const LOCAL = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 84532;
const STEP_TIMEOUT_MS = 20 * 60 * 1000;
const OUT_DIR = join(CONTRACTS, "cache", "rehearsal");

export const PUBLIC_RPC = [
  "https://base-sepolia-rpc.publicnode.com",
  "https://sepolia.base.org",
  "https://base-sepolia.drpc.org",
];

// 鏈上實況（與 contracts/script/*.s.sol 的常數相同）。
const OWNER = "0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585"; // DEPLOY_130_CUTOVER.md §2 指定的部署者
const KEEPER = "0x540aECD37E7A7885824e7b7e996eBddfb842ef17"; // MockOracle owner／GuardedOracle KEEPER／marketOperator
const MOCK_ORACLE = "0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3";
const OLD_GUARDED_ORACLE = "0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842";
const VAULT_PROXY = "0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a";
const USDC = "0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035";
const PEPE_TOKEN = "0xccd05cbdc2f7961a4c27d3633694022722786a0f";

// 演練用的角色地址：沒有程式碼、沒有人持有私鑰的空白地址（anvil 會自動假冒）。
// 真實部署：GUARDIAN 是另一把熱錢包，TREASURY 是平台金庫，proposer／executor 是 Safe。
const R = {
  GUARDIAN: "0x00000000000000000000000000000000000a11ce",
  TREASURY: "0x00000000000000000000000000000000000b0b00",
  PROPOSER: "0x00000000000000000000000000000000000c0de1",
  EXECUTOR: "0x00000000000000000000000000000000000c0de2",
};

const SYMS = ["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"];

/** 一步的結果：{ name, ok, note }。 */
const results = [];
const addrs = {};
const caveats = [];

function sh(cmd, args, { env = {}, allowFail = false, quiet = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: CONTRACTS,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: STEP_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error?.code === "ETIMEDOUT") throw new Error(`${cmd} ${args[0]} 逾時`);
  if (r.error) throw r.error;
  if (!quiet) process.stdout.write(out);
  if (r.status !== 0 && !allowFail) {
    const tail = out.trim().split("\n").slice(-6).join("\n");
    throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} 失敗（exit ${r.status}）\n${tail}`);
  }
  return { status: r.status, out };
}

const cast = (args, opts) => sh("cast", args, { quiet: true, ...opts }).out.trim();
const call = (to, sig, ...a) => cast(["call", to, sig, ...a, "--rpc-url", LOCAL]).split("\n")[0].split(" ")[0];
const send = (from, to, sig, ...a) => cast(["send", to, sig, ...a, "--from", from, "--unlocked", "--rpc-url", LOCAL]);
const rpc = (method, ...params) => cast(["rpc", method, ...params, "--rpc-url", LOCAL]);
const id = (sym) => cast(["keccak", sym]);
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

function forgeScript(name, { env = {}, broadcast = true, sender = OWNER, extra = [] } = {}) {
  const args = ["script", `script/${name}.s.sol:${name}`, "--rpc-url", LOCAL, "-vv", ...extra];
  if (broadcast) args.push("--unlocked", "--sender", sender, "--broadcast", "--slow");
  console.log(`::group::forge script ${name}`);
  try {
    return sh("forge", args, { env: { FOUNDRY_BROADCAST: "cache/rehearsal/broadcast", ...env } }).out;
  } finally {
    console.log("::endgroup::");
  }
}

/** `NAME = 0x…` 或 `NAME: 0x…`（console.log 的兩種寫法）。 */
function grab(out, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = out.match(new RegExp(`${esc}\\s*[=:]\\s*(0x[0-9a-fA-F]{40})`));
  if (!m) throw new Error(`輸出裡找不到 ${label}`);
  return m[1];
}
function grabNum(out, label) {
  const m = out.match(new RegExp(`${label}\\s*=\\s*(\\d+)`));
  if (!m) throw new Error(`輸出裡找不到 ${label}`);
  return m[1];
}
/** 標題行的下一行（console.logBytes 印的 hex）。 */
function grabBytesAfter(out, heading) {
  const lines = out.split("\n");
  const i = lines.findIndex((l) => l.includes(heading));
  if (i < 0) throw new Error(`輸出裡找不到「${heading}」`);
  const hex = lines.slice(i + 1).map((l) => l.trim()).find((l) => /^0x[0-9a-fA-F]*$/.test(l));
  if (!hex) throw new Error(`「${heading}」後面沒有 hex`);
  return hex;
}

async function step(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    const note = (await fn()) ?? "";
    results.push({ name, ok: true, note });
    console.log(`ok   ${name}${note ? `：${note}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, note: e.message.split("\n")[0] });
    console.log(`FAIL ${name}\n${e.message}`);
    throw e;
  }
}

/** GuardedOracle 的 getPrice 在過期時會 revert，所以 guarded 用 peek 讀現價。 */
function heartbeat(oracle, label, { guarded = false } = {}) {
  let n = 0;
  for (const s of SYMS) {
    const sig = guarded ? "peek(bytes32)(uint256,uint256,bool,bool)" : "getPrice(bytes32)(uint256,uint256)";
    const raw = cast(["call", oracle, sig, id(s), "--rpc-url", LOCAL]);
    const price = raw.split("\n")[0].split(" ")[0];
    send(KEEPER, oracle, "updatePrice(bytes32,uint256)", id(s), price);
    n++;
  }
  return `${label}：${n} 檔以 keeper 身分原價重寫`;
}

function portInUse(port) {
  return new Promise((res) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), res(true)));
    s.once("error", () => res(false));
  });
}

async function startAnvil() {
  if (await portInUse(PORT)) throw new Error(`127.0.0.1:${PORT} 已經有人在聽——不連到不是自己起的節點`);
  const candidates = process.env.REHEARSAL_RPC ? [process.env.REHEARSAL_RPC] : PUBLIC_RPC;
  let source = null;
  for (const url of candidates) {
    const r = spawnSync("cast", ["chain-id", "--rpc-url", url], { encoding: "utf8", timeout: 30_000 });
    if (r.status === 0 && Number(r.stdout.trim()) === CHAIN_ID) {
      source = url;
      break;
    }
    console.log(`略過 ${url}（${(r.stderr || r.stdout || "").trim().split("\n").pop()}）`);
  }
  if (!source) throw new Error("沒有可用的 Base Sepolia 公開 RPC");
  const child = spawn("anvil", ["--fork-url", source, "--port", String(PORT), "--auto-impersonate", "--silent", "--retries", "10", "--timeout", "60000"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  let exited = null;
  child.on("exit", (c) => (exited = c));
  for (let i = 0; i < 120; i++) {
    if (exited !== null) throw new Error(`anvil 提早結束（exit ${exited}）`);
    const r = spawnSync("cast", ["chain-id", "--rpc-url", LOCAL], { encoding: "utf8", timeout: 10_000 });
    if (r.status === 0) {
      if (Number(r.stdout.trim()) !== CHAIN_ID) throw new Error(`本機節點 chainId ${r.stdout.trim()}，不是 ${CHAIN_ID}`);
      const client = cast(["rpc", "web3_clientVersion", "--rpc-url", LOCAL]);
      if (!/anvil/i.test(client)) throw new Error(`本機節點不是 anvil：${client}`);
      const block = cast(["block-number", "--rpc-url", LOCAL]);
      return { child, source, block };
    }
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  throw new Error("anvil 兩分鐘內沒有就緒");
}

function summary(meta) {
  const lines = [
    "## 平台 cutover 演練（anvil fork，未廣播到任何真實鏈）",
    "",
    `fork 來源：${meta.source}，區塊 ${meta.block}；部署者 \`${OWNER}\`（anvil 假冒，沒有私鑰）`,
    "",
    "| 步驟 | 結果 | 說明 |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.name} | ${r.ok ? "✅" : "❌"} | ${r.note.replace(/\|/g, "\\|")} |`),
    "",
  ];
  if (Object.keys(addrs).length) {
    lines.push("演練中產生的位址（只存在於這次 fork，**不是**要填進設定的值）：", "", "| 名稱 | 位址 |", "|---|---|");
    for (const [k, v] of Object.entries(addrs)) lines.push(`| ${k} | \`${v}\` |`);
    lines.push("");
  }
  if (caveats.length) lines.push("演練與真實部署不同的地方：", "", ...caveats.map((c) => `- ${c}`), "");
  const md = lines.join("\n");
  console.log(`\n${md}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
}

async function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  console.log("::group::forge build");
  sh("forge", ["build"], { quiet: true });
  console.log("::endgroup::");

  const meta = await startAnvil();
  console.log(`anvil fork of ${meta.source} at block ${meta.block} on ${LOCAL}`);
  caveats.push(`GUARDIAN／TREASURY／timelock proposer、executor 是演練用空白地址（${Object.values(R).join("、")}）；真實部署要用另一把熱錢包、平台 treasury 與 Safe`);
  caveats.push("DeployGovernance 以 ALLOW_EOA_ROLES=true 執行（真實部署的 proposer／executor 必須是 Safe 合約）");
  try {
    for (const a of [OWNER, KEEPER, ...Object.values(R)]) rpc("anvil_setBalance", a, "0x56BC75E2D63100000"); // 100 ETH

    await step("0. keeper heartbeat", () => [heartbeat(MOCK_ORACLE, "MockOracle"), heartbeat(OLD_GUARDED_ORACLE, "GuardedOracle（舊）", { guarded: true })].join("；"));

    let cut;
    await step("1a. Redeploy130Hardened 預檢", () => {
      const r = sh("forge", ["script", "script/Redeploy130Hardened.s.sol:Redeploy130Hardened", "--rpc-url", LOCAL, "--sender", OWNER, "-vv"], {
        env: { GUARDIAN: R.GUARDIAN, PREFLIGHT_ONLY: "true" },
        allowFail: true,
      });
      if (r.status === 0) return "舊 exchange 沒有未平倉";
      if (/old exchange has open positions/.test(r.out)) {
        const n = (r.out.match(/!!! (\d+) OPEN position/) ?? [])[1] ?? "?";
        caveats.push(`**真實阻擋項**：舊 exchange 有 ${n} 個未平倉，正式 cutover 前要先平倉／清算（DEPLOY_130_CUTOVER.md §5.1）；演練以 ALLOW_OPEN_POSITIONS=true 繼續`);
        process.env.ALLOW_OPEN_POSITIONS = "true";
        return `舊 exchange 有 ${n} 個未平倉（真實阻擋項，見下方）；演練帶 ALLOW_OPEN_POSITIONS=true 繼續`;
      }
      throw new Error(r.out.trim().split("\n").slice(-6).join("\n"));
    });
    await step("1b. Redeploy130Hardened broadcast", () => {
      cut = forgeScript("Redeploy130Hardened", { env: { GUARDIAN: R.GUARDIAN } });
      for (const k of ["EXCHANGE_NEW", "COPYTRACKER_NEW", "STRATEGY_REGISTRY_NEW", "SESSION_MANAGER_NEW", "TRADER_STAKE"]) addrs[k] = grab(cut, k);
      addrs.OI_CAP_NON_RWA_USDC = grabNum(cut, "OI_CAP_NON_RWA_USDC");
      addrs.OI_CAP_RWA_USDC = grabNum(cut, "OI_CAP_RWA_USDC");
      return `新 exchange ${addrs.EXCHANGE_NEW}；OI 上限 ${addrs.OI_CAP_NON_RWA_USDC}／${addrs.OI_CAP_RWA_USDC} USDC`;
    });
    const v130 = {
      EXCHANGE_NEW: addrs.EXCHANGE_NEW,
      COPYTRACKER_NEW: addrs.COPYTRACKER_NEW,
      STRATEGY_REGISTRY_NEW: addrs.STRATEGY_REGISTRY_NEW,
      SESSION_MANAGER_NEW: addrs.SESSION_MANAGER_NEW,
      GUARDIAN: R.GUARDIAN,
      OI_CAP_NON_RWA_USDC: addrs.OI_CAP_NON_RWA_USDC,
      OI_CAP_RWA_USDC: addrs.OI_CAP_RWA_USDC,
    };
    await step("2. Verify130", () => (forgeScript("Verify130", { env: v130, broadcast: false }), "全部斷言通過"));

    await step("3. RedeployGuardedOracle", () => {
      // KEEPER_HEARTBEAT：base-sepolia-keeper 的實際值（agent/keeper/run.ts 預設 900 秒、workflow 未覆寫），
      // 讓腳本核對 maxPriceAge ≥ heartbeat＋排程延遲；不帶時腳本只印警告。
      const out = forgeScript("RedeployGuardedOracle", { env: { GUARDIAN: R.GUARDIAN, EXCHANGE_NEW: addrs.EXCHANGE_NEW, KEEPER_HEARTBEAT: "900" } });
      if (/KEEPER_HEARTBEAT not given/.test(out)) throw new Error("腳本沒有收到 KEEPER_HEARTBEAT");
      addrs.NEW_GUARDED_ORACLE = grab(out, "NEW_GUARDED_ORACLE");
      const o = call(VAULT_PROXY, "oracle()(address)");
      if (!eq(o, addrs.NEW_GUARDED_ORACLE)) throw new Error(`V2 金庫 oracle() 是 ${o}，不是新 oracle`);
      return `新 oracle ${addrs.NEW_GUARDED_ORACLE}，V2 金庫已改讀它`;
    });

    await step("4. UpgradeVaultToV2_5", () => {
      forgeScript("UpgradeVaultToV2_5");
      const v = cast(["call", VAULT_PROXY, "version()(string)", "--rpc-url", LOCAL]);
      if (!v.includes("2.5.0")) throw new Error(`version() = ${v}`);
      return "version() = 2.5.0";
    });

    await step("5. DeploySessionCredentialAnchor（平台首次部署）", () => {
      const out = forgeScript("DeploySessionCredentialAnchor", { env: { SESSION_MANAGER_ADDR: addrs.SESSION_MANAGER_NEW } });
      addrs.SessionCredentialAnchor = grab(out, "SessionCredentialAnchor");
      const sm = call(addrs.SessionCredentialAnchor, "sessionManager()(address)");
      if (!eq(sm, addrs.SESSION_MANAGER_NEW)) throw new Error(`anchor.sessionManager() = ${sm}`);
      return "綁定新的 AgentSessionManager";
    });

    const gov = { TIMELOCK_PROPOSER: R.PROPOSER, TIMELOCK_EXECUTOR: R.EXECUTOR };
    await step("6. DeployGovernance", () => {
      const out = forgeScript("DeployGovernance", { env: { ...gov, ALLOW_EOA_ROLES: "true" } });
      addrs.TIMELOCK = grab(out, "TIMELOCK");
      return `timelock ${addrs.TIMELOCK}，minDelay ${call(addrs.TIMELOCK, "getMinDelay()(uint256)")} 秒`;
    });
    const handover = {
      ...gov,
      TIMELOCK: addrs.TIMELOCK,
      EXCHANGE_NEW: addrs.EXCHANGE_NEW,
      COPYTRACKER_NEW: addrs.COPYTRACKER_NEW,
      TRADER_STAKE: addrs.TRADER_STAKE,
      GUARDED_ORACLE: addrs.NEW_GUARDED_ORACLE,
    };
    await step("7. HandoverToTimelock phase 1", () => {
      forgeScript("HandoverToTimelock", { env: { ...handover, HANDOVER_PHASE: "1" } });
      const o = call(addrs.EXCHANGE_NEW, "owner()(address)");
      if (!eq(o, addrs.TIMELOCK)) throw new Error(`exchange.owner() = ${o}`);
      return "exchange 等 owner 已移交 timelock（部署者仍保有 AccessControl admin，phase 2 才放棄）";
    });

    await step("8a. RedeployInsuranceStack", () => {
      const bal = BigInt(call(USDC, "balanceOf(address)(uint256)", OWNER));
      const unit = 10n ** BigInt(call(USDC, "decimals()(uint8)"));
      if (bal < unit) {
        const usdcOwner = call(USDC, "owner()(address)");
        send(usdcOwner, USDC, "mint(address,uint256)", OWNER, (10n * unit).toString());
        caveats.push(`部署者在 fork 區塊只有 ${bal} 單位 MockUSDC，不足 1 枚種子；演練由 MockUSDC owner 補發 10 枚。真實部署前部署者要先備妥 ≥1 枚**新資金**`);
      }
      const env = {
        EXCHANGE: addrs.EXCHANGE_NEW,
        STRATEGY_REGISTRY: addrs.STRATEGY_REGISTRY_NEW,
        TRADER_STAKE: addrs.TRADER_STAKE,
        TREASURY: R.TREASURY,
        TIMELOCK: addrs.TIMELOCK,
      };
      const out = forgeScript("RedeployInsuranceStack", { env });
      addrs.InsuranceVault_NEW = grab(out, "InsuranceVault_NEW");
      addrs.FeeRouter_NEW = grab(out, "FeeRouter_NEW");
      addrs.CopyTracker_FINAL = grab(out, "CopyTracker_NEW");
      addrs._schedule = grabBytesAfter(out, "scheduleBatch calldata");
      addrs._execute = grabBytesAfter(out, "executeBatch calldata");
      forgeScript("RedeployInsuranceStack", {
        env: {
          ...env,
          VERIFY_ONLY: "true",
          BROADCASTER: OWNER,
          RESUME_VAULT: addrs.InsuranceVault_NEW,
          RESUME_FEE_ROUTER: addrs.FeeRouter_NEW,
          RESUME_COPY_TRACKER: addrs.CopyTracker_FINAL,
        },
        broadcast: false,
      });
      return "新保險金庫、平台 FeeRouter、CopyTracker 部署並讀回核對；VERIFY_ONLY 通過";
    });
    await step("8b. timelock 排程 → 等待 → 遷移窗口 → 執行", () => {
      cast(["send", addrs.TIMELOCK, addrs._schedule, "--from", R.PROPOSER, "--unlocked", "--rpc-url", LOCAL]);
      const delay = Number(call(addrs.TIMELOCK, "getMinDelay()(uint256)"));
      rpc("evm_increaseTime", String(delay + 1));
      rpc("evm_mine");
      for (const s of SYMS) send(KEEPER, addrs.EXCHANGE_NEW, "setAssetMode(bytes32,uint8)", id(s), "1");
      cast(["send", addrs.TIMELOCK, addrs._execute, "--from", R.EXECUTOR, "--unlocked", "--rpc-url", LOCAL]);
      const back = [];
      for (const s of SYMS) {
        const r = sh("cast", ["send", addrs.EXCHANGE_NEW, "setAssetMode(bytes32,uint8)", id(s), "0", "--from", KEEPER, "--unlocked", "--rpc-url", LOCAL], {
          allowFail: true,
          quiet: true,
        });
        if (r.status !== 0) back.push(s);
      }
      const checks = [
        ["exchange.insuranceVault()", call(addrs.EXCHANGE_NEW, "insuranceVault()(address)"), addrs.InsuranceVault_NEW],
        ["exchange.feeRouter()", call(addrs.EXCHANGE_NEW, "feeRouter()(address)"), addrs.FeeRouter_NEW],
        ["exchange.copyTracker()", call(addrs.EXCHANGE_NEW, "copyTracker()(address)"), addrs.CopyTracker_FINAL],
        ["TraderStake.copyTracker()", call(addrs.TRADER_STAKE, "copyTracker()(address)"), addrs.CopyTracker_FINAL],
      ];
      const bad = checks.filter(([, got, want]) => !eq(got, want));
      if (bad.length) throw new Error(bad.map(([n, g, w]) => `${n} = ${g}，應為 ${w}`).join("；"));
      if (back.length) caveats.push(`遷移窗口後 marketOperator 無法把 ${back.join("、")} 切回 Active（要由 owner＝timelock 放寬）——正式遷移要把這一步排進 timelock 或預留時間`);
      delete addrs._schedule;
      delete addrs._execute;
      return `minDelay ${delay} 秒後 executeBatch 成功，四個指標都換到新合約${back.length ? `；${back.length} 檔無法由 marketOperator 切回 Active` : "；11 檔已切回 Active"}`;
    });

    await step("9. DeployPepeIncentives", () => {
      const out = forgeScript("DeployPepeIncentives", {
        env: { PEPE_TOKEN, PERPETUAL_EXCHANGE: addrs.EXCHANGE_NEW, COPY_TRACKER: addrs.CopyTracker_FINAL, ESG_REGISTRY: "0x0000000000000000000000000000000000000000" },
      });
      addrs.PepeIncentives = grab(out, "PepeIncentives deployed");
      return "綁新 exchange 與最終 CopyTracker";
    });

    await step("10. DeployAMM", () => {
      const usdcOwner = call(USDC, "owner()(address)");
      rpc("anvil_setBalance", usdcOwner, "0x56BC75E2D63100000");
      heartbeat(MOCK_ORACLE, "MockOracle");
      const out = forgeScript("DeployAMM", { env: { MOCK_USDC: USDC, MOCK_ORACLE }, sender: usdcOwner, extra: ["--skip-simulation"] });
      addrs.PepeAMM = grab(out, "PepeAMM deployed");
      const dev = (out.match(/deviation \(bps\)\s*:\s*(\d+)/) ?? [])[1];
      if (/The pool would open more than 5% away/.test(out)) throw new Error(`種子價格偏離 oracle ${dev} bps——套利會吃掉種子`);
      if (!eq(usdcOwner, OWNER)) caveats.push(`DeployAMM 的簽署者是 MockUSDC owner \`${usdcOwner}\`，不是部署者`);
      return `MockUSDC owner ${usdcOwner} 簽署；種子依 oracle 現價，偏離 ${dev ?? "?"} bps`;
    });

    await step("11. HandoverToTimelock phase 2 → VerifyHandover", () => {
      forgeScript("HandoverToTimelock", { env: { ...handover, HANDOVER_PHASE: "2" } });
      forgeScript("VerifyHandover", { env: { ...handover, EXPECT_PHASE: "2", DEPLOYER: OWNER }, broadcast: false });
      return "部署者已放棄所有 admin；VerifyHandover 通過";
    });
  } finally {
    summary(meta);
    meta.child.kill("SIGTERM");
  }
}

main().then(
  () => process.exit(results.every((r) => r.ok) ? 0 : 1),
  (e) => {
    console.error(`::error::cutover 演練中止：${e.message.split("\n")[0]}`);
    process.exit(1);
  },
);
