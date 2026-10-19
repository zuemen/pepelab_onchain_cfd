#!/usr/bin/env node
// #344 的 fork 演練：在 Base Sepolia 實況的 anvil fork 上，照 OWNER_ACTIONS 第 5 步部署一套新合約
// （ORACLE_KIND=fresh 的專用 MockOracle、#333 的碳權退役、平台 FeeRouter 付給分流合約、PepeIncentives、
// EsgRewardDistributor），再用公開鏈模式（replay.ts --public-chain）回放小規模排程，中途砍掉一次再續跑，
// 最後跑績效分析與對帳。**不需要、也不讀任何私鑰**：部署者由 anvil 假冒，回放用 --impersonate-deployer。
//
//   node scripts/heroes-fork-rehearsal.mjs [schedule.json]      預設 heroes/tests/fixtures/schedule_smoke.json
//   REHEARSAL_RPC=<url>       fork 來源（預設依序試 cutover-rehearsal.mjs 的 PUBLIC_RPC）
//   REHEARSAL_ANVIL_PORT=8551 本機 anvil 埠
//   PY=<python>               跑 heroes/ 分析的 python（預設 python3；WSL 上用 heroes/.venv/bin/python）
//
// PATH 上要有 anvil／forge／cast（Smart App Control 的 Windows 機器在 WSL 裡跑，見 docs/agents/environment.md）。
// 只打 127.0.0.1 上自己起的 anvil；所有產物寫在 heroes/out/fork-rehearsal/ 與 contracts/cache/rehearsal-heroes/
// （都被 git 忽略），不碰 frontend/public/data/heroes/ 與 contracts/broadcast/。
//
// 演練與真實 cutover 不同的地方（會印在結果裡）：GUARDIAN 是空白地址；InsuranceStack 以 KEEP_DEPLOYER_OWNER
// 執行，後續四筆由 owner 直接送（真實部署走 timelock 的 scheduleBatch）；部署者的 ETH 用 anvil_setBalance 補；
// 回放的部署者是假冒的（真實回放用擁有者的 Foundry keystore：--deployer-account）。

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS = join(ROOT, "contracts");
const AGENT = join(ROOT, "agent");
const HEROES = join(ROOT, "heroes");
const WORK = join(HEROES, "out", "fork-rehearsal");
const PORT = Number(process.env.REHEARSAL_ANVIL_PORT ?? 8551);
const LOCAL = `http://127.0.0.1:${PORT}`;
const CHAIN_ID = 84532;
const PY = process.env.PY ?? "python3";
const SCHEDULE = resolve(process.argv[2] ?? join(HEROES, "tests", "fixtures", "schedule_smoke.json"));
// 與 cutover-rehearsal.mjs 相同（不 import：那支一載入就開始跑）。
const PUBLIC_RPC = ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org", "https://base-sepolia.drpc.org"];

// 鏈上實況（與 contracts/script/*.s.sol 的常數相同）。
const OWNER = "0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585";
const KEEPER = "0x540aECD37E7A7885824e7b7e996eBddfb842ef17";
const MOCK_ORACLE = "0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3";
const USDC = "0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035";
const KYC = "0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d";
const ESG_V2 = "0xBF5B9cD78566791d79c687A732b4ed5bc3E95dFf";
const BADGE = "0x0a4aE14a413a03c20ccF43E8134BfbD7bCB89820";
const PEPE_TOKEN = "0xccd05cbdc2f7961a4c27d3633694022722786a0f";
const GUARDIAN = "0x00000000000000000000000000000000000a11ce"; // 演練用空白地址
// 回放的 OI 上限：本機完整回放裡單一資產單邊的名目最高約 69,000（sBOND）；真實 cutover 也要給這麼大。
const OI_CAP_USDC = "250000";
const SYMS = ["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"];
const KEYSTORE_PASSWORD = "fork-rehearsal-only"; // 只保護 fork 上的帳號；真實回放互動輸入

const results = [];
const addrs = {};
const caveats = [];

