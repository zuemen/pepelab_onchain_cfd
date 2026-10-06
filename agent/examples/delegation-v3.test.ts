// 委託授權 VC v3（AgentDelegationCredential）＋ x402 KYA presentation 測試。
// 完全離線：不連鏈、不送交易。docs/SSI_AGENT_DELEGATION.md。
//   npx tsx examples/delegation-v3.test.ts
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pepe-vc-v3-"));
const MGR = ethers.getAddress("0x" + "5e".repeat(20));
const AGENT_PK = ethers.Wallet.createRandom().privateKey;
process.env.AGENT_PRIVATE_KEY = AGENT_PK;
process.env.SESSION_MANAGER_ADDRESS = MGR;
process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:1";
process.env.VC_NONCE_STATE_PATH = path.join(TMP, "nonces.json");
delete process.env.DELEGATION_VC_CHAIN_IDS;

const shared = await import("@pepelab/shared");
const {
  issueDelegationCredential, verifyDelegationCredential, delegationCredentialHash, credentialHashOf,
  delegationFieldsFromCredential, compareDelegationWithSession, delegationAsVerifyResult, credentialJti,
  checkAndRecordVcNonce, presentForX402, verifyX402Presentation, paymentAuthorizationOf, kyaFetch,
  matchX402Endpoint, canonicalRequestPath, agentCredentialVersion, issueAuthorizationVC, verifyAuthorizationVC,
  GuardedWallet, SigningGuardError, isDelegationCredential, AGENT_PRESENTATION_HEADER, encodeHeaderJson, decodeHeaderJson,
} = shared;

const CHAIN = 84532;
const NOW = Math.floor(Date.now() / 1000);
const NOW_MS = NOW * 1000;
const BTC = ethers.id("sBTC");
const ETH = ethers.id("sETH");
const user = ethers.Wallet.createRandom();
const agent = new ethers.Wallet(AGENT_PK);
const stranger = ethers.Wallet.createRandom();
const session = {
  maxMarginPerTrade: 50n * 10n ** 18n,
  totalMarginBudget: 1000n * 10n ** 18n,
  maxLeverage: 5n,
  expiry: BigInt(NOW + 7 * 86400),
  allowedAssets: [ETH, BTC],
};
const onchain = { user: user.address, agent: agent.address, ...session, revoked: false };
let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

const issue = (o: Record<string, unknown> = {}) =>
  issueDelegationCredential({
    issuer: user,
    agentAddress: agent.address,
    sessionManager: MGR,
    sessionId: 7,
    session,
    x402: { maxPerPeriod: "20000", periodSeconds: 3600, maxTotal: "50000" },
    chainId: CHAIN,
    validFrom: NOW,
    ...o,
  });

// 1) 結構：W3C VC 2.0
const { credential: vc, credentialHash } = await issue();
{
  assert.deepEqual(vc.type, ["VerifiableCredential", "AgentDelegationCredential"]);
  assert.equal(vc["@context"][0], "https://www.w3.org/ns/credentials/v2");
  assert.equal(vc.issuer, `did:pkh:eip155:${CHAIN}:${user.address}`);
  assert.equal(vc.credentialSubject.id, `did:pkh:eip155:${CHAIN}:${agent.address}`);
  assert.equal(vc.credentialStatus.statusListIndex, vc.credentialSubject.nonce.toLowerCase());
  assert.equal(vc.proof.type, "EthereumEip712Signature2021");
  assert.equal(vc.proof.eip712.domain.verifyingContract, MGR);
  assert.equal(vc.proof.eip712.primaryType, "AgentDelegationCredential");
  assert.deepEqual(vc.credentialSubject.session.allowedAssets, [BTC, ETH].map((s) => s.toLowerCase()).sort());
  assert.ok(isDelegationCredential(vc));
  assert.equal(agentCredentialVersion(vc), 3);
  assert.equal(vc.validUntil, new Date(Number(session.expiry) * 1000).toISOString(), "validUntil 預設 ≤ session 到期");
  ok("v3 結構：VC 2.0 @context、type、did:pkh、credentialStatus（jti＝nonce）、EIP-712 proof");
}

