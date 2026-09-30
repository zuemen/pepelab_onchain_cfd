// node --test ops/keeper-trigger/keeper-trigger.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { decide } from "./decide.mjs";
import worker, { tick } from "./worker.mjs";

const NOW = Date.parse("2026-09-30T10:00:00Z");
const ago = (sec) => new Date(NOW - sec * 1000).toISOString();

test("沒有任何執行紀錄 → 觸發", () => {
  assert.equal(decide(null, NOW).dispatch, true);
});

test("最近一次在排隊或進行中 → 不觸發", () => {
  for (const status of ["queued", "in_progress", "waiting", "requested", "pending"]) {
    assert.equal(decide({ status, created_at: ago(7200) }, NOW).dispatch, false, status);
  }
});

test("最近一次完成於 15 分鐘內 → 不觸發；超過 → 觸發", () => {
  assert.equal(decide({ status: "completed", created_at: ago(600) }, NOW).dispatch, false);
  assert.equal(decide({ status: "completed", created_at: ago(900) }, NOW).dispatch, true);
  assert.equal(decide({ status: "completed", created_at: ago(4.5 * 3600) }, NOW).dispatch, true);
});

test("created_at 壞掉 → 觸發（寧可多跑一次）", () => {
  assert.equal(decide({ status: "completed", created_at: "nope" }, NOW).dispatch, true);
});

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: init.headers, body: init.body });
    const r = routes(url, init);
    return new Response(r.body ?? null, { status: r.status });
  };
  return { fn, calls };
}

const ENV = { GITHUB_TOKEN: "t", GITHUB_REPO: "zuemen/pepelab_onchain_cfd" };

test("tick：舊執行已完成 → POST dispatch（ref master），帶 token", async () => {
  const f = fakeFetch((url, init) =>
    init.method === "POST"
      ? { status: 204 }
      : { status: 200, body: JSON.stringify({ workflow_runs: [{ status: "completed", created_at: ago(3600) }] }) },
  );
  globalThis.fetch = f.fn;
  const d = await tick(ENV, NOW);
  assert.equal(d.dispatch, true);
  const post = f.calls.find((c) => c.method === "POST");
  assert.match(post.url, /\/repos\/zuemen\/pepelab_onchain_cfd\/actions\/workflows\/base-sepolia-keeper\.yml\/dispatches$/);
  assert.deepEqual(JSON.parse(post.body), { ref: "master" });
  assert.equal(post.headers.Authorization, "Bearer t");
});

test("tick：執行中 → 不送 POST", async () => {
  const f = fakeFetch(() => ({
    status: 200,
    body: JSON.stringify({ workflow_runs: [{ status: "in_progress", created_at: ago(60) }] }),
  }));
  globalThis.fetch = f.fn;
  await tick(ENV, NOW);
  assert.equal(f.calls.filter((c) => c.method === "POST").length, 0);
});

test("tick：dispatch 非 204 → 丟錯，讓 Cloudflare 記成失敗", async () => {
  const f = fakeFetch((url, init) => (init.method === "POST" ? { status: 403, body: "forbidden" } : { status: 500 }));
  globalThis.fetch = f.fn;
  await assert.rejects(tick(ENV, NOW), /HTTP 403/);
});

test("tick：缺 token 或 repo → 丟錯", async () => {
  await assert.rejects(tick({ GITHUB_REPO: "x/y" }, NOW), /GITHUB_TOKEN/);
});

test("HTTP 請求一律 404，公開 URL 不能觸發 keeper", async () => {
  const res = await worker.fetch(new Request("https://example.invalid/"));
  assert.equal(res.status, 404);
});