function sh(cmd, args, { cwd = CONTRACTS, env = {}, allowFail = false, quiet = false, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, input });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.error) throw r.error;
  if (!quiet) process.stdout.write(out);
  if (r.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} 失敗（exit ${r.status}）\n${out.trim().split("\n").slice(-8).join("\n")}`);
  return { status: r.status, out };
}
const cast = (args) => sh("cast", args, { quiet: true }).out.trim();
const call = (to, sig, ...a) => cast(["call", to, sig, ...a, "--rpc-url", LOCAL]).split("\n")[0].split(" ")[0];
const send = (from, to, sig, ...a) => cast(["send", to, sig, ...a, "--from", from, "--unlocked", "--rpc-url", LOCAL]);
const rpc = (method, ...params) => cast(["rpc", method, ...params, "--rpc-url", LOCAL]);
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const tsx = (args, opts = {}) => sh("npx", ["tsx", ...args], { cwd: AGENT, ...opts });

function forgeScript(name, { env = {}, broadcast = true } = {}) {
  const args = ["script", `script/${name}.s.sol:${name}`, "--rpc-url", LOCAL, "-vv"];
  if (broadcast) args.push("--unlocked", "--sender", OWNER, "--broadcast", "--slow");
  return sh("forge", args, { env: { FOUNDRY_BROADCAST: "cache/rehearsal-heroes/broadcast", ...env } }).out;
}

function grab(out, label) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = out.match(new RegExp(`${esc}\\s*[=:]\\s*(0x[0-9a-fA-F]{40})`));
  if (!m) throw new Error(`輸出裡找不到 ${label}`);
  return m[1];
}

/** RedeployInsuranceStack 沒有 timelock 時印出的四筆後續呼叫（target + payload）。 */
function followUps(out) {
  const lines = out.split("\n").map((l) => l.trim());
  const calls = [];
  for (let i = 0; i < lines.length; i++) {
    const target = lines[i].match(/^target:\s*(0x[0-9a-fA-F]{40})/);
    if (!target) continue;
    const p = lines.findIndex((l, j) => j > i && l === "payload:");
    calls.push({ target: target[1], payload: lines[p + 1] });
  }
  if (calls.length !== 4) throw new Error(`預期 4 筆後續呼叫，讀到 ${calls.length}`);
  return calls;
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
    if (r.status === 0 && Number(r.stdout.trim()) === CHAIN_ID) { source = url; break; }
    console.log(`略過 ${url}`);
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
      if (!/anvil/i.test(cast(["rpc", "web3_clientVersion", "--rpc-url", LOCAL]))) throw new Error("本機節點不是 anvil");
      return { child, source, block: cast(["block-number", "--rpc-url", LOCAL]) };
    }
    await new Promise((r2) => setTimeout(r2, 1000));
  }
  throw new Error("anvil 兩分鐘內沒有就緒");
}

/** 公開鏈模式的回放。killAfterDays：進度檔記到這麼多天就砍掉行程（模擬中斷）。 */
function replay({ killAfterDays = null, extra = [], confirm = "replay on 84532" } = {}) {
  const args = ["tsx", "heroes/replay.ts", "--public-chain", SCHEDULE, join(WORK, "addresses.json"), join(WORK, "events.json"),
    "--progress", join(WORK, "progress.json"), "--keystore", join(WORK, "keys.json"), "--impersonate-deployer", OWNER, ...extra];
  const env = { ...process.env, HEROES_RPC_URL: LOCAL, HEROES_KEYSTORE_PASSWORD: KEYSTORE_PASSWORD, HEROES_RECEIPT_POLL_MS: "200" };
  return new Promise((res, rej) => {
    const child = spawn("npx", args, { cwd: AGENT, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let killed = false;
    child.stderr.on("data", (d) => {
      out += d;
      process.stderr.write(d);
    });
    child.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(d);
      if (killAfterDays !== null && !killed && existsSync(join(WORK, "progress.json"))) {
        try {
          const days = JSON.parse(readFileSync(join(WORK, "progress.json"), "utf8")).days.length;
          if (days >= killAfterDays) {
            killed = true;
            // 整個行程群組（npx → tsx → node）一起砍，像 Ctrl-C 之外更粗暴的斷線
            spawnSync("pkill", ["-KILL", "-f", "heroes/replay.ts --public-chain"]);
          }
        } catch { /* 進度檔正在改名：下一段輸出再看 */ }
      }
    });
    child.stdin.end(`${confirm}\n`);
    child.on("error", rej);
    child.on("exit", (code, signal) => res({ code, signal, out, killed }));
  });
}

function summary(meta) {
  const lines = [
    "## #344 fork 演練（anvil fork，未廣播到任何真實鏈）",
    "",
    `fork 來源：${meta.source}，區塊 ${meta.block}；部署者 \`${OWNER}\`（anvil 假冒，沒有私鑰）；排程 \`${SCHEDULE.replace(ROOT + "/", "")}\``,
    "",
    "| 步驟 | 結果 | 說明 |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.name} | ${r.ok ? "✅" : "❌"} | ${r.note.replace(/\|/g, "\\|")} |`),
    "",
  ];
  if (caveats.length) lines.push("演練與真實部署不同的地方：", "", ...caveats.map((c) => `- ${c}`), "");
  const md = lines.join("\n");
  console.log(`\n${md}`);
  writeFileSync(join(WORK, "summary.md"), md + "\n");
}