// 2) 驗證通過 + credentialHash 穩定
{
  const r = verifyDelegationCredential(vc, { now: NOW_MS, expectedSessionManager: MGR });
  assert.equal(r.valid, true, r.reason);
  assert.equal(r.credentialHash, credentialHash);
  assert.equal(credentialHashOf(vc), credentialHash);
  const { fields, chainId } = delegationFieldsFromCredential(vc);
  assert.equal(delegationCredentialHash(fields, chainId), credentialHash);
  assert.match(credentialHash, /^0x[0-9a-f]{64}$/);
  // JSON 往返（header 傳輸）後 hash 不變
  assert.equal(credentialHashOf(JSON.parse(JSON.stringify(vc))), credentialHash);
  ok("驗簽通過；credentialHash＝EIP-712 digest，JSON 往返不變");
}

// 3) 竄改任一欄 → 簽章不符
{
  const mutate = (f: (v: any) => void) => {
    const c = JSON.parse(JSON.stringify(vc));
    f(c);
    return verifyDelegationCredential(c, { now: NOW_MS });
  };
  for (const [name, f] of [
    ["maxMarginPerTrade", (v: any) => (v.credentialSubject.session.maxMarginPerTrade = "51000000000000000000")],
    ["x402.maxTotal", (v: any) => (v.credentialSubject.x402.maxTotal = "999999999")],
    ["x402.endpoints", (v: any) => v.credentialSubject.x402.endpoints.push("GET /admin/*")],
    ["allowedAssets", (v: any) => v.credentialSubject.session.allowedAssets.pop()],
    ["agent", (v: any) => (v.credentialSubject.id = `did:pkh:eip155:${CHAIN}:${stranger.address}`)],
    ["sessionId", (v: any) => (v.credentialSubject.sessionId = 8)],
  ] as const) {
    const r = mutate(f);
    assert.equal(r.valid, false, name);
    assert.ok(r.reasonCode === "VC_BAD_SIGNATURE" || r.reasonCode === "VC_MALFORMED", `${name}: ${r.reasonCode}`);
  }
  const wrongMgr = mutate((v) => {
    v.credentialSubject.sessionManager = ethers.getAddress("0x" + "77".repeat(20));
  });
  assert.equal(wrongMgr.valid, false);
  const statusPtr = mutate((v) => (v.credentialStatus.statusListIndex = "0x" + "00".repeat(32)));
  assert.equal(statusPtr.reasonCode, "VC_STATUS_POINTER_MISMATCH");
  ok("竄改額度／x402 上限／端點／資產／代理人／sessionId／session manager → 拒絕；狀態指標不符 → VC_STATUS_POINTER_MISMATCH");
}

// 4) 鏈、session manager、期限
{
  assert.equal(verifyDelegationCredential(vc, { now: NOW_MS, acceptedChainIds: [1] }).reasonCode, "VC_WRONG_CHAIN");
  assert.equal(
    verifyDelegationCredential(vc, { now: NOW_MS, expectedSessionManager: ethers.getAddress("0x" + "11".repeat(20)) }).reasonCode,
    "VC_WRONG_VERIFYING_CONTRACT",
  );
  assert.equal(verifyDelegationCredential(vc, { now: (Number(session.expiry) + 1) * 1000 }).reasonCode, "VC_EXPIRED");
  const future = (await issue({ validFrom: NOW + 3600 })).credential;
  assert.equal(verifyDelegationCredential(future, { now: NOW_MS }).reasonCode, "VC_NOT_YET_VALID");
  await assert.rejects(issue({ validUntil: Number(session.expiry) + 10 }), /不可晚於鏈上 session 到期/);
  await assert.rejects(issue({ x402: { maxPerPeriod: "5", maxTotal: "1" } }), /maxPerPeriod 不可大於 maxTotal/);
  ok("DID 鏈不在接受清單／session manager 不符／過期／未生效 → 拒絕；簽發端擋下超過 session 期限與 x402 額度矛盾");
}

