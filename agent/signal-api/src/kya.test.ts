// x402 KYA（Know Your Agent）閘門測試 —— docs/SSI_AGENT_DELEGATION.md。
//   cd agent && npx tsx signal-api/src/kya.test.ts
//
// 完全離線：本機假 facilitator（會真的驗 EIP-3009 的 EIP-712 簽章，結算是假的）、假 Upstash、
// 假 RPC；鏈上 session／錨定與撤銷狀態以注入的 stub 提供。不連網、不送交易、不付款。
//
// 要證明的：
//   • KYA 關閉（預設）：402 與付費流程與加入 KYA 前相同（沒有 X-Agent-KYA header）。
//   • KYA 開啟：v1 與 v2 付款都要求 v3 委託憑證的 presentation；presentation 簽者＝憑證主體＝付款人；
//     撤銷（fail-closed）、鏈上 session 不符、未錨定、端點不在範圍、重放 → 付款前拒絕（facilitator 沒被呼叫）；
//     依 credentialHash 原子累計（每期間＋總額），超過上限 403 且不扣款；結算失敗會退回預留。
import assert from "node:assert";
import { ethers } from "ethers";
import { createWalletClient, http, publicActions } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createPaymentHeader as createV1PaymentHeader } from "x402/client";
import { x402Client } from "@x402/core/client";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { startMockFacilitator } from "./testing/mockFacilitator.ts";
import { startFakeUpstash } from "./testing/fakeUpstash.ts";
import { startRpcStub } from "./testing/rpcStub.ts";

const facilitator = await startMockFacilitator();
const upstash = await startFakeUpstash();
const rpc = await startRpcStub();

process.env.X402_FACILITATOR_URL = facilitator.url;
process.env.X402_NETWORK = "base-sepolia";
process.env.BASE_SEPOLIA_RPC_URL = rpc.url;
process.env.UPSTASH_REDIS_REST_URL = upstash.url;
process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
for (const k of ["X402_PROTOCOL", "PAY_TO", "X402_KYA_MODE", "SIGNAL_API_PUBLIC_URL", "DELEGATION_VC_CHAIN_IDS"]) delete process.env[k];

const { createApp } = await import("./app.ts");
const { createKyaGate, upstashKyaSpendStore, memoryKyaSpendStore, kyaTotalKey, resolveKyaConfig, KYA_RESERVE_SCRIPT, KYA_MAX_TTL_SEC } = await import("./kya.ts");
const shared = await import("@pepelab/shared");
const { issueDelegationCredential, kyaFetch, presentForX402, AGENT_PRESENTATION_HEADER, AGENT_KYA_HEADER, AGENT_KYA_SPEND_HEADER } = shared;

const PAYTO = "0x4444444444444444444444444444444444444444";
const TRADER = "0x5555555555555555555555555555555555555555";
const MGR = ethers.getAddress("0x" + "5e".repeat(20));
const ANCHOR = ethers.getAddress("0x" + "a1".repeat(20));
const NOW = Math.floor(Date.now() / 1000);
const BTC = ethers.id("sBTC");

const user = ethers.Wallet.createRandom();
const agentPk = generatePrivateKey();
const agentEthers = new ethers.Wallet(agentPk);
const account = privateKeyToAccount(agentPk);
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpc.url) }).extend(publicActions);
const strangerPk = generatePrivateKey();
const strangerWallet = createWalletClient({ account: privateKeyToAccount(strangerPk), chain: baseSepolia, transport: http(rpc.url) }).extend(publicActions);

const sessionTerms = {
  maxMarginPerTrade: 100n * 10n ** 18n,
  totalMarginBudget: 500n * 10n ** 18n,
  maxLeverage: 5n,
  expiry: BigInt(NOW + 86400),
  allowedAssets: [BTC],
};
// 「鏈上」：可變的 stub（撤銷、錨定都在這裡切換）。
const chainState = {
  session: { user: user.address, agent: agentEthers.address, ...sessionTerms, revoked: false },
  anchored: new Set<string>(),
  sessionReads: 0,
};
const revokedJti = new Set<string>();

