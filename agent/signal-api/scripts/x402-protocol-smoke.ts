// X402_PROTOCOL 三種模式的本機冒煙測試：真的啟動 `src/index.ts`（SIGNAL_API_PORT），
// 以真 HTTP 打免費端點與付費端點（**未付款**），印出並檢查 402 的格式。
//
//   cd agent && npx tsx signal-api/scripts/x402-protocol-smoke.ts
//
// 完全離線：facilitator 是本機假的（testing/mockFacilitator.ts），RPC 是本機假節點
// （testing/rpcStub.ts，eth_getCode 一律回 "0x"，讓收款地址守門把 PAY_TO 當成 EOA；
// /oracle 的新鮮度閘門讀到的是剛寫入的價格，否則它會 fail-closed 回 503）。
// **不帶任何付款 header、不簽任何東西、不連外網**。子行程以 PID 結束，不以映像名稱殺行程。
//
// 檢查的事：
//   1. 未設 X402_PROTOCOL 與 X402_PROTOCOL=v1 的 402 逐位元相同（狀態、header、body）。
//   2. v2：402 的 body 是 {}、付款要求在 PAYMENT-REQUIRED（x402Version 2、CAIP-2、maxTimeoutSeconds 60）。
//   3. both：body 與 v1 逐字相同，另外多 PAYMENT-REQUIRED。
//   4. 免費端點（/healthz、/）在三種模式都正常；GET / 只有 v2／both 才多出 x402 欄位。
//
// 用的是 /oracle/sBTC 而不是 /signals/:trader：後者在 402 之前要讀鏈上 registry，假 RPC 讀不到會回
// 503 registry_unavailable（那是對的行為，但看不到 402）。見 docs/ADR-010-x402-v2-migration.md。
import assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { startMockFacilitator } from "../src/testing/mockFacilitator.ts";
import { startRpcStub } from "../src/testing/rpcStub.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGNAL_API_DIR = resolve(HERE, "..");
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");
const PAY_TO = "0x4444444444444444444444444444444444444444";
/** 等伺服器起來的上限。冷啟動要 tsx 轉譯整棵 x402 v1 依賴樹，機器忙的時候可以超過一分鐘。 */
const STARTUP_TIMEOUT_MS = Number(process.env.SMOKE_STARTUP_TIMEOUT_MS ?? "300000");

const facilitator = await startMockFacilitator();
const rpc = await startRpcStub({ everyAddressIsEoa: true, freshOraclePrices: true });

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });
}

interface Snapshot {
  status: number;
  headers: [string, string][];
  body: string;
}
async function snap(url: string): Promise<Snapshot> {
  const r = await fetch(url);
  const body = await r.text();
  // date／connection／keep-alive／transfer-encoding 是 node HTTP 伺服器加的，與應用無關。
  const skip = new Set(["date", "connection", "keep-alive", "transfer-encoding"]);
  const headers = [...r.headers.entries()].filter(([k]) => !skip.has(k)).sort(([a], [b]) => (a < b ? -1 : 1));
  return { status: r.status, headers, body };
}
const unb64 = (h: string | undefined) => JSON.parse(Buffer.from(h ?? "", "base64").toString("utf8"));
const header = (s: Snapshot, name: string) => s.headers.find(([k]) => k === name)?.[1];

interface ModeResult {
  healthz: Snapshot;
  discovery: Snapshot;
  oracle402: Snapshot;
  port: number;
}

