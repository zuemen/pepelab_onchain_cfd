// node --test scripts/vercel-ignore-build.test.mjs
// 在暫存 git repo 裡模擬 Vercel 的 Ignored Build Step（exit 0 = 跳過、exit 1 = 建置）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("scripts/vercel-ignore-build.sh");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "vib-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  const commit = (file, body) => {
    mkdirSync(join(dir, file, ".."), { recursive: true });
    writeFileSync(join(dir, file), body);
    git("add", "-A");
    git("commit", "-q", "-m", file);
    return git("rev-parse", "HEAD");
  };
  return { dir, commit };
}

function run(cwd, env, ...paths) {
  const r = spawnSync("bash", [SCRIPT, ...paths], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, VERCEL_GIT_COMMIT_REF: "master", VERCEL_GIT_PREVIOUS_SHA: "", ...env },
  });
  return r.status;
}

test("上次部署之後本專案有變更 → 建置", () => {
  const r = repo();
  const base = r.commit("frontend/a.ts", "1");
  r.commit("frontend/a.ts", "2");
  assert.equal(run(join(r.dir, "frontend"), { VERCEL_GIT_PREVIOUS_SHA: base }, "."), 1);
});

test("只有其他目錄變更 → 跳過", () => {
  const r = repo();
  r.commit("frontend/a.ts", "1");
  const base = r.commit("agent/x.ts", "1");
  r.commit("agent/x.ts", "2");
  assert.equal(run(join(r.dir, "frontend"), { VERCEL_GIT_PREVIOUS_SHA: base }, "."), 0);
});

test("上次部署被額度擋下：基準是更早的成功部署，積欠的變更仍會建置", () => {
  const r = repo();
  const lastDeployed = r.commit("frontend/a.ts", "1");
  r.commit("frontend/a.ts", "2"); // 這次部署被擋
  r.commit("agent/x.ts", "1"); // 之後只動 agent
  assert.equal(run(join(r.dir, "frontend"), { VERCEL_GIT_PREVIOUS_SHA: lastDeployed }, "."), 1);
});

test("相對路徑可涵蓋上層檔案（signal-api 的 lockfile）", () => {
  const r = repo();
  r.commit("agent/signal-api/api/index.js", "1");
  const base = r.commit("agent/package-lock.json", "1");
  r.commit("agent/package-lock.json", "2");
  const cwd = join(r.dir, "agent/signal-api");
  assert.equal(run(cwd, { VERCEL_GIT_PREVIOUS_SHA: base }, ".", "../package.json", "../package-lock.json"), 1);
  assert.equal(run(cwd, { VERCEL_GIT_PREVIOUS_SHA: base }, "."), 0);
});

test("沒有基準、基準不存在、沒指定路徑 → 一律建置", () => {
  const r = repo();
  r.commit("frontend/a.ts", "1");
  const cwd = join(r.dir, "frontend");
  assert.equal(run(cwd, {}, "."), 1);
  assert.equal(run(cwd, { VERCEL_GIT_PREVIOUS_SHA: "deadbeef".repeat(5) }, "."), 1);
  assert.equal(run(cwd, { VERCEL_GIT_PREVIOUS_SHA: "HEAD" }), 1);
});

test("dependabot 分支 → 跳過 preview", () => {
  const r = repo();
  const base = r.commit("frontend/a.ts", "1");
  r.commit("frontend/a.ts", "2");
  assert.equal(
    run(join(r.dir, "frontend"), { VERCEL_GIT_COMMIT_REF: "dependabot/npm_and_yarn/x", VERCEL_GIT_PREVIOUS_SHA: base }, "."),
    0,
  );
});

test("兩個 vercel.json 都掛上 ignoreCommand", async () => {
  const { readFileSync } = await import("node:fs");
  for (const p of ["frontend/vercel.json", "agent/signal-api/vercel.json"]) {
    const cmd = JSON.parse(readFileSync(p, "utf8")).ignoreCommand ?? "";
    assert.match(cmd, /scripts\/vercel-ignore-build\.sh \./, p);
  }
});

test("兩個 vercel.json 只讓 master 與 preview/** 建立部署（被取消的部署仍計入額度）", async () => {
  const { readFileSync } = await import("node:fs");
  for (const p of ["frontend/vercel.json", "agent/signal-api/vercel.json"]) {
    const d = JSON.parse(readFileSync(p, "utf8")).git?.deploymentEnabled;
    assert.deepEqual(d, { "**": false, master: true, "preview/**": true }, p);
  }
});