// 每期間 0.02、總額 0.03 USDC：/signals 0.01 一次 → 第三次超過每期間上限。
const { credential, credentialHash } = await issueDelegationCredential({
  issuer: user,
  agentAddress: agentEthers.address,
  sessionManager: MGR,
  sessionId: 3,
  session: sessionTerms,
  x402: { maxPerPeriod: "20000", periodSeconds: 3600, maxTotal: "30000", endpoints: ["GET /signals/*"] },
  chainId: 84532,
  validFrom: NOW - 5,
});
chainState.anchored.add(credentialHash);

const gateBase = {
  config: { mode: "on" as const, anchor: "required" as const, sessionManager: MGR, anchorAddress: ANCHOR, acceptedChainIds: [84532], maxSkewSec: 120 },
  chain: {
    session: async (mgr, id) => {
      chainState.sessionReads++;
      assert.equal(mgr, MGR);
      assert.equal(id, 3);
      return chainState.session;
    },
    chainId: async () => 84532,
    anchorSessionManager: async () => MGR,
    isAnchored: async (a, id, h) => a === ANCHOR && id === 3 && chainState.anchored.has(h),
  },
  spend: upstashKyaSpendStore(),
  statusCheck: async (res) =>
    revokedJti.has(String(res.nonce).toLowerCase())
      ? { ok: false, status: "revoked", reasonCode: "VC_REVOKED", message: "jti 在簽發者的狀態清單中" }
      : { ok: true, status: "active", reasonCode: "STATUS_NO_LIST", message: "沒有撤銷" },
} satisfies Parameters<typeof createKyaGate>[0];
const kya = createKyaGate(gateBase);

const seams = {
  payTo: PAYTO,
  payoutCodeReader: { getCode: async () => "0x" },
  isRegisteredTrader: async () => true,
  signalReader: async (trader: string) => ({ trader, note: "mock signal (kya.test)" }),
};
const appOn = createApp({ ...seams, x402Protocol: "both", kya });
const appOff = createApp({ ...seams, x402Protocol: "both", kya: null });
const URL_SIGNALS = `http://localhost/signals/${TRADER}`;

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);
const b64json = (h: string | null) => (h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null);

/** 未付款 402 → 取 v1 付款要求 → 簽 X-PAYMENT。 */
async function v1Payment(app: ReturnType<typeof createApp>, w = wallet): Promise<string> {
  const r = await app.request(URL_SIGNALS);
  assert.equal(r.status, 402);
  const body = (await r.json()) as { accepts: unknown[] };
  return createV1PaymentHeader(w as never, 1, body.accepts[0] as never);
}
const v2Client = new x402Client().register("eip155:84532", new ExactEvmScheme(account));
async function v2Payment(app: ReturnType<typeof createApp>): Promise<string> {
  const r = await app.request(URL_SIGNALS);
  const required = b64json(r.headers.get("PAYMENT-REQUIRED"));
  return encodePaymentSignatureHeader(await v2Client.createPaymentPayload(required));
}
async function vpFor(pay: string, path = `/signals/${TRADER}`, holder = agentEthers): Promise<string> {
  return (
    await presentForX402({
      credential,
      holderAddress: holder.address,
      signTypedData: (d, t, v) => holder.signTypedData(d, t, v),
      method: "GET",
      path,
      paymentHeader: pay,
    })
  ).header;
}
const settles = () => facilitator.count("/settle");
const spent = () => BigInt(upstash.strings.get(kyaTotalKey(credentialHash)) ?? "0");

// 1) KYA 關閉：與原行為相同
{
  const r = await appOff.request(URL_SIGNALS);
  assert.equal(r.status, 402);
  assert.equal(r.headers.get(AGENT_KYA_HEADER), null);
  const pay = await v1Payment(appOff);
  const paid = await appOff.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay } });
  assert.equal(paid.status, 200, "KYA 關閉：不需要 presentation");
  ok("KYA 關閉（預設）：402 不宣告 KYA、付款不需要 presentation——與既有行為相同");
}

// 2) KYA 開啟：402 宣告；付款但沒帶 presentation → 403，facilitator 沒被呼叫
{
  const r = await appOn.request(URL_SIGNALS);
  assert.equal(r.status, 402);
  assert.match(r.headers.get(AGENT_KYA_HEADER) ?? "", /^required; header=X-Agent-Presentation/);
  const before = facilitator.count("/verify");
  const pay = await v1Payment(appOn);
  const res = await appOn.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay } });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: string }).error, "kya_presentation_required");
  assert.equal(facilitator.count("/verify"), before, "付款沒有送去 facilitator");
  ok("KYA 開啟：402 帶 X-Agent-KYA；付款缺 presentation → 403，付款授權沒有送給 facilitator");
}

