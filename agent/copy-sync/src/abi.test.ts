// abi.ts 的手寫片段必須與合約原始碼一致：直接解析 contracts/src/*.sol 的宣告，逐一核對
// 名稱、參數型別（topic0／selector 只看型別）與事件的 indexed 位置。合約改了而這裡沒跟上就失敗。
// 完全離線，不需要 forge。
//   cd agent && npx tsx copy-sync/src/abi.test.ts
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { COPY_TRACKER_ABI, PERPETUAL_EXCHANGE_ERRORS_ABI, RESYNC_FOR_SIGNATURE, STRATEGY_REGISTRY_ABI } from "./abi.ts";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "src");

interface Decl {
  kind: "function" | "event" | "error";
  name: string;
  types: string[];
  indexed: boolean[];
}

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function parseSol(file: string): { decls: Decl[]; text: string } {
  const text = stripComments(readFileSync(join(SRC, file), "utf8"));
  const enums = new Set([...text.matchAll(/\benum\s+(\w+)\s*\{/g)].map((m) => m[1]));
  const norm = (t: string) => {
    const base = t.replace(/^\w+\./, ""); // StrategyRegistry.Allocation → Allocation
    if (enums.has(base)) return "uint8";
    if (base === "uint") return "uint256";
    if (base === "int") return "int256";
    return base;
  };
  const decls: Decl[] = [];
  for (const m of text.matchAll(/\b(function|event|error)\s+(\w+)\s*\(([^)]*)\)/g)) {
    const params = m[3].split(",").map((p) => p.trim()).filter(Boolean);
    decls.push({
      kind: m[1] as Decl["kind"],
      name: m[2],
      types: params.map((p) => norm(p.split(/\s+/)[0])),
      indexed: params.map((p) => /\bindexed\b/.test(p)),
    });
  }
  return { decls, text };
}

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

function check(abi: readonly string[], files: string[], label: string): void {
  const parsed = files.map(parseSol);
  const decls = parsed.flatMap((p) => p.decls);
  const text = parsed.map((p) => p.text).join("\n");
  const iface = new ethers.Interface(abi as unknown as string[]);
  iface.forEachFunction((f) => {
    const found = decls.filter((d) => d.kind === "function" && d.name === f.name);
    if (found.length === 0) {
      // public 狀態變數／mapping 的自動 getter
      assert.ok(new RegExp(`\\bpublic\\b[^;=]*\\b${f.name}\\b`).test(text), `${label}: 找不到 ${f.name}（函式或 public 變數）`);
      return;
    }
    const want = f.inputs.map((i) => i.type).join(",");
    assert.ok(found.some((d) => d.types.join(",") === want), `${label}: ${f.name}(${want}) 與原始碼 ${found.map((d) => `(${d.types})`).join(" ")} 不符`);
  });
  iface.forEachEvent((e) => {
    const d = decls.find((x) => x.kind === "event" && x.name === e.name);
    assert.ok(d, `${label}: 找不到 event ${e.name}`);
    assert.equal(e.inputs.map((i) => i.type).join(","), d!.types.join(","), `${label}: event ${e.name} 型別不符`);
    assert.deepEqual(e.inputs.map((i) => !!i.indexed), d!.indexed, `${label}: event ${e.name} 的 indexed 位置不符`);
  });
  iface.forEachError((e) => {
    const d = decls.find((x) => x.kind === "error" && x.name === e.name);
    assert.ok(d, `${label}: 找不到 error ${e.name}`);
    assert.equal(e.inputs.map((i) => i.type).join(","), d!.types.join(","), `${label}: error ${e.name} 型別不符`);
  });
}

check(COPY_TRACKER_ABI, ["CopyTracker.sol"], "CopyTracker");
ok("CopyTracker 的函式、事件（含 indexed 位置）、錯誤都與 contracts/src/CopyTracker.sol 相同");

