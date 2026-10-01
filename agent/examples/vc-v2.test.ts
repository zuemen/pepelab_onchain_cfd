// VC 強化（v2）測試：verifyingContract 綁定、validUntil 到期、nonce 一次性、舊格式相容。
// 完全離線：不連鏈、不送交易。
//   npx tsx examples/vc-v2.test.ts
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pepe-vc-v2-"));
const MGR = ethers.getAddress("0x" + "5e".repeat(20));
const AGENT_PK = ethers.Wallet.createRandom().privateKey;
process.env.AGENT_PRIVATE_KEY = AGENT_PK;
process.env.SESSION_MANAGER_ADDRESS = MGR;
process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:1";
process.env.POLICY_STATE_PATH = path.join(TMP, "policy.json");
process.env.POLICY_AUDIT_PATH = path.join(TMP, "audit.jsonl");
process.env.VC_NONCE_STATE_PATH = path.join(TMP, "nonces.json");
delete process.env.RISK_GATE_ENABLED;

const {
  issueAuthorizationVC, verifyAuthorizationVC, checkAndRecordVcNonce, openPositionForSession,
  LEGACY_VC_SUNSET_ISO, newAuthNonce,
} = await import("@pepelab/shared");

const user = ethers.Wallet.createRandom();
const agent = new ethers.Wallet(AGENT_PK);
// 「現在」固定為常數，不讀真實時鐘（issue #210）：v1 段落在 LEGACY_VC_SUNSET_ISO 之後若用真實時鐘
// 驗證會一律回 LEGACY_VC_SUNSET。簽發一律覆寫 issuedAt、驗證與 nonce 檢查一律明確傳 now。
// 不全域 mock Date.now —— fileLock 判斷鎖是否過期也靠它。
const NOW_ISO = "2026-09-01T00:00:00Z";
const NOW = Date.parse(NOW_ISO) / 1000;
const NOW_MS = NOW * 1000;
assert.ok(NOW_MS < Date.parse(LEGACY_VC_SUNSET_ISO), "固定的「現在」必須早於 v1 淘汰期限，v1 段落才有意義");
const caps = { maxMarginPerTrade: "50", totalBudget: "1000", maxLeverage: 5, expiry: NOW + 30 * 86400 };
const issue = (o: Record<string, unknown> = {}) =>
  issueAuthorizationVC({ issuer: user, agentAddress: agent.address, sessionId: 3, caps, issuedAt: NOW, ...o });
/** 驗證：預設以固定的 NOW_MS 為「現在」；個別段落可再覆寫 now。 */
const verify = (v: Parameters<typeof verifyAuthorizationVC>[0], o: Parameters<typeof verifyAuthorizationVC>[1] = {}) =>
  verifyAuthorizationVC(v, { now: NOW_MS, ...o });
/** nonce 檢查：同上，預設 now = NOW_MS。 */
const checkNonce = (r: Parameters<typeof checkAndRecordVcNonce>[0], o: Parameters<typeof checkAndRecordVcNonce>[1] = {}) =>
  checkAndRecordVcNonce(r, { now: NOW_MS, ...o });
let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

// 1) 新格式驗證通過
const vc = await issue();
{
  assert.equal(vc.proof.eip712Domain?.version, "2");
  assert.equal(vc.proof.eip712Domain?.verifyingContract, MGR);
  assert.match(vc.credentialSubject.nonce!, /^0x[0-9a-f]{64}$/);
  assert.ok(vc.credentialSubject.validUntil! <= caps.expiry);
  assert.equal(vc.credentialSubject.validUntil, NOW + 30 * 86400, "預設有效期 30 天");
  const short = await issue({ caps: { ...caps, expiry: NOW + 10 * 86400 } });
  assert.equal(short.credentialSubject.validUntil, NOW + 10 * 86400, "不超過 session 到期");
  const r = verify(vc, { expectedVerifyingContract: MGR });
  assert.equal(r.valid, true, r.reason);
  assert.equal(r.version, 2);
  assert.equal(r.nonce, vc.credentialSubject.nonce);
  assert.equal(r.warnings, undefined, "v2 不帶 legacy 警告");
  ok("v2 VC（verifyingContract + validUntil + nonce）驗證通過");
}

// 2) 竄改 v2 新欄位 → 驗簽失敗
{
  for (const mutate of [
    (x: any) => { x.credentialSubject.validUntil += 86400; },
    (x: any) => { x.credentialSubject.nonce = newAuthNonce(); },
    (x: any) => { x.proof.eip712Domain.verifyingContract = ethers.getAddress("0x" + "77".repeat(20)); },
  ]) {
    const t = structuredClone(vc);
    mutate(t);
    const r = verify(t);
    assert.equal(r.valid, false);
    assert.equal(r.reasonCode, "VC_BAD_SIGNATURE");
  }
  ok("竄改 validUntil / nonce / verifyingContract → VC_BAD_SIGNATURE");
}

