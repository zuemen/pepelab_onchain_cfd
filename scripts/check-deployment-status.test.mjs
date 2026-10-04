// 自我測試：bytecode 遮蔽比對、外洩地址判讀、報告產生與 --offline 一致性檢查。
// 不連網：RPC 以假的 fetch 回應，編譯產物以合成的 JSON 代替。
//   node --test scripts/check-deployment-status.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ADDRESSES_FILE,
  COMPONENTS_FILE,
  DEPLOYED_SNAPSHOT,
  REPORT_JSON,
  REPORT_MD,
  SESSION_FILE,
  X402_FILE,
  aggregate,
  buildReport,
  checkConfig,
  classifyCode,
  compareRuntime,
  expandSources,
  loadSources,
  makeRpc,
  parseDenylist,
  parseTokenGroups,
  refreshAcceptance,
  renderMarkdown,
  resolveTargets,
  shortAddr,
  snapshotCompare,
} from "./check-deployment-status.mjs";
import { selector } from "../ops/monitoring/keccak.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEAKED = "0xe80a81360608c1342e66743f70a00f75d792eb93";
const LEAKED_SHORT = "0xe80a…eb93";

// ── 合成產物 ────────────────────────────────────────────────────────────────
// 版面：[0..4) 程式碼、[4..36) immutable A、[36..40) 程式碼、[40..72) immutable A（同一個）、
//       [72..76) 程式碼、[76..96) library 位址、[96..100) 程式碼、結尾 CBOR（長度 6：4 byte 內容＋2 byte 長度）。
const CODE = (n, b) => b.repeat(n);
function artifact({ body = "aa", lib = false, meta = "a1b2c3d4" } = {}) {
  const imm = "00".repeat(32);
  const libPart = lib ? "__$0123456789abcdef0123456789abcdef01$__" : CODE(20, "77");
  const object = "0x" + CODE(4, body) + imm + CODE(4, "bb") + imm + CODE(4, "cc") + libPart + CODE(4, "dd") + meta + "0004";
  return {
    deployedBytecode: {
      object,
      immutableReferences: { 7: [{ start: 4, length: 32 }, { start: 40, length: 32 }] },
      linkReferences: lib ? { "src/Lib.sol": { Lib: [{ start: 76, length: 20 }] } } : {},
    },
  };
}
function onchain({ body = "aa", immA = "11".repeat(32), immB = immA, libAddr = "77".repeat(20), meta = "a1b2c3d4" } = {}) {
  return "0x" + CODE(4, body) + immA + CODE(4, "bb") + immB + CODE(4, "cc") + libAddr + CODE(4, "dd") + meta + "0004";
}
// library 自己的產物：它的 call guard immutable 是自己的位址。
const libArtifact = () => ({
  deployedBytecode: { object: "0x" + "ee".repeat(4) + "00".repeat(32) + "ef00000004", immutableReferences: { 1: [{ start: 4, length: 32 }] }, linkReferences: {} },
});
const libOnchain = (addr) => "0x" + "ee".repeat(4) + addr.replace(/^0x/, "").padStart(64, "0") + "ef00000004";

test("compareRuntime：完全一致、只有 metadata 不同、immutable 遮蔽", () => {
  const a = artifact();
  assert.deepEqual(compareRuntime(onchain(), a), { match: true, metadataOnly: false, reason: null, libraries: [] });
  const m = compareRuntime(onchain({ meta: "ffffffff" }), a);
  assert.equal(m.match, true);
  assert.equal(m.metadataOnly, true);
});

test("compareRuntime：程式碼不同、長度不同、同一個 immutable 兩個值 → 不一致", () => {
  const a = artifact();
  const d = compareRuntime(onchain({ body: "ab" }), a);
  assert.equal(d.match, false);
  assert.match(d.reason, /第 0 byte 起不同/);
  assert.match(compareRuntime(onchain() + "00", a).reason, /長度不同/);
  assert.match(compareRuntime(onchain({ immA: "11".repeat(32), immB: "22".repeat(32) }), a).reason, /兩個不同的值/);
});

test("compareRuntime：library 位址遮蔽並回報；pinImmutable 不符 → 不一致", () => {
  const a = artifact({ lib: true });
  const lib = "0x" + "12".repeat(20);
  const r = compareRuntime(onchain({ libAddr: lib.slice(2) }), a);
  assert.equal(r.match, true);
  assert.deepEqual(r.libraries, [{ spec: "Lib.sol:Lib", address: lib }]);
  assert.equal(compareRuntime(libOnchain(lib), libArtifact(), { pinImmutable: lib }).match, true);
  assert.match(compareRuntime(libOnchain(lib), libArtifact(), { pinImmutable: "0x" + "34".repeat(20) }).reason, /不是預期/);
});

