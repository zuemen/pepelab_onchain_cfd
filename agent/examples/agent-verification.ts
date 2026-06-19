// ERC-8126 verification-layer demo + minimal test.
//
// Run:  cd agent && npx tsx examples/agent-verification.ts
//
// Builds a full ERC-8126-shaped agent verification attestation on Base Sepolia:
//   ① run the five checks (ETV / MCV / SCV / WAV / WV) → print each result
//   ② roll up the unified 0–100 risk score + tier, print the verifier-signed
//      attestation
//   ③ positive path: verifier signature + proof digests check out → valid
//   ④ negative path A: tamper a check score → digest/score mismatch → refused
//   ⑤ negative path B: tamper the signed score only → signature broken → refused
//
// Uses a public Base Sepolia RPC + the live signal-api by default (override with
// BASE_SEPOLIA_RPC_URL / SIGNAL_API_PUBLIC_URL). The negative paths are pure
// crypto/digest math and never need the network.
import assert from "node:assert";
import { ethers } from "ethers";
import {
  ADDRESSES,
  agentDid,
  buildAgentVerification,
  verifyAgentVerification,
  type ContractTarget,
} from "@pepelab/shared";

function banner(t: string) {
  console.log("\n" + "─".repeat(64) + `\n${t}\n` + "─".repeat(64));
}

const RPC = process.env.BASE_SEPOLIA_RPC_URL?.trim() || "https://sepolia.base.org";
const API =
  process.env.SIGNAL_API_PUBLIC_URL?.trim() ||
  "https://agent-git-master-zuemens-projects.vercel.app";

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, {
    chainId: 84532,
    name: "base-sepolia",
  });

  // verifier (trust authority) + agent (subject) — random for a self-contained demo.
  const verifier = ethers.Wallet.createRandom();
  const agent = ethers.Wallet.createRandom().connect(provider);

  const etvTargets: ContractTarget[] = [
    { label: "USDC (settlement)", address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
    { label: "PerpetualExchange", address: ADDRESSES.PerpetualExchange },
  ];
  const scvTargets: ContractTarget[] = [
    { label: "PerpetualExchange", address: ADDRESSES.PerpetualExchange },
    { label: "FeeRouter", address: ADDRESSES.FeeRouter },
  ];

  banner("① 對 agent 跑 ERC-8126 五項驗證");
  console.log(`agent    DID : ${agentDid(agent.address)}`);
  console.log(`verifier DID : ${agentDid(verifier.address)}`);
  console.log(`RPC          : ${RPC}`);
  console.log(`signal-api   : ${API}\n`);

  const av = await buildAgentVerification({
    did: agent.address,
    verifier,
    provider,
    apiBaseUrl: API,
    etvTargets,
    scvTargets,
    explorerApiKey:
      process.env.ETHERSCAN_API_KEY?.trim() || process.env.BASESCAN_API_KEY?.trim(),
    holderSigner: agent, // agent 出示持有證明（WV）
  });

  for (const c of av.checks) {
    const tag = !c.applicable ? "N/A " : c.passed ? "PASS" : "WARN";
    console.log(`  [${c.type}] ${tag}  score=${String(c.score).padStart(3)}  ${c.details}`);
  }

  banner("② 統一風險分數 + 簽名 attestation");
  console.log(`overallRiskScore = ${av.overallRiskScore}  → ${av.riskTier} (${av.assessment})`);
  console.log(`summaryProofId   = ${av.proofIds.summaryProofId}`);
  console.log(JSON.stringify(av, null, 2));

  banner("③ verifier 驗證 attestation（正常路徑）");
  const good = verifyAgentVerification(av);
  console.log(good);
  assert.equal(good.valid, true, "untampered attestation should verify");
  assert.equal(good.verifier!.toLowerCase(), verifier.address.toLowerCase());
  assert.equal(good.subject, agentDid(agent.address));
  console.log("✓ 驗證通過 → 風險分數可信");

  banner("④ 竄改某項檢查（WAV score → 0 偽裝安全）→ 應被拒");
  const tamperedCheck = structuredClone(av);
  const wav = tamperedCheck.checks.find((c) => c.type === "WAV")!;
  wav.score = 0;
  wav.details = "(forged) all good";
  const bad1 = verifyAgentVerification(tamperedCheck);
  console.log(bad1);
  assert.equal(bad1.valid, false, "tampered check must fail");
  console.log("✓ 竄改檢查被擋下：", bad1.reason);

  banner("⑤ 只竄改已簽欄位（overallRiskScore）→ 簽章/摘要不符 → 應被拒");
  const tamperedScore = structuredClone(av);
  tamperedScore.overallRiskScore = 1; // 偽裝低風險
  const bad2 = verifyAgentVerification(tamperedScore);
  console.log(bad2);
  assert.equal(bad2.valid, false, "tampered score must fail");
  console.log("✓ 竄改分數被擋下：", bad2.reason);

  banner("結論");
  console.log(
    "可驗證的 agent 信任分數：五項檢查的摘要被 verifier EIP-712 簽章綁定；" +
      "任何竄改（檢查內容或分數）都會破壞摘要/簽章 → 對手方拒絕信任。",
  );
  console.log("\n✅ ALL ASSERTIONS PASSED");
}

main().catch((err) => {
  console.error("\n❌ verification demo/test failed:", err);
  process.exit(1);
});
