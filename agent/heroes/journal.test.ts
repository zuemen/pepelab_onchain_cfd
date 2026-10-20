// 中斷續跑（#344）：從正確的那一天接著跑、不重複送出、區塊與天數的對應正確。
// 用一條假的鏈模擬回放的形狀（每天幾個動作、有依賴當下狀態的決定），在各種位置中斷再重跑。
//   cd agent && npx tsx heroes/journal.test.ts
import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayOfBlock, fileStore, Journal, memoryStore, type Entry, type ProgressStore, type Resolution } from "./journal.ts";

const DATES = ["2024-10-01", "2024-10-02", "2024-10-03", "2024-10-04"];
const ACTIONS = ["price:a", "price:b", "close:1", "open:1:0", "open:1:1"];
const IDENTITY = { schedule: "abc", exchange: "0xex" };

class Crash extends Error {}

/** 假的鏈：每筆交易一個區塊。lost=true 的那一筆廣播前就斷線（節點不知道它）。 */
class FakeChain {
  block = 100;
  mined = new Map<string, number>(); // hash → block
  sends: string[] = [];
  margin = 1000; // 「當下狀態」：平倉會改變它，開倉的大小依它決定
  send(key: string): string {
    const hash = `0x${key}#${this.sends.length}`;
    this.sends.push(key);
    this.mined.set(hash, ++this.block);
    if (key.startsWith("close")) this.margin += 500;
    return hash;
  }
  resolve = async (e: Entry): Promise<Resolution> => (this.mined.has(e.hash!) ? "ok" : "unknown");
}

/** 回放的形狀：startDay → 各動作（開倉金額是依當下 margin 算的決定，要記進進度）→ finishDay。crashAfter 次送出後中斷。 */
async function run(chain: FakeChain, store: ProgressStore, crashAfter = Infinity, loseLast = false): Promise<Journal> {
  const j = new Journal(store, 84532, IDENTITY);
  let budget = crashAfter;
  for (let n = j.nextDay(DATES); n < DATES.length; n++) {
    const { resumed } = j.startDay(DATES[n], chain.block + 1);
    if (resumed) await j.resolvePending(chain.resolve);
    const size = await j.plan("opens", async () => chain.margin, (v) => v, (raw) => raw as number);
    assert.equal(typeof size, "number");
    for (const key of ACTIONS) {
      if (j.entry(key)) continue;
      if (budget-- <= 0) throw new Crash();
      const hash = chain.send(`${DATES[n]}/${key}`);
      j.markSent(key, hash, "0xfrom");
      if (loseLast && budget <= 0) {
        chain.mined.delete(hash); // 廣播失敗：雜湊記了，節點卻沒收到
        chain.sends.pop();
        throw new Crash();
      }
      j.markResult(key, true, key);
    }
    j.finishDay(chain.block, 1_700_000_000 + chain.block, []);
  }
  return j;
}

const expected = DATES.flatMap((d) => ACTIONS.map((a) => `${d}/${a}`));

// ── 不中斷：每個動作恰好一次 ─────────────────────────────────────────────
{
  const chain = new FakeChain();
  const j = await run(chain, memoryStore());
  assert.deepEqual(chain.sends, expected);
  assert.equal(j.doc.days.length, 4);
  assert.equal(j.doc.stats.sent, expected.length);
}

// ── 在每一個位置中斷再重跑：送出的交易與不中斷時完全相同 ───────────────
for (let crashAt = 0; crashAt <= expected.length; crashAt++) {
  const chain = new FakeChain();
  const store = memoryStore();
  try {
    await run(chain, store, crashAt);
  } catch (e) {
    if (!(e instanceof Crash)) throw e;
  }
  const j = await run(chain, store);
  assert.deepEqual(chain.sends, expected, `crash after ${crashAt} sends: duplicates or gaps`);
  assert.equal(j.doc.stats.sent, expected.length, `crash after ${crashAt}: sent count`);
  // 中斷前那一天的起始區塊沿用第一次的，區塊範圍連續、不重疊
  for (let i = 1; i < j.doc.days.length; i++) assert.ok(j.doc.days[i].fromBlock > j.doc.days[i - 1].toBlock);
}

// ── 記了雜湊但節點沒收到：續跑時重送那一筆，只那一筆 ───────────────────
{
  const chain = new FakeChain();
  const store = memoryStore();
  await assert.rejects(run(chain, store, 7, true), Crash);
  assert.equal(chain.sends.length, 6);
  const j = await run(chain, store);
  assert.deepEqual(chain.sends, expected);
  assert.equal(j.doc.stats.sent, expected.length);
}