function outDirWith(map) {
  const dir = mkdtempSync(join(tmpdir(), "status-out-"));
  for (const [spec, art] of Object.entries(map)) {
    const [file, name] = spec.split(":");
    mkdirSync(join(dir, file), { recursive: true });
    writeFileSync(join(dir, file, `${name}.json`), JSON.stringify(art));
  }
  return dir;
}

test("classifyCode：現行版一致／符合舊版候選／都不符／沒有產物", async () => {
  const outDir = outDirWith({ "New.sol:New": artifact({ body: "aa" }), "Old.sol:Old": artifact({ body: "a0" }) });
  const fetchCode = async () => {
    throw new Error("不該讀 library");
  };
  try {
    assert.equal((await classifyCode(onchain(), ["New.sol:New", "Old.sol:Old"], { outDir, fetchCode })).status, "equal");
    const old = await classifyCode(onchain({ body: "a0" }), ["New.sol:New", "Old.sol:Old"], { outDir, fetchCode });
    assert.equal(old.status, "behind");
    assert.match(old.detail, /鏈上是舊版 Old/);
    const none = await classifyCode(onchain({ body: "99" }), ["New.sol:New", "Old.sol:Old"], { outDir, fetchCode });
    assert.equal(none.status, "behind");
    assert.match(none.detail, /與原始碼現行版不一致/);
    const missing = await classifyCode(onchain(), ["Nope.sol:Nope"], { outDir, fetchCode });
    assert.equal(missing.status, "unknown");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("classifyCode：library 也要一致，否則不算鏈上＝原始碼", async () => {
  const lib = "0x" + "12".repeat(20);
  const outDir = outDirWith({ "Main.sol:Main": artifact({ lib: true }), "Lib.sol:Lib": libArtifact() });
  try {
    const ok = await classifyCode(onchain({ libAddr: lib.slice(2) }), ["Main.sol:Main"], { outDir, fetchCode: async () => libOnchain(lib) });
    assert.equal(ok.status, "equal");
    const bad = await classifyCode(onchain({ libAddr: lib.slice(2) }), ["Main.sol:Main"], { outDir, fetchCode: async () => "0x" + "ff".repeat(41) });
    assert.equal(bad.status, "behind");
    assert.match(bad.detail, /library Lib\.sol:Lib/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("外洩地址名單：讀 payoutSafety.ts；空名單 → 丟錯（不可無聲通過）", () => {
  const list = parseDenylist(readFileSync(join(REPO, "agent/shared/src/payoutSafety.ts"), "utf8"));
  assert.ok(list.includes(LEAKED));
  assert.deepEqual(parseDenylist('export const COMPROMISED_ADDRESSES: readonly string[] = [\n  // "0x1111111111111111111111111111111111111111",\n  "0x2222222222222222222222222222222222222222",\n];'), [
    "0x2222222222222222222222222222222222222222",
  ]);
  assert.throws(() => parseDenylist("export const COMPROMISED_ADDRESSES = [];"), /空的/);
  assert.equal(shortAddr(LEAKED), LEAKED_SHORT);
});

test("位址解析：與 frontend/src/contracts/** 相同；同一位址只比一次；代幣群組只列鏈上真的有的", () => {
  const src = loadSources(REPO);
  const tokens = parseTokenGroups(readFileSync(join(REPO, ADDRESSES_FILE), "utf8"), ["84532", "11155111"]);
  for (const id of ["84532", "11155111"]) {
    assert.equal(Object.keys(tokens[id].SYNTH_TOKENS).length, 11);
  }
  assert.equal(Object.keys(tokens["84532"]["V2_STACK.tokens"]).length, 11);
  // Sepolia 的 V2 只有 8 顆真的上鏈；sGOOGL／sICLN／sESGU 的位址沒有程式碼，已自前端設定移除。
  assert.deepEqual(Object.keys(tokens["11155111"]["V2_STACK.tokens"]).sort(), ["sAAPL", "sBOND", "sBTC", "sETH", "sGOLD", "sMSFT", "sNVDA", "sTSLA"]);
  const t = resolveTargets(src);
  const base = (id) => t.find((x) => x.chainId === "84532" && x.id === id);
  assert.equal(base("PerpetualExchange").addresses[0].address, src.frontend["84532"].roles.PerpetualExchange);
  assert.equal(base("X402FeeRouter").addresses[0].address, src.frontend["84532"].roles.X402FeeRouter);
  // Base 的 ESGRegistry 與 ESGRegistryV2 是同一顆：V2 先比，V1 列為同一位址。
  if (src.frontend["84532"].roles.ESGRegistry.toLowerCase() === src.frontend["84532"].roles.ESGRegistryV2.toLowerCase()) {
    assert.equal(base("ESGRegistry").status, "same-as");
    assert.equal(base("ESGRegistry").sameAs, "ESGRegistryV2");
  }
  assert.equal(t.some((x) => x.chainId === "11155111" && x.id === "X402FeeRouter"), false);
});

test("原始碼範圍含 repo 內的 import：依賴改了也算改了", () => {
  const files = expandSources(REPO, ["contracts/src/AgentSessionManager.sol"]);
  assert.ok(files.includes("contracts/src/PerpetualExchange.sol"), "AgentSessionManager 呼叫 PerpetualExchange");
  assert.ok(files.includes("contracts/src/AgentSessionManager.sol"));
  assert.ok(files.every((f) => !f.startsWith("@") && !f.includes("lib/")), "submodule 不展開");
  const v2 = expandSources(REPO, ["contracts/src/v2/AssetVaultV2_5.sol"]);
  assert.ok(v2.includes("contracts/src/CarbonTiers.sol"), "../ 相對路徑");
});

test("makeRpc：只允許唯讀方法", async () => {
  const rpc = makeRpc("https://example.invalid", { fetchImpl: async () => assert.fail("不該送出") });
  await assert.rejects(() => rpc("eth_sendRawTransaction", ["0x"]), /不允許/);
  await assert.rejects(() => rpc("eth_sendTransaction", [{}]), /不允許/);
});

test("snapshotCompare 與 aggregate", () => {
  const snap = { contracts: { "0xaa": { codeHash: "h1", impl: null, implCodeHash: null } }, codes: { h1: "0x6080" } };
  assert.equal(snapshotCompare(snap, "0xAA", "0x6080", null), "same");
  assert.equal(snapshotCompare(snap, "0xaa", "0x6081", null), "changed");
  assert.equal(snapshotCompare(snap, "0xbb", "0x6080", null), "absent");
  const r = (status) => ({ code: { status, detail: status } });
  assert.equal(aggregate([r("equal"), r("equal")]).status, "equal");
  assert.equal(aggregate([r("equal"), r("unknown")]).status, "unknown");
  assert.equal(aggregate([r("unknown"), r("behind")]).status, "behind");
});

// ── 報告產生與 --offline ─────────────────────────────────────────────────────

/** 在暫存目錄複製一份最小 repo（設定、位址來源、元件原始碼、證據檔），不含 git。 */
function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "status-repo-"));
  const cfg = JSON.parse(readFileSync(join(REPO, COMPONENTS_FILE), "utf8"));
  const paths = new Set([COMPONENTS_FILE, ADDRESSES_FILE, SESSION_FILE, X402_FILE, cfg.denylist.file, DEPLOYED_SNAPSHOT]);
  for (const c of [...cfg.components, ...cfg.offchain]) for (const s of c.sources ?? []) paths.add(s);
  for (const a of Object.values(cfg.acceptance)) for (const e of a.evidence ?? []) paths.add(e.split("#")[0]);
  for (const p of paths) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    cpSync(join(REPO, p), join(root, p), { recursive: true, filter: (s) => !/node_modules|[\\/]\.wrangler|[\\/]\.state/.test(s) });
  }
  return root;
}

/** 假 RPC：PerpetualExchange 的 code 符合假產物、owner() 是外洩地址；noCode 裡的位址沒有 code；其餘是不符產物的短 code。 */
function fakeChain(root, chainId, noCode = new Set()) {
  const { frontend } = loadSources(root);
  const pe = frontend[chainId].roles.PerpetualExchange.toLowerCase();
  const word = (a) => "0x" + a.replace(/^0x/, "").padStart(64, "0");
  return async (_url, init) => {
    const { method, params, id } = JSON.parse(init.body);
    const ok = (result) => ({ status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: "2.0", id, result }) });
    const err = (message) => ({ status: 200, ok: true, text: async () => JSON.stringify({ jsonrpc: "2.0", id, error: { code: 3, message } }) });
    if (method === "eth_chainId") return ok("0x" + Number(chainId).toString(16));
    if (method === "eth_blockNumber") return ok("0x100");
    if (method === "eth_getCode") return ok(params[0].toLowerCase() === pe ? onchain() : noCode.has(params[0].toLowerCase()) ? "0x" : "0x6080");
    if (method === "eth_getStorageAt") return ok(word("0"));
    if (method === "eth_call") {
      const { to, data } = params[0];
      if (to.toLowerCase() !== pe) return err("execution reverted");
      if (data === selector("owner()")) return ok(word(LEAKED));
      if (data.startsWith(selector("authorizedAgents(address)"))) return ok(word("1"));
      return ok(word("0x" + "ab".repeat(20)));
    }
    return err("unexpected");
  };
}

async function generate(root, outDir, noCode) {
  const exec = (cmd, args) => {
    if (args[0] === "log") return "1234567890abcdef1234567890abcdef12345678\t2026-10-04\tsomething (#999)\n";
    throw new Error("no git");
  };
  const report = await buildReport({ root, outDir, chainIds: ["84532"], fetchImpl: fakeChain(root, "84532", noCode), sleep: async () => {}, today: "2026-10-04", exec });
  writeFileSync(join(root, REPORT_JSON), JSON.stringify(report, null, 1) + "\n");
  writeFileSync(join(root, REPORT_MD), renderMarkdown(report));
  return report;
}

test("buildReport：分類、外洩地址只寫縮寫、四個欄位都在 markdown 裡", async () => {
  const root = tempRepo();
  const outDir = outDirWith({ "PerpetualExchange.sol:PerpetualExchange": artifact() });
  try {
    const report = await generate(root, outDir);
    const rows = report.chains["84532"].components;
    const pe = rows.find((r) => r.id === "PerpetualExchange");
    assert.equal(pe.status, "equal");
    assert.deepEqual(pe.merged, { pr: 999, commit: "1234567", date: "2026-10-04" });
    assert.ok(pe.leaked.some((l) => l.what === "owner()" && l.holder === LEAKED_SHORT));
    assert.ok(pe.leaked.some((l) => /^authorizedAgents\(/.test(l.what)));
    assert.equal(rows.find((r) => r.id === "MockOracle").status, "unknown"); // 假 out/ 沒有 MockOracle 產物
    assert.match(rows.find((r) => r.id === "MockOracle").detail, /找不到編譯產物/);
    const json = JSON.stringify(report);
    const md = readFileSync(join(root, REPORT_MD), "utf8");
    assert.equal(json.toLowerCase().includes(LEAKED), false, "JSON 不得出現完整的外洩地址");
    assert.equal(md.toLowerCase().includes(LEAKED), false, "markdown 不得出現完整的外洩地址");
    assert.match(md, /已合併不等於使用者受保護/);
    assert.match(md, /\| 元件 \| 已合併（PR／commit） \| 已部署 \| 鏈上驗證 \| 展示驗收 \|/);
    assert.match(md, /#999／`1234567`/);
    assert.match(md, /\*\*鏈上＝原始碼\*\*/);
    assert.match(md, /\*\*無法比對\*\*/);
    assert.deepEqual(checkConfig(root).problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("--offline：手改報告、位址變更、原始碼在「鏈上＝原始碼」之後被改、證據不存在 → 擋下", async () => {
  const root = tempRepo();
  const outDir = outDirWith({ "PerpetualExchange.sol:PerpetualExchange": artifact() });
  try {
    await generate(root, outDir);
    assert.deepEqual(checkConfig(root).problems, []);
    const has = (re) => checkConfig(root).problems.some((p) => re.test(p));

    // 1. 手改 markdown 的數字
    const md = readFileSync(join(root, REPORT_MD), "utf8");
    writeFileSync(join(root, REPORT_MD), md.replace("| Base Sepolia（84532） | 256 |", "| Base Sepolia（84532） | 999 |"));
    assert.ok(has(/不是 .*的渲染結果/));
    writeFileSync(join(root, REPORT_MD), md);

    // 2. 前端設定換了 exchange 位址，報告沒重跑
    const addr = readFileSync(join(root, ADDRESSES_FILE), "utf8");
    const { frontend } = loadSources(root);
    writeFileSync(join(root, ADDRESSES_FILE), addr.replace(frontend["84532"].roles.PerpetualExchange, "0x" + "5".repeat(40)));
    assert.ok(has(/PerpetualExchange：位址已變更/));
    writeFileSync(join(root, ADDRESSES_FILE), addr);

    // 3. 報告寫「鏈上＝原始碼」之後原始碼又改了
    const pePath = join(root, "contracts/src/PerpetualExchange.sol");
    const pe = readFileSync(pePath, "utf8");
    writeFileSync(pePath, pe + "\n// changed\n");
    assert.ok(has(/報告寫「鏈上＝原始碼」，但原始碼在產生之後改過/));
    writeFileSync(pePath, pe);

    // 4. 展示驗收引用不存在的證據；「已驗收」沒有證據
    const cfgPath = join(root, COMPONENTS_FILE);
    const cfgText = readFileSync(cfgPath, "utf8");
    const cfg = JSON.parse(cfgText);
    cfg.acceptance.PepeAMM = { status: "已驗收", date: "2026-10-04", evidence: ["docs/NOPE.md"] };
    cfg.acceptance.PepeToken = { status: "已驗收", date: "2026-10-04", evidence: [] };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    assert.ok(has(/證據 docs\/NOPE\.md 不存在/));
    assert.ok(has(/PepeToken：已驗收 必須至少引用一個證據檔/));
    assert.ok(has(/展示驗收與 components\.json 不同/));
    writeFileSync(cfgPath, cfgText);

    // 5. 外洩名單被清空
    const denyPath = join(root, "agent/shared/src/payoutSafety.ts");
    const deny = readFileSync(denyPath, "utf8");
    writeFileSync(denyPath, deny.replace(/"0x[0-9a-f]{40}",/g, ""));
    assert.ok(has(/空的/));
    writeFileSync(denyPath, deny);

    assert.deepEqual(checkConfig(root).problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("前端設定列了鏈上沒有程式碼的位址 → 報告列出、--offline 擋下；移除後通過", async () => {
  const root = tempRepo();
  const outDir = outDirWith({ "PerpetualExchange.sol:PerpetualExchange": artifact() });
  try {
    const { tokens } = loadSources(root);
    const ghost = tokens["84532"]["V2_STACK.tokens"].sICLN;
    await generate(root, outDir, new Set([ghost.toLowerCase()]));
    const row = JSON.parse(readFileSync(join(root, REPORT_JSON), "utf8")).chains["84532"].components.find((r) => r.id === "SyntheticAssetV2");
    assert.equal(row.status, "unknown");
    assert.deepEqual(row.noCode, [{ key: "sICLN", address: ghost }]);
    assert.match(readFileSync(join(root, REPORT_MD), "utf8"), /前端設定列了、但鏈上沒有程式碼的位址/);
    assert.ok(checkConfig(root).problems.some((p) => p.includes(ghost) && /沒有程式碼/.test(p)));

    // 從前端設定移除後重跑 → 通過
    const addrFile = join(root, ADDRESSES_FILE);
    const lines = readFileSync(addrFile, "utf8").split("\n");
    writeFileSync(addrFile, lines.filter((l) => !l.includes(`"${ghost}"`)).join("\n"));
    await generate(root, outDir, new Set([ghost.toLowerCase()]));
    assert.deepEqual(checkConfig(root).problems, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("--refresh-acceptance：只改驗收欄位，不需要連網", async () => {
  const root = tempRepo();
  const outDir = outDirWith({});
  try {
    await generate(root, outDir);
    const cfgPath = join(root, COMPONENTS_FILE);
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.acceptance.PepeAMM = { status: "部分驗收", date: "2026-10-04", evidence: [COMPONENTS_FILE], note: "測試" };
    writeFileSync(cfgPath, JSON.stringify(cfg));
    assert.ok(checkConfig(root).problems.length > 0);
    const report = refreshAcceptance(root);
    writeFileSync(join(root, REPORT_JSON), JSON.stringify(report, null, 1) + "\n");
    writeFileSync(join(root, REPORT_MD), renderMarkdown(report));
    assert.deepEqual(checkConfig(root).problems, []);
    assert.match(readFileSync(join(root, REPORT_MD), "utf8"), /部分驗收（2026-10-04）/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("repo 內的 components.json 本身合法（不檢查報告是否存在）", () => {
  const problems = checkConfig(REPO).problems.filter((p) => !p.includes(REPORT_JSON) && !p.includes(REPORT_MD));
  assert.deepEqual(problems, []);
  assert.ok(existsSync(join(REPO, COMPONENTS_FILE)));
});
