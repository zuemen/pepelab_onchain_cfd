// 稽核 A-3 / A-4 的回歸測試：**沒有 VC 就不准下單，也不准平倉**。
//
// A-3：`openPositionForSession` 的 VC 閘門以前是「有帶才驗」，而三個呼叫端都沒帶
//      → 等於完全沒有授權層。
// A-4：`closePositionForSession` 連「有帶才驗」都沒有 —— 沒有 VC、沒有風險閘、
//      沒有任何檢查，可平掉使用者任意部位、實現虧損。
//
// 這支測試不送任何交易：VC 閘門在建立交易之前就回傳結構化錯誤，因此完全離線可跑。
//   npx tsx examples/write-gate.test.ts
import assert from "node:assert";
import { ethers } from "ethers";

// env 必須在 import @pepelab/shared 之前設好（addresses/provider 於載入時讀取）。
process.env.AGENT_PRIVATE_KEY = ethers.Wallet.createRandom().privateKey;
process.env.SESSION_MANAGER_ADDRESS = "0x" + "1".repeat(40);
// 指向一個必定連不上的位址：任何「不小心送出去」的呼叫都會立刻失敗而不是真的上鏈。
process.env.BASE_SEPOLIA_RPC_URL = "http://127.0.0.1:1";
delete process.env.AGENT_ALLOW_UNSIGNED_TRADES;
delete process.env.RISK_GATE_ENABLED;

const {
  openPositionForSession,
  closePositionForSession,
  issueAuthorizationVC,
} = await import("@pepelab/shared");

const VC_REFUSAL = "授權憑證(VC)";

async function main() {
  // 1) 開倉缺 VC → 拒絕（且沒有任何鏈上互動）。
  {
    const r = await openPositionForSession({
      sessionId: 0, symbol: "sBTC", isLong: true, marginUsdc: 50, leverage: 3,
    });
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes(VC_REFUSAL), `錯誤訊息應說明缺 VC，實得：${r.error}`);
    assert.ok(r.error?.includes("拒絕下單"), r.error);
    console.log("✓ 開倉缺 VC → 拒絕：", r.error?.slice(0, 48) + "…");
  }

  // 2) 平倉缺 VC → 拒絕（A-4：以前完全沒有這道閘門）。
  {
    const r = await closePositionForSession({ sessionId: 0, positionId: 1 });
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes(VC_REFUSAL), `錯誤訊息應說明缺 VC，實得：${r.error}`);
    assert.ok(r.error?.includes("拒絕平倉"), r.error);
    console.log("✓ 平倉缺 VC → 拒絕：", r.error?.slice(0, 48) + "…");
  }

  // 3) 明確 opt-out 才放行閘門（放行後會因為連不上 RPC 而失敗——重點是**不是**因為 VC）。
  {
    const r = await openPositionForSession({
      sessionId: 0, symbol: "sBTC", isLong: true, marginUsdc: 50, leverage: 3,
      allowUnsignedForTesting: true,
    });
    assert.equal(r.ok, false, "連不上 RPC，本來就該失敗");
    assert.ok(!r.error?.includes(VC_REFUSAL), `opt-out 後不該再是 VC 錯誤，實得：${r.error}`);
    console.log("✓ allowUnsignedForTesting 明確 opt-out 才會通過 VC 閘門");
  }

  // 4) env opt-out 同理（僅測試環境使用）。
  {
    process.env.AGENT_ALLOW_UNSIGNED_TRADES = "true";
    const r = await closePositionForSession({ sessionId: 0, positionId: 1 });
    assert.ok(!r.error?.includes(VC_REFUSAL), r.error);
    process.env.AGENT_ALLOW_UNSIGNED_TRADES = "false";
    const r2 = await closePositionForSession({ sessionId: 0, positionId: 1 });
    assert.ok(r2.error?.includes(VC_REFUSAL), "設成 false 必須恢復閘門");
    delete process.env.AGENT_ALLOW_UNSIGNED_TRADES;
    console.log("✓ AGENT_ALLOW_UNSIGNED_TRADES 只有明確 true 才關閘門");
  }

  // 5) 帶了一張「不屬於本 agent」的 VC → 在鏈上比對之前就被本地驗證擋下。
  {
    const user = ethers.Wallet.createRandom();
    const otherAgent = ethers.Wallet.createRandom();
    const vc = await issueAuthorizationVC({
      issuer: user,
      agentAddress: otherAgent.address, // 不是本 process 的 session key
      sessionId: 0,
      caps: { maxMarginPerTrade: "50", totalBudget: "1000", maxLeverage: 5, expiry: Math.floor(Date.now() / 1000) + 86400 },
    });
    const r = await openPositionForSession({
      sessionId: 0, symbol: "sBTC", isLong: true, marginUsdc: 50, leverage: 3, authVc: vc,
    });
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes("非本 session key"), `實得：${r.error}`);
    console.log("✓ VC 授權的 agent ≠ 本 session key → 拒絕（未觸及鏈上）");
  }

  // 6) 竄改過的 VC → 驗簽失敗。
  {
    const user = ethers.Wallet.createRandom();
    const me = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY!);
    const vc = await issueAuthorizationVC({
      issuer: user, agentAddress: me.address, sessionId: 0,
      caps: { maxMarginPerTrade: "50", totalBudget: "1000", maxLeverage: 5, expiry: Math.floor(Date.now() / 1000) + 86400 },
    });
    const tampered = structuredClone(vc);
    tampered.credentialSubject.authorization.maxMarginPerTrade = "999999";
    const r = await openPositionForSession({
      sessionId: 0, symbol: "sBTC", isLong: true, marginUsdc: 50, leverage: 3, authVc: tampered,
    });
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes("VC 驗證未過"), `實得：${r.error}`);
    console.log("✓ 竄改 VC 上限 → 驗簽失敗，拒絕下單");
  }

  console.log("\n✅ write-gate.test.ts 全過（A-3 開倉 / A-4 平倉的授權閘門）");
}

main().catch((e) => { console.error("\n❌ write-gate 測試失敗：", e); process.exit(1); });
