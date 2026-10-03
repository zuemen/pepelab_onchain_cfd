// 狀態清單（ADR-016）SDK helpers：viem 簽 ↔ shared(ethers) 驗（位元組相容）、竄改、
// 撤銷判斷、重放（minSequence）、過期、簽發者不符；createVcStatusChecker 以注入時鐘測快取。
// 完全離線，金鑰為測試用隨機金鑰；時間一律固定常數。
//   cd agent && npx tsx sdk/test/vcStatus.test.ts
import assert from "node:assert";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress, type Hex } from "viem";

import {
  InvalidStatusListError,
  STATUS_LIST_PRIMARY_TYPE,
  buildAuthorizationTypedData,
  buildStatusListTypedData,
  checkCredentialStatusWithList,
  createVcStatusChecker,
  credentialJti,
  finalizeAuthorizationVC,
  finalizeStatusList,
  issueStatusList,
  memoryStatusStateStore,
  verifyAuthorizationVCv2,
} from "../src/index.ts";
import { issueStatusList as sharedIssueList, verifyStatusList as sharedVerifyList } from "../../shared/src/vcStatus.ts";
import { ethers } from "ethers";

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

const MGR = getAddress("0x" + "5e".repeat(20));
const OTHER_MGR = getAddress("0x" + "77".repeat(20));
const user = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const T0 = Date.parse("2026-09-01T00:00:00Z") / 1000;
const NOW_MS = (T0 + 86_400) * 1000;
const caps = { maxMarginPerTrade: "50", totalBudget: "1000", maxLeverage: 3, expiry: T0 + 30 * 86_400 };

async function vc(issuedAt: number) {
  const d = buildAuthorizationTypedData({ issuer: user.address, agent: agent.address, sessionId: 4, caps, verifyingContract: MGR, issuedAt });
  const v = finalizeAuthorizationVC(d, await user.signTypedData(d.typedData), { nowMs: NOW_MS });
  return verifyAuthorizationVCv2(v, { expectedVerifyingContract: MGR, nowMs: NOW_MS });
}
const A = await vc(T0);
const B = await vc(T0 + 100);
assert.equal(A.valid && B.valid, true);

// 1) viem 簽 → finalize → shared 驗；shared 簽 → SDK 判斷
{
  const d = buildStatusListTypedData({ issuer: user.address, verifyingContract: MGR, sequence: 1, issuedAt: T0 + 50, revoked: [A.nonce!.toUpperCase().replace("0X", "0x")] });
  assert.equal(d.typedData.primaryType, STATUS_LIST_PRIMARY_TYPE);
  assert.deepEqual(d.typedData.domain, { name: "PepeLabAgentAuthorization", version: "2", chainId: 84532, verifyingContract: MGR });
  assert.deepEqual(d.revoked, [A.nonce!.toLowerCase()], "jti 正規化成小寫");
  const doc = finalizeStatusList(d, await user.signTypedData(d.typedData), { nowMs: NOW_MS });
  assert.equal(sharedVerifyList(doc, { now: NOW_MS, expectedIssuer: user.address }).valid, true);

  const ethersUser = new ethers.Wallet(generatePrivateKey());
  const doc2 = await sharedIssueList({ issuer: ethersUser, verifyingContract: MGR, sequence: 1, issuedAt: T0 });
  assert.equal(sharedVerifyList(doc2, { now: NOW_MS }).valid, true);
  ok("viem 簽的清單 shared 驗得過；domain 與 VC v2 相同、primary type 不同");
}

