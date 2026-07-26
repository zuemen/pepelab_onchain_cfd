// 自測（Part E）：VC 閘門 + 稽核摘要的核心邏輯，純密碼學、免鏈免資金。
// 證明「有效 VC → 可承認 ✅、竄改/換 holder/錯 session → 被拒 ❌」。
//   npx tsx examples/audit-trail.test.ts
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";
import {
  issueAuthorizationVC, vcId, appendAudit, readAudit, agentDid,
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
  fs.rmSync(tmp, { force: true });
  console.log("✓ 稽核 JSONL append/read roundtrip");

  console.log("\n✅ audit-trail 自測全過（VC 閘門 + 稽核摘要）");
}

main().catch((e) => { console.error("\n❌ audit-trail 測試失敗：", e); process.exit(1); });