// 3) verifyingContract 與 agent 實際使用的 session manager 不符 → 拒絕
{
  const r = verify(vc, { expectedVerifyingContract: "0x" + "88".repeat(20) });
  assert.equal(r.valid, false);
  assert.equal(r.reasonCode, "VC_WRONG_VERIFYING_CONTRACT");
  ok("verifyingContract ≠ 本 agent 的 session manager → VC_WRONG_VERIFYING_CONTRACT");
}

// 4) 過期被拒（validUntil 已過；session 本身尚未到期）
{
  const expired = await issue({ issuedAt: NOW - 7200, validUntil: NOW - 60 });
  const r = verify(expired);
  assert.equal(r.valid, false);
  assert.equal(r.reasonCode, "VC_EXPIRED");
  assert.match(r.reason!, /validUntil/);
  // 同一張在 validUntil 之前是有效的
  assert.equal(verify(expired, { now: (NOW - 120) * 1000 }).valid, true);
  ok("validUntil 已過 → VC_EXPIRED（到期前同一張有效）");
}

// 5) nonce 一次性：同一張可重複使用；同 nonce 不同內容 → 拒；舊 VC 被新 VC 取代後重放 → 拒
{
  const statePath = path.join(TMP, "n5.json");
  const r1 = verify(vc);
  assert.equal(checkNonce(r1, { statePath }).ok, true);
  assert.equal(checkNonce(r1, { statePath }).ok, true, "同一張 VC 在有效期內可用於多筆下單");

  const sameNonce = await issue({ nonce: vc.credentialSubject.nonce, caps: { ...caps, maxLeverage: 3 } });
  const r2 = verify(sameNonce);
  assert.equal(r2.valid, true, "簽章本身有效");
  const c2 = checkNonce(r2, { statePath });
  assert.equal(c2.ok, false);
  assert.equal(c2.reasonCode, "NONCE_REPLAYED");

  const older = await issue({ issuedAt: NOW - 100 });
  const newer = await issue({ issuedAt: NOW - 10 });
  const sp2 = path.join(TMP, "n5b.json");
  assert.equal(checkNonce(verify(older), { statePath: sp2 }).ok, true);
  assert.equal(checkNonce(verify(newer), { statePath: sp2 }).ok, true);
  const replay = checkNonce(verify(older), { statePath: sp2 });
  assert.equal(replay.ok, false);
  assert.equal(replay.reasonCode, "VC_SUPERSEDED");
  ok("nonce：同一張可重用；同 nonce 不同內容 → NONCE_REPLAYED；被新 VC 取代的舊 VC 重放 → VC_SUPERSEDED");

  // 重啟語意：狀態在檔案裡 → 「重啟」後（重新讀檔）仍拒絕
  const raw = JSON.parse(fs.readFileSync(sp2, "utf8"));
  assert.ok(Object.keys(raw.nonces).length >= 2);
  const again = checkNonce(verify(older), { statePath: sp2 });
  assert.equal(again.reasonCode, "VC_SUPERSEDED");
  // 過期紀錄會被清掉
  checkNonce(verify(newer), { statePath: sp2, now: (NOW + 31 * 86400) * 1000 });
  const left = Object.keys(JSON.parse(fs.readFileSync(sp2, "utf8")).nonces);
  assert.deepEqual(left, [newer.credentialSubject.nonce!.toLowerCase()], "validUntil 過後的紀錄（older）被清除，只剩本次寫入的");
  // 狀態檔壞掉 → fail-closed
  fs.writeFileSync(sp2, "{oops");
  assert.equal(checkNonce(verify(newer), { statePath: sp2 }).reasonCode, "NONCE_STORE_UNREADABLE");
  ok("nonce 狀態持久化於檔案（重啟後仍有效）；過期紀錄自動清除；檔案損毀 → NONCE_STORE_UNREADABLE");
}

// 6) 舊格式（v1）仍可驗證並附警告；淘汰期限後拒絕；沒有 nonce 檢查
{
  const legacy = await issue({ legacyV1: true });
  assert.equal(legacy.proof.eip712Domain, undefined);
  assert.equal(legacy.credentialSubject.nonce, undefined);
  const r = verify(legacy);
  assert.equal(r.valid, true, r.reason);
  assert.equal(r.version, 1);
  assert.ok(r.warnings?.[0]?.includes("LEGACY_VC_V1"));
  assert.ok(r.warnings?.[0]?.includes(LEGACY_VC_SUNSET_ISO));
  // expectedVerifyingContract 不適用於 v1（v1 domain 沒有這個欄位）
  assert.equal(verify(legacy, { expectedVerifyingContract: MGR }).valid, true);
  assert.equal(checkNonce(r, { statePath: path.join(TMP, "n6.json") }).reasonCode, "OK");
  const after = verify(legacy, { now: Date.parse(LEGACY_VC_SUNSET_ISO) + 1000 });
  assert.equal(after.valid, false);
  assert.equal(after.reasonCode, "LEGACY_VC_SUNSET");
  ok(`v1 舊格式：驗證通過＋LEGACY_VC_V1 警告；${LEGACY_VC_SUNSET_ISO} 之後 → LEGACY_VC_SUNSET`);
}

