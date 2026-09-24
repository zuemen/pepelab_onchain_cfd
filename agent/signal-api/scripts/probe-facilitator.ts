// 實測 x402 facilitator 與付費端點（x402 硬化 P2 / P3）。三種模式：
//
//   cd agent && npx tsx signal-api/scripts/probe-facilitator.ts            # validity（預設）
//   cd agent && MODE=verify-latency SAMPLES=30 npx tsx signal-api/scripts/probe-facilitator.ts
//   cd agent && MODE=challenge-latency SAMPLES=30 API_URL=https://… npx tsx signal-api/scripts/probe-facilitator.ts
//   cd agent && MODE=concurrency SAMPLES=20 API_URL=http://localhost:4021 npx tsx signal-api/scripts/probe-facilitator.ts
//
// validity：驗證時間窗的判讀（見下）。
// verify-latency：/verify 的往返延遲（循序、每筆間隔 500ms，刻意不是壓測——這是別人的
//   公開服務，找它的 RPS 上限需要對它施壓，不做）。
// challenge-latency：部署中的付費端點「未付款 → 402」的往返延遲。這是付費請求在
//   verify / handler / settle 之前的那一段，**不是**完整的付費請求 P95。
// concurrency：對 /oracle/sBTC（可用 BENCH_PATH 覆寫）以 1、5、10 併發各打 SAMPLES 次，
//   **不帶 X-PAYMENT**——量的是「新鮮度閘門 2 次 RPC + 402 挑戰」這段在併發下的表現，
//   不付款、不動任何 USDC。完整付費請求與結算 worker 的容量見 docs/COST_MODEL.md。
//
// 只打 /verify，不打 /settle：用一把**隨機、零餘額**的錢包簽名，所以任何一個
// case 都不可能真的轉帳。時間檢查若通過，預期的下一個失敗是 insufficient_funds
// ——這正是判讀依據：看到 insufficient_funds = 時間窗被接受。
//
// 為什麼要實測而不是讀 spec：x402 core spec 沒有規定 facilitator 必須檢查
// validBefore 的上界，實作分成三種（見 docs/KNOWN_LIMITATIONS.md §15）。
// validity 模式每個 case 送一次，總共 6 個請求。
import { createWalletClient, http, getAddress, toHex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const FACILITATOR_URL = process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";
const MAX_TIMEOUT_SECONDS = 60; // 與 app.ts 的路由設定一致
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Base Sepolia 官方 USDC
const PAY_TO = "0x000000000000000000000000000000000000dEaD";
const AMOUNT = "10000"; // $0.01

const account = privateKeyToAccount(generatePrivateKey());
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() });

const requirements = {
  scheme: "exact",
  network: "base-sepolia",
  maxAmountRequired: AMOUNT,
  resource: "https://example.invalid/probe",
  description: "validity-window probe",
  mimeType: "application/json",
  payTo: getAddress(PAY_TO),
  maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
  asset: getAddress(USDC),
  extra: { name: "USDC", version: "2" },
};

