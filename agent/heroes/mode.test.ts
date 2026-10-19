// 公開鏈模式的守門（#344）：旗標、chainId、fork 演練的假冒、確認字句。不碰鏈。
//   cd agent && npx tsx heroes/mode.test.ts
import assert from "node:assert";
import { assertChain, assertImpersonationAllowed, CONFIRM_PHRASE, confirmed, parseArgs, rpcWarning } from "./mode.ts";

const POS = ["s.json", "a.json", "e.json"];
const PUBLIC = ["--public-chain", ...POS, "--progress", "p.json", "--keystore", "k.json"];

// ── 預設照舊是本機 ─────────────────────────────────────────────────────────
const local = parseArgs(POS);
assert.equal(local.mode, "local");
assert.deepEqual([local.schedulePath, local.addressesPath, local.outPath], POS);
assert.throws(() => parseArgs(["s.json", "a.json"]), /usage/);
// 公開鏈的參數沒有 --public-chain 就不算數，不會默默切過去
assert.throws(() => parseArgs([...POS, "--progress", "p.json"]), /only apply with --public-chain/);
assert.throws(() => parseArgs([...POS, "--chain", "84532"]), /unknown flag/);

// ── 公開鏈要明確的旗標與全部參數 ─────────────────────────────────────────
const pub = parseArgs([...PUBLIC, "--deployer-account", "owner"]);
assert.equal(pub.mode, "public");
assert.equal(pub.progressPath, "p.json");
assert.equal(pub.keystorePath, "k.json");
assert.equal(pub.deployerAccount, "owner");
assert.equal(pub.impersonate, null);
assert.throws(() => parseArgs(PUBLIC), /exactly one of/);
assert.throws(() => parseArgs([...PUBLIC, "--deployer-account", "owner", "--impersonate-deployer", "0x1"]), /exactly one of/);
assert.throws(() => parseArgs(["--public-chain", ...POS, "--keystore", "k.json", "--deployer-account", "o"]), /needs --progress/);
assert.throws(() => parseArgs(["--public-chain", ...POS, "--progress", "p.json", "--deployer-account", "o"]), /needs --keystore/);
assert.throws(() => parseArgs([...PUBLIC, "--deployer-account"]), /needs a value/);

// ── chainId：本機只收 31337，公開鏈只收 84532 ───────────────────────────
assertChain("local", 31337n);
assertChain("public", 84532n);
for (const id of [1n, 8453n, 11155111n, 31337n]) {
  assert.throws(() => assertChain("public", id), /Base Sepolia \(84532\) only/, `public mode accepted chainId ${id}`);
}
for (const id of [84532n, 1n]) assert.throws(() => assertChain("local", id), /local Anvil \(31337\) only/);

// ── 假冒部署者只在 anvil 上：真的節點不會自稱 anvil ─────────────────────
assertImpersonationAllowed("anvil/v1.8.1");
for (const client of ["Geth/v1.101411.0", "reth/v1.1.0", "Nethermind", "op-geth/v1.101503.2"]) {
  assert.throws(() => assertImpersonationAllowed(client), /anvil fork rehearsal only/);
}

// ── 確認字句一字不差 ───────────────────────────────────────────────────────
assert.ok(confirmed(CONFIRM_PHRASE));
assert.ok(confirmed(`  ${CONFIRM_PHRASE}\n`));
for (const answer of ["y", "yes", "replay on 31337", "Replay on 84532", ""]) assert.ok(!confirmed(answer), answer);

assert.match(rpcWarning("https://sepolia.base.org")!, /eth_getLogs/);
assert.equal(rpcWarning("https://base-sepolia.g.alchemy.com/v2/x"), null);

console.log("mode: ok");