// 3) v1：帶 presentation → 200、花費累計、回應帶 X-Agent-KYA-Spend
{
  const s0 = settles();
  const pay = await v1Payment(appOn);
  const res = await appOn.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: await vpFor(pay) } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(settles(), s0 + 1);
  assert.match(res.headers.get(AGENT_KYA_SPEND_HEADER) ?? "", /^total=10000;period=10000;maxTotal=30000;maxPerPeriod=20000;hash=0x/);
  assert.equal(spent(), 10000n);
  ok("v1 付款＋presentation → 200；依 credentialHash 原子累計 0.01 USDC，回應附花費進度");
}

// 4) 重放同一張付款＋presentation → 409（facilitator 未被呼叫）
{
  const pay = await v1Payment(appOn);
  const vp = await vpFor(pay);
  const first = await appOn.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: vp } });
  assert.equal(first.status, 200);
  const v0 = facilitator.count("/verify");
  const again = await appOn.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: vp } });
  assert.equal(again.status, 409);
  assert.equal(((await again.json()) as { error: string }).error, "kya_presentation_replayed");
  assert.equal(facilitator.count("/verify"), v0);
  assert.equal(spent(), 20000n);
  ok("同一筆付款＋presentation 重送 → 409 kya_presentation_replayed，不計費");
}

// 5) 超過每期間上限 → 403 kya_spend_limit_exceeded，不扣款、不累計
{
  const s0 = settles();
  const pay = await v1Payment(appOn);
  const res = await appOn.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: await vpFor(pay) } });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string; limit: string; capAtomic: string; message: string };
  assert.equal(body.error, "kya_spend_limit_exceeded");
  assert.equal(body.limit, "period");
  assert.equal(body.capAtomic, "20000");
  assert.match(body.message, /每期間上限/);
  assert.equal(settles(), s0, "沒有結算");
  assert.equal(spent(), 20000n);
  ok("超過憑證的每期間上限（0.02）→ 403 並說明已花／本筆／上限，不扣款");
}

// 換一張額度較大的新憑證（也示範「重簽＋重新錨定」）。
const big = await issueDelegationCredential({
  issuer: user,
  agentAddress: agentEthers.address,
  sessionManager: MGR,
  sessionId: 3,
  session: sessionTerms,
  x402: { maxPerPeriod: "1000000", periodSeconds: 3600, maxTotal: "1000000", endpoints: ["GET /signals/*"] },
  chainId: 84532,
  validFrom: NOW - 1,
});
const vpBig = async (pay: string, path = `/signals/${TRADER}`) =>
  (await presentForX402({ credential: big.credential, holderAddress: agentEthers.address, signTypedData: (d, t, v) => agentEthers.signTypedData(d, t, v), method: "GET", path, paymentHeader: pay })).header;

// 6) 新憑證未錨定 → 403 kya_not_anchored；錨定後通過；舊憑證被取代（anchor 只有一個 current）
{
  let pay = await v1Payment(appOn);
  let res = await appOn.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: await vpBig(pay) } });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: string }).error, "kya_not_anchored");
  chainState.anchored = new Set([big.credentialHash]); // 使用者錨定新憑證（舊的被取代）
  pay = await v1Payment(appOn);
  res = await appOn.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: await vpBig(pay) } });
  assert.equal(res.status, 200);
  pay = await v1Payment(appOn);
  res = await appOn.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: await vpFor(pay) } });
  assert.equal(res.status, 403, "舊憑證已被取代");
  ok("錨定：未錨定 → 403 kya_not_anchored；錨定後通過；重新錨定新憑證後舊憑證被拒");
}

// 7) v2 付款＋presentation → 200
{
  const pay = await v2Payment(appOn);
  const res = await appOn.request(URL_SIGNALS, { headers: { "PAYMENT-SIGNATURE": pay, [AGENT_PRESENTATION_HEADER]: await vpBig(pay) } });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(b64json(res.headers.get("PAYMENT-RESPONSE"))?.success, true);
  assert.ok(res.headers.get(AGENT_KYA_SPEND_HEADER));
  ok("v2（PAYMENT-SIGNATURE）付款＋presentation → 200，同樣累計花費");
}