async function probe(label: string, validAfter: bigint, validBefore: bigint, quiet = false) {
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const authorization = {
    from: account.address,
    to: getAddress(PAY_TO),
    value: AMOUNT,
    validAfter: validAfter.toString(),
    validBefore: validBefore.toString(),
    nonce,
  };
  const signature = await wallet.signTypedData({
    domain: { name: "USDC", version: "2", chainId: baseSepolia.id, verifyingContract: getAddress(USDC) },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      ...authorization,
      value: BigInt(AMOUNT),
      validAfter,
      validBefore,
    },
  });
  const t0 = performance.now();
  const res = await fetch(`${FACILITATOR_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      x402Version: 1,
      paymentPayload: {
        x402Version: 1,
        scheme: "exact",
        network: "base-sepolia",
        payload: { signature, authorization },
      },
      paymentRequirements: requirements,
    }),
  });
  const ms = Math.round(performance.now() - t0);
  const body = await res.text();
  if (!quiet) console.log(`${label}\n  HTTP ${res.status} ${ms}ms  ${body.slice(0, 300)}\n`);
  return { status: res.status, ms };
}

function summarize(name: string, samples: { status: number; ms: number }[]) {
  const ms = samples.map((x) => x.ms).sort((a, b) => a - b);
  const pct = (q: number) => ms[Math.min(ms.length - 1, Math.ceil(q * ms.length) - 1)];
  const byStatus: Record<number, number> = {};
  for (const x of samples) byStatus[x.status] = (byStatus[x.status] ?? 0) + 1;
  console.log(
    `${name}: n=${ms.length} min=${ms[0]}ms p50=${pct(0.5)}ms p95=${pct(0.95)}ms ` +
      `max=${ms[ms.length - 1]}ms status=${JSON.stringify(byStatus)} at=${new Date().toISOString()}`,
  );
}

const MODE = process.env.MODE ?? "validity";
const SAMPLES = Number(process.env.SAMPLES ?? "30");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (MODE === "verify-latency") {
  const out = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const t = BigInt(Math.floor(Date.now() / 1000));
    out.push(await probe("", t - 600n, t + 60n, true));
    await sleep(500);
  }
  summarize(`verify ${FACILITATOR_URL}`, out);
  process.exit(0);
}

if (MODE === "challenge-latency") {
  const api = (process.env.API_URL ?? "").replace(/\/$/, "");
  if (!api) throw new Error("challenge-latency 需要 API_URL");
  for (const path of ["/oracle/sBTC", "/signals/0xE80A81360608C1342e66743F70a00f75d792Eb93"]) {
    const out = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const t0 = performance.now();
      const res = await fetch(api + path, { headers: { Accept: "application/json" } });
      await res.arrayBuffer();
      out.push({ status: res.status, ms: Math.round(performance.now() - t0) });
      await sleep(500);
    }
    summarize(`402 challenge ${api}${path}`, out);
  }
  process.exit(0);
}

if (MODE === "concurrency") {
  const api = (process.env.API_URL ?? "http://localhost:4021").replace(/\/$/, "");
  const path = process.env.BENCH_PATH ?? "/oracle/sBTC";
  for (const level of [1, 5, 10]) {
    const out: { status: number; ms: number }[] = [];
    let issued = 0;
    const t0All = performance.now();
    await Promise.all(
      Array.from({ length: level }, async () => {
        while (issued < SAMPLES) {
          issued += 1;
          const t0 = performance.now();
          try {
            const res = await fetch(api + path, { headers: { Accept: "application/json" } });
            await res.arrayBuffer();
            out.push({ status: res.status, ms: Math.round(performance.now() - t0) });
          } catch {
            out.push({ status: 0, ms: Math.round(performance.now() - t0) });
          }
        }
      }),
    );
    const wallSec = (performance.now() - t0All) / 1000;
    summarize(`concurrency=${level} ${api}${path}`, out);
    console.log(`  throughput=${(out.length / wallSec).toFixed(2)} req/s wall=${wallSec.toFixed(2)}s`);
  }
  process.exit(0);
}

const now = BigInt(Math.floor(Date.now() / 1000));
console.log(`facilitator=${FACILITATOR_URL}  payer=${account.address}  now=${now}\n`);

await probe("A 官方 client 形狀：validAfter=now-600, validBefore=now+60", now - 600n, now + 60n);
await probe("B validAfter=0（PR #2601 之後的形狀）, validBefore=now+60", 0n, now + 60n);
await probe("C validBefore=now+3（低於 6 秒緩衝）", now - 600n, now + 3n);
await probe("D validBefore=now+3600（遠超 maxTimeoutSeconds=60）", now - 600n, now + 3600n);
await probe("E validAfter=now+300（尚未生效）", now + 300n, now + 600n);
await probe("F validBefore=now+30*86400（30 天）", 0n, now + 30n * 86400n);
