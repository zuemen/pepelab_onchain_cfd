// 跨 process 檔案鎖測試（審查 Medium-5）：兩個 process 同時對同一份 policy 狀態做
// 預留、同時寫 VC nonce 狀態與 hash-chained 稽核。沒有鎖時會發生 lost update
// （每日額度少算）與 hash chain 分岔。不連鏈、不送交易。
//   npx tsx examples/concurrency.test.ts
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pepe-conc-"));
const statePath = path.join(TMP, "policy.json");
const auditPath = path.join(TMP, "audit.jsonl");
const noncePath = path.join(TMP, "nonces.json");
const N = 20;
const WORKERS = 2;

const { readAudit, verifyAuditChain, readPolicyState, withFileLockSync, LockTimeoutError } = await import("@pepelab/shared");

const worker = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "concurrency-worker.ts");
const env = {
  ...process.env,
  POLICY_STATE_PATH: statePath,
  POLICY_AUDIT_PATH: auditPath,
  VC_NONCE_STATE_PATH: noncePath,
  POLICY_MAX_DAILY_MARGIN: "100000",
  POLICY_MAX_ORDERS_PER_WINDOW: "100000",
  WORKER_ITER: String(N),
};
let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

const children = Array.from({ length: WORKERS }, (_, i) =>
  fork(worker, [], { env: { ...env, WORKER_ID: String(i) }, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"] }),
);
await Promise.all(children.map((c) => new Promise<void>((res) => c.once("message", () => res()))));
const results = await Promise.all(
  children.map(
    (c) =>
      new Promise<{ allowed: number; nonceOk: number }>((res, rej) => {
        c.once("message", (m) => res(m as any));
        c.once("exit", (code) => code !== 0 && rej(new Error(`worker exit ${code}`)));
        c.send("go");
      }),
  ),
);

const total = WORKERS * N;
assert.equal(results.reduce((a, r) => a + r.allowed, 0), total, "每一次預留都被放行");
const st = readPolicyState(statePath);
const a = Object.values(st.agents)[0];
assert.equal(a.dailyMargin, total, `兩個 process 同時預留：每日累計必須是 ${total}（無 lost update），實得 ${a.dailyMargin}`);
assert.equal(a.orders.length, total, "筆數計數也不能遺失");
ok(`兩個 process 同時各預留 ${N} 次 → dailyMargin=${a.dailyMargin}、orders=${a.orders.length}（無 lost update）`);

const recs = readAudit(auditPath);
assert.equal(recs.length, total);
assert.deepEqual(verifyAuditChain(recs), [], "並發 append 後 hash chain 仍完整");
ok(`並發寫稽核 ${recs.length} 筆，hash chain 完整`);

assert.equal(results.reduce((a, r) => a + r.nonceOk, 0), total);
const nonces = JSON.parse(fs.readFileSync(noncePath, "utf8")).nonces;
assert.equal(Object.keys(nonces).length, total, "並發記錄 nonce 不遺失");
ok(`並發記錄 VC nonce ${total} 筆，無遺失`);

// 過期鎖回收：持有者 pid 已不存在 → 可回收；存活且未過期 → 逾時
{
  const target = path.join(TMP, "x.json");
  fs.writeFileSync(`${target}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, token: "dead", at: Date.now() }));
  assert.equal(withFileLockSync(target, () => 42), 42, "死掉的持有者 → 回收");
  fs.writeFileSync(`${target}.lock`, JSON.stringify({ pid: process.pid, token: "live", at: Date.now() - 60_000 }));
  assert.equal(withFileLockSync(target, () => 43), 43, "超過 staleMs → 回收");
  fs.writeFileSync(`${target}.lock`, JSON.stringify({ pid: process.pid, token: "live", at: Date.now() }));
  assert.throws(() => withFileLockSync(target, () => 0, { timeoutMs: 100 }), LockTimeoutError);
  fs.unlinkSync(`${target}.lock`);
  ok("過期鎖回收（pid 不存在 / 超過 staleMs）；有效鎖 → LockTimeoutError");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n✅ concurrency.test.ts 全過（${n} 組）`);