// 8) 付款人不是代理人（別人的錢包付款、卻出示代理人的 presentation）→ 403
{
  const pay = await v1Payment(appOn, strangerWallet as never);
  const vpAgentForOtherPay = await (async () => {
    // 代理人不會替別人的付款簽（簽發端就擋）；這裡用一張代理人自己付款的 presentation 搭配別人的付款
    const own = await v1Payment(appOn);
    return vpBig(own);
  })();
  const res = await appOn.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: vpAgentForOtherPay } });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string; reasonCode: string };
  assert.equal(body.error, "kya_presentation_invalid");
  assert.equal(body.reasonCode, "KYA_PRESENTATION_WRONG_PAYMENT");
  ok("presentation 綁的付款不是本請求的付款（付款人≠代理人）→ 403");
}

// 9) 路徑不在憑證允許範圍 → 403（/oracle 不在 endpoints）
{
  const r = await appOn.request("http://localhost/oracle/sBTC");
  // /oracle 新鮮度閘門讀 RPC 失敗 → 交給下游 → 402
  assert.equal(r.status, 402);
  const body = (await r.json()) as { accepts: unknown[] };
  const pay = await createV1PaymentHeader(wallet as never, 1, body.accepts[0] as never);
  const res = await appOn.request("http://localhost/oracle/sBTC", { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: await vpBig(pay, "/oracle/sBTC") } });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { error: string }).error, "kya_endpoint_not_allowed");
  ok("付費端點不在憑證的 x402 endpoints 範圍 → 403 kya_endpoint_not_allowed");
}

// 10) 鏈上 session 撤銷 → 403 kya_session_mismatch；VC 撤銷（狀態清單）→ 403 kya_credential_revoked
{
  chainState.session = { ...chainState.session, revoked: true };
  let pay = await v1Payment(appOn);
  let res = await appOn.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: await vpBig(pay) } });
  assert.equal(res.status, 403);
  let body = (await res.json()) as { error: string; reasonCode: string };
  assert.deepEqual([body.error, body.reasonCode], ["kya_session_mismatch", "SESSION_REVOKED"]);
  chainState.session = { ...chainState.session, revoked: false };

  revokedJti.add(big.credential.credentialSubject.nonce.toLowerCase());
  pay = await v1Payment(appOn);
  res = await appOn.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: await vpBig(pay) } });
  assert.equal(res.status, 403);
  body = (await res.json()) as { error: string; reasonCode: string };
  assert.equal(body.error, "kya_credential_revoked");
  revokedJti.clear();
  ok("鏈上 session 撤銷 → 403 SESSION_REVOKED；VC 在狀態清單被撤銷 → 403 kya_credential_revoked");
}

// 11) 結算失敗 → 退回預留
{
  const before = BigInt(upstash.strings.get(kyaTotalKey(big.credentialHash)) ?? "0");
  facilitator.mode = "settle_rejected";
  const pay = await v1Payment(appOn);
  const res = await appOn.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: await vpBig(pay) } });
  facilitator.mode = "ok";
  assert.notEqual(res.status, 200);
  assert.equal(BigInt(upstash.strings.get(kyaTotalKey(big.credentialHash)) ?? "0"), before, "結算失敗：預留已退回");
  ok("facilitator 拒絕結算（買方未被扣款）→ KYA 預留退回，花費不增加");
}

// 12) kyaFetch 包在官方 v1 client 底下：自動附 presentation
{
  const { wrapFetchWithPayment } = await import("x402-fetch");
  const base = (async (input: any, init?: RequestInit) => appOn.request(typeof input === "string" ? input : input.url, init)) as typeof fetch;
  const payFetch = wrapFetchWithPayment(
    kyaFetch({ credential: big.credential, holderAddress: agentEthers.address, signTypedData: (d, t, v) => agentEthers.signTypedData(d, t, v), allowedOrigins: [URL_SIGNALS] }, base),
    wallet as never,
    20000n,
  ) as unknown as typeof fetch;
  const res = await payFetch(URL_SIGNALS, { method: "GET" });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get(AGENT_KYA_SPEND_HEADER));
  ok("x402-fetch（官方 v1 client）＋ kyaFetch：402 → 自動付款並附 presentation → 200");
}

