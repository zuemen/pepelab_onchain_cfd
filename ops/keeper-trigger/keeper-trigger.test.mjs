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
  assert.throws(() => workflowsOf({ WORKFLOW_FILES: "..yml" }), /不合法/, "首字元必須是英數字");
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

// ───────────── GitHub App installation token ─────────────
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import {
  appConfigOf,
  createAppJwt,
  getInstallationToken,
  pemToPkcs8Der,
  pkcs1ToPkcs8,
  redact,
  resetAppTokenCache,
} from "./github-app.mjs";
import { resolveAuth } from "./worker.mjs";

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
const RSA_GEN = { ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
const toPem = (label, der) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der).toString("base64").match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;
const b64urlDecode = (s) => Buffer.from(s, "base64url");

// 每次測試執行產生一把臨時金鑰（WebCrypto），不落地、不進 repo。
const pair = await crypto.subtle.generateKey(RSA_GEN, true, ["sign", "verify"]);
const PKCS8_DER = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
const PKCS8_PEM = toPem("PRIVATE KEY", PKCS8_DER);
// GitHub 下載的格式是 PKCS#1。用 node:crypto（獨立於待測程式的實作）轉出來當 fixture。
const PKCS1_PEM = createPrivateKey({ key: Buffer.from(PKCS8_DER), format: "der", type: "pkcs8" }).export({
  type: "pkcs1",
  format: "pem",
});