// 5) 與鏈上 session 逐欄比對
{
  const { fields } = delegationFieldsFromCredential(vc);
  assert.equal(compareDelegationWithSession(fields, onchain, NOW), null);
  // 鏈上資產順序不同、大小寫不同 → 仍相符（集合比較）
  assert.equal(compareDelegationWithSession(fields, { ...onchain, allowedAssets: [BTC.toUpperCase().replace("0X", "0x"), ETH] }, NOW), null);
  const cases: [string, Partial<typeof onchain>][] = [
    ["SESSION_USER_MISMATCH", { user: stranger.address }],
    ["SESSION_AGENT_MISMATCH", { agent: stranger.address }],
    ["SESSION_REVOKED", { revoked: true }],
    ["SESSION_TERMS_MISMATCH", { maxMarginPerTrade: 49n * 10n ** 18n }],
    ["SESSION_TERMS_MISMATCH", { totalMarginBudget: 1n }],
    ["SESSION_TERMS_MISMATCH", { maxLeverage: 6n }],
    ["SESSION_TERMS_MISMATCH", { expiry: session.expiry + 1n }],
    ["SESSION_ASSETS_MISMATCH", { allowedAssets: [BTC] }],
    ["SESSION_ASSETS_MISMATCH", { allowedAssets: [] }],
  ];
  for (const [code, patch] of cases) {
    assert.equal(compareDelegationWithSession(fields, { ...onchain, ...patch }, NOW)?.code, code, JSON.stringify(patch, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  }
  assert.equal(compareDelegationWithSession(fields, onchain, Number(session.expiry) + 1)?.code, "SESSION_EXPIRED");
  ok("與 sessions(id)＋allowedAssets(id) 逐欄比對：user、agent、撤銷、到期、四個額度、資產白名單（集合）");
}

// 6) 投影到 v2 形狀：ADR-016 jti＝nonce、vcNonce 取代語意可用
{
  const r = verifyDelegationCredential(vc, { now: NOW_MS });
  const p = delegationAsVerifyResult(r);
  assert.equal(credentialJti(p), vc.credentialSubject.nonce.toLowerCase());
  assert.equal(p.verifyingContract, MGR);
  assert.equal(p.issuedAt, NOW);
  assert.equal(checkAndRecordVcNonce(p, { now: NOW_MS }).ok, true);
  const newer = (await issue({ validFrom: NOW + 10 })).credential;
  const pNew = delegationAsVerifyResult(verifyDelegationCredential(newer, { now: NOW_MS + 20_000 }));
  assert.equal(checkAndRecordVcNonce(pNew, { now: NOW_MS + 20_000 }).ok, true);
  assert.equal(checkAndRecordVcNonce(p, { now: NOW_MS + 30_000 }).reasonCode, "VC_SUPERSEDED", "重簽後舊 v3 被取代");
  ok("v3 投影：jti＝nonce（狀態清單沿用）、nonce 一次性與取代規則沿用（重簽後舊憑證 VC_SUPERSEDED）");
}

// 7) v2 不受影響
{
  const v2 = await issueAuthorizationVC({
    issuer: user,
    agentAddress: agent.address,
    sessionId: 7,
    caps: { maxMarginPerTrade: "50", totalBudget: "1000", maxLeverage: 5, expiry: Number(session.expiry) },
    verifyingContract: MGR,
    issuedAt: NOW,
  });
  const r = verifyAuthorizationVC(v2, { now: NOW_MS, expectedVerifyingContract: MGR });
  assert.equal(r.valid, true);
  assert.equal(r.version, 2);
  assert.equal(agentCredentialVersion(v2), 2);
  assert.equal(isDelegationCredential(v2), false);
  ok("v2 授權 VC 照舊可驗（version 2），不被當成 v3");
}

// 8) 端點比對與路徑正規化
{
  const eps = ["GET /signals/*", "GET /oracle/sBTC"];
  assert.equal(matchX402Endpoint(eps, "GET", "/signals/0xabc"), "GET /signals/*");
  assert.equal(matchX402Endpoint(eps, "get", "/oracle/sBTC"), "GET /oracle/sBTC");
  assert.equal(matchX402Endpoint(eps, "GET", "/oracle/sETH"), null);
  assert.equal(matchX402Endpoint(eps, "GET", "/signals/a/b"), null);
  assert.equal(matchX402Endpoint(eps, "POST", "/signals/0xabc"), null);
  assert.equal(canonicalRequestPath("/SIGNALS//0xAbC/?x=1"), "/signals/0xAbC");
  assert.equal(canonicalRequestPath("/oracle/s%42TC"), "/oracle/sBTC");
  ok("x402 端點範圍比對（* 只配一段）與路徑正規化（與 signal-api 路由相同規則）");
}

// 9) presentation：簽、驗、綁定
const PAYTO = ethers.getAddress("0x" + "44".repeat(20));
const payHeader = (from: string, nonce = ethers.hexlify(ethers.randomBytes(32)), value = "10000") =>
  Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: "exact",
      network: "base-sepolia",
      payload: { signature: "0x", authorization: { from, to: PAYTO, value, validAfter: "0", validBefore: String(NOW + 60), nonce } },
    }),
  ).toString("base64");