// 13) 免費查詢花費
{
  const r = await appOn.request(`http://localhost/kya/spend/${big.credentialHash}?period=3600`);
  assert.equal(r.status, 200);
  const j = (await r.json()) as { totalAtomic: string; periodAtomic: string };
  assert.ok(BigInt(j.totalAtomic) >= 20000n);
  assert.equal((await appOff.request(`http://localhost/kya/spend/${big.credentialHash}`)).status, 404);
  ok("GET /kya/spend/:hash 免費查詢憑證的 x402 花費（KYA 關閉時 404）");
}

// 14) facilitator 在結算之前失敗（verify 503／429）：v1、v2 都退回預留，連打不會燒掉額度
{
  const h = big.credentialHash;
  const before = BigInt(upstash.strings.get(kyaTotalKey(h)) ?? "0");
  const s0 = settles();
  for (const mode of ["verify_http503", "verify_http429"] as const) {
    facilitator.mode = mode;
    for (let i = 0; i < 3; i++) {
      const pay = await v1Payment(appOn);
      const res = await appOn.request(URL_SIGNALS, {
        headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: await vpBig(pay), "x-forwarded-for": "10.0.0.14" },
      });
      assert.ok(res.status === 502 || res.status === 429, `v1 ${mode} → ${res.status}`);
    }
    const pay2 = await v2Payment(appOn);
    const r2 = await appOn.request(URL_SIGNALS, {
      headers: { "PAYMENT-SIGNATURE": pay2, [AGENT_PRESENTATION_HEADER]: await vpBig(pay2), "x-forwarded-for": "10.0.0.14" },
    });
    assert.ok(r2.status === 502 || r2.status === 429, `v2 ${mode} → ${r2.status}`);
  }
  facilitator.mode = "ok";
  assert.equal(settles(), s0, "沒有任何一筆送去結算");
  assert.equal(BigInt(upstash.strings.get(kyaTotalKey(h)) ?? "0"), before, "結算前失敗：預留全數退回");
  const pay = await v1Payment(appOn);
  const res = await appOn.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: await vpBig(pay) } });
  assert.equal(res.status, 200, "facilitator 恢復後照常付款");
  ok("facilitator 在結算前失敗（verify 503／429，v1 與 v2）→ 預留退回；連續失敗不會耗盡憑證額度");
}

// 15) X402_KYA_MODE 無法辨識 → fail-closed：付費端點 503（連未付款的 402 都不發）
{
  for (const v of ["true", "1", "yes", "enabled"]) assert.equal(resolveKyaConfig({ X402_KYA_MODE: v }).mode, "invalid", v);
  assert.equal(resolveKyaConfig({}).mode, "off");
  assert.equal(resolveKyaConfig({ X402_KYA_MODE: " OFF " }).mode, "off");
  assert.equal(resolveKyaConfig({ X402_KYA_MODE: "on" }).mode, "on");
  const bad = createKyaGate({ ...gateBase, config: { ...gateBase.config, mode: "invalid" } });
  const app = createApp({ ...seams, x402Protocol: "both", kya: bad });
  const r = await app.request(URL_SIGNALS);
  assert.equal(r.status, 503);
  assert.equal(((await r.json()) as { error: string }).error, "kya_misconfigured");
  assert.equal((await app.request("http://localhost/healthz")).status, 200, "免費端點照常");
  ok("X402_KYA_MODE=true／1／yes／enabled → 視為設定錯誤，付費端點 503 kya_misconfigured（不會悄悄關閉）");
}

// 16) 錨定合約綁的 manager ≠ SESSION_MANAGER_ADDRESS → 503；17) 憑證的鏈 ≠ 讀取端的鏈 → 403
{
  const wrongAnchor = createKyaGate({
    ...gateBase,
    spend: memoryKyaSpendStore(),
    chain: { ...gateBase.chain, anchorSessionManager: async () => ethers.getAddress("0x" + "77".repeat(20)) },
  });
  let app = createApp({ ...seams, x402Protocol: "both", kya: wrongAnchor });
  let pay = await v1Payment(app);
  let res = await app.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: await vpBig(pay), "x-forwarded-for": "10.0.0.16" } });
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as { error: string }).error, "kya_misconfigured");

  const wrongChain = createKyaGate({
    ...gateBase,
    config: { ...gateBase.config, acceptedChainIds: [31337, 84532] },
    spend: memoryKyaSpendStore(),
    chain: { ...gateBase.chain, chainId: async () => 31337 },
  });
  app = createApp({ ...seams, x402Protocol: "both", kya: wrongChain });
  pay = await v1Payment(app);
  res = await app.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: await vpBig(pay), "x-forwarded-for": "10.0.0.17" } });
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string; reasonCode: string };
  assert.deepEqual([body.error, body.reasonCode], ["kya_credential_invalid", "VC_WRONG_CHAIN"]);
  ok("錨定合約綁定的 manager 與設定不符 → 503 kya_misconfigured；憑證的鏈 ≠ 讀取端實際連的鏈 → 403 VC_WRONG_CHAIN");
}

