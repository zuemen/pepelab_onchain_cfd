// SDK：委託授權 VC v3 與 x402 KYA presentation（viem 簽 ↔ shared(ethers) 驗）。完全離線。
//   cd agent && npx tsx sdk/test/delegation.test.ts
import assert from "node:assert";
import { getAddress, keccak256, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { createDelegationCredential, issueDelegationCredential, kyaFetch, presentForX402, verifyDelegationCredential } from "../src/index.ts";
import { credentialHashOf, paymentAuthorizationOf, verifyX402Presentation } from "../../shared/src/delegation.ts";

let n = 0;
const ok = (m: string) => console.log(`✓ ${++n}. ${m}`);

const MGR = getAddress("0x" + "5e".repeat(20));
const user = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(generatePrivateKey());
const NOW = Math.floor(Date.now() / 1000);
const session = {
  maxMarginPerTrade: 10n ** 20n,
  totalMarginBudget: 10n ** 21n,
  maxLeverage: 3,
  expiry: NOW + 86_400,
  allowedAssets: [keccak256(toHex("sBTC"))],
};
const params = { issuer: user.address, agent: agent.address, sessionManager: MGR, sessionId: 2, session, chainId: 84532 };

// 1) createDelegationCredential → viem 簽 → finalize → shared 驗證
{
  const draft = createDelegationCredential(params);
  assert.equal(draft.typedData.primaryType, "AgentDelegationCredential");
  assert.deepEqual(draft.typedData.domain, { name: "PepeLabAgentDelegation", version: "3", chainId: 84532, verifyingContract: MGR });
  const sig = await user.signTypedData(draft.typedData as never);
  const vc = draft.finalize(sig);
  assert.equal(credentialHashOf(vc), draft.credentialHash);
  const r = verifyDelegationCredential(vc, { expectedSessionManager: MGR, acceptedChainIds: [84532] });
  assert.equal(r.valid, true, r.reason);
  assert.equal(r.issuer, user.address);
  assert.equal(r.agent, agent.address);
  assert.throws(() => draft.finalize(("0x" + "11".repeat(65)) as Hex), /簽章驗證失敗/);
  ok("SDK 建 typed data → viem 簽 → finalize；shared(ethers) 驗證通過、credentialHash 一致；錯簽章 finalize 丟錯");
}

// 2) issueDelegationCredential（一次完成）＋ presentForX402（viem 簽）→ shared 驗證 presentation
const { credential } = await issueDelegationCredential({ ...params, signTypedData: (td) => user.signTypedData(td as never) });
const payHeader = (from: string) =>
  Buffer.from(
    JSON.stringify({
      x402Version: 1,
      payload: { signature: "0x", authorization: { from, to: MGR, value: "10000", validAfter: "0", validBefore: String(NOW + 60), nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) } },
    }),
  ).toString("base64");
{
  const ph = payHeader(agent.address);
  const { header } = await presentForX402({
    credential, holder: agent.address, signTypedData: (td) => agent.signTypedData(td as never),
    method: "GET", url: "https://api.example/signals/0x1", paymentHeader: ph,
  });
  const r = verifyX402Presentation(header, { method: "GET", path: "/signals/0x1", payment: paymentAuthorizationOf(ph)! });
  assert.equal(r.ok, true, r.reason);
  ok("SDK presentForX402（viem 簽）→ shared verifyX402Presentation 通過");
}

// 3) kyaFetch（viem 簽）
{
  let seen: string | null = null;
  const f = kyaFetch({ credential, holder: agent.address, signTypedData: (td) => agent.signTypedData(td as never), allowedOrigins: ["http://127.0.0.1"] }, (async (_i: unknown, init?: RequestInit) => {
    seen = new Headers(init?.headers).get("X-Agent-Presentation");
    return new Response("{}");
  }) as typeof fetch);
  await f("http://127.0.0.1/signals/0x1", { headers: { "X-PAYMENT": payHeader(agent.address) } });
  assert.ok(seen);
  ok("SDK kyaFetch：付款請求自動附 X-Agent-Presentation");
}

console.log(`\n✅ sdk/test/delegation.test.ts 全過（${n} 組）`);