// 2) 撤銷判斷、minSequence 防重放、過期、簽發者不符、簽章錯
{
  const l2 = await issueStatusList({
    issuer: user.address, verifyingContract: MGR, sequence: 2, issuedAt: T0 + 200, revoked: [credentialJti(A)!],
    signTypedData: (td) => user.signTypedData(td), nowMs: NOW_MS,
  });
  let r = checkCredentialStatusWithList(A, l2, { expectedVerifyingContract: MGR, nowMs: NOW_MS });
  assert.equal(r.status, "revoked");
  assert.equal(r.ok, false);
  r = checkCredentialStatusWithList(B, l2, { expectedVerifyingContract: MGR, nowMs: NOW_MS, minSequence: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.reasonCode, "STATUS_ACTIVE");
  assert.equal(r.warnings, undefined, "有 minSequence、離到期還久：沒有警告");
  r = checkCredentialStatusWithList(B, l2, { expectedVerifyingContract: MGR, nowMs: NOW_MS });
  assert.equal(r.ok, true);
  assert.match(r.warnings!.join(), /minSequence/, "沒傳 minSequence → 警告（審查 L5）");
  r = checkCredentialStatusWithList(B, l2, { expectedVerifyingContract: MGR, nowMs: (T0 + 200 + 25 * 86_400) * 1000, minSequence: 2 });
  assert.equal(r.ok, true);
  assert.match(r.warnings!.join(), /到期/, "剩 5 天 → 到期預警（審查 M3）");
  r = checkCredentialStatusWithList(B, l2, { expectedVerifyingContract: MGR, nowMs: NOW_MS, minSequence: 3 });
  assert.equal(r.reasonCode, "STATUS_LIST_REPLAYED");
  assert.equal(r.ok, false);
  r = checkCredentialStatusWithList(B, l2, { expectedVerifyingContract: MGR, nowMs: (T0 + 31 * 86_400) * 1000 });
  assert.equal(r.reasonCode, "STATUS_LIST_EXPIRED");
  r = checkCredentialStatusWithList(B, l2, { expectedVerifyingContract: OTHER_MGR, nowMs: NOW_MS });
  assert.equal(r.reasonCode, "STATUS_LIST_WRONG_DOMAIN");
  const byOther = await issueStatusList({ issuer: other.address, verifyingContract: MGR, sequence: 9, issuedAt: T0, signTypedData: (td) => other.signTypedData(td), nowMs: NOW_MS });
  r = checkCredentialStatusWithList(B, byOther, { expectedVerifyingContract: MGR, nowMs: NOW_MS });
  assert.equal(r.reasonCode, "STATUS_LIST_WRONG_ISSUER");
  const tampered = structuredClone(l2);
  tampered.revoked = [];
  r = checkCredentialStatusWithList(A, tampered, { expectedVerifyingContract: MGR, nowMs: NOW_MS });
  assert.equal(r.reasonCode, "STATUS_LIST_BAD_SIGNATURE");
  ok("checkCredentialStatusWithList：撤銷、minSequence 重放、過期、別的部署、簽發者不符、竄改");
}

// 3) finalize：簽的人不是 issuer → 丟錯
{
  const d = buildStatusListTypedData({ issuer: user.address, verifyingContract: MGR, sequence: 1, issuedAt: T0 });
  assert.throws(() => finalizeStatusList(d, ("0x" + "11".repeat(65)) as Hex, { nowMs: NOW_MS }), InvalidStatusListError);
  assert.throws(() => buildStatusListTypedData({ issuer: user.address, verifyingContract: MGR, sequence: 1, issuedAt: T0, validUntil: T0 + 91 * 86_400 }), /有效期/);
  ok("finalize 驗不過就丟錯；有效期超過 90 天不建構");
}

// 4) createVcStatusChecker（注入時鐘）：新鮮度上限內沿用快取，過了才看見撤銷
{
  let clock = NOW_MS;
  let calls = 0;
  let doc: unknown = await issueStatusList({ issuer: user.address, verifyingContract: MGR, sequence: 1, issuedAt: T0, signTypedData: (td) => user.signTypedData(td), nowMs: NOW_MS });
  const checker = createVcStatusChecker({
    source: { describe: "t", fetch: async () => { calls++; return { kind: "list", doc }; } },
    store: memoryStatusStateStore(),
    now: () => clock,
    cacheMaxAgeSec: 30,
  });
  assert.equal((await checker.check(B as any, { action: "write", verifyingContract: MGR })).ok, true);
  doc = await issueStatusList({ issuer: user.address, verifyingContract: MGR, sequence: 2, issuedAt: T0 + 300, revoked: [credentialJti(B)!], signTypedData: (td) => user.signTypedData(td), nowMs: NOW_MS });
  clock += 30_000;
  assert.equal((await checker.check(B as any, { action: "write", verifyingContract: MGR })).ok, true, "30 秒整仍沿用快取");
  clock += 1;
  const r = await checker.check(B as any, { action: "write", verifyingContract: MGR });
  assert.equal(r.reasonCode, "VC_REVOKED");
  assert.equal(calls, 2);
  ok("createVcStatusChecker：快取新鮮度上限（注入時鐘）");
}

console.log(`\n✅ sdk/test/vcStatus.test.ts 全過（${n} 組）`);