// 18) 撤銷檢查的內部訊息不對外；KYA 驗證失敗每 IP 限流
{
  const leaky = createKyaGate({
    ...gateBase,
    spend: memoryKyaSpendStore(),
    statusCheck: async () => ({ ok: false, status: "unknown", reasonCode: "STATUS_UNAVAILABLE", message: "VC_STATUS_URL 必須是 http(s) URL：/secret/path" }),
  });
  let app = createApp({ ...seams, x402Protocol: "both", kya: leaky });
  const pay = await v1Payment(app);
  const res = await app.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: await vpBig(pay), "x-forwarded-for": "10.0.0.18" } });
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.ok(!text.includes("/secret/path"), "回應不含內部訊息");
  assert.match(text, /STATUS_UNAVAILABLE/);

  app = createApp({ ...seams, x402Protocol: "both", kya });
  const statuses: number[] = [];
  for (let i = 0; i < 22; i++) {
    const p = await v1Payment(app);
    const r = await app.request(URL_SIGNALS, { headers: { "X-PAYMENT": p, "x-forwarded-for": "10.0.0.99" } });
    statuses.push(r.status);
  }
  assert.ok(statuses.slice(0, 20).every((s) => s === 403), statuses.join(","));
  assert.equal(statuses[21], 429, "超過每 IP 失敗上限 → 429，不再做驗證");
  const other = await app.request(URL_SIGNALS, { headers: { "X-PAYMENT": await v1Payment(app), "x-forwarded-for": "10.0.0.100" } });
  assert.equal(other.status, 403, "其他 IP 不受影響");
  ok("撤銷檢查失敗只回原因代碼（內部訊息只寫 log）；同一 IP 的 KYA 驗證失敗超過上限 → 429");
}

// 19) 花費帳：超出範圍的憑證拒收；Lua 參數不合法時不寫入
{
  const longCred = await issueDelegationCredential({
    issuer: user,
    agentAddress: agentEthers.address,
    sessionManager: MGR,
    sessionId: 3,
    session: sessionTerms,
    x402: { maxPerPeriod: "1000", periodSeconds: KYA_MAX_TTL_SEC, maxTotal: "1000", endpoints: ["GET /signals/*"] },
    chainId: 84532,
    validFrom: NOW - 1,
  });
  chainState.anchored.add(longCred.credentialHash);
  const pay = await v1Payment(appOn);
  const vp = (await presentForX402({ credential: longCred.credential, holderAddress: agentEthers.address, signTypedData: (d, t, v) => agentEthers.signTypedData(d, t, v), method: "GET", path: `/signals/${TRADER}`, paymentHeader: pay })).header;
  const res = await appOn.request(URL_SIGNALS, { headers: { "X-PAYMENT": pay, [AGENT_PRESENTATION_HEADER]: vp, "x-forwarded-for": "10.0.0.19" } });
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { reasonCode: string }).reasonCode, "KYA_ALLOWANCE_OUT_OF_RANGE");
  chainState.anchored = new Set([big.credentialHash]);

  const k = "0x" + "ee".repeat(32);
  const r = await fetch(upstash.url, {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify(["EVAL", KYA_RESERVE_SCRIPT, 2, kyaTotalKey(k), `${kyaTotalKey(k)}:p`, "5", "100", "100", KYA_MAX_TTL_SEC + 1, 60]),
  });
  assert.equal(r.ok, false);
  assert.equal(upstash.strings.get(kyaTotalKey(k)), undefined, "參數不合法：什麼都沒寫");
  ok("期間／效期／上限超出花費帳能正確表示的範圍 → 403 拒收；reserve 腳本參數不合法時不寫入任何 key");
}

await facilitator.close();
await upstash.close();
await rpc.close();
console.log(`\n✅ kya.test.ts 全過（${n} 組）`);