// 6b) v1 參與取代；接受過 v2 之後拒收 v1；未來 issuedAt 拒收；latest 在 keepUntil 後清理
{
  const sp = path.join(TMP, "n6b.json");
  const v1old = await issue({ legacyV1: true, issuedAt: NOW - 300 });
  const v1new = await issue({ legacyV1: true, issuedAt: NOW - 200 });
  assert.equal(checkNonce(verify(v1old), { statePath: sp }).reasonCode, "OK");
  assert.equal(checkNonce(verify(v1new), { statePath: sp }).reasonCode, "OK");
  assert.equal(checkNonce(verify(v1old), { statePath: sp }).reasonCode, "VC_SUPERSEDED", "新的 v1 取代舊的 v1");
  assert.equal(checkNonce(verify(v1new), { statePath: sp }).reasonCode, "OK", "最新那張可重複使用");

  const v2 = await issue({ issuedAt: NOW - 100 });
  assert.equal(checkNonce(verify(v2), { statePath: sp }).reasonCode, "OK", "v1 → v2 升級");
  assert.equal(checkNonce(verify(v1new), { statePath: sp }).reasonCode, "LEGACY_AFTER_V2");
  const v1later = await issue({ legacyV1: true, issuedAt: NOW - 50 });
  assert.equal(checkNonce(verify(v1later), { statePath: sp }).reasonCode, "LEGACY_AFTER_V2", "即使 v1 較新也拒收");
  // 其他 session 不受影響
  const other = await issue({ legacyV1: true, sessionId: 99 });
  assert.equal(checkNonce(verify(other), { statePath: sp }).reasonCode, "OK");

  const future = await issue({ issuedAt: NOW + 600 });
  assert.equal(verify(future).reasonCode, "VC_ISSUED_IN_FUTURE");
  const skew = await issue({ issuedAt: NOW + 200 });
  assert.equal(verify(skew).valid, true, "300 秒內的時鐘誤差可接受");

  // session 到期（keepUntil）之後，latest 紀錄被清掉
  checkNonce(verify(other), { statePath: sp, now: (caps.expiry + 10) * 1000 });
  const latest = JSON.parse(fs.readFileSync(sp, "utf8")).latest;
  assert.deepEqual(Object.keys(latest), [`${user.address.toLowerCase()}|99`], "過了 keepUntil 的 latest 被清掉，只剩本次寫入的");
  ok("v1 參與取代；接受過 v2 後拒收 v1（LEGACY_AFTER_V2）；issuedAt > now+300s 拒收；latest 在 keepUntil 後清理");
}

// 7) 降級攻擊：把 v2 標記拿掉冒充 v1 → 拒絕
{
  const d1 = structuredClone(vc);
  delete d1.proof.eip712Domain;
  assert.equal(verify(d1).reasonCode, "VC_VERSION_INCONSISTENT");
  delete d1.credentialSubject.nonce;
  delete d1.credentialSubject.validUntil;
  assert.equal(verify(d1).reasonCode, "VC_BAD_SIGNATURE", "v2 簽章不能當 v1 驗過");
  ok("拿掉 v2 標記冒充 v1 → VC_VERSION_INCONSISTENT / VC_BAD_SIGNATURE");
}

// 8) write.ts 整合：綁別顆 session manager 的 VC 在碰鏈之前被擋
// openPositionForSession 內部以真實時鐘驗證；此斷言不受時間影響，因為 verifyingContract 比對
// 在 issuedAt／validUntil／淘汰期限等時間檢查之前（identity.ts verifyAuthorizationVC）。
{
  const foreign = await issue({ verifyingContract: "0x" + "99".repeat(20) });
  const r = await openPositionForSession({ sessionId: 3, symbol: "sBTC", isLong: true, marginUsdc: 10, leverage: 2, authVc: foreign });
  assert.equal(r.ok, false);
  assert.equal(r.guardStage, "vc");
  assert.match(r.error!, /VC_WRONG_VERIFYING_CONTRACT/);
  ok("openPositionForSession：VC 的 verifyingContract ≠ SESSION_MANAGER_ADDRESS → 拒絕（未觸及鏈上）");
}

// 9) #212：nonce 狀態寫不進去 → NONCE_STORE_WRITE_FAILED（不再歸到 UNREADABLE）；開倉拒絕、平倉降級
{
  const { vcNonceDecision } = await import("@pepelab/shared");
  const sp = path.join(TMP, "n9.json");
  fs.mkdirSync(`${sp}.${process.pid}.tmp`); // 暫存檔路徑是目錄 → writeFileSync 必失敗
  const c = checkNonce(verify(vc), { statePath: sp });
  assert.equal(c.ok, false);
  assert.equal(c.reasonCode, "NONCE_STORE_WRITE_FAILED");
  assert.equal(fs.existsSync(sp), false, "沒有寫入任何狀態");
  assert.equal(vcNonceDecision(c, "open").kind, "reject");
  assert.deepEqual(vcNonceDecision(c, "close"), { kind: "degraded", code: "NONCE_STORE_WRITE_FAILED" });
  ok("nonce 狀態寫入失敗 → NONCE_STORE_WRITE_FAILED；開倉拒絕、平倉降級");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n✅ vc-v2.test.ts 全過（${n} 組）`);
