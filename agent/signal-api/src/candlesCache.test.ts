// /candles 快取上界與參數夾取，離線測試（不打上游）。
//   cd agent && npx tsx signal-api/src/candlesCache.test.ts
import assert from "node:assert";
import { LruCache } from "./lru.ts";
import { normalizeEnd, normalizeLimit, MIN_END_SEC, MAX_LIMIT, DEFAULT_LIMIT, CANDLE_CACHE_MAX } from "./candles.ts";

// ── LRU：容量有上界、淘汰最久未用的 ──────────────────────────────────────────
{
  const c = new LruCache<number>(3);
  c.set("a", 1);
  c.set("b", 2);
  c.set("c", 3);
  assert.equal(c.get("a"), 1); // a 變成最新
  c.set("d", 4); // 淘汰最久未用的 b
  assert.equal(c.size, 3);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  for (let i = 0; i < 10_000; i += 1) c.set(`k${i}`, i);
  assert.equal(c.size, 3, "大量不同鍵也不會超過上限");
  assert.throws(() => new LruCache(0));
  assert.ok(CANDLE_CACHE_MAX >= 1);
  console.log(`✓ LRU 有上界（candles 快取上限 ${CANDLE_CACHE_MAX}）`);
}

// ── end：未來 → 最新；太早 → 夾到下限；非法 → 沒給 ───────────────────────────
{
  const now = 1_800_000_000;
  assert.equal(normalizeEnd(undefined, now), undefined);
  assert.equal(normalizeEnd("abc", now), undefined);
  assert.equal(normalizeEnd(0, now), undefined);
  assert.equal(normalizeEnd(-5, now), undefined);
  assert.equal(normalizeEnd(now + 999_999, now), undefined, "未來的 end 等同最新，共用同一格快取");
  assert.equal(normalizeEnd(5, now), MIN_END_SEC, "1970 年的 end 夾到下限");
  assert.equal(normalizeEnd(1_000, now), MIN_END_SEC);
  assert.equal(normalizeEnd("1700000000.9", now), 1_700_000_000);
  console.log("✓ end 夾在 [MIN_END_SEC, now) 之間");
}

// ── limit：夾在 [1, MAX_LIMIT] ───────────────────────────────────────────────
{
  assert.equal(normalizeLimit(undefined), DEFAULT_LIMIT);
  assert.equal(normalizeLimit("abc"), DEFAULT_LIMIT);
  assert.equal(normalizeLimit(0), 1);
  assert.equal(normalizeLimit(-100), 1);
  assert.equal(normalizeLimit(10_000_000), MAX_LIMIT);
  assert.equal(normalizeLimit("12.7"), 12);
  console.log(`✓ limit 夾在 [1, ${MAX_LIMIT}]`);
}

console.log("candlesCache.test.ts ✓ all assertions passed");
