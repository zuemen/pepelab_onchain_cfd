// P0 收款地址守門（fail-closed）的離線測試。
//   cd agent && npx tsx signal-api/src/payoutSafety.test.ts
//
// 全部用假 getCode 來源，不打任何 RPC、不送交易。涵蓋：
//   - shared/assessPayoutAddress：外洩清單、EIP-7702 委派碼、正常 EOA、RPC 失敗且無快取、
//     RPC 失敗但有快取、requireEoa 對合約 code 的判定
//   - signal-api：payTo unsafe 時付費路由回 503 payto_unsafe，且**不發 402**；GET / 顯示狀態
//   - settlement-worker：payoutPreflight 對 payTo / signer / platformTreasury 的判定
import assert from "node:assert";

process.env.BASE_SEPOLIA_RPC_URL ??= "http://127.0.0.1:1";

const {
  assessPayoutAddress,
  clearPayoutSafetyCache,
  COMPROMISED_ADDRESSES,
  EIP7702_DELEGATION_PREFIX,
} = await import("@pepelab/shared");

const LEAKED = "0xE80A81360608C1342e66743F70a00f75d792Eb93";
const EOA = "0x1111111111111111111111111111111111111111";
const DELEGATED = "0x2222222222222222222222222222222222222222";
const CONTRACT = "0x3333333333333333333333333333333333333333";
const DELEGATION_CODE = `${EIP7702_DELEGATION_PREFIX}${"ab".repeat(20)}`;

/** 假 getCode：依地址回 code；`down=true` 時模擬 RPC 失敗。記錄呼叫次數。 */
function fakeReader(codes: Record<string, string>) {
  const r = {
    down: false,
    calls: 0,
    async getCode(addr: string): Promise<string> {
      r.calls += 1;
      if (r.down) throw new Error("ECONNREFUSED (fake)");
      return codes[addr.toLowerCase()] ?? "0x";
    },
  };
  return r;
}
const codes = {
  [DELEGATED.toLowerCase()]: DELEGATION_CODE,
  [CONTRACT.toLowerCase()]: "0x6080604052",
  [LEAKED.toLowerCase()]: DELEGATION_CODE,
};

// ── 1) 外洩清單命中：不需 RPC，一律 unsafe ─────────────────────────────────
{
  clearPayoutSafetyCache();
  assert.ok(COMPROMISED_ADDRESSES.includes(LEAKED.toLowerCase()), "外洩 deployer 必須在清單內");
  const r = fakeReader(codes);
  r.down = true; // 就算 RPC 掛了，清單命中也不該需要 RPC
  const a = await assessPayoutAddress(r, LEAKED);
  assert.equal(a.safe, false);
  assert.equal(a.source, "denylist");
  assert.match(a.reason, /^compromised/);
  assert.equal(r.calls, 0, "清單命中不應打 RPC");
  // 大小寫不敏感
  assert.equal((await assessPayoutAddress(r, LEAKED.toLowerCase())).safe, false);
  console.log("外洩清單命中 → unsafe（不打 RPC、大小寫不敏感） ✓");
}

// ── 2) EIP-7702 委派碼 → unsafe ─────────────────────────────────────────────
{
  clearPayoutSafetyCache();
  const a = await assessPayoutAddress(fakeReader(codes), DELEGATED);
  assert.equal(a.safe, false);
  assert.match(a.reason, /^eip7702_delegated/);
  console.log("EIP-7702 委派碼（0xef0100…）→ unsafe ✓");
}

// ── 3) 正常 EOA → safe，且結果被快取 ────────────────────────────────────────
{
  clearPayoutSafetyCache();
  const r = fakeReader(codes);
  const a = await assessPayoutAddress(r, EOA, { requireEoa: true, now: 1_000 });
  assert.equal(a.safe, true);
  assert.equal(a.source, "rpc");
  const b = await assessPayoutAddress(r, EOA, { requireEoa: true, now: 1_000 + 60_000 });
  assert.equal(b.safe, true);
  assert.equal(b.source, "cache");
  assert.equal(r.calls, 1, "TTL 內不應重打 RPC");
  const c = await assessPayoutAddress(r, EOA, { requireEoa: true, now: 1_000 + 11 * 60_000 });
  assert.equal(c.source, "rpc", "超過 10 分鐘 TTL 要重查");
  assert.equal(r.calls, 2);
  console.log("正常 EOA → safe；10 分鐘快取 ✓");
}

