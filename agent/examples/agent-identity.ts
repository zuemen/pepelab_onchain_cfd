// Track 3 demo + minimal unit test — Agent identity via W3C VC / SSI (did:pkh).
//
// Run:  cd agent && npx tsx examples/agent-identity.ts
//
// Shows the full SSI triangle and the positive/negative contrast that makes it
// convincing:
//   ① issuer (user) signs an authorization VC for the agent (holder)
//   ② verifier validates the VC  → ✓ trade allowed
//   ③ tamper the caps            → ✗ signature broken, refused
//   ④ swap the agent (holder)    → ✗ wrong agent, refused
//
// No chain / no funds needed — pure signature math with the existing ethers stack.
import assert from "node:assert";
import { ethers } from "ethers";
import {
  agentDid,
  issueAuthorizationVC,
  verifyAuthorizationVC,
  type AuthorizationCaps,
} from "@pepelab/shared";

function banner(t: string) {
  console.log("\n" + "─".repeat(64) + `\n${t}\n` + "─".repeat(64));
}

async function main() {
  // user (issuer) + agent (holder) wallets — random for a self-contained demo.
  const user = ethers.Wallet.createRandom();
  const agent = ethers.Wallet.createRandom();
  const other = ethers.Wallet.createRandom();

  const sessionId = 7;
  const caps: AuthorizationCaps = {
    maxMarginPerTrade: "1000",
    totalBudget: "5000",
    maxLeverage: 5,
    expiry: Math.floor(Date.now() / 1000) + 24 * 3600,
  };

  banner("① 使用者(issuer)為 agent(holder) 簽發授權 VC");
  console.log(`user  DID : ${agentDid(user.address)}`);
  console.log(`agent DID : ${agentDid(agent.address)}`);
  const vc = await issueAuthorizationVC({
    issuer: user,
    agentAddress: agent.address,
    sessionId,
    caps,
  });
  console.log(JSON.stringify(vc, null, 2));

  banner("② verifier 驗證 VC（正常路徑）");
  const good = verifyAuthorizationVC(vc);
  console.log(good);
  assert.equal(good.valid, true, "valid VC should verify");
  assert.equal(good.issuer!.toLowerCase(), user.address.toLowerCase());
  assert.equal(good.agent!.toLowerCase(), agent.address.toLowerCase());
  assert.equal(good.sessionId, sessionId);
  console.log("✓ 驗證通過 → 允許下單");

  banner("③ 竄改授權上限（maxLeverage 5 → 50）→ 應被拒");
  const tampered = structuredClone(vc);
  tampered.credentialSubject.authorization.maxLeverage = 50;
  const bad1 = verifyAuthorizationVC(tampered);
  console.log(bad1);
  assert.equal(bad1.valid, false, "tampered caps must fail");
  console.log("✓ 竄改被擋下：", bad1.reason);

  banner("④ 換掉 agent(holder) 位址 → 應被拒");
  const swapped = structuredClone(vc);
  swapped.credentialSubject.id = agentDid(other.address);
  const bad2 = verifyAuthorizationVC(swapped);
  console.log(bad2);
  assert.equal(bad2.valid, false, "swapped agent must fail");
  console.log("✓ 換 agent 被擋下：", bad2.reason);

  banner("結論");
  console.log("可驗證的 agent 自主交易：只有持使用者簽發、未經竄改的 VC，agent 才能在 session 限額內下單。");
  console.log("\n✅ ALL ASSERTIONS PASSED");
}

main().catch((err) => {
  console.error("\n❌ identity demo/test failed:", err);
  process.exit(1);
});
