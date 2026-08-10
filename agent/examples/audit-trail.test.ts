// 自測（Part E）：VC 閘門 + 稽核摘要的核心邏輯，純密碼學、免鏈免資金。
// 證明「有效 VC → 可承認 ✅、竄改/換 holder/錯 session → 被拒 ❌」。
//   npx tsx examples/audit-trail.test.ts
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";
import {
  issueAuthorizationVC, vcId, vcBinding, appendAudit, readAudit, agentDid,
  verifyAuditChain, verifyAuthorizationVC, recordHash,
  type AuthorizationCaps, type AuditRecord,
} from "@pepelab/shared";
import { localVerifyVc } from "./vc-gate.ts";

async function main() {
  const user = ethers.Wallet.createRandom();   // issuer（使用者）
  const agent = ethers.Wallet.createRandom();  // holder（agent）
  const other = ethers.Wallet.createRandom();
  const SESSION_ID = 6;
  const caps: AuthorizationCaps = { maxMarginPerTrade: "50", totalBudget: "1000", maxLeverage: 5, expiry: Math.floor(Date.now() / 1000) + 365 * 24 * 3600 };

  const vc = await issueAuthorizationVC({ issuer: user, agentAddress: agent.address, sessionId: SESSION_ID, caps });

  // 1) 有效 VC（驗章 + sessionId + holder 相符）→ ok
  const good = localVerifyVc(vc, agent.address, SESSION_ID);
  assert.equal(good.ok, true, good.reason);
  assert.equal(good.issuerDid, agentDid(user.address));
  console.log("✓ 有效 VC → 可下單：", good.reason);

  // 2) 竄改授權上限 → 驗章失敗 → ✗
  const tampered = structuredClone(vc);
  tampered.credentialSubject.authorization.maxLeverage = 50;
  const bad1 = localVerifyVc(tampered, agent.address, SESSION_ID);
  assert.equal(bad1.ok, false);
  console.log("✓ 竄改 VC → 拒絕：", bad1.reason);

  // 3) 換 holder（agent 不符）→ ✗
  const bad2 = localVerifyVc(vc, other.address, SESSION_ID);
  assert.equal(bad2.ok, false);
  console.log("✓ 換 holder → 拒絕：", bad2.reason);

  // 4) sessionId 不符（例如舊 #0）→ ✗
  const bad3 = localVerifyVc(vc, agent.address, 0);
  assert.equal(bad3.ok, false);
  console.log("✓ sessionId 不符 → 拒絕：", bad3.reason);

  // 5) VC 摘要：同一張穩定、不同張（不同 holder）不同 → audit 可比對
  const vc2 = await issueAuthorizationVC({ issuer: user, agentAddress: other.address, sessionId: SESSION_ID, caps });
  assert.equal(vcId(vc), vcId(vc));
  assert.notEqual(vcId(vc), vcId(vc2));
  console.log("✓ VC 摘要穩定且可辨識不同憑證");

  // 6) 稽核 append/read roundtrip（skip 筆，免鏈）
  const tmp = path.join(os.tmpdir(), `pepe-audit-${Date.now()}.jsonl`);
  const rec: AuditRecord = {
    ts: new Date().toISOString(), issuerDid: good.issuerDid, agentDid: agentDid(agent.address), sessionId: SESSION_ID,
    vc: { id: good.id, expiry: good.expiry, verified: good.ok },
    research: { resource: "/oracle/sBTC", priceUsdc: "0.005", settlementTx: "0xpay" },
    decision: { edgeScore: 10, side: "skip", reason: "訊號弱" },
    action: { opened: false, positionId: null, txHash: null },
  };
  appendAudit(tmp, rec);
  const back = readAudit(tmp);
  assert.equal(back.length, 1);
  assert.equal(back[0].vc.id, good.id);
  assert.equal(back[0].vc.verified, true);
  console.log("✓ 稽核 JSONL append/read roundtrip");

  // 7) VC ↔ 紀錄內容綁定：改動內容 → binding 對不上（以前只綁簽章位元組，改不到）。
  assert.ok(back[0].vc.binding, "appendAudit 應自動補上 vc.binding");
  const recomputed = vcBinding({
    vcIdValue: good.id, issuerDid: back[0].issuerDid, agentDid: back[0].agentDid,
    sessionId: back[0].sessionId, research: back[0].research, decision: back[0].decision,
  });
  assert.equal(back[0].vc.binding, recomputed);
  const tamperedContent = structuredClone(back[0]);
  tamperedContent.decision.side = "long"; // 把「本來 skip」改寫成「有下單」
  const afterTamper = vcBinding({
    vcIdValue: good.id, issuerDid: tamperedContent.issuerDid, agentDid: tamperedContent.agentDid,
    sessionId: tamperedContent.sessionId, research: tamperedContent.research, decision: tamperedContent.decision,
  });
  assert.notEqual(afterTamper, tamperedContent.vc.binding, "改寫決策後 binding 必須對不上");
  console.log("✓ VC 與紀錄內容綁定（改 decision/session 即對不上）");

  // 8) hash chain：三筆連續紀錄必須成鏈，且任何竄改/刪除/重排都會被抓到。
  for (let i = 0; i < 2; i++) {
    appendAudit(tmp, { ...rec, ts: new Date(Date.now() + i + 1).toISOString(), decision: { ...rec.decision, edgeScore: i } });
  }
  const chain = readAudit(tmp);
  assert.equal(chain.length, 3);
  assert.deepEqual(verifyAuditChain(chain), [], "完整的鏈不該有任何 issue");
  assert.equal(chain[0].prevHash, null);
  assert.equal(chain[1].prevHash, chain[0].hash);
  assert.equal(chain[2].prevHash, chain[1].hash);
  console.log("✓ hash chain 串接正確（3 筆）");

  // 8a) 竄改中間一筆的內容 → 該筆 hash 對不上。
  {
    const t = structuredClone(chain);
    t[1].action = { opened: true, positionId: "999", txHash: "0x" + "a".repeat(64) };
    const issues = verifyAuditChain(t);
    assert.ok(issues.some((i) => i.index === 1 && i.problem.includes("竄改")), JSON.stringify(issues));
  }
  // 8b) 刪掉中間一筆 → 斷鏈。
  {
    const t = [chain[0], chain[2]];
    const issues = verifyAuditChain(t);
    assert.ok(issues.some((i) => i.index === 1 && i.problem.includes("prevHash")), JSON.stringify(issues));
  }
  // 8c) 重排 → 斷鏈。
  {
    const t = [chain[1], chain[0], chain[2]];
    assert.ok(verifyAuditChain(t).length > 0);
  }
  // 8d) 連 hash 一起重算的竄改也擋得住嗎？擋不住——但會在後面斷鏈，這正是鏈的價值。
  {
    const t = structuredClone(chain);
    t[1].decision.reason = "改過的理由";
    t[1].hash = recordHash(t[1]); // 攻擊者重算了自己那一筆
    const issues = verifyAuditChain(t);
    assert.ok(
      issues.some((i) => i.index === 2 && i.problem.includes("prevHash")),
      "重算單筆 hash 後，下一筆的 prevHash 必須對不上",
    );
    console.log("✓ 竄改/刪除/重排/重算單筆 hash 皆被 verifyAuditChain 抓到");
  }

  fs.rmSync(tmp, { force: true });

  // 9) DID chainId 綁定：把 did:pkh 的 chainId 換掉必須失效（以前仍 valid:true）。
  {
    const wrongChain = structuredClone(vc);
    wrongChain.issuer = wrongChain.issuer.replace(/eip155:\d+/, "eip155:1");
    assert.equal(verifyAuthorizationVC(wrongChain).valid, false, "issuer DID 換鏈必須失效");
    const wrongChain2 = structuredClone(vc);
    wrongChain2.credentialSubject.id = wrongChain2.credentialSubject.id.replace(/eip155:\d+/, "eip155:1");
    assert.equal(verifyAuthorizationVC(wrongChain2).valid, false, "holder DID 換鏈必須失效");
    console.log("✓ VC 的 did:pkh chainId 已綁定（換成 eip155:1 即失效）");
  }

  console.log("\n✅ audit-trail 自測全過（VC 閘門 + 內容綁定 + hash chain + DID 綁鏈）");
}

main().catch((e) => { console.error("\n❌ audit-trail 測試失敗：", e); process.exit(1); });