async function verifyJwt(jwt, publicKey = pair.publicKey) {
  const [h, p, s] = jwt.split(".");
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    b64urlDecode(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  return { ok, header: JSON.parse(b64urlDecode(h)), payload: JSON.parse(b64urlDecode(p)) };
}

const APP_ENV = {
  GITHUB_REPO: "zuemen/pepelab_onchain_cfd",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_INSTALLATION_ID: "987654",
  GITHUB_APP_PRIVATE_KEY: PKCS1_PEM,
};
const INSTALL_TOKEN = "ghs_installationTokenForTests0123456789";
const isTokenReq = (c) => c.url.includes("/access_tokens");

/** access_tokens 回 201，其餘照 keeper 的 list／dispatch。tokenRes 可覆寫 access_tokens 的回應。 */
function appFetch({ tokenRes, dispatchStatus = 204, expiresAt } = {}) {
  let n = 0;
  return fakeFetch((url, init) => {
    if (url.includes("/access_tokens")) {
      n += 1;
      if (tokenRes) return tokenRes(init, n);
      return {
        status: 201,
        body: JSON.stringify({
          token: `${INSTALL_TOKEN}_${n}`,
          expires_at: expiresAt ?? new Date(NOW + 3600_000).toISOString(),
          permissions: { actions: "write", metadata: "read" },
        }),
      };
    }
    if (init.method === "POST") return { status: dispatchStatus, body: dispatchStatus === 204 ? null : "nope" };
    return {
      status: 200,
      body: JSON.stringify({ workflow_runs: [{ status: "completed", created_at: "2026-09-01T00:00:00Z" }] }),
    };
  });
}

function captureLogs() {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  return { lines, restore: () => (console.log = orig) };
}

test("App JWT：RS256、iat 回推 60 秒、exp 不超過 10 分鐘、iss 是 App ID，簽章可用公鑰驗證", async () => {
  const jwt = await createAppJwt({ appId: "123456", privateKeyPem: PKCS8_PEM }, NOW);
  const { ok, header, payload } = await verifyJwt(jwt);
  assert.equal(ok, true, "簽章必須驗得過");
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  const nowSec = NOW / 1000;
  assert.equal(payload.iat, nowSec - 60);
  assert.equal(payload.iss, "123456");
  assert.ok(payload.exp > nowSec && payload.exp <= nowSec + 600, `exp 必須在未來且不超過 10 分鐘（${payload.exp - nowSec}s）`);
  assert.deepEqual(Object.keys(payload).sort(), ["exp", "iat", "iss"]);
  assert.doesNotMatch(jwt, /[+/=]/, "必須是 base64url、不帶 padding");

  // 竄改 payload 後簽章必須失效（確認上面的驗證不是永遠為真）。
  const [h, , s] = jwt.split(".");
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...payload, iss: "999" })).toString("base64url")}.${s}`;
  assert.equal((await verifyJwt(forged)).ok, false);
  // 換一把公鑰必須驗不過。
  const other = await crypto.subtle.generateKey(RSA_GEN, true, ["sign", "verify"]);
  assert.equal((await verifyJwt(jwt, other.publicKey)).ok, false);
});

test("App 私鑰：PKCS#1（GitHub 下載的格式）包成 PKCS#8 後與原 PKCS#8 逐位元組相同，簽出的 JWT 驗得過", async () => {
  assert.match(PKCS1_PEM, /^-----BEGIN RSA PRIVATE KEY-----/);
  assert.deepEqual(pemToPkcs8Der(PKCS1_PEM), PKCS8_DER);
  assert.deepEqual(pemToPkcs8Der(PKCS8_PEM), PKCS8_DER);
  assert.equal((await verifyJwt(await createAppJwt({ appId: "1", privateKeyPem: PKCS1_PEM }, NOW))).ok, true);
  // secret 被貼成單行、換行變成字面 \n，或是 CRLF，都要能用。
  assert.deepEqual(pemToPkcs8Der(PKCS1_PEM.trim().replace(/\n/g, "\\n")), PKCS8_DER);
  assert.deepEqual(pemToPkcs8Der(PKCS1_PEM.replace(/\n/g, "\r\n")), PKCS8_DER);
  // 其他長度的金鑰（DER 長度欄位的不同編碼）也要包得對。
  for (const bits of [1024, 3072, 4096]) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: bits });
    const p1 = privateKey.export({ type: "pkcs1", format: "der" });
    const p8 = privateKey.export({ type: "pkcs8", format: "der" });
    assert.deepEqual(Buffer.from(pkcs1ToPkcs8(new Uint8Array(p1))), p8, `${bits} bits`);
  }
});

test("App 私鑰格式錯 → 丟錯，訊息不含金鑰內容", async () => {
  const body = Buffer.from(PKCS8_DER).toString("base64");
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const encrypted = createPrivateKey(PKCS1_PEM).export({
    type: "pkcs1",
    format: "pem",
    cipher: "aes-256-cbc",
    passphrase: "x",
  });
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const cases = [
    ["不是 PEM", body, /不是 PEM/],
    ["雜訊", "hello", /不是 PEM/],
    ["公鑰", toPem("PUBLIC KEY", spki), /PEM 類型是「PUBLIC KEY」/],
    ["加密的 PKCS#8", toPem("ENCRYPTED PRIVATE KEY", PKCS8_DER), /ENCRYPTED PRIVATE KEY/],
    ["加了密碼的 PKCS#1", encrypted, /加了密碼/],
    ["EC 金鑰（PKCS#8 外殼）", ec.privateKey.export({ type: "pkcs8", format: "pem" }), /無法匯入為 RSA 簽章金鑰/],
    ["截斷的 PKCS#8", toPem("PRIVATE KEY", PKCS8_DER.slice(0, 200)), /無法匯入為 RSA 簽章金鑰/],
    ["內容是垃圾的 PKCS#1", toPem("RSA PRIVATE KEY", new Uint8Array(64).fill(7)), /無法匯入為 RSA 簽章金鑰/],
    ["BEGIN／END 不一致", PKCS8_PEM.replace("END PRIVATE KEY", "END RSA PRIVATE KEY"), /不是 PEM/],
    ["base64 混入非法字元", PKCS8_PEM.replace("\n", "\n!!!!"), /不是合法的 base64/],
  ];
  for (const [name, pem, re] of cases) {
    await assert.rejects(createAppJwt({ appId: "1", privateKeyPem: pem }, NOW), (e) => {
      assert.match(e.message, re, name);
      assert.ok(
        !e.message.includes(body.slice(0, 24)) && !e.message.includes(body.slice(100, 124)),
        `${name}：訊息不可帶金鑰內容`,
      );
      assert.doesNotMatch(e.message, /[A-Za-z0-9+/]{40,}/, `${name}：訊息不可帶長 base64`);
      return true;
    });
  }
});

test("appConfigOf：三項都沒設 → null；只設一部分或格式錯 → 丟錯", () => {
  assert.equal(appConfigOf({ GITHUB_TOKEN: "t" }), null);
  assert.equal(appConfigOf({ GITHUB_APP_ID: " ", GITHUB_APP_INSTALLATION_ID: "" }), null, "空白視為沒設");
  assert.throws(
    () => appConfigOf({ GITHUB_APP_ID: "1" }),
    /設定不完整：缺少 GITHUB_APP_INSTALLATION_ID、GITHUB_APP_PRIVATE_KEY/,
  );
  assert.throws(() => appConfigOf({ GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2" }), /缺少 GITHUB_APP_PRIVATE_KEY/);
  assert.throws(() => appConfigOf({ ...APP_ENV, GITHUB_APP_INSTALLATION_ID: "12/../x" }), /INSTALLATION_ID 格式不對/);
  assert.throws(() => appConfigOf({ ...APP_ENV, GITHUB_APP_ID: "a b" }), /GITHUB_APP_ID 格式不對/);
  assert.equal(appConfigOf({ ...APP_ENV, GITHUB_APP_ID: "Iv23liABCdef" }).appId, "Iv23liABCdef", "client ID 也可以當 iss");
});

test("tick（App）：用 JWT 換 installation token（範圍縮到本 repo＋actions:write），再用它 dispatch", async () => {
  resetAppTokenCache();
  const f = appFetch();
  globalThis.fetch = f.fn;
  const [d] = await tick(APP_ENV, NOW);
  assert.equal(d.dispatch, true);

  const tokenReqs = f.calls.filter(isTokenReq);
  assert.equal(tokenReqs.length, 1);
  assert.equal(tokenReqs[0].url, "https://api.github.com/app/installations/987654/access_tokens");
  assert.equal(tokenReqs[0].method, "POST");
  assert.deepEqual(JSON.parse(tokenReqs[0].body), {
    repositories: ["pepelab_onchain_cfd"],
    permissions: { actions: "write" },
  });
  const m = /^Bearer (.+)$/.exec(tokenReqs[0].headers.Authorization);
  const { ok, payload } = await verifyJwt(m[1]);
  assert.equal(ok, true, "送去換 token 的 JWT 必須是用 App 私鑰簽的");
  assert.equal(payload.iss, "123456");

  const others = f.calls.filter((c) => !isTokenReq(c));
  assert.equal(others.length, 2, "list runs＋dispatch");
  for (const c of others) assert.equal(c.headers.Authorization, `Bearer ${INSTALL_TOKEN}_1`);
  assert.ok(f.calls.indexOf(tokenReqs[0]) < f.calls.indexOf(others[0]), "先換 token 才呼叫 Actions API");
});

test("tick（App）：多個 workflow 只換一次 token", async () => {
  resetAppTokenCache();
  const f = appFetch();
  globalThis.fetch = f.fn;
  await tick({ ...APP_ENV, WORKFLOW_FILES: "base-sepolia-keeper.yml,price-keeper.yml" }, NOW);
  assert.equal(f.calls.filter(isTokenReq).length, 1);
  assert.equal(f.calls.filter((c) => c.url.endsWith("/dispatches")).length, 2);
});

test("App token 快取：到期前 5 分鐘之內才重新換", async () => {
  resetAppTokenCache();
  const f = appFetch(); // expires_at = NOW + 60 分鐘
  globalThis.fetch = f.fn;
  const min = 60_000;
  const log = captureLogs();
  const authAt = async (t) => (await resolveAuth(APP_ENV, NOW + t)).token;
  try {
    assert.equal(await authAt(0), `${INSTALL_TOKEN}_1`);
    assert.equal(await authAt(20 * min), `${INSTALL_TOKEN}_1`, "20 分鐘後沿用");
    assert.equal(await authAt(40 * min), `${INSTALL_TOKEN}_1`, "40 分鐘後沿用");
    assert.equal(await authAt(55 * min - 1), `${INSTALL_TOKEN}_1`, "還差 1ms 才進入到期前 5 分鐘");
    assert.equal(f.calls.filter(isTokenReq).length, 1);

    assert.equal(await authAt(55 * min), `${INSTALL_TOKEN}_2`, "剩 5 分鐘 → 重新換");
    assert.equal(f.calls.filter(isTokenReq).length, 2);
    // fixture 的 expires_at 固定是 NOW+60 分，所以過期後再問一次仍要重換。
    assert.equal(await authAt(61 * min), `${INSTALL_TOKEN}_3`, "已過期 → 重新換");
  } finally {
    log.restore();
  }
  assert.ok(!log.lines.join("\n").includes(INSTALL_TOKEN), "log 不可帶 token");
});

test("App token 快取：換了 installation／repo 不沿用；expires_at 壞掉就不快取", async () => {
  resetAppTokenCache();
  const f = appFetch();
  globalThis.fetch = f.fn;
  const cfg = appConfigOf(APP_ENV);
  assert.equal((await getInstallationToken(cfg, APP_ENV.GITHUB_REPO, NOW)).fromCache, false);
  assert.equal((await getInstallationToken(cfg, APP_ENV.GITHUB_REPO, NOW)).fromCache, true);
  assert.equal((await getInstallationToken({ ...cfg, installationId: "111" }, APP_ENV.GITHUB_REPO, NOW)).fromCache, false);
  await assert.rejects(getInstallationToken(cfg, "not-a-repo", NOW), /GITHUB_REPO 格式不對/);

  resetAppTokenCache();
  const g = appFetch({ expiresAt: "nope" });
  globalThis.fetch = g.fn;
  const a = await getInstallationToken(cfg, APP_ENV.GITHUB_REPO, NOW);
  assert.equal(a.expiresAtMs, null);
  assert.equal((await getInstallationToken(cfg, APP_ENV.GITHUB_REPO, NOW)).fromCache, false);
  assert.equal(g.calls.filter(isTokenReq).length, 2);
});

test("同時設定 App 與 PAT → 用 App 並記 log；PAT 不會被送出", async () => {
  resetAppTokenCache();
  const f = appFetch();
  globalThis.fetch = f.fn;
  const log = captureLogs();
  try {
    await tick({ ...APP_ENV, GITHUB_TOKEN: "github_pat_ownerTokenMustNotBeUsed" }, NOW);
  } finally {
    log.restore();
  }
  assert.ok(
    log.lines.some((l) => /GitHub App 與 GITHUB_TOKEN 都有設定，使用 GitHub App/.test(l)),
    log.lines.join("\n"),
  );
  for (const c of f.calls) assert.doesNotMatch(c.headers.Authorization, /github_pat_/);
  const all = log.lines.join("\n");
  assert.ok(!all.includes(INSTALL_TOKEN) && !all.includes("github_pat_") && !/eyJ/.test(all), "log 不可帶任何憑證");
});

test("未設定 App → 沿用 PAT，不呼叫 access_tokens", async () => {
  resetAppTokenCache();
  const f = appFetch();
  globalThis.fetch = f.fn;
  await tick(ENV, NOW);
  assert.equal(f.calls.filter(isTokenReq).length, 0);
  for (const c of f.calls) assert.equal(c.headers.Authorization, "Bearer t");
  assert.deepEqual(await resolveAuth(ENV, NOW), { token: "t", kind: "pat" });
});

test("App 設定不完整 → 丟錯，不退回 PAT、不發任何請求", async () => {
  resetAppTokenCache();
  const f = appFetch();
  globalThis.fetch = f.fn;
  const { GITHUB_APP_PRIVATE_KEY: _drop, ...partial } = APP_ENV;
  await assert.rejects(tick({ ...partial, GITHUB_TOKEN: "t" }, NOW), /設定不完整：缺少 GITHUB_APP_PRIVATE_KEY/);
  assert.equal(f.calls.length, 0);
});

test("換 token 被拒（401／403／404／422／500）→ cron 失敗；不退回 PAT、不 dispatch、訊息不含 JWT 或金鑰", async () => {
  for (const status of [401, 403, 404, 422, 500]) {
    resetAppTokenCache();
    let sentJwt = "";
    const f = appFetch({
      tokenRes: (init) => {
        sentJwt = init.headers.Authorization.replace(/^Bearer /, "");
        // 最壞情況：伺服器把 JWT 與 PEM 原樣放進錯誤訊息。
        return { status, body: JSON.stringify({ message: `Bad credentials ${sentJwt} ${PKCS1_PEM}` }) };
      },
    });
    globalThis.fetch = f.fn;
    const env = { ...APP_ENV, GITHUB_TOKEN: "github_pat_fallbackMustNotHappen" };
    const log = captureLogs();
    try {
      await assert.rejects(worker.scheduled({}, env), (e) => {
        assert.match(e.message, new RegExp(`換 installation token 失敗：HTTP ${status}`));
        assert.ok(sentJwt.length > 100);
        assert.ok(!e.message.includes(sentJwt), "訊息不可含 JWT");
        assert.ok(!e.message.includes(sentJwt.split(".")[2]), "訊息不可含 JWT 簽章");
        assert.doesNotMatch(e.message, /BEGIN|PRIVATE KEY-----|github_pat_|eyJ/, "訊息不可含金鑰或 token");
        return true;
      });
    } finally {
      log.restore();
    }
    assert.equal(f.calls.filter((c) => !isTokenReq(c)).length, 0, `HTTP ${status}：不可再呼叫 Actions API`);
  }
});

test("換 token：回應不是 JSON／沒有 token／fetch 本身失敗 → 丟錯", async () => {
  const cfg = appConfigOf(APP_ENV);
  resetAppTokenCache();
  globalThis.fetch = appFetch({ tokenRes: () => ({ status: 201, body: "<html>" }) }).fn;
  await assert.rejects(getInstallationToken(cfg, APP_ENV.GITHUB_REPO, NOW), /回應不是 JSON/);
  globalThis.fetch = appFetch({
    tokenRes: () => ({ status: 201, body: JSON.stringify({ expires_at: "2026-09-30T11:00:00Z" }) }),
  }).fn;
  await assert.rejects(getInstallationToken(cfg, APP_ENV.GITHUB_REPO, NOW), /回應沒有 token/);
  globalThis.fetch = async (_url, init) => {
    throw new Error(`network down while sending ${init.headers.Authorization}`);
  };
  await assert.rejects(getInstallationToken(cfg, APP_ENV.GITHUB_REPO, NOW), (e) => {
    assert.match(e.message, /換 installation token 失敗：network down/);
    assert.doesNotMatch(e.message, /eyJ/);
    return true;
  });
});

test("快取的 App token 在 Actions API 被 401 → 這次丟錯，下一次重新換", async () => {
  resetAppTokenCache();
  const log = captureLogs();
  try {
    const bad = appFetch({ dispatchStatus: 401 });
    globalThis.fetch = bad.fn;
    await assert.rejects(tick(APP_ENV, NOW), (e) => {
      assert.match(e.message, /dispatch failed: HTTP 401/);
      assert.ok(!e.message.includes(INSTALL_TOKEN));
      return true;
    });
    const good = appFetch();
    globalThis.fetch = good.fn;
    await tick(APP_ENV, NOW + 60_000);
    assert.equal(good.calls.filter(isTokenReq).length, 1, "快取已作廢，重新換 token");
  } finally {
    log.restore();
  }
});

test("redact：遮掉 JWT、GitHub token、PEM 與指定的秘密值", () => {
  const input = [
    "a eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0.c2ln",
    "b ghs_abcdefghijklmnop",
    "c github_pat_11ABCDEFG_zzzzzz",
    `d ${PKCS8_PEM.trim()}`,
    "e my-secret-value",
  ].join(" ");
  const out = redact(input, ["my-secret-value"]);
  assert.doesNotMatch(out, /eyJ|ghs_|github_pat_|BEGIN|my-secret-value/);
  assert.equal(out, "a [redacted jwt] b [redacted token] c [redacted token] d [redacted pem] e [redacted]");
});