const signer = (w: ethers.Wallet | ethers.HDNodeWallet) => (d: any, t: any, v: any) => w.signTypedData(d, t, v);
{
  const ph = payHeader(agent.address);
  const pay = paymentAuthorizationOf(ph)!;
  assert.equal(pay.from, agent.address);
  assert.equal(pay.value, 10000n);
  const { header, presentation } = await presentForX402({
    credential: vc, holderAddress: agent.address, signTypedData: signer(agent),
    method: "get", path: "https://api.example/signals/0xAbC?x=1", paymentHeader: ph, created: NOW,
  });
  assert.equal(presentation.proof.challenge, pay.nonce);
  assert.equal(presentation.proof.domain, "GET /signals/0xAbC");
  assert.equal(presentation.holder, `did:pkh:eip155:${CHAIN}:${agent.address}`);
  const req = { method: "GET", path: "/signals/0xAbC", payment: pay };
  const good = verifyX402Presentation(header, req, { now: NOW_MS });
  assert.equal(good.ok, true, good.reason);
  assert.equal(verifyX402Presentation(header, { ...req, path: "/signals/0xDEF" }, { now: NOW_MS }).reasonCode, "KYA_PRESENTATION_WRONG_REQUEST");
  assert.equal(verifyX402Presentation(header, { ...req, method: "POST" }, { now: NOW_MS }).reasonCode, "KYA_PRESENTATION_WRONG_REQUEST");
  const other = paymentAuthorizationOf(payHeader(agent.address))!;
  assert.equal(verifyX402Presentation(header, { ...req, payment: other }, { now: NOW_MS }).reasonCode, "KYA_PRESENTATION_WRONG_PAYMENT");
  assert.equal(verifyX402Presentation(header, req, { now: NOW_MS + 600_000 }).reasonCode, "KYA_PRESENTATION_STALE");
  // 竄改 presentation 的 domain → 簽章不符
  const vp = decodeHeaderJson<any>(header);
  vp.proof.domain = "GET /signals/0xDEF";
  assert.equal(
    verifyX402Presentation(encodeHeaderJson(vp), { ...req, path: "/signals/0xDEF" }, { now: NOW_MS }).reasonCode,
    "KYA_PRESENTATION_BAD_SIGNATURE",
  );
  ok("presentation：綁 METHOD＋路徑＋付款 nonce＋payer；換路徑／方法／付款、過期、竄改 → 拒絕");
}

// 10) 身分一致：簽者＝主體＝付款人
{
  // 別人拿著這張憑證出示（簽者≠主體）：簽發端直接拒絕
  await assert.rejects(
    presentForX402({ credential: vc, holderAddress: stranger.address, signTypedData: signer(stranger), method: "GET", path: "/signals/0x1", paymentHeader: payHeader(stranger.address) }),
    /不是憑證的代理人/,
  );
  // 付款人不是代理人：簽發端拒絕
  await assert.rejects(
    presentForX402({ credential: vc, holderAddress: agent.address, signTypedData: signer(agent), method: "GET", path: "/signals/0x1", paymentHeader: payHeader(stranger.address) }),
    /付款人.*不是代理人/,
  );
  // 手工組一份「stranger 簽、holder 宣稱 stranger」的 presentation → 驗證端 KYA_HOLDER_NOT_SUBJECT
  const ph = payHeader(stranger.address);
  const pay = paymentAuthorizationOf(ph)!;
  const fields = {
    holder: stranger.address, credentialHash, method: "GET", path: "/signals/0x1",
    paymentNonce: pay.nonce, payer: stranger.address, created: NOW,
  };
  const sig = await stranger.signTypedData(shared.presentationDomain(CHAIN), shared.PRESENTATION_TYPES as any, shared.buildPresentationTypedValue(fields));
  const forged = encodeHeaderJson(shared.assemblePresentation({ credential: vc, fields, chainId: CHAIN, signature: sig }));
  assert.equal(verifyX402Presentation(forged, { method: "GET", path: "/signals/0x1", payment: pay }, { now: NOW_MS }).reasonCode, "KYA_HOLDER_NOT_SUBJECT");
  // 代理人簽、但 payer 宣稱代理人而實際付款人是 stranger → WRONG_PAYMENT
  const f2 = { ...fields, holder: agent.address, payer: agent.address };
  const sig2 = await agent.signTypedData(shared.presentationDomain(CHAIN), shared.PRESENTATION_TYPES as any, shared.buildPresentationTypedValue(f2));
  const vp2 = encodeHeaderJson(shared.assemblePresentation({ credential: vc, fields: f2, chainId: CHAIN, signature: sig2 }));
  assert.equal(verifyX402Presentation(vp2, { method: "GET", path: "/signals/0x1", payment: pay }, { now: NOW_MS }).reasonCode, "KYA_PRESENTATION_WRONG_PAYMENT");
  ok("身分一致：presentation 簽者＝憑證主體＝x402 付款人，任何一個不同都拒絕");
}

