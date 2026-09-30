// SDK 的最小 ABI 必須與前端 ABI JSON（現行部署版）逐一吻合；
// 只有 P1_OPTIONAL_READS 可以不在 JSON 裡，但必須出現在 master 的合約原始碼。
//   cd agent && npx tsx sdk/test/abi.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toFunctionSelector, type Abi, type AbiFunction } from "viem";

import {
  AGENT_SESSION_MANAGER_ABI,
  ERC20_ABI,
  ORACLE_ABI,
  P1_OPTIONAL_READS,
  PERPETUAL_EXCHANGE_ABI,
} from "../src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const json = (name: string): Abi => {
  const j = JSON.parse(readFileSync(resolve(ROOT, `frontend/src/contracts/abi/${name}.json`), "utf8"));
  return (Array.isArray(j) ? j : j.abi) as Abi;
};
const fns = (abi: Abi) => abi.filter((x): x is AbiFunction => x.type === "function");
const sig = (f: AbiFunction) => toFunctionSelector(f);

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

function compare(label: string, sdk: Abi, ref: Abi, optional: readonly string[] = []) {
  const refSel = new Map(fns(ref).map((f) => [sig(f), f]));
  for (const f of fns(sdk)) {
    const r = refSel.get(sig(f));
    if (!r) {
      assert.ok(optional.includes(f.name), `${label}.${f.name} 不在前端 ABI JSON 裡，也不是 P1 選用讀取`);
      continue;
    }
    assert.equal(f.stateMutability === "view", r.stateMutability === "view" || r.stateMutability === "pure", `${label}.${f.name} view 性質不符`);
    assert.equal(f.stateMutability === "payable", r.stateMutability === "payable", `${label}.${f.name} payable 性質不符`);
    // 回傳型別：SDK 可以只取前綴（Position 只取前 13 欄），但已列的必須一致。
    const flat = (o: readonly { type: string; components?: readonly unknown[] }[]): string[] =>
      o.flatMap((x) => (x.type === "tuple" ? flat(x.components as never) : [x.type]));
    const a = flat(f.outputs as never);
    const b = flat(r.outputs as never);
    assert.deepEqual(b.slice(0, a.length), a, `${label}.${f.name} 回傳型別不符`);
  }
}

compare("PerpetualExchange", PERPETUAL_EXCHANGE_ABI as Abi, json("PerpetualExchange"), P1_OPTIONAL_READS);
compare("AgentSessionManager", AGENT_SESSION_MANAGER_ABI as Abi, json("AgentSessionManager"));
compare("MockOracle", ORACLE_ABI as Abi, json("MockOracle"));
compare("GuardedOracle", ORACLE_ABI as Abi, json("GuardedOracle"));
compare("MockUSDC", ERC20_ABI as Abi, json("MockUSDC"));
ok("SDK ABI 的 selector／回傳型別與前端 ABI JSON 吻合");

// P1 選用讀取：必須是 master 合約原始碼裡的 public getter
{
  const sol = readFileSync(resolve(ROOT, "contracts/src/PerpetualExchange.sol"), "utf8");
  for (const name of P1_OPTIONAL_READS) {
    const re = new RegExp(`(public\\s+${name}\\s*;|function\\s+${name}\\s*\\([^)]*\\)[^{;]*\\b(public|external)\\b[^{;]*\\bview\\b)`);
    assert.match(sol, re, `${name} 不是 PerpetualExchange.sol 的 public getter`);
  }
  assert.match(sol, /enum AssetMode \{ Active, ReduceOnly, Halted \}/, "AssetMode 列舉順序變了 → read.ts 的 ASSET_MODES 要跟著改");
  ok("P1 選用讀取都是 master 合約的 public getter；AssetMode 列舉順序一致");
}

console.log(`\n✅ sdk abi.test.ts 全過（${n} 項）`);