// ── 4) RPC 失敗且從未成功查過 → unsafe（fail-closed）──────────────────────
{
  clearPayoutSafetyCache();
  const r = fakeReader(codes);
  r.down = true;
  const a = await assessPayoutAddress(r, EOA, { requireEoa: true });
  assert.equal(a.safe, false);
  assert.equal(a.source, "no-data");
  assert.match(a.reason, /^rpc_unavailable/);
  console.log("RPC 失敗且無快取 → unsafe（fail-closed） ✓");
}

// ── 5) RPC 失敗但有上次結果 → 沿用（即使已過期）─────────────────────────────
{
  clearPayoutSafetyCache();
  const r = fakeReader(codes);
  await assessPayoutAddress(r, EOA, { now: 0 });
  await assessPayoutAddress(r, DELEGATED, { now: 0 });
  r.down = true;
  const ok = await assessPayoutAddress(r, EOA, { now: 60 * 60_000 });
  assert.equal(ok.safe, true);
  assert.equal(ok.source, "stale-cache");
  const bad = await assessPayoutAddress(r, DELEGATED, { now: 60 * 60_000 });
  assert.equal(bad.safe, false, "上次已知是 unsafe，RPC 失敗時仍是 unsafe");
  // 審查 Low-7：stale 結果最多沿用 1 小時，超過就 fail-closed
  const tooOld = await assessPayoutAddress(r, EOA, { now: 61 * 60_000 });
  assert.equal(tooOld.safe, false, "stale 超過 1 小時 → unsafe");
  assert.match(tooOld.reason, /^rpc_unavailable/);
  console.log("RPC 失敗但有上次結果 → 1 小時內沿用，超過改判 unsafe ✓");
}

// ── 5b) RPC 錯誤訊息（可能含帶 key 的 URL）不可出現在 reason ────────────────
{
  clearPayoutSafetyCache();
  const leaky = {
    getCode: async () => {
      throw new Error('could not coalesce error (info={ "requestUrl": "https://rpc.example/v2/SECRETKEY1234567890abcd" })');
    },
  };
  const a = await assessPayoutAddress(leaky, EOA);
  assert.equal(a.safe, false);
  assert.ok(!a.reason.includes("SECRETKEY"), `reason 不可帶 RPC 錯誤原文：${a.reason}`);
  assert.ok(!a.reason.includes("rpc.example"));
  console.log("RPC 錯誤原文不進 reason（只給 rpc_unavailable 代碼） ✓");
}

// ── 5c) PAYOUT_DENYLIST 格式錯誤 → 啟動時警告，不默默忽略 ─────────────────────
{
  const { checkPayoutDenylistEnv, parsePayoutDenylist, isCompromisedAddress } = await import("@pepelab/shared");
  process.env.PAYOUT_DENYLIST = `0x${"77".repeat(20)}, not-an-address ,0x123`;
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
  const invalid = checkPayoutDenylistEnv();
  console.warn = orig;
  assert.deepEqual(invalid, ["not-an-address", "0x123"]);
  assert.ok(warned.some((w) => w.includes("PAYOUT_DENYLIST") && w.includes("not-an-address")), "要發出警告");
  assert.deepEqual(parsePayoutDenylist().addresses, ["0x" + "77".repeat(20)]);
  assert.equal(isCompromisedAddress("0x" + "77".repeat(20)), true, "合法項目照樣生效");
  delete process.env.PAYOUT_DENYLIST;
  console.log("PAYOUT_DENYLIST 格式錯誤 → 警告並列出無效項目 ✓");
}

