// VC v2 helpers：viem 簽 ↔ shared(ethers) 驗、shared 簽 ↔ SDK 驗（位元組相容）、拒絕 v1、
// verifyingContract 綁定、竄改、與鏈上 session 交叉比對。完全離線，金鑰為測試用隨機金鑰。
//   cd agent && npx tsx sdk/test/vc.test.ts
import assert from "node:assert";
import { ethers } from "ethers";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, type Hex } from "viem";

import {
  InvalidAuthorizationError,
  VC_PRIMARY_TYPE,
  buildAuthorizationTypedData,
  crossCheckWithSession,
  finalizeAuthorizationVC,
  issueAuthorizationVC,
  margin,
  verifyAuthorizationVCv2,
  type SessionView,
} from "../src/index.ts";
import {
  issueAuthorizationVC as sharedIssue,
  verifyAuthorizationVC as sharedVerify,
} from "../../shared/src/identity.ts";

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

const MGR = getAddress("0x" + "5e".repeat(20));
const OTHER_MGR = getAddress("0x" + "77".repeat(20));
const user = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const NOW = Math.floor(Date.now() / 1000);
const caps = { maxMarginPerTrade: "50", totalBudget: "1000", maxLeverage: 3, expiry: NOW + 10 * 86_400 };
const params = { issuer: user.address, agent: agent.address, sessionId: 4, caps, verifyingContract: MGR };

// 1) SDK 建構 → viem 簽 → finalize（內含驗證）→ shared 驗證也通過
const draft = buildAuthorizationTypedData(params);
{
  assert.equal(draft.typedData.primaryType, VC_PRIMARY_TYPE);
  assert.deepEqual(draft.typedData.domain, { name: "PepeLabAgentAuthorization", version: "2", chainId: 84532, verifyingContract: MGR });
  assert.equal(draft.validUntil, caps.expiry, "預設 min(30 天, session 到期)");
  assert.match(draft.nonce, /^0x[0-9a-f]{64}$/);
  const sig = await user.signTypedData(draft.typedData as never);
  const vc = finalizeAuthorizationVC(draft, sig);
  assert.equal(vc.proof.eip712Domain?.version, "2");
  const r = verifyAuthorizationVCv2(vc, { expectedVerifyingContract: MGR });
  assert.equal(r.valid, true, r.reason);
  assert.equal(r.version, 2);
  const s = sharedVerify(vc, { expectedVerifyingContract: MGR });
  assert.equal(s.valid, true, "agent 端（ethers）也驗得過 —— 同一份 schema");
  assert.equal(s.digest, r.digest);
  ok("SDK 建構 + viem 簽 → SDK 與 shared(ethers) 驗證皆通過，digest 相同");
}

// 2) shared(ethers) 簽發的 v2 → SDK 驗證通過
{
  const wallet = new ethers.Wallet(generatePrivateKey());
  const vc = await sharedIssue({ issuer: wallet, agentAddress: agent.address, sessionId: 9, caps, verifyingContract: MGR });
  const r = verifyAuthorizationVCv2(vc, { expectedVerifyingContract: MGR });
  assert.equal(r.valid, true, r.reason);
  assert.equal(r.issuer, wallet.address);
  ok("shared/前端格式簽發的 v2 VC → SDK 驗證通過");
}

// 3) 拒絕 v1（即使 shared 在淘汰期限前仍會帶警告放行）
{
  const wallet = new ethers.Wallet(generatePrivateKey());
  const v1 = await sharedIssue({ issuer: wallet, agentAddress: agent.address, sessionId: 1, caps, legacyV1: true });
  const origWarn = console.warn;
  console.warn = () => {};
  const shared = sharedVerify(v1, { now: Date.parse("2026-10-01T00:00:00Z") });
  console.warn = origWarn;
  assert.equal(shared.valid, true, "前提：shared 在 2026-12-31 前仍接受 v1");
  const r = verifyAuthorizationVCv2(v1, { expectedVerifyingContract: MGR, now: Date.parse("2026-10-01T00:00:00Z") });
  assert.equal(r.valid, false);
  assert.equal(r.reasonCode, "VC_V1_REJECTED");
  ok("v1 VC 一律 VC_V1_REJECTED（SDK 不收舊格式）");
}

