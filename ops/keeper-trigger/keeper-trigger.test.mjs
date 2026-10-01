// node --test ops/keeper-trigger/keeper-trigger.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { decide } from "./decide.mjs";
import worker, { tick, workflowsOf } from "./worker.mjs";

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
  const [d] = await tick(ENV, NOW);
  assert.equal(d.dispatch, true);
  assert.equal(d.workflow, "base-sepolia-keeper.yml");
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

test("scheduled：tick 失敗時 reject（Cloudflare 記成失敗的 cron），成功時 resolve", async () => {
  const bad = fakeFetch((url, init) => (init.method === "POST" ? { status: 403, body: "forbidden" } : { status: 500 }));
  globalThis.fetch = bad.fn;
  await assert.rejects(worker.scheduled({}, ENV, { waitUntil: () => assert.fail("不應改用 waitUntil") }), /HTTP 403/);
  await assert.rejects(worker.scheduled({}, { GITHUB_REPO: "x/y" }), /GITHUB_TOKEN/);

  const good = fakeFetch((url, init) =>
    init.method === "POST"
      ? { status: 204 }
      : { status: 200, body: JSON.stringify({ workflow_runs: [{ status: "completed", created_at: new Date(Date.now() - 3600_000).toISOString() }] }) },
  );
  globalThis.fetch = good.fn;
  await worker.scheduled({}, ENV);
  assert.equal(good.calls.filter((c) => c.method === "POST").length, 1);
});

test("HTTP 請求一律 404，公開 URL 不能觸發 keeper", async () => {
  const res = await worker.fetch(new Request("https://example.invalid/"));
  assert.equal(res.status, 404);
});

test("workflowsOf：WORKFLOW_FILES 優先、去重、拒絕不合法檔名", () => {
  assert.deepEqual(workflowsOf({}), ["base-sepolia-keeper.yml"]);
  assert.deepEqual(workflowsOf({ WORKFLOW_FILE: "a.yml" }), ["a.yml"]);
  assert.deepEqual(workflowsOf({ WORKFLOW_FILES: " a.yml, b.yaml ,a.yml", WORKFLOW_FILE: "x.yml" }), ["a.yml", "b.yaml"]);
  assert.throws(() => workflowsOf({ WORKFLOW_FILES: "../secrets.yml" }), /不合法/);
  assert.throws(() => workflowsOf({ WORKFLOW_FILES: "a.yml/dispatches?x" }), /不合法/);
  assert.throws(() => workflowsOf({ WORKFLOW_FILES: " , " }), /空的/);
});

test("tick：多個 workflow 各自判斷——一個執行中、一個過久 → 只觸發後者", async () => {
  const f = fakeFetch((url, init) => {
    if (init.method === "POST") return { status: 204 };
    const status = url.includes("base-sepolia-keeper") ? "in_progress" : "completed";
    return { status: 200, body: JSON.stringify({ workflow_runs: [{ status, created_at: ago(5 * 3600) }] }) };
  });
  globalThis.fetch = f.fn;
  const r = await tick({ ...ENV, WORKFLOW_FILES: "base-sepolia-keeper.yml,price-keeper.yml" }, NOW);
  assert.deepEqual(r.map((x) => [x.workflow, x.dispatch]), [["base-sepolia-keeper.yml", false], ["price-keeper.yml", true]]);
  const posts = f.calls.filter((c) => c.method === "POST");
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /price-keeper\.yml\/dispatches$/);
});

test("tick：一個 workflow dispatch 失敗不影響另一個，最後仍丟錯", async () => {
  const f = fakeFetch((url, init) => {
    if (init.method === "POST") return url.includes("price-keeper") ? { status: 500, body: "boom" } : { status: 204 };
    return { status: 200, body: JSON.stringify({ workflow_runs: [{ status: "completed", created_at: ago(3600) }] }) };
  });
  globalThis.fetch = f.fn;
  await assert.rejects(tick({ ...ENV, WORKFLOW_FILES: "base-sepolia-keeper.yml,price-keeper.yml" }, NOW), /price-keeper\.yml.*HTTP 500/);
  const posts = f.calls.filter((c) => c.method === "POST").map((c) => c.url);
  assert.ok(posts.some((u) => u.includes("base-sepolia-keeper")), "另一個仍有觸發");
});

test("wrangler.toml 照顧兩條鏈的 keeper", async () => {
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /WORKFLOW_FILES = "base-sepolia-keeper\.yml,price-keeper\.yml"/);
});