check(STRATEGY_REGISTRY_ABI, ["StrategyRegistry.sol"], "StrategyRegistry");
ok("StrategyRegistry 的 getLatestStrategy／getStrategyCount／isEligibleTrader／StrategyPublished 相同");

check(PERPETUAL_EXCHANGE_ERRORS_ABI, ["PerpetualExchange.sol"], "PerpetualExchange");
ok("交易所會冒泡上來的錯誤（KYC、市場模式、OI 上限…）與原始碼相同");

// 執行者解讀事件時只依賴 topic1：AutoSyncSet／Resynced／SyncGasDeposited／TraderFollowed 的第一個
// indexed 參數必須是 follower，StrategyPublished 的必須是 trader。
const t = new ethers.Interface(COPY_TRACKER_ABI as unknown as string[]);
for (const name of ["AutoSyncSet", "Resynced", "SyncGasDeposited", "TraderFollowed", "TraderUnfollowed", "SyncExecutorSet"]) {
  const ev = t.getEvent(name)!;
  assert.equal(ev.inputs[0].name, "follower");
  assert.ok(ev.inputs[0].indexed, `${name} 的 follower 必須是 indexed`);
}
const sp = new ethers.Interface(STRATEGY_REGISTRY_ABI as unknown as string[]).getEvent("StrategyPublished")!;
assert.ok(sp.inputs[0].name === "trader" && sp.inputs[0].indexed);
ok("topic1 的約定：tracker 事件是 follower、StrategyPublished 是 trader");

const guardSel = new ethers.Interface([RESYNC_FOR_SIGNATURE]).getFunction("resyncFor")!.selector;
assert.equal(guardSel, t.getFunction("resyncFor")!.selector, "簽章白名單的 selector 與 ABI 相同");
ok("guard.ts 白名單的 resyncFor selector 與合約一致");

// 與前端同一個來源：frontend/src/contracts/abi/*.json 是 forge 產物（contracts/out/<C>.sol/<C>.json 的 abi），
// 前端的 abiSync.test.ts 再把它對回合約原始碼。上面的原始碼解析只看參數型別；這裡逐一核對完整片段——
// 回傳型別、payable／view（例如 resyncFor 是 payable、guard.ts 才要求 value = 0）與 indexed——
// 確保執行者與前端用的是同一份介面。
const FRONTEND_ABI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "frontend", "src", "contracts", "abi");
function sameAsArtifact(abi: readonly string[], contract: string): void {
  const artifact = new ethers.Interface(JSON.parse(readFileSync(join(FRONTEND_ABI, `${contract}.json`), "utf8")));
  const ours = new ethers.Interface(abi as unknown as string[]);
  const shape = (f: ethers.Fragment): string => {
    const params = (ps: readonly ethers.ParamType[]) => ps.map((p) => p.format("sighash") + (p.indexed ? " indexed" : "")).join(",");
    if (f instanceof ethers.FunctionFragment) return `${f.name}(${params(f.inputs)}) ${f.stateMutability} returns (${params(f.outputs)})`;
    if (f instanceof ethers.EventFragment || f instanceof ethers.ErrorFragment) return `${f.type} ${f.name}(${params(f.inputs)})`;
    return f.type; // constructor／fallback／receive：執行者不用
  };
  const theirs = new Set(artifact.fragments.map(shape));
  for (const f of ours.fragments) {
    assert.ok(theirs.has(shape(f)), `${contract}: ${shape(f)} 與 forge 產物（frontend/src/contracts/abi/${contract}.json）不符`);
  }
}
sameAsArtifact(COPY_TRACKER_ABI, "CopyTracker");
sameAsArtifact(STRATEGY_REGISTRY_ABI, "StrategyRegistry");
sameAsArtifact(PERPETUAL_EXCHANGE_ERRORS_ABI, "PerpetualExchange");
ok("每個片段（含回傳型別、payable／view、indexed）都與前端用的 forge 產物 ABI 完全相同");

console.log(`copy-sync abi: ${n} ok`);
