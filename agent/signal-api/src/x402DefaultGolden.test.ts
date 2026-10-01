// 預設模式（未設 X402_PROTOCOL，或設成 v1）的 402 回應必須與 master 4b07f3f **逐位元相同**。
//   cd agent && npx tsx signal-api/src/x402DefaultGolden.test.ts
//
// 為什麼要釘：x402 v2 遷移（docs/ADR-009）把 v2 與 v1 放在同一個付費牆後面，由環境變數
// X402_PROTOCOL 切換。正式站在營運方切換之前，行為必須完全不變——402 回應是買方的
// x402 client 逐欄解析的東西，多一個 header、少一個欄位都可能讓既有客戶付不了款。
//
// golden 檔（testing/golden/x402-v1-402.json）是在**改動 app.ts 之前**、從 master 4b07f3f
// 的程式碼擷取的：狀態碼、全部回應 header（排序）、body 原文（HTML 付費牆只記 sha256 與長度）。
// 之後只有在「刻意改變 v1 行為」時才可以用 UPDATE_GOLDEN=1 重新產生，並在 PR 說明原因。
//
// 完全離線：未付款的 402 不會呼叫 facilitator；RPC 指向 127.0.0.1:1（連不上，走既有的降級路徑）。
import assert from "node:assert";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, "testing", "golden", "x402-v1-402.json");

process.env.X402_NETWORK = "base-sepolia";
process.env.X402_FACILITATOR_URL = "http://127.0.0.1:1";
process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:1";
for (const k of ["PAY_TO", "SIGNAL_API_PUBLIC_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) {
  delete process.env[k];
}

const PAYTO_EOA = "0x4444444444444444444444444444444444444444";
const TRADER = "0x5555555555555555555555555555555555555555";

interface Captured {
  name: string;
  status: number;
  headers: [string, string][];
  /** JSON 回應：body 原文。HTML 付費牆：省略，改記 sha256 與長度。 */
  body?: string;
  bodySha256: string;
  bodyBytes: number;
}

const CASES: { name: string; url: string; headers?: Record<string, string> }[] = [
  { name: "signals 未付款（https）", url: `https://signal.example/signals/${TRADER}` },
  { name: "signals 未付款（http localhost）", url: `http://localhost:4021/signals/${TRADER}` },
  { name: "oracle 未付款", url: "https://signal.example/oracle/sBTC" },
  { name: "signals 未付款（帶 query）", url: `https://signal.example/signals/${TRADER}?x=1` },
  {
    name: "signals 瀏覽器（HTML 付費牆）",
    url: `https://signal.example/signals/${TRADER}`,
    headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0 (golden)" },
  },
  {
    name: "signals 帶無法解析的 X-PAYMENT",
    url: `https://signal.example/signals/${TRADER}`,
    headers: { "X-PAYMENT": "not-base64-json" },
  },
  // v2 的 header 在 v1 模式下必須被完全忽略（等同未付款）。
  {
    name: "signals 帶 PAYMENT-SIGNATURE（v1 模式忽略）",
    url: `https://signal.example/signals/${TRADER}`,
    headers: { "PAYMENT-SIGNATURE": "e30=" },
  },
];

async function capture(protocol: string | undefined): Promise<Captured[]> {
  if (protocol === undefined) delete process.env.X402_PROTOCOL;
  else process.env.X402_PROTOCOL = protocol;
  // app.ts 在 import 時讀 env；每種模式用不同的 query 字串強制重新載入模組。
  const { createApp } = (await import(`./app.ts?golden=${protocol ?? "unset"}`)) as typeof import("./app.ts");
  const app = createApp({
    payTo: PAYTO_EOA,
    payoutCodeReader: { getCode: async () => "0x" },
    isRegisteredTrader: async () => true,
  });
  const out: Captured[] = [];
  for (const cse of CASES) {
    const res = await app.request(cse.url, { headers: cse.headers });
    const text = await res.text();
    const headers = [...res.headers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    out.push({
      name: cse.name,
      status: res.status,
      headers,
      ...(isJson ? { body: text } : {}),
      bodySha256: createHash("sha256").update(text).digest("hex"),
      bodyBytes: Buffer.byteLength(text),
    });
  }
  return out;
}

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const { warn, error } = console;
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
};

const unset = await quiet(() => capture(undefined));

if (process.env.UPDATE_GOLDEN === "1") {
  await mkdir(dirname(GOLDEN), { recursive: true });
  await writeFile(GOLDEN, `${JSON.stringify(unset, null, 2)}\n`);
  console.log(`✓ 已寫入 golden：${GOLDEN}（${unset.length} 組）`);
  process.exit(0);
}

const golden = JSON.parse(await readFile(GOLDEN, "utf8")) as Captured[];
assert.equal(golden.length, CASES.length, "golden 的組數必須與 CASES 相同");

function compare(label: string, got: Captured[]): void {
  for (let i = 0; i < CASES.length; i++) {
    const g = golden[i]!;
    const r = got[i]!;
    assert.equal(r.name, g.name);
    assert.equal(r.status, g.status, `${label}｜${g.name}：狀態碼`);
    assert.deepStrictEqual(r.headers, g.headers, `${label}｜${g.name}：回應 header 必須完全相同（不可多、不可少）`);
    if (g.body !== undefined) assert.strictEqual(r.body, g.body, `${label}｜${g.name}：body 必須逐字相同`);
    assert.equal(r.bodyBytes, g.bodyBytes, `${label}｜${g.name}：body 長度`);
    assert.equal(r.bodySha256, g.bodySha256, `${label}｜${g.name}：body sha256`);
  }
}

compare("未設 X402_PROTOCOL", unset);
console.log(`✓ 未設 X402_PROTOCOL：${CASES.length} 組 402 回應與 master golden 逐位元相同`);

// golden 本身的健全性：確實是 v1 的 402（不是誤把別的回應釘成 golden）。
{
  const first = golden[0]!;
  assert.equal(first.status, 402);
  const j = JSON.parse(first.body!) as { x402Version: number; accepts: Record<string, unknown>[] };
  assert.equal(j.x402Version, 1);
  assert.equal(j.accepts[0]!.maxTimeoutSeconds, 60);
  assert.equal(j.accepts[0]!.payTo, PAYTO_EOA);
  assert.equal(j.accepts[0]!.resource, `https://signal.example/signals/${TRADER}`, "resource 必須保留 https");
  assert.ok(!first.headers.some(([k]) => k.toLowerCase() === "payment-required"), "v1 模式不可出現 PAYMENT-REQUIRED header");
  console.log("✓ golden 內容是 v1 的 402（x402Version=1、maxTimeoutSeconds=60、resource 為 https、無 PAYMENT-REQUIRED）");
}

compare("X402_PROTOCOL=v1", await quiet(() => capture("v1")));
console.log("✓ X402_PROTOCOL=v1：與 golden 逐位元相同");

// 設錯值不可以悄悄變成別的模式：一律退回 v1（並在 stderr 警告）。
compare("X402_PROTOCOL=garbage", await quiet(() => capture("V3-typo")));
console.log("✓ X402_PROTOCOL 設成無法辨識的值：退回 v1，與 golden 逐位元相同");

console.log("\n✅ x402DefaultGolden.test.ts 全過");