async function runMode(protocol: string | undefined): Promise<ModeResult> {
  const port = await freePort();
  // 乾淨的 env：只給這支測試需要的變數（不繼承呼叫端 shell 裡可能存在的金鑰或 PAY_TO）。
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    SIGNAL_API_PORT: String(port),
    PAY_TO,
    X402_NETWORK: "base-sepolia",
    X402_FACILITATOR_URL: facilitator.url,
    BASE_SEPOLIA_RPC_URL: rpc.url,
    ...(protocol === undefined ? {} : { X402_PROTOCOL: protocol }),
  };
  const child: ChildProcess = spawn(process.execPath, [TSX_CLI, "src/index.ts"], { cwd: SIGNAL_API_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout?.on("data", (d) => (log += d));
  child.stderr?.on("data", (d) => (log += d));
  try {
    const base = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`伺服器提前結束（exit ${child.exitCode}）：\n${log}`);
      try {
        if ((await fetch(`${base}/healthz`)).status === 200) break;
      } catch {
        /* 還沒起來 */
      }
      if (Date.now() > deadline) throw new Error(`伺服器 ${STARTUP_TIMEOUT_MS / 1000} 秒內沒有起來：\n${log}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    return {
      port,
      healthz: await snap(`${base}/healthz`),
      discovery: await snap(`${base}/`),
      oracle402: await snap(`${base}/oracle/sBTC`),
    };
  } finally {
    child.kill(); // 以 PID 結束這一個子行程
    await new Promise<void>((r) => (child.exitCode !== null ? r() : child.once("exit", () => r())));
  }
}

/** 把 port 換成固定字樣，才能跨模式逐位元比較（每個模式用不同的隨機 port）。 */
const normalize = (s: Snapshot, port: number): Snapshot => ({
  ...s,
  body: s.body.replaceAll(`127.0.0.1:${port}`, "127.0.0.1:PORT"),
  headers: s.headers.map(([k, v]) => [k, k === "content-length" ? "*" : v]),
});

function show(label: string, r: ModeResult): void {
  console.log(`\n━━ X402_PROTOCOL=${label} ━━`);
  console.log(`GET /healthz        → ${r.healthz.status} ${JSON.stringify(r.healthz.body)}`);
  const disc = JSON.parse(r.discovery.body) as { payTo: string; payToSafety: { safe: boolean }; x402?: { protocol: string; versions: number[]; network: string } };
  console.log(`GET /               → ${r.discovery.status}  payTo=${disc.payTo}  payToSafety.safe=${disc.payToSafety.safe}  x402=${disc.x402 ? JSON.stringify({ protocol: disc.x402.protocol, versions: disc.x402.versions, network: disc.x402.network }) : "(無此欄位)"}`);
  console.log(`GET /oracle/sBTC    → ${r.oracle402.status}`);
  console.log(`  headers: ${r.oracle402.headers.map(([k, v]) => `${k}: ${v.length > 48 ? `${v.slice(0, 48)}…(${v.length})` : v}`).join(" | ")}`);
  console.log(`  body   : ${r.oracle402.body.length > 260 ? `${r.oracle402.body.slice(0, 260)}…(${r.oracle402.body.length})` : r.oracle402.body}`);
  const pr = header(r.oracle402, "payment-required");
  if (pr) {
    const d = unb64(pr);
    console.log(`  PAYMENT-REQUIRED（解碼）: x402Version=${d.x402Version} error=${JSON.stringify(d.error)} resource.url=${d.resource.url}`);
    console.log(`    accepts[0]=${JSON.stringify(d.accepts[0])}`);
    console.log(`    extensions=${JSON.stringify(Object.keys(d.extensions ?? {}))}`);
  }
}

try {
  const unset = await runMode(undefined);
  const v1 = await runMode("v1");
  const v2 = await runMode("v2");
  const both = await runMode("both");
  show("（未設）", unset);
  show("v1", v1);
  show("v2", v2);
  show("both", both);

  for (const r of [unset, v1, v2, both]) {
    assert.equal(r.healthz.status, 200);
    assert.equal(r.healthz.body, "ok");
    assert.equal(r.discovery.status, 200);
    assert.equal(r.oracle402.status, 402);
    assert.equal(JSON.parse(r.discovery.body).payToSafety.safe, true);
  }
  // 1) 未設 = v1，逐位元相同；沒有任何 v2 的東西。
  assert.deepStrictEqual(normalize(unset.oracle402, unset.port), normalize(v1.oracle402, v1.port), "未設與 v1 的 402 必須逐位元相同");
  // GET / 帶收款地址守門的檢查時間（payToSafety.checkedAt／source），每次啟動都不同 → 去掉再比。
  const stable = (r: ModeResult) => {
    const j = JSON.parse(normalize(r.discovery, r.port).body) as { payToSafety: Record<string, unknown> };
    delete j.payToSafety.checkedAt;
    delete j.payToSafety.source;
    return JSON.stringify(j);
  };
  assert.equal(stable(unset), stable(v1), "未設與 v1 的 GET / 必須相同（checkedAt／source 除外）");
  assert.equal(header(v1.oracle402, "payment-required"), undefined);
  assert.equal("x402" in JSON.parse(v1.discovery.body), false);
  const v1Body = JSON.parse(v1.oracle402.body) as { x402Version: number; accepts: Record<string, unknown>[] };
  assert.equal(v1Body.x402Version, 1);
  assert.equal(v1Body.accepts[0]!.network, "base-sepolia");
  assert.equal(v1Body.accepts[0]!.maxAmountRequired, "5000");
  assert.equal(v1Body.accepts[0]!.maxTimeoutSeconds, 60);
  assert.equal(v1Body.accepts[0]!.payTo, PAY_TO);

  // 2) v2
  assert.equal(v2.oracle402.body, "{}");
  assert.equal(header(v2.oracle402, "cache-control"), "no-store");
  const pr2 = unb64(header(v2.oracle402, "payment-required"));
  assert.equal(pr2.x402Version, 2);
  assert.deepEqual(
    { scheme: pr2.accepts[0].scheme, network: pr2.accepts[0].network, amount: pr2.accepts[0].amount, payTo: pr2.accepts[0].payTo, maxTimeoutSeconds: pr2.accepts[0].maxTimeoutSeconds, asset: pr2.accepts[0].asset },
    { scheme: "exact", network: "eip155:84532", amount: "5000", payTo: PAY_TO, maxTimeoutSeconds: 60, asset: v1Body.accepts[0]!.asset },
  );
  assert.equal(pr2.resource.url, `http://127.0.0.1:${v2.port}/oracle/sBTC`);
  assert.deepEqual(JSON.parse(v2.discovery.body).x402.versions, [2]);

  // 3) both：body 與 v1 逐字相同，只多 v2 的 header。
  assert.equal(normalize(both.oracle402, both.port).body, normalize(v1.oracle402, v1.port).body, "both 的 402 body 必須與 v1 逐字相同");
  const prBoth = unb64(header(both.oracle402, "payment-required"));
  assert.equal(prBoth.x402Version, 2);
  assert.equal(prBoth.accepts[0].network, "eip155:84532");
  const v1Keys = v1.oracle402.headers.map(([k]) => k);
  assert.deepEqual(both.oracle402.headers.map(([k]) => k).filter((k) => !v1Keys.includes(k)).sort(), ["cache-control", "payment-required"]);
  assert.deepEqual(JSON.parse(both.discovery.body).x402.versions, [2, 1]);

  // 未付款的 402 不需要驗證或結算；v1 模式連 /supported 都不打。
  assert.equal(facilitator.count("/verify") + facilitator.count("/settle"), 0);
  console.log(`\nfacilitator 呼叫：/supported ×${facilitator.count("/supported")}（v2 與 both 各一次）、/verify ×0、/settle ×0`);
  assert.equal(facilitator.count("/supported"), 2);
  console.log("\n✅ x402-protocol-smoke：未設＝v1（逐位元相同）；v2 的 402 在 PAYMENT-REQUIRED；both＝v1 的 body＋PAYMENT-REQUIRED；免費端點三種模式皆正常");
} finally {
  await facilitator.close();
  await rpc.close();
}
