// 熔斷停單說明的純函式測試（複審 H2）。
//   cd agent && npx tsx keeper/protect.test.ts
import assert from "node:assert";
import { describeProtection, formatAge, protectAsset } from "./protect.ts";
import { renderBody, renderCloseComment, decideAlert, type HealthReport } from "./alert.ts";

// 線上現況：exchange 是舊合約 → 做不到切 ReduceOnly，必須明寫。
{
  const d = describeProtection({ symbol: "sAAPL", mode: "unsupported" }, 21_600);
  assert.equal(d.exchangeStillTrading, true);
  assert.ok(d.notes.some((n) => n.includes("交易所將以舊價繼續成交，直到 maxPriceAge（6h）；需人工處置")), d.notes.join(" | "));
  assert.ok(d.notes[0].includes("setAssetMode"), d.notes[0]);
  assert.ok(!d.notes.join("").includes("GUARDIAN"), "不再提凍結 GuardedOracle");
}
assert.equal(describeProtection({ symbol: "sBTC", mode: "not-operator" }, 21_600).exchangeStillTrading, true);
// 切到 ReduceOnly → 不再新開倉，但仍提醒平倉與清算用舊價。
{
  const d = describeProtection({ symbol: "sAAPL", mode: "done" }, 21_600);
  assert.equal(d.exchangeStillTrading, false);
  assert.ok(d.notes.some((n) => n.includes("平倉與清算仍以舊價執行")));
}
assert.equal(describeProtection({ symbol: "x", mode: "already" }, null).exchangeStillTrading, false);
// maxPriceAge 讀不到時不編造數字。
assert.ok(describeProtection({ symbol: "x", mode: "unsupported" }, null).notes[1].includes("maxPriceAge（maxPriceAge）"));
assert.equal(formatAge(21_600), "6h");
assert.equal(formatAge(5_400), "1.5h");

// ── protectAsset（可注入，窄複審 7）─────────────────────────────────────────
const KEEPER = "0x540aECD37E7A7885824e7b7e996eBddfb842ef17";
const missing = Object.assign(new Error("missing revert data"), { code: "CALL_EXCEPTION", data: "0x" });
function fakeExchange(o: { operator?: string | Error; mode?: number; checkThrows?: Error; sendThrows?: Error }) {
  const sent: number[] = [];
  return {
    sent,
    marketOperator: async () => {
      if (o.operator instanceof Error) throw o.operator;
      return o.operator ?? KEEPER;
    },
    assetMode: async () => BigInt(o.mode ?? 0),
    checkSetAssetMode: async () => {
      if (o.checkThrows) throw o.checkThrows;
    },
    setAssetMode: async (_id: string, m: number) => {
      if (o.sendThrows) throw o.sendThrows;
      sent.push(m);
      return { hash: "0xrm", wait: async () => undefined };
    },
  };
}
const isMissing = (e: unknown) => (e as { data?: string }).data === "0x";
const base = { symbol: "sAAPL", assetId: "0xid", signerAddress: KEEPER, isMissingFunction: isMissing };
{
  const ex = fakeExchange({});
  const r = await protectAsset({ ...base, exchange: ex });
  assert.equal(r.mode, "done");
  assert.deepEqual(ex.sent, [1], "切 ReduceOnly（1）");
}
assert.equal((await protectAsset({ ...base, exchange: fakeExchange({ operator: missing }) })).mode, "unsupported");
assert.equal((await protectAsset({ ...base, exchange: fakeExchange({ operator: new Error("429") }) })).mode, "failed");
{
  const ex = fakeExchange({ operator: "0x000000000000000000000000000000000000dEaD" });
  assert.equal((await protectAsset({ ...base, exchange: ex })).mode, "not-operator");
  assert.equal(ex.sent.length, 0, "不是 operator 不送交易");
}
assert.equal((await protectAsset({ ...base, exchange: fakeExchange({ mode: 1 }) })).mode, "already");
assert.equal((await protectAsset({ ...base, exchange: fakeExchange({ mode: 2 }) })).mode, "already", "Halted 不碰");
{
  const ex = fakeExchange({ checkThrows: new Error("AssetModeChangeNotAllowed") });
  assert.equal((await protectAsset({ ...base, exchange: ex })).mode, "failed");
  assert.equal(ex.sent.length, 0, "預檢失敗不送交易");
}
assert.equal((await protectAsset({ ...base, signerAddress: null, exchange: fakeExchange({}) })).mode, "dry-run");
assert.equal((await protectAsset({ ...base, exchange: null })).mode, "no-exchange");

// ── 熔斷 issue 內文（alert.ts kind=breaker） ────────────────────────────────
const report: HealthReport = {
  kind: "breaker",
  chain: "base-sepolia",
  status: "stale",
  checkedAtSec: 1_790_000_000,
  maxAgeSec: 21_600,
  stale: ["sAAPL"],
  unreadable: [],
  notes: describeProtection({ symbol: "sAAPL", mode: "unsupported" }, 21_600).notes,
  lines: ["sAAPL: 偏離 30% 超過熔斷門檻"],
};
{
  const body = renderBody(report);
  assert.ok(body.includes("熔斷拒寫資產（1）"));
  assert.ok(body.includes("交易所將以舊價繼續成交，直到 maxPriceAge（6h）；需人工處置"));
  assert.ok(body.includes("<!-- oracle-health:stale=sAAPL -->"));
  assert.ok(!body.includes("過期資產"), "不能套用 oracle-health 的過期文案");
  assert.ok(renderCloseComment({ ...report, status: "ok", stale: [] }).includes("keeper 不會自動解除"));
}
// 本輪有資產來源無效 → 不自動關閉熔斷 issue。
assert.equal(
  decideAlert({
    report: { ...report, status: "ok", stale: [], unreadable: ["sAAPL"] },
    open: { number: 4, lastSignature: "sAAPL", lastUpdatedSec: 0 },
    nowSec: 1_790_000_000,
  }).action,
  "none",
);

console.log("protect.test.ts ✓ all assertions passed");