// ── 依賴當下狀態的決定沿用第一次算出來的 ─────────────────────────────────
{
  const chain = new FakeChain();
  const store = memoryStore();
  await assert.rejects(run(chain, store, 3), Crash); // 第一天平倉之後中斷：margin 已經變了
  const j = new Journal(store, 84532, IDENTITY);
  assert.equal(j.doc.current!.plans.opens, 1000, "the open size was decided before the close and must stay");
}

// ── 進度檔：寫到磁碟、另一個行程讀回（換鏈或換排程就拒絕）───────────────
{
  const dir = mkdtempSync(join(tmpdir(), "heroes-journal-"));
  try {
    const path = join(dir, "progress.json");
    const chain = new FakeChain();
    await assert.rejects(run(chain, fileStore(path), 8), Crash);
    const j = await run(chain, fileStore(path));
    assert.deepEqual(chain.sends, expected);
    assert.equal(j.nextDay(DATES), DATES.length);
    assert.throws(() => new Journal(fileStore(path), 31337, IDENTITY), /chainId 84532/);
    assert.throws(() => new Journal(fileStore(path), 84532, { ...IDENTITY, schedule: "other" }), /another replay: schedule/);
    // 排程的前幾天被改過：nextDay 拒絕
    assert.throws(() => j.nextDay(["2024-10-01", "2024-10-09", "2024-10-03", "2024-10-04"]), /schedule says 2024-10-09/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 跳過的原因只記一次 ───────────────────────────────────────────────────
{
  const j = new Journal(memoryStore(), 84532, IDENTITY);
  j.skip("publish:2024-10-01:13", "publish x: stake below the minimum");
  j.skip("publish:2024-10-01:13", "publish x: stake below the minimum");
  assert.deepEqual(j.doc.stats.skipped, ["publish x: stake below the minimum"]);
}

// ── 區塊 → 模擬日 ────────────────────────────────────────────────────────
{
  const days = [
    { date: "2024-10-01", fromBlock: 10, toBlock: 19, toTimestamp: 1 },
    { date: "2024-10-02", fromBlock: 20, toBlock: 20, toTimestamp: 2 },
    { date: "2024-10-04", fromBlock: 25, toBlock: 40, toTimestamp: 3 },
  ];
  assert.equal(dayOfBlock(days, 10), "2024-10-01");
  assert.equal(dayOfBlock(days, 19), "2024-10-01");
  assert.equal(dayOfBlock(days, 20), "2024-10-02");
  assert.equal(dayOfBlock(days, 33), "2024-10-04");
  assert.equal(dayOfBlock(days, 9), null, "setup blocks belong to no day");
  assert.equal(dayOfBlock(days, 22), null, "blocks between days (someone else's) belong to no day");
  assert.equal(dayOfBlock(days, 41), null);
}

console.log("journal: ok");

// ── 續跑時：沒送出就被判失敗的動作重做一次（節點落後的誤判），送出過的失敗不重做 ─────
{
  const j = new Journal(memoryStore(), 84532, IDENTITY);
  j.markRejected("stake:10", "stake Whale Alpha", "execution reverted (ERC20InsufficientAllowance)");
  j.markSent("open:10:0", "0xabc", "0xfrom", 3);
  j.markResult("open:10:0", false, "open Whale Alpha sBTC", "reverted: 0xabc");
  assert.equal(j.doc.stats.failed, 2);
  assert.equal(j.retryRejected(), 1);
  assert.equal(j.entry("stake:10"), undefined, "rejected-before-send is retried");
  assert.equal(j.entry("open:10:0")!.status, "failed", "a mined revert is kept");
  assert.deepEqual([j.doc.stats.sent, j.doc.stats.failed], [1, 1]);
  assert.deepEqual(j.doc.stats.failures, ["open Whale Alpha sBTC: reverted: 0xabc"]);
}

console.log("journal (retryRejected): ok");

// ── 失敗的動作列得出來（初始化有失敗就不能進第一天）─────────────────────────
{
  const j = new Journal(memoryStore(), 84532, IDENTITY);
  j.markSent("mint:10", "0x1", "0xf");
  j.markResult("mint:10", true, "mint");
  j.markRejected("stake:10", "stake Whale Alpha", "reverted");
  assert.deepEqual(j.failedEntries(), ["stake:10"]);
  j.retryRejected();
  assert.deepEqual(j.failedEntries(), []);
}
console.log("journal (failedEntries): ok");
