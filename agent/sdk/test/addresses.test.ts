// 位址：核心合約來自 addresses.ts（不複製）；AgentSessionManager 對照表必須與
// frontend/src/contracts/sessionManager.ts 一致（重用 scripts/check-addresses.mjs 的解析器）。
//   cd agent && npx tsx sdk/test/addresses.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getAddress } from "viem";

import { CHAIN_MAP, getV2Stack } from "../../../frontend/src/contracts/addresses.ts";
import {
  SESSION_MANAGER_BY_CHAIN,
  UnsupportedChainError,
  assetSymbolOf,
  resolveAddresses,
  toAssetId,
} from "../src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

// 1) 核心位址就是 addresses.ts 的值
for (const id of [84532, 11155111]) {
  const a = resolveAddresses(id);
  const src = CHAIN_MAP[id]!;
  assert.equal(a.perpetualExchange, getAddress(src.PerpetualExchange));
  assert.equal(a.oracle, getAddress(src.MockOracle));
  assert.equal(a.marginToken, getAddress(src.MockUSDC));
  assert.equal(a.strategyRegistry, getAddress(src.StrategyRegistry));
  const v2 = getV2Stack(id);
  assert.equal(a.guardedOracle, v2 ? getAddress(v2.GuardedOracle) : null);
}
ok("核心位址直接取自 frontend/src/contracts/addresses.ts");

// 2) Session manager 對照表 vs sessionManager.ts（兩種解析：check-addresses.mjs 與逐行）
{
  const script = pathToFileURL(resolve(ROOT, "scripts/check-addresses.mjs")).href;
  const { parseFrontendConfig } = (await import(script)) as {
    parseFrontendConfig: (a: string, s: string) => Record<string, { roles: Record<string, string> }>;
  };
  const addressesSrc = readFileSync(resolve(ROOT, "frontend/src/contracts/addresses.ts"), "utf8");
  const sessionSrc = readFileSync(resolve(ROOT, "frontend/src/contracts/sessionManager.ts"), "utf8");
  const chains = parseFrontendConfig(addressesSrc, sessionSrc);
  const fromScript = chains["84532"]!.roles.AgentSessionManager;
  assert.ok(fromScript, "check-addresses.mjs 解析得到 84532 的 AgentSessionManager");
  assert.equal(resolveAddresses(84532).sessionManager, getAddress(fromScript));

  // 逐行：SESSION_MANAGER_ADDRESS 區塊裡每一條鏈
  const block = sessionSrc.slice(sessionSrc.indexOf("SESSION_MANAGER_ADDRESS"));
  const body = block.slice(block.indexOf("{"), block.indexOf("}"));
  const entries = [...body.matchAll(/^\s*(\d+)\s*:\s*(?:['"](0x[0-9a-fA-F]{40})['"]|ZERO)/gm)];
  assert.ok(entries.length >= 3, "sessionManager.ts 至少列了 3 條鏈");
  for (const [, id, addr] of entries) {
    const expected = addr && !/^0x0{40}$/i.test(addr) ? getAddress(addr) : null;
    const mirrored = SESSION_MANAGER_BY_CHAIN[Number(id)];
    assert.equal(mirrored ? getAddress(mirrored) : null, expected, `chain ${id} 的 session manager 與前端不一致`);
  }
  for (const id of Object.keys(SESSION_MANAGER_BY_CHAIN)) {
    assert.ok(entries.some((e) => e[1] === id), `SDK 多出前端沒有的鏈 ${id}`);
  }
  ok("SESSION_MANAGER_BY_CHAIN 與 sessionManager.ts 逐鏈一致（重用 check-addresses 解析器）");
}

// 3) 未知鏈、覆寫
{
  assert.throws(() => resolveAddresses(1), UnsupportedChainError);
  const local = resolveAddresses(31337, { sessionManager: "0x" + "ab".repeat(20) });
  assert.equal(local.sessionManager, getAddress("0x" + "ab".repeat(20)));
  assert.throws(() => resolveAddresses(31337, { perpetualExchange: "0x0000000000000000000000000000000000000000" }), /PerpetualExchange/);
  const custom = resolveAddresses(999, {
    perpetualExchange: "0x" + "01".repeat(20),
    oracle: "0x" + "02".repeat(20),
    marginToken: "0x" + "03".repeat(20),
  });
  assert.equal(custom.sessionManager, null);
  ok("未知鏈丟錯；覆寫只用於本機／測試部署；核心位址為 0x0 時丟錯");
}

// 4) 資產代號
{
  assert.equal(toAssetId("sBTC"), "0x6587d61b59ac1e9c9f12c71f220fb1b1740d054e81277d4466a0d348e0e266e1");
  assert.equal(assetSymbolOf(toAssetId("sESGU")), "sESGU");
  assert.throws(() => toAssetId("BTC"), /未知資產/);
  assert.throws(() => toAssetId("0x" + "00".repeat(32)), /0x0/);
  ok("資產代號 ↔ bytes32");
}

console.log(`\n✅ sdk addresses.test.ts 全過（${n} 項）`);