async function main() {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  sh("forge", ["build"], { quiet: true });
  const meta = await startAnvil();
  console.log(`anvil fork of ${meta.source} at block ${meta.block} on ${LOCAL}`);
  caveats.push(`GUARDIAN 是演練用空白地址 \`${GUARDIAN}\`；真實部署是另一把熱錢包`);
  caveats.push("RedeployInsuranceStack 以 KEEP_DEPLOYER_OWNER=true 執行、後續四筆由 owner 直接送；真實部署走 timelock 的 scheduleBatch／executeBatch（OWNER_ACTIONS 第 5 步第 4 項）");
  caveats.push("部署者與 keeper 的 ETH 由 anvil_setBalance 補（演練的準備，不是回放的一部分；回放本身沒有任何 anvil_* 呼叫，除了假冒部署者）");
  caveats.push("回放的部署者用 --impersonate-deployer 假冒；真實回放用 --deployer-account <擁有者的 Foundry keystore>");
  try {
    for (const a of [OWNER, KEEPER, GUARDIAN]) rpc("anvil_setBalance", a, "0x56BC75E2D63100000"); // 100 ETH

    await step("0. keeper heartbeat（共用 MockOracle）", () => {
      for (const s of SYMS) send(KEEPER, MOCK_ORACLE, "updatePrice(bytes32,uint256)", cast(["keccak", s]), call(MOCK_ORACLE, "getPrice(bytes32)(uint256,uint256)", cast(["keccak", s])));
      addrs._sharedBtc = cast(["call", MOCK_ORACLE, "getPrice(bytes32)(uint256,uint256)", cast(["keccak", "sBTC"]), "--rpc-url", LOCAL]);
      return "11 檔以 keeper 身分原價重寫（新 oracle 的種子價格要新鮮）";
    });

    const cutEnv = { GUARDIAN, ORACLE_KIND: "fresh", OI_CAP_NON_RWA_USDC: OI_CAP_USDC, OI_CAP_RWA_USDC: OI_CAP_USDC };
    await step("1a. Redeploy130Hardened 預檢（ORACLE_KIND=fresh）", () => {
      const r = sh("forge", ["script", "script/Redeploy130Hardened.s.sol:Redeploy130Hardened", "--rpc-url", LOCAL, "--sender", OWNER, "-vv"], {
        env: { ...cutEnv, PREFLIGHT_ONLY: "true" }, allowFail: true,
      });
      if (r.status === 0) return "舊 exchange 沒有未平倉";
      if (/old exchange has open positions/.test(r.out)) {
        const n = (r.out.match(/!!! (\d+) OPEN position/) ?? [])[1] ?? "?";
        caveats.push(`**真實阻擋項**：舊 exchange 有 ${n} 個未平倉，正式 cutover 前要先平倉／清算（DEPLOY_130_CUTOVER.md §5.1）；演練以 ALLOW_OPEN_POSITIONS=true 繼續`);
        cutEnv.ALLOW_OPEN_POSITIONS = "true";
        return `舊 exchange 有 ${n} 個未平倉（真實阻擋項）；演練帶 ALLOW_OPEN_POSITIONS=true 繼續`;
      }
      throw new Error(r.out.trim().split("\n").slice(-6).join("\n"));
    });

    await step("1b. Redeploy130Hardened broadcast（新 MockOracle）", () => {
      const out = forgeScript("Redeploy130Hardened", { env: cutEnv });
      for (const k of ["EXCHANGE_NEW", "COPYTRACKER_NEW", "STRATEGY_REGISTRY_NEW", "SESSION_MANAGER_NEW", "TRADER_STAKE", "ORACLE_NEW"]) addrs[k] = grab(out, k);
      if (eq(addrs.ORACLE_NEW, MOCK_ORACLE)) throw new Error("新交易所接的是共用 MockOracle");
      return `exchange ${addrs.EXCHANGE_NEW}，oracle ${addrs.ORACLE_NEW}（部署者持有）`;
    });

    await step("2. Verify130（ORACLE_KIND=fresh）", () => {
      forgeScript("Verify130", {
        broadcast: false,
        env: {
          EXCHANGE_NEW: addrs.EXCHANGE_NEW, COPYTRACKER_NEW: addrs.COPYTRACKER_NEW, STRATEGY_REGISTRY_NEW: addrs.STRATEGY_REGISTRY_NEW,
          SESSION_MANAGER_NEW: addrs.SESSION_MANAGER_NEW, GUARDIAN, ORACLE_KIND: "fresh", ORACLE_NEW: addrs.ORACLE_NEW,
          OI_CAP_NON_RWA_USDC: OI_CAP_USDC, OI_CAP_RWA_USDC: OI_CAP_USDC,
        },
      });
      return "全部斷言通過（含 oracle 不是共用的、owner 是部署者）";
    });

    await step("3. DeployCarbonRetirement（#333）", () => {
      const out = forgeScript("DeployCarbonRetirement", {
        env: { CARBON_USDC: USDC, CARBON_TREASURY: OWNER, CARBON_DEPLOY_ROUTER: "false", CARBON_CHAIN_ID: String(CHAIN_ID) },
      });
      addrs.PlatformFeeSplitter = grab(out, "PlatformFeeSplitter");
      addrs.CarbonRetirement = grab(out, "CarbonRetirement");
      return `分流合約 ${addrs.PlatformFeeSplitter}`;
    });

    await step("4. RedeployInsuranceStack（平台收款人＝分流合約）＋後續四筆", () => {
      if (BigInt(call(USDC, "balanceOf(address)(uint256)", OWNER)) < 10n ** 18n) send(OWNER, USDC, "mint(address,uint256)", OWNER, (10n ** 19n).toString());
      const out = forgeScript("RedeployInsuranceStack", {
        env: {
          EXCHANGE: addrs.EXCHANGE_NEW, STRATEGY_REGISTRY: addrs.STRATEGY_REGISTRY_NEW, TRADER_STAKE: addrs.TRADER_STAKE,
          TREASURY: OWNER, CARBON_SPLITTER: addrs.PlatformFeeSplitter, KEEP_DEPLOYER_OWNER: "true",
        },
      });
      addrs.FeeRouter_NEW = grab(out, "FeeRouter_NEW");
      addrs.CopyTracker_FINAL = grab(out, "CopyTracker_NEW");
      for (const c of followUps(out)) cast(["send", c.target, c.payload, "--from", OWNER, "--unlocked", "--rpc-url", LOCAL]);
      return `FeeRouter ${addrs.FeeRouter_NEW}，CopyTracker ${addrs.CopyTracker_FINAL}`;
    });

    await step("5. DeployPepeIncentives＋EsgRewardDistributor（綁新交易所）", () => {
      addrs.PepeIncentives = grab(forgeScript("DeployPepeIncentives", {
        env: { PEPE_TOKEN, PERPETUAL_EXCHANGE: addrs.EXCHANGE_NEW, COPY_TRACKER: addrs.CopyTracker_FINAL, ESG_REGISTRY: "0x0000000000000000000000000000000000000000" },
      }), "PepeIncentives deployed");
      addrs.EsgRewardDistributor = grab(forgeScript("Deploy102RewardDistributor", {
        env: { EXCHANGE_NEW: addrs.EXCHANGE_NEW, ESG_REGISTRY_V2: ESG_V2, SUSTAINABILITY_BADGE: BADGE },
      }), "EsgRewardDistributor");
      return `PepeIncentives ${addrs.PepeIncentives}，EsgRewardDistributor ${addrs.EsgRewardDistributor}`;
    });

    await step("6. 讀回（#344 的部署測試決定）", () => {
      const checks = [
        ["exchange.oracle() = 新 MockOracle", call(addrs.EXCHANGE_NEW, "oracle()(address)"), addrs.ORACLE_NEW],
        ["新 MockOracle.owner() = 部署者", call(addrs.ORACLE_NEW, "owner()(address)"), OWNER],
        ["exchange.kyc() = 沿用的 KYC", call(addrs.EXCHANGE_NEW, "kyc()(address)"), KYC],
        ["exchange.feeRouter() = 新平台 FeeRouter", call(addrs.EXCHANGE_NEW, "feeRouter()(address)"), addrs.FeeRouter_NEW],
        ["FeeRouter.platformTreasury() = #333 分流合約", call(addrs.FeeRouter_NEW, "platformTreasury()(address)"), addrs.PlatformFeeSplitter],
        ["exchange.copyTracker() = 最終 CopyTracker", call(addrs.EXCHANGE_NEW, "copyTracker()(address)"), addrs.CopyTracker_FINAL],
        ["PepeIncentives.exchange() = 新交易所", call(addrs.PepeIncentives, "exchange()(address)"), addrs.EXCHANGE_NEW],
        ["EsgRewardDistributor.exchange() = 新交易所", call(addrs.EsgRewardDistributor, "exchange()(address)"), addrs.EXCHANGE_NEW],
      ];
      const bad = checks.filter(([, got, want]) => !eq(got, want));
      if (bad.length) throw new Error(bad.map(([n, g, w]) => `${n}：讀到 ${g}，應為 ${w}`).join("；"));
      return `${checks.length} 項全部相符`;
    });

    await step("7. chainAddresses.ts（從新交易所的接線讀位址表）", () => {
      tsx(["heroes/chainAddresses.ts", addrs.EXCHANGE_NEW, join(WORK, "addresses.json")], { env: { HEROES_RPC_URL: LOCAL } });
      const a = JSON.parse(readFileSync(join(WORK, "addresses.json"), "utf8"));
      if (!eq(a.MockOracle, addrs.ORACLE_NEW) || !eq(a.CopyTracker, addrs.CopyTracker_FINAL) || !eq(a.PlatformFeeSplitter, addrs.PlatformFeeSplitter)) {
        throw new Error("位址表與部署輸出不一致");
      }
      return "oracle、CopyTracker、分流與退役合約都從鏈上讀到";
    });

    await step("8. 守門：不帶 --public-chain、或確認字句不對，都不送任何交易", async () => {
      const local = tsx(["heroes/replay.ts", SCHEDULE, join(WORK, "addresses.json"), join(WORK, "never.json")], { env: { HEROES_RPC_URL: LOCAL }, allowFail: true, quiet: true });
      if (local.status === 0 || !/local Anvil \(31337\) only/.test(local.out)) throw new Error(`本機模式沒有拒絕 84532：${local.out.slice(-300)}`);
      const nonce = cast(["nonce", OWNER, "--rpc-url", LOCAL]);
      const wrong = await replay({ confirm: "yes" });
      if (wrong.code === 0 || !/not confirmed/.test(wrong.out)) throw new Error("確認字句錯誤卻沒有中止");
      if (cast(["nonce", OWNER, "--rpc-url", LOCAL]) !== nonce || existsSync(join(WORK, "progress.json"))) throw new Error("確認之前就送了交易或寫了進度");
      return "本機模式拒絕 chainId 84532；確認字句錯誤時部署者 nonce 不變、沒有進度檔";
    });

    const days = JSON.parse(readFileSync(SCHEDULE, "utf8")).days.length;
    const killAt = Math.max(1, Math.floor(days / 3));
    await step(`9a. 公開鏈回放，跑到第 ${killAt} 天砍掉`, async () => {
      const r = await replay({ killAfterDays: killAt });
      if (!r.killed) throw new Error(`回放沒有被中斷（exit ${r.code}）——排程太短？`);
      const p = JSON.parse(readFileSync(join(WORK, "progress.json"), "utf8"));
      return `中斷時已完成 ${p.days.length} 天、送出 ${p.stats.sent} 筆${p.current ? `，${p.current.date} 跑到一半（${Object.keys(p.current.entries).length} 個動作）` : ""}`;
    });

    await step("9b. 同一行指令續跑到結束", async () => {
      const r = await replay();
      if (r.code !== 0) throw new Error(`續跑失敗（exit ${r.code}）`);
      const m = r.out.match(/resuming at day (\d+)\/(\d+)/);
      if (!m) throw new Error("續跑沒有從進度檔接著跑");
      const ev = JSON.parse(readFileSync(join(WORK, "events.json"), "utf8"));
      return `從第 ${m[1]}/${m[2]} 天接著跑；共 ${ev.stats.sent} 筆、${ev.stats.failed} 筆失敗、${ev.events.length} 個事件、${ev.days.length} 天的區塊範圍`;
    });

    await step("9c. 沒有重複送出（鏈上事件數 = 排程動作數）", () => {
      const sched = JSON.parse(readFileSync(SCHEDULE, "utf8"));
      const ev = JSON.parse(readFileSync(join(WORK, "events.json"), "utf8"));
      const count = (name) => ev.events.filter((e) => e.name === name).length;
      const rebalances = sched.traders.reduce((s, t) => s + t.rebalances.length, 0);
      const follows = sched.followers.reduce((s, f) => s + f.actions.filter((a) => a.type === "follow").length, 0);
      const unfollows = sched.followers.reduce((s, f) => s + f.actions.filter((a) => a.type === "unfollow").length, 0);
      const checks = [["StrategyPublished", count("StrategyPublished"), rebalances], ["TraderFollowed", count("TraderFollowed"), follows], ["TraderUnfollowed", count("TraderUnfollowed"), unfollows]];
      const bad = checks.filter(([, got, want]) => got !== want);
      if (bad.length) throw new Error(bad.map(([n, g, w]) => `${n} ${g}，排程 ${w}`).join("；"));
      if (!ev.timeCompressed || ev.chainId !== CHAIN_ID) throw new Error("events.json 不是 84532 的時間壓縮回放");
      // 價格只寫在新 oracle：共用的那顆從演練開頭的 keeper 寫入之後沒有再變（價格與時間都一樣）
      const shared = cast(["call", MOCK_ORACLE, "getPrice(bytes32)(uint256,uint256)", cast(["keccak", "sBTC"]), "--rpc-url", LOCAL]);
      if (shared !== addrs._sharedBtc) throw new Error(`共用 MockOracle 的 sBTC 被改過：${addrs._sharedBtc} → ${shared}`);
      const replayPrice = call(addrs.ORACLE_NEW, "getPrice(bytes32)(uint256,uint256)", cast(["keccak", "sBTC"]));
      const lastDay = sched.days[sched.days.length - 1].prices.sBTC;
      if (replayPrice !== lastDay) throw new Error(`新 oracle 的 sBTC ${replayPrice}，排程最後一天是 ${lastDay}`);
      return `${checks.map(([n, g]) => `${n} ${g}`).join("、")}，與排程相同；新 oracle 停在排程最後一天的價格，共用 MockOracle 的價格與時間沒有變`;
    });

    await step("10. 績效分析（壓縮模式）＋對帳", () => {
      const data = join(WORK, "data");
      sh(PY, ["build_analytics.py", join(WORK, "events.json"), "--out", data], { cwd: HEROES });
      const out = sh(PY, ["check_pipeline.py", join(WORK, "events.json"), SCHEDULE, "--data", data], { cwd: HEROES }).out;
      const index = JSON.parse(readFileSync(join(data, "index.json"), "utf8"));
      if (index.schemaVersion !== 3 || index.timeCompressed !== true || index.chainId !== CHAIN_ID) throw new Error("index.json 不是 schema 3 的 84532 壓縮資料");
      const sample = JSON.parse(readFileSync(join(data, `${index.traders[0].address.toLowerCase()}.json`), "utf8"));
      const t = sample.trades[0];
      return `${out.trim().split("\n").pop()}；例：${sample.name} 第一筆 ${t.asset} 模擬日期 ${t.openDate}、上鏈 ${new Date(t.openTime * 1000).toISOString()}`;
    });
  } finally {
    delete addrs._sharedBtc;
    summary(meta);
    meta.child.kill("SIGTERM");
  }
}

main().then(
  () => process.exit(results.every((r) => r.ok) ? 0 : 1),
  (e) => {
    console.error(`fork 演練中止：${e.message.split("\n")[0]}`);
    process.exit(1);
  },
);