// 11) 簽章守門：GuardedWallet 只放行合規的 presentation
{
  const g = new GuardedWallet(AGENT_PK);
  const ph = payHeader(agent.address);
  const { header } = await presentForX402({
    credential: vc, holderAddress: agent.address, signTypedData: (d, t, v) => g.signTypedData(d, t, v),
    method: "GET", path: "/oracle/sBTC", paymentHeader: ph,
  });
  assert.ok(header.length > 100);
  const pay = paymentAuthorizationOf(ph)!;
  const base = { holder: agent.address, credentialHash, method: "GET", path: "/x", paymentNonce: pay.nonce, payer: agent.address, created: Math.floor(Date.now() / 1000) };
  const T = shared.PRESENTATION_TYPES as any;
  const v = (o: Partial<typeof base>) => shared.buildPresentationTypedValue({ ...base, ...o });
  const reject = async (d: any, t: any, val: any, label: string) =>
    assert.rejects(g.signTypedData(d, t, val), (e: unknown) => e instanceof SigningGuardError && (e as any).reasonCode === "TYPED_DATA_NOT_ALLOWLISTED", label);
  await reject(shared.presentationDomain(CHAIN), T, v({ holder: stranger.address }), "holder≠self");
  await reject(shared.presentationDomain(CHAIN), T, v({ payer: stranger.address }), "payer≠self");
  await reject(shared.presentationDomain(CHAIN), T, v({ created: base.created - 3600 }), "stale");
  await reject({ ...shared.presentationDomain(CHAIN), verifyingContract: MGR }, T, v({}), "verifyingContract");
  await reject(shared.presentationDomain(1), T, v({}), "chain");
  await reject(
    shared.presentationDomain(CHAIN),
    { AgentX402Presentation: [...T.AgentX402Presentation, { name: "extra", type: "uint256" }] },
    { ...v({}), extra: 1n },
    "extra field",
  );
  ok("簽章守門 (d)：GuardedWallet 可簽合規 presentation；holder／payer 非自己、過期、domain 帶合約或錯鏈、型別多欄 → 拒絕");
}

// 12) kyaFetch：只在帶付款 header 的請求附上 presentation
{
  const seen: Headers[] = [];
  const base = (async (_i: any, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const f = kyaFetch({ credential: vc, holderAddress: agent.address, signTypedData: signer(agent) }, base);
  await f("http://127.0.0.1/signals/0x1");
  await f("http://127.0.0.1/signals/0x1", { headers: { "X-PAYMENT": payHeader(agent.address) } });
  assert.equal(seen[0]!.get(AGENT_PRESENTATION_HEADER), null, "未付款的請求不附");
  const vpHeader = seen[1]!.get(AGENT_PRESENTATION_HEADER);
  assert.ok(vpHeader, "付款請求附上 presentation");
  const vp = decodeHeaderJson<any>(vpHeader!);
  assert.equal(vp.proof.domain, "GET /signals/0x1");
  ok("kyaFetch：未付款的請求不附；帶 X-PAYMENT 的重送自動附上綁定該付款的 presentation");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n✅ delegation-v3.test.ts 全過（${n} 組）`);