// 4) verifyingContract 綁定、必填
{
  const vc = finalizeAuthorizationVC(draft, await user.signTypedData(draft.typedData as never));
  const r = verifyAuthorizationVCv2(vc, { expectedVerifyingContract: OTHER_MGR });
  assert.equal(r.valid, false);
  assert.equal(r.reasonCode, "VC_WRONG_VERIFYING_CONTRACT");
  assert.throws(() => verifyAuthorizationVCv2(vc, {} as never), /expectedVerifyingContract/);
  assert.throws(() => buildAuthorizationTypedData({ ...params, verifyingContract: "0x" + "00".repeat(20) }), /verifyingContract/);
  ok("verifyingContract：不符 → VC_WRONG_VERIFYING_CONTRACT；驗證時必填；建構時不可為 0x0");
}

// 5) 簽錯人 / 竄改 / 過期
{
  const mallory = privateKeyToAccount(generatePrivateKey());
  const wrongSig = await mallory.signTypedData(draft.typedData as never);
  assert.throws(() => finalizeAuthorizationVC(draft, wrongSig), (e: unknown) => e instanceof InvalidAuthorizationError && e.result.reasonCode === "VC_BAD_SIGNATURE");
  const vc = finalizeAuthorizationVC(draft, await user.signTypedData(draft.typedData as never));
  const t = structuredClone(vc);
  t.credentialSubject.authorization.maxLeverage = 5;
  assert.equal(verifyAuthorizationVCv2(t, { expectedVerifyingContract: MGR }).reasonCode, "VC_BAD_SIGNATURE");
  const expired = verifyAuthorizationVCv2(vc, { expectedVerifyingContract: MGR, now: (caps.expiry + 1) * 1000 });
  assert.equal(expired.reasonCode, "VC_EXPIRED");
  assert.throws(() => buildAuthorizationTypedData({ ...params, validUntil: NOW - 10, issuedAt: NOW }), /validUntil/);
  assert.throws(() => buildAuthorizationTypedData({ ...params, nonce: "0x1234" }), /bytes32/);
  ok("簽錯人 → finalize 丟 InvalidAuthorizationError；竄改 → VC_BAD_SIGNATURE；過期 → VC_EXPIRED");
}

// 6) issueAuthorizationVC（build → 呼叫端簽 → finalize）
{
  let called = 0;
  const vc = await issueAuthorizationVC({
    ...params,
    signTypedData: async (td) => {
      called++;
      return (await user.signTypedData(td as never)) as Hex;
    },
  });
  assert.equal(called, 1);
  assert.equal(verifyAuthorizationVCv2(vc, { expectedVerifyingContract: MGR }).valid, true);
  ok("issueAuthorizationVC：簽署由呼叫端提供，SDK 不碰金鑰");
}

// 7) 與鏈上 session 交叉比對
{
  const vc = finalizeAuthorizationVC(draft, await user.signTypedData(draft.typedData as never));
  const verified = verifyAuthorizationVCv2(vc, { expectedVerifyingContract: MGR });
  const E18 = 10n ** 18n;
  const session: SessionView = {
    blockNumber: 1n,
    blockTimestamp: BigInt(NOW),
    sessionManager: MGR,
    sessionId: 4n,
    exists: true,
    user: user.address,
    agent: agent.address,
    maxMarginPerTrade: margin(50n * E18),
    totalMarginBudget: margin(1000n * E18),
    spentMargin: margin(0n),
    remainingBudget: margin(1000n * E18),
    maxLeverage: 3n,
    expiry: BigInt(caps.expiry),
    revoked: false,
    expired: false,
    active: true,
    allowedAssets: [],
    unrestricted: true,
  };
  assert.deepEqual(crossCheckWithSession(verified, session), { ok: true, mismatches: [] });
  const bad = crossCheckWithSession(verified, { ...session, maxLeverage: 5n, revoked: true, agent: getAddress("0x" + "99".repeat(20)) });
  assert.equal(bad.ok, false);
  assert.equal(bad.mismatches.length, 3, bad.mismatches.join(" | "));
  assert.equal(crossCheckWithSession(verified, { ...session, sessionId: 5n }).ok, false);
  assert.equal(crossCheckWithSession(verified, { ...session, sessionManager: OTHER_MGR }).ok, false);
  assert.equal(crossCheckWithSession(verified, { ...session, expired: true }).ok, false);
  assert.equal(crossCheckWithSession(verified, { ...session, totalMarginBudget: margin(1000n * E18 + 1n) }).ok, false);
  ok("crossCheckWithSession：issuer/agent/sessionId/manager/caps/撤銷/過期逐項比對");
}

console.log(`\n✅ sdk vc.test.ts 全過（${n} 項）`);
