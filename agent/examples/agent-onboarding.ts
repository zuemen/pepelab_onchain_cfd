// Agent onboarding consistency test — proves a VC signed exactly the way the
// website signs it (browser wallet → EIP-712) verifies on the agent (verifier)
// side. This is the contract that makes web onboarding work end-to-end.
//
// Run:  cd agent && npx tsx examples/agent-onboarding.ts
//
// The frontend (SessionsPage) signs with:
//     buildAuthTypedValue(...)  →  signer.signTypedData(AUTH_DOMAIN, AUTH_TYPES, value)  →  assembleAuthorizationVC(...)
// all from the SHARED module frontend/src/contracts/agentAuth.ts. Here we make
// the identical calls with a throwaway wallet standing in for MetaMask, then run
// the result through the agent's existing verifyAuthorizationVC.
//
//   ① issuer (user) signs in "wallet"     → VC
//   ② agent verifier validates            → ✓ valid
//   ③ tamper caps                         → ✗ signature broken
//   ④ swap holder agent                   → ✗ wrong agent
//
// No chain / no funds — pure signature math, same as the browser flow.
import assert from "node:assert";
import { ethers } from "ethers";
import {
  AUTH_DOMAIN,
  AUTH_TYPES,
  buildAuthTypedValue,
  assembleAuthorizationVC,
  verifyAuthorizationVC,
  agentDid,
  authDid,
  type AuthorizationCaps,
} from "@pepelab/shared";

function banner(t: string) {
  console.log("\n" + "─".repeat(64) + `\n${t}\n` + "─".repeat(64));
}

/**
 * Stand-in for the browser wallet: ethers Wallet exposes the exact same
 * signTypedData(domain, types, value) interface as the frontend's connected
 * signer (window.ethereum / wagmi walletClient), so this faithfully mirrors the
 * MetaMask signing the website performs — the private key would never leave the
 * wallet in production.
 */
async function signLikeFrontend(params: {
  userWallet: ethers.Wallet | ethers.HDNodeWallet;
  agentAddress: string;
  sessionId: number;
  caps: AuthorizationCaps;
}) {
  const issuerAddress = await params.userWallet.getAddress();
  const issuedAt = Math.floor(Date.now() / 1000);
  // ── exactly what SessionsPage does, from the shared agentAuth module ──
  const value = buildAuthTypedValue({
    issuer: issuerAddress,
    agent: params.agentAddress,
    sessionId: params.sessionId,
    caps: params.caps,
    issuedAt,
  });
  const signature = await params.userWallet.signTypedData(AUTH_DOMAIN, AUTH_TYPES, value);
  return assembleAuthorizationVC({
    issuerAddress,
    agentAddress: params.agentAddress,
    sessionId: params.sessionId,
    caps: params.caps,
    issuedAt,
    signature,
  });
}

async function main() {
  const user = ethers.Wallet.createRandom();   // issuer (signs in MetaMask)
  const agent = ethers.Wallet.createRandom();  // holder (the session key)
  const other = ethers.Wallet.createRandom();

  const sessionId = 7;
  const caps: AuthorizationCaps = {
    maxMarginPerTrade: "1000",
    totalBudget: "5000",
    maxLeverage: 5,
    expiry: Math.floor(Date.now() / 1000) + 24 * 3600,
  };

  banner("① 前端式簽發：使用者用「錢包」簽 EIP-712 → VC");
  console.log(`user  DID : ${authDid(user.address)}`);
  console.log(`agent DID : ${authDid(agent.address)}`);
  const vc = await signLikeFrontend({ userWallet: user, agentAddress: agent.address, sessionId, caps });
  console.log(JSON.stringify(vc, null, 2));

  banner("② agent 端 verifyAuthorizationVC（與前端共用同一組 EIP-712 schema）");
  const good = verifyAuthorizationVC(vc);
  console.log(good);
  assert.equal(good.valid, true, "frontend-signed VC must verify on the agent side");
  assert.equal(good.issuer!.toLowerCase(), user.address.toLowerCase());
  assert.equal(good.agent!.toLowerCase(), agent.address.toLowerCase());
  assert.equal(good.sessionId, sessionId);
  // 前端 did.ts 與 agent agentDid 也須一致（同鏈同格式）。
  assert.equal(authDid(user.address).toLowerCase(), agentDid(user.address).toLowerCase());
  console.log("✓ 前端簽出的 VC 被 agent 驗過 → 一致性成立");

  banner("③ 竄改授權上限（maxLeverage 5 → 50）→ 應被拒");
  const tampered = structuredClone(vc);
  tampered.credentialSubject.authorization.maxLeverage = 50;
  const bad1 = verifyAuthorizationVC(tampered);
  console.log(bad1);
  assert.equal(bad1.valid, false, "tampered caps must fail");
  console.log("✓ 竄改被擋下：", bad1.reason);

  banner("④ 換掉 holder agent → 應被拒");
  const swapped = structuredClone(vc);
  swapped.credentialSubject.id = authDid(other.address);
  const bad2 = verifyAuthorizationVC(swapped);
  console.log(bad2);
  assert.equal(bad2.valid, false, "swapped agent must fail");
  console.log("✓ 換 agent 被擋下：", bad2.reason);

  banner("結論");
  console.log(
    "網站 onboarding 可行：使用者在瀏覽器錢包簽發的授權 VC，與 agent 端 verifyAuthorizationVC " +
      "共用同一組 EIP-712 schema（frontend/src/contracts/agentAuth.ts）→ 前後端一致、可驗。",
  );
  console.log("\n✅ ALL ASSERTIONS PASSED");
}

main().catch((err) => {
  console.error("\n❌ onboarding consistency test failed:", err);
  process.exit(1);
});