// ── 5d) redactSecrets：遮掉帶憑證的 env 值與 requestUrl ─────────────────────
{
  const { redactSecrets } = await import("@pepelab/shared");
  const prev = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_TOKEN = "tok_ABCDEFGH12345678";
  const s = redactSecrets(
    'x tok_ABCDEFGH12345678 y {"requestUrl":"https://base-sepolia.g.alchemy.com/v2/abcdefghijklmnop1234"}',
  );
  assert.ok(!s.includes("tok_ABCDEFGH12345678"));
  assert.ok(!s.includes("abcdefghijklmnop1234"));
  if (prev === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = prev;
  console.log("redactSecrets 遮掉 token 與 requestUrl ✓");
}

// ── 6) requireEoa：合約 code（Safe / FeeRouter）→ unsafe；不要求時 safe ─────
{
  clearPayoutSafetyCache();
  const r = fakeReader(codes);
  assert.equal((await assessPayoutAddress(r, CONTRACT)).safe, true, "treasury 可以是合約（如 Safe）");
  const a = await assessPayoutAddress(r, CONTRACT, { requireEoa: true });
  assert.equal(a.safe, false);
  assert.match(a.reason, /^not_eoa/);
  assert.equal((await assessPayoutAddress(r, "")).safe, false, "空字串 → invalid");
  assert.equal((await assessPayoutAddress(r, "0x" + "0".repeat(40))).safe, false, "零地址 → invalid");
  console.log("requireEoa：合約 code → not_eoa；空值/零地址 → invalid ✓");
}

// ── 7) signal-api：payTo unsafe → 付費路由 503，且不發 402 ─────────────────
{
  const { createApp } = await import("./app.ts");

  for (const [label, payTo] of [
    ["外洩清單", LEAKED],
    ["EIP-7702 委派", DELEGATED],
    ["合約（非 EOA）", CONTRACT],
  ] as const) {
    clearPayoutSafetyCache();
    const app = createApp({ payTo, payoutCodeReader: fakeReader(codes) });
    for (const path of ["/oracle/sBTC", `/signals/${EOA}`]) {
      const res = await app.request(path);
      assert.equal(res.status, 503, `${label} ${path} 應回 503，got ${res.status}`);
      const j = (await res.json()) as { error: string; reason: string; accepts?: unknown };
      assert.equal(j.error, "payto_unsafe");
      assert.ok(j.reason.length > 0);
      assert.equal(j.accepts, undefined, "不可帶任何付款要求");
    }
    const root = (await (await app.request("/")).json()) as {
      payTo: string;
      payToSafety: { safe: boolean; reason: string };
    };
    assert.equal(root.payTo, payTo);
    assert.equal(root.payToSafety.safe, false);
    console.log(`payTo=${label} → /oracle、/signals 皆 503 payto_unsafe、無 402；GET / 顯示 unsafe ✓`);
  }

  // 審查 High-1：大小寫、`//`、%2F、結尾斜線等變體都不能繞過守門
  {
    clearPayoutSafetyCache();
    const variants = [
      `/SIGNALS/${EOA}`,
      `/Signals/${EOA}`,
      `//signals/${EOA}`,
      `/signals//${EOA}`,
      `/signals/${EOA}/`,
      `/signals%2F${EOA}`,
      "/ORACLE/sBTC",
      "//oracle/sBTC",
      "/oracle//sBTC",
      "/OrAcLe/sBTC/",
      "/oracle%2FsBTC",
    ];
    const app = createApp({
      payTo: LEAKED,
      payoutCodeReader: fakeReader(codes),
      isRegisteredTrader: async () => true,
    });
    for (const v of variants) {
      const res = await app.request(v);
      assert.equal(res.status, 503, `${v} 應 503，got ${res.status}`);
      assert.equal(((await res.json()) as { error: string }).error, "payto_unsafe", v);
    }
    // 對照組：safe payTo 時，變體被正規化成同一條付費路由（402），閘門照樣生效
    clearPayoutSafetyCache();
    const safe = createApp({
      payTo: EOA,
      payoutCodeReader: fakeReader(codes),
      isRegisteredTrader: async (t) => t.toLowerCase() === EOA.toLowerCase(),
    });
    assert.equal((await safe.request(`/SIGNALS/${EOA}`)).status, 402);
    assert.equal((await safe.request("//ORACLE/sBTC")).status, 402);
    assert.equal((await safe.request(`/SIGNALS/${DELEGATED}`)).status, 400, "registry 閘門對變體同樣生效");
    assert.equal((await safe.request("/ORACLE/sDOGE")).status, 400, "輸入驗證對變體同樣生效");
    console.log(`路徑變體 ${variants.length} 種（大小寫 / // / %2F / 結尾 /）→ 一律 503，不發 402 ✓`);
  }

  // 審查 Medium-3：payTo 檢查的 RPC 錯誤原文不回給 client
  {
    clearPayoutSafetyCache();
    const app = createApp({
      payTo: EOA,
      payoutCodeReader: {
        getCode: async () => {
          throw new Error("fail https://rpc.example/v2/SECRETKEY1234567890abcd");
        },
      },
    });
    const res = await app.request("/oracle/sBTC");
    const text = await res.text();
    assert.equal(res.status, 503);
    assert.ok(!text.includes("SECRETKEY") && !text.includes("rpc.example"), text);
    console.log("RPC 錯誤原文不外流到 503 回應 ✓");
  }

  // RPC 掛了且沒有快取 → 也是 503（fail-closed）
  {
    clearPayoutSafetyCache();
    const r = fakeReader(codes);
    r.down = true;
    const app = createApp({ payTo: EOA, payoutCodeReader: r });
    const res = await app.request("/oracle/sBTC");
    assert.equal(res.status, 503);
    console.log("payTo 檢查 RPC 失敗且無快取 → 503（fail-closed） ✓");
  }

  // 對照組：safe 的 EOA → 會走到 x402 付費牆（402）
  {
    clearPayoutSafetyCache();
    const app = createApp({ payTo: EOA, payoutCodeReader: fakeReader(codes) });
    const res = await app.request("/oracle/sBTC");
    assert.equal(res.status, 402, `safe payTo 應發出 402，got ${res.status}`);
    const root = (await (await app.request("/")).json()) as { payToSafety: { safe: boolean } };
    assert.equal(root.payToSafety.safe, true);
    console.log("對照組：safe EOA → 402 付款要求照常發出 ✓");
  }
}

// ── 8) settlement-worker 的 payoutPreflight ────────────────────────────────
{
  delete process.env.FEE_SETTLEMENT_PRIVATE_KEY;
  const { payoutPreflight } = await import("./settlement-worker.ts");
  const base = {
    codeReader: fakeReader(codes),
    payTo: EOA,
    signerAddress: EOA,
    routerAddress: CONTRACT,
    readPlatformTreasury: async () => CONTRACT,
    fetchPublishedPayTo: async () => EOA,
  };
  clearPayoutSafetyCache();
  assert.deepEqual((await payoutPreflight(base)).problems, [], "全部安全 → 無 problem");

  // 審查 Medium-6：PAY_TO ≠ signer → problem（以前只是 warning）
  clearPayoutSafetyCache();
  const q1 = await payoutPreflight({ ...base, payTo: "0x" + "88".repeat(20), fetchPublishedPayTo: async () => EOA });
  assert.ok(q1.problems.some((p) => p.includes("≠ 結算 signer")), JSON.stringify(q1.problems));
  // 線上 signal-api 公布的 payTo ≠ signer → problem
  clearPayoutSafetyCache();
  const q2 = await payoutPreflight({ ...base, fetchPublishedPayTo: async () => "0x" + "88".repeat(20) });
  assert.ok(q2.problems.some((p) => p.includes("線上 signal-api 公布的 payTo")));
  // 讀不到線上 payTo → fail-closed
  clearPayoutSafetyCache();
  const q3 = await payoutPreflight({
    ...base,
    fetchPublishedPayTo: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.ok(q3.problems.some((p) => p.includes("讀不到線上 signal-api")));
  // 沒設 SIGNAL_API_URL → 跳過並警告
  clearPayoutSafetyCache();
  const q4 = await payoutPreflight({ ...base, fetchPublishedPayTo: undefined });
  assert.deepEqual(q4.problems, []);
  assert.ok(q4.warnings.some((w) => w.includes("SIGNAL_API_URL 未設")));
  console.log("worker preflight：PAY_TO≠signer、線上 payTo≠signer、讀不到 → problem；未設 URL → 警告 ✓");

  clearPayoutSafetyCache();
  const p1 = await payoutPreflight({ ...base, readPlatformTreasury: async () => LEAKED });
  assert.equal(p1.problems.length, 1);
  assert.match(p1.problems[0]!, /platformTreasury unsafe/);

  clearPayoutSafetyCache();
  const p2 = await payoutPreflight({ ...base, payTo: LEAKED, signerAddress: LEAKED });
  assert.ok(p2.problems.some((p) => p.startsWith("PAY_TO unsafe")));

  clearPayoutSafetyCache();
  const p3 = await payoutPreflight({ ...base, signerAddress: DELEGATED });
  assert.ok(p3.problems.some((p) => p.startsWith("結算 signer unsafe")));

  clearPayoutSafetyCache();
  const p4 = await payoutPreflight({ ...base, payTo: undefined });
  assert.ok(p4.problems.some((p) => p.includes("PAY_TO 未設")));

  clearPayoutSafetyCache();
  const p5 = await payoutPreflight({
    ...base,
    readPlatformTreasury: async () => {
      throw new Error("rpc down");
    },
  });
  assert.ok(p5.problems.some((p) => p.includes("fail-closed")), "讀不到 treasury → fail-closed");
  console.log("worker preflight：payTo / signer / platformTreasury 任一 unsafe 或讀不到 → problem ✓");
}

console.log("payoutSafety.test.ts ✓ all assertions passed");
