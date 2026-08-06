// ERC-8126 attestation 的竄改/重放測試（稽核 四·Medium）。
// 純密碼學，免鏈免資金：只用假的 provider 與本地錢包。
//   npx tsx examples/verification.test.ts
import assert from "node:assert";
import { ethers } from "ethers";
import {
  buildAgentVerification, verifyAgentVerification, riskTierOf, checkWV,
  type AgentVerification,
} from "@pepelab/shared";

/** 最小假 provider：五個檢查裡只有 ETV/SCV/WV 會用到它。 */
const fakeProvider = {
  getCode: async () => "0x", // agent 是 EOA；合約目標會被判為「無 code」，不影響本測試主題
  getTransactionCount: async () => 3,
} as unknown as ethers.Provider;

async function build(over: { verifierEphemeral?: boolean; ttlSec?: number } = {}) {
  const verifier = ethers.Wallet.createRandom();
  const agent = ethers.Wallet.createRandom();
  return {
    verifier,
    agent,
    av: await buildAgentVerification({
      did: agent.address,
      verifier,
      provider: fakeProvider,
      // 不存在的 host → WAV 三項全失敗，但那是「分數低」不是「驗證失敗」，
      // 正好也證明檢查失敗不會讓 attestation 變不可驗。
      apiBaseUrl: "http://127.0.0.1:1",
      etvTargets: [{ label: "USDC", address: "0x" + "1".repeat(40) }],
      scvTargets: [{ label: "Perp", address: "0x" + "2".repeat(40) }],
      holderSigner: agent,
      ...over,
    }),
  };
}

async function main() {
  const { av } = await build();

  // 1) 原始 attestation 可驗證。
  const base = verifyAgentVerification(av);
  assert.equal(base.valid, true, base.reason);
  console.log(`✓ 原始 attestation 可驗證（score=${av.overallRiskScore} tier=${av.riskTier}）`);

  // 2) 竄改 riskTier —— 這正是稽核實測「改 tier 為 low → valid:true」的那一刀。
  {
    const t = structuredClone(av) as AgentVerification;
    t.riskTier = "low";
    const r = verifyAgentVerification(t);
    // 若原本就是 low 就改成 critical，確保這條測試永遠有意義。
    if (av.riskTier === "low") {
      t.riskTier = "critical";
      assert.equal(verifyAgentVerification(t).valid, false);
    } else {
      assert.equal(r.valid, false, "竄改 riskTier 必須被抓到");
    }
    console.log("✓ 竄改 riskTier → 拒絕");
  }

  // 3) 竄改 evidence（以前完全不在 digest 內）。
  {
    const t = structuredClone(av) as AgentVerification;
    const wv = t.checks.find((c) => c.type === "WV")!;
    wv.evidence = { ...(wv.evidence ?? {}), txCount: 999_999 };
    assert.equal(verifyAgentVerification(t).valid, false, "竄改 evidence 必須被抓到");
    console.log("✓ 竄改 evidence → 拒絕");
  }

  // 4) 竄改 passed 旗標（以前也不在 digest 內）。
  {
    const t = structuredClone(av) as AgentVerification;
    const wav = t.checks.find((c) => c.type === "WAV")!;
    wav.passed = !wav.passed;
    assert.equal(verifyAgentVerification(t).valid, false, "竄改 passed 必須被抓到");
    console.log("✓ 竄改 passed → 拒絕");
  }

  // 5) 竄改 name（以前也不在 digest 內）。
  {
    const t = structuredClone(av) as AgentVerification;
    t.checks[0].name = "Totally Audited";
    assert.equal(verifyAgentVerification(t).valid, false);
    console.log("✓ 竄改 check name → 拒絕");
  }

  // 6) 竄改分數 → 與 checks 不符。
  {
    const t = structuredClone(av) as AgentVerification;
    t.overallRiskScore = 0;
    assert.equal(verifyAgentVerification(t).valid, false);
    console.log("✓ 竄改 overallRiskScore → 拒絕");
  }

  // 7) 過期 → 拒絕（以前沒有有效期，可無限重放）。
  {
    const short = await build({ ttlSec: 1 });
    const future = Date.now() + 5000;
    assert.equal(verifyAgentVerification(short.av, { nowMs: future }).valid, false, "過期必須拒絕");
    assert.equal(verifyAgentVerification(short.av).valid, true, "未過期時仍有效");
    console.log("✓ attestation 有效期生效（過期即拒）");
  }

  // 8) nonce 重放 → 第二次拒絕。
  {
    const seen = new Set<string>();
    assert.equal(verifyAgentVerification(av, { seenNonces: seen }).valid, true);
    assert.equal(verifyAgentVerification(av, { seenNonces: seen }).valid, false, "同一個 nonce 不可重放");
    console.log("✓ nonce 防重放生效");
  }

  // 9) 移除 expiresAt / nonce（舊格式）→ 一律拒絕。
  {
    const t = structuredClone(av) as any;
    delete t.expiresAt;
    assert.equal(verifyAgentVerification(t).valid, false);
    const t2 = structuredClone(av) as any;
    delete t2.nonce;
    assert.equal(verifyAgentVerification(t2).valid, false);
    console.log("✓ 缺 expiresAt / nonce 的舊格式 → 拒絕");
  }

  // 10) 臨時 verifier 必須被明確標記。
  {
    const eph = await build({ verifierEphemeral: true });
    assert.equal(eph.av.verifierEphemeral, true);
    assert.equal(verifyAgentVerification(eph.av).verifierEphemeral, true);
    assert.equal(av.verifierEphemeral, false);
    console.log("✓ 臨時 verifier 於輸出與驗證結果都明確標記");
  }

  // 11) WV：未出示持有證明不得與出示者同分（以前直接從分母移除）。
  {
    const w = ethers.Wallet.createRandom();
    const withProof = await checkWV(fakeProvider, w.address, { holderSigner: w });
    const without = await checkWV(fakeProvider, w.address);
    assert.ok(
      without.score > withProof.score,
      `未出示持有證明的分數(${without.score})必須高於出示者(${withProof.score})`,
    );
    console.log(`✓ WV 持有證明計入分母（有證明 ${withProof.score} < 無證明 ${without.score}）`);
  }

  // 12) riskTierOf 的邊界（EIP-8126 分級）。
  assert.equal(riskTierOf(0), "low");
  assert.equal(riskTierOf(20), "low");
  assert.equal(riskTierOf(21), "moderate");
  assert.equal(riskTierOf(41), "elevated");
  assert.equal(riskTierOf(61), "high");
  assert.equal(riskTierOf(81), "critical");

  console.log("\n✅ verification.test.ts 全過（ERC-8126 竄改/重放/降級標記）");
}

main().catch((e) => { console.error("\n❌ verification 測試失敗：", e); process.exit(1); });
