// ERC-8126 verification layer — "is this agent trustworthy?" alongside x402's
// "can this agent pay?". Where identity.ts (ERC-8004-style did:pkh + VC) answers
// *who* an agent is, this module produces a signed, ERC-8126-shaped attestation
// that scores the agent's verifiability across five dimensions and rolls them up
// into a single 0–100 risk score (like an SSL padlock for an autonomous agent).
//
// Faithful subset of EIP-8126 — explicit simplifications (see docs/AGENT_ECONOMY_STANDARDS.md):
//   • No zero-knowledge PDV proofs. `proofIds` are keccak256 digests of each
//     check result (not ZK proofs); `summaryProofId` is the digest of all five.
//   • Single verifier (this process) rather than a verifier network/registry.
//   • Agent is identified by its did:pkh (ERC-8004 style) rather than an
//     ERC-721 `agentId` from an on-chain Identity Registry.
//   • MCV (media) is N/A for a trading agent → marked not-applicable, excluded
//     from the mean.
//
// Risk convention (per EIP-8126): LOWER score = safer. Each check returns 0
// (fully verified) … 100 (failed/severe); the overall score is the mean of the
// applicable checks. Bands: 0–20 low / 21–40 moderate / 41–60 elevated /
// 61–80 high / 81–100 critical.
import { ethers } from "ethers";
import { AGENT_CHAIN_ID } from "./addresses.ts";
import { agentDid, parseDidPkh } from "./identity.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** EIP-8126 verification type codes. */
export type VerificationType = "ETV" | "MCV" | "SCV" | "WAV" | "WV";

/** EIP-8126 unified risk tiers (0–100, lower = safer). */
export type RiskTier = "low" | "moderate" | "elevated" | "high" | "critical";

/** Result of one of the five EIP-8126 checks. */
export interface VerificationCheck {
  /** EIP-8126 type code. */
  type: VerificationType;
  /** Human-readable name (matches EIP-8126 wording). */
  name: string;
  /** false → N/A (e.g. MCV for a non-media agent); excluded from the mean. */
  applicable: boolean;
  /** Convenience flag: score ≤ 20 (low-risk band). */
  passed: boolean;
  /** 0 (fully verified/safe) … 100 (failed/severe). */
  score: number;
  /** What was checked and the outcome. */
  details: string;
  /** Raw evidence for auditing (addresses, HTTP statuses, tx counts…). */
  evidence?: Record<string, unknown>;
}

export interface AgentVerificationProofIds {
  etvProofId: string;
  mcvProofId: string;
  scvProofId: string;
  wavProofId: string;
  wvProofId: string;
  /** Combined digest of all five (stands in for the EIP-8126 ZK PDV proof). */
  summaryProofId: string;
}

/** ERC-8126-shaped agent verification attestation, signed by the verifier. */
export interface AgentVerification {
  "@context": string[];
  type: string[];
  /** Agent did:pkh (the verification subject). */
  subject: string;
  /** EIP-8126 `agentId` analogue — we use the did:pkh (no ERC-721 registry). */
  agentId: string;
  /** Mean of applicable check scores, 0–100 (lower = safer). */
  overallRiskScore: number;
  /** Band for `overallRiskScore`. */
  riskTier: RiskTier;
  /** Per-EIP-8126-band guidance string. */
  assessment: string;
  /** The five checks (ETV / MCV / SCV / WAV / WV). */
  checks: VerificationCheck[];
  proofIds: AgentVerificationProofIds;
  /** Verifier did:pkh (recovers from `proof.proofValue`). */
  verifier: string;
  issuedAt: string;
  proof: {
    type: "EthereumEip712Signature2021";
    created: string;
    proofPurpose: "assertionMethod";
    verificationMethod: string;
    proofValue: string;
  };
}

// ── Risk scoring ─────────────────────────────────────────────────────────────

const TIER_ASSESSMENT: Record<RiskTier, string> = {
  low: "Minimal concerns identified",
  moderate: "Some concerns, review recommended",
  elevated: "Notable concerns, caution advised",
  high: "Significant concerns detected",
  critical: "Severe concerns, avoid interaction",
};

/** Map a 0–100 risk score to its EIP-8126 band. */
export function riskTierOf(score: number): RiskTier {
  if (score <= 20) return "low";
  if (score <= 40) return "moderate";
  if (score <= 60) return "elevated";
  if (score <= 80) return "high";
  return "critical";
}

/**
 * Mean of the applicable checks → overall risk score + tier (EIP-8126 §"overall
 * score is the mean of all applicable verification scores"). N/A checks (MCV)
 * are excluded. No applicable checks → critical (cannot assess).
 */
export function computeRiskScore(checks: VerificationCheck[]): {
  overallRiskScore: number;
  riskTier: RiskTier;
  assessment: string;
} {
  const applicable = checks.filter((c) => c.applicable);
  const overallRiskScore = applicable.length
    ? Math.round(applicable.reduce((s, c) => s + c.score, 0) / applicable.length)
    : 100;
  const riskTier = riskTierOf(overallRiskScore);
  return { overallRiskScore, riskTier, assessment: TIER_ASSESSMENT[riskTier] };
}

// ── Proof identifiers (keccak digests, NOT ZK proofs — see header) ────────────

/** Canonical, key-ordered serialization of a check → its proofId is the digest. */
function checkDigest(c: VerificationCheck): string {
  const canonical = JSON.stringify({
    type: c.type,
    applicable: c.applicable,
    score: c.score,
    details: c.details,
  });
  return ethers.id(canonical); // keccak256(utf8) → bytes32
}

function byType(checks: VerificationCheck[], t: VerificationType): VerificationCheck | undefined {
  return checks.find((c) => c.type === t);
}

function buildProofIds(checks: VerificationCheck[]): AgentVerificationProofIds {
  const idOf = (t: VerificationType) => {
    const c = byType(checks, t);
    return c ? checkDigest(c) : ZERO_BYTES32;
  };
  const etvProofId = idOf("ETV");
  const mcvProofId = idOf("MCV");
  const scvProofId = idOf("SCV");
  const wavProofId = idOf("WAV");
  const wvProofId = idOf("WV");
  const summaryProofId = ethers.solidityPackedKeccak256(
    ["bytes32", "bytes32", "bytes32", "bytes32", "bytes32"],
    [etvProofId, mcvProofId, scvProofId, wavProofId, wvProofId],
  );
  return { etvProofId, mcvProofId, scvProofId, wavProofId, wvProofId, summaryProofId };
}

// ── Verifier signature (EIP-712, same ethers stack as identity.ts) ────────────

const VERIFIER_DOMAIN = {
  name: "PepeLabAgentVerification",
  version: "1",
  chainId: AGENT_CHAIN_ID,
};

const VERIFIER_TYPES: Record<string, ethers.TypedDataField[]> = {
  AgentVerificationAttestation: [
    { name: "subject", type: "string" },
    { name: "overallRiskScore", type: "uint256" },
    { name: "summaryProofId", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
  ],
};

function verifierValue(p: {
  subject: string;
  overallRiskScore: number;
  summaryProofId: string;
  issuedAt: number;
}) {
  return {
    subject: p.subject,
    overallRiskScore: BigInt(p.overallRiskScore),
    summaryProofId: p.summaryProofId,
    issuedAt: BigInt(p.issuedAt),
  };
}

// ── The five EIP-8126 checks ──────────────────────────────────────────────────

/** A contract target to verify (label is for human-readable evidence). */
export interface ContractTarget {
  label: string;
  address: string;
}

/**
 * ETV — Ethereum Token Verification: the agent's associated contracts (settlement
 * token + protocol core) actually exist on-chain (non-empty `eth_getCode`).
 */
export async function checkETV(
  provider: ethers.Provider,
  targets: ContractTarget[],
): Promise<VerificationCheck> {
  const evidence: Record<string, unknown> = {};
  let missing = 0;
  const live = targets.filter((t) => t.address && t.address !== ZERO);
  for (const t of live) {
    try {
      const code = await provider.getCode(t.address);
      const hasCode = code && code !== "0x";
      evidence[t.label] = { address: t.address, hasCode: !!hasCode };
      if (!hasCode) missing += 1;
    } catch (err) {
      evidence[t.label] = { address: t.address, error: (err as Error).message };
      missing += 1;
    }
  }
  const total = live.length || 1;
  const score = Math.round((missing / total) * 100);
  return {
    type: "ETV",
    name: "Ethereum Token Verification",
    applicable: live.length > 0,
    passed: score <= 20,
    score,
    details:
      live.length === 0
        ? "no on-chain contracts supplied"
        : missing === 0
          ? `all ${live.length} associated contracts present on-chain`
          : `${missing}/${live.length} associated contracts have no code on-chain`,
    evidence,
  };
}

/**
 * SCV — Solidity Code Verification: core contracts have verified source on the
 * block explorer (Etherscan V2 multichain API) AND non-empty bytecode. Without
 * an API key we can only confirm bytecode → reported honestly as a partial pass.
 */
export async function checkSCV(
  provider: ethers.Provider,
  targets: ContractTarget[],
  opts: { apiKey?: string; chainId?: number } = {},
): Promise<VerificationCheck> {
  const chainId = opts.chainId ?? AGENT_CHAIN_ID;
  const apiKey = opts.apiKey?.trim();
  const evidence: Record<string, unknown> = {};
  const live = targets.filter((t) => t.address && t.address !== ZERO);
  if (live.length === 0) {
    return {
      type: "SCV",
      name: "Solidity Code Verification",
      applicable: false,
      passed: false,
      score: 0,
      details: "no core contracts supplied",
      evidence,
    };
  }

  let scoreSum = 0;
  for (const t of live) {
    let codePresent = false;
    try {
      const code = await provider.getCode(t.address);
      codePresent = !!code && code !== "0x";
    } catch {
      codePresent = false;
    }

    if (!codePresent) {
      evidence[t.label] = { address: t.address, codePresent, sourceVerified: false };
      scoreSum += 100; // no bytecode → severe
      continue;
    }

    if (!apiKey) {
      // Can't confirm source verification → bytecode-only partial (moderate band).
      evidence[t.label] = {
        address: t.address,
        codePresent: true,
        sourceVerified: "unknown (no explorer API key)",
      };
      scoreSum += 30;
      continue;
    }

    try {
      const url =
        `https://api.etherscan.io/v2/api?chainid=${chainId}` +
        `&module=contract&action=getsourcecode&address=${t.address}&apikey=${apiKey}`;
      const res = await fetch(url);
      const json = (await res.json()) as {
        status?: string;
        result?: Array<{ SourceCode?: string; ContractName?: string }>;
      };
      const entry = json.result?.[0];
      const sourceVerified = !!entry?.SourceCode && entry.SourceCode.length > 0;
      evidence[t.label] = {
        address: t.address,
        codePresent: true,
        sourceVerified,
        contractName: entry?.ContractName || undefined,
      };
      scoreSum += sourceVerified ? 0 : 60; // code present but source unverified → elevated
    } catch (err) {
      evidence[t.label] = {
        address: t.address,
        codePresent: true,
        sourceVerified: "error",
        error: (err as Error).message,
      };
      scoreSum += 30;
    }
  }

  const score = Math.round(scoreSum / live.length);
  return {
    type: "SCV",
    name: "Solidity Code Verification",
    applicable: true,
    passed: score <= 20,
    score,
    details: apiKey
      ? `explorer source-verification checked for ${live.length} core contracts`
      : `bytecode confirmed for ${live.length} core contracts (set ETHERSCAN_API_KEY to verify source)`,
    evidence,
  };
}

/**
 * WAV — Web Application Verification: the agent's x402 endpoint is HTTPS, the
 * root is reachable (200), and a paid endpoint correctly demands payment (402).
 */
export async function checkWAV(
  apiBaseUrl: string,
  opts: { paidPath?: string } = {},
): Promise<VerificationCheck> {
  const base = apiBaseUrl.replace(/\/$/, "");
  const paidPath = opts.paidPath ?? "/oracle/sBTC";
  const evidence: Record<string, unknown> = { apiBaseUrl: base };

  let httpsOk = false;
  try {
    const u = new URL(base);
    httpsOk = u.protocol === "https:";
    // localhost dev is exempt from the HTTPS requirement (noted in evidence).
    if (!httpsOk && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) {
      httpsOk = true;
      evidence.httpsNote = "localhost dev — HTTPS requirement waived";
    }
  } catch {
    httpsOk = false;
  }
  evidence.https = httpsOk;

  let rootOk = false;
  try {
    const r = await fetch(base + "/", { method: "GET" });
    rootOk = r.status === 200;
    evidence.rootStatus = r.status;
  } catch (err) {
    evidence.rootError = (err as Error).message;
  }

  let payWallOk = false;
  try {
    const r = await fetch(base + paidPath, { method: "GET" });
    payWallOk = r.status === 402;
    evidence.paidPath = paidPath;
    evidence.paidStatus = r.status;
  } catch (err) {
    evidence.paidError = (err as Error).message;
  }

  // Equal weighting across the three sub-checks.
  const passes = [httpsOk, rootOk, payWallOk].filter(Boolean).length;
  const score = Math.round(((3 - passes) / 3) * 100);
  return {
    type: "WAV",
    name: "Web Application Verification",
    applicable: true,
    passed: score <= 20,
    score,
    details:
      `HTTPS=${httpsOk ? "ok" : "no"}, root=${rootOk ? "200" : "fail"}, ` +
      `paywall=${payWallOk ? "402" : "fail"}`,
    evidence,
  };
}

/**
 * WV — Wallet Verification: the agent wallet is a non-zero EOA with on-chain
 * history, and (if a matching signer is provided) demonstrates key possession
 * by signing a fresh challenge.
 */
export async function checkWV(
  provider: ethers.Provider,
  agentAddress: string,
  opts: { holderSigner?: ethers.Wallet | ethers.HDNodeWallet } = {},
): Promise<VerificationCheck> {
  const evidence: Record<string, unknown> = { agentAddress };
  const checks: boolean[] = [];

  // 1) non-zero address
  const nonZero = !!agentAddress && agentAddress !== ZERO;
  evidence.nonZeroAddress = nonZero;
  checks.push(nonZero);

  // 2) is an EOA (no contract code) — session keys are plain EOAs
  let isEoa = false;
  try {
    const code = await provider.getCode(agentAddress);
    isEoa = code === "0x";
    evidence.isEOA = isEoa;
  } catch (err) {
    evidence.codeError = (err as Error).message;
  }
  checks.push(isEoa);

  // 3) has on-chain transaction history
  let hasHistory = false;
  try {
    const txCount = await provider.getTransactionCount(agentAddress);
    hasHistory = txCount > 0;
    evidence.txCount = txCount;
  } catch (err) {
    evidence.txCountError = (err as Error).message;
  }
  checks.push(hasHistory);

  // 4) proof of possession (optional but strongest signal)
  let possession: boolean | "not-demonstrated" = "not-demonstrated";
  const signer = opts.holderSigner;
  if (signer) {
    try {
      const signerAddr = await signer.getAddress();
      if (ethers.getAddress(signerAddr) === ethers.getAddress(agentAddress)) {
        const challenge = `pepelab-wv:${agentAddress}:${Date.now()}`;
        const sig = await signer.signMessage(challenge);
        const recovered = ethers.verifyMessage(challenge, sig);
        possession = ethers.getAddress(recovered) === ethers.getAddress(agentAddress);
      } else {
        possession = false; // signer present but for a different address
      }
    } catch (err) {
      evidence.possessionError = (err as Error).message;
      possession = false;
    }
  }
  evidence.possession = possession;

  // Scoring: address + EOA + history are the baseline; possession, when
  // demonstrated, removes any residual doubt; when not demonstrated it is simply
  // excluded from the denominator (history already evidences a live wallet).
  const baseline = [nonZero, isEoa, hasHistory];
  if (possession === true) baseline.push(true);
  if (possession === false) baseline.push(false);
  const passes = baseline.filter(Boolean).length;
  const score = Math.round(((baseline.length - passes) / baseline.length) * 100);
  return {
    type: "WV",
    name: "Wallet Verification",
    applicable: true,
    passed: score <= 20,
    score,
    details:
      `nonZero=${nonZero}, EOA=${isEoa}, history=${hasHistory}, ` +
      `possession=${possession}`,
    evidence,
  };
}

/** MCV is not applicable to a trading agent (no media content). */
export function checkMCVNotApplicable(): VerificationCheck {
  return {
    type: "MCV",
    name: "Media Content Verification",
    applicable: false,
    passed: false,
    score: 0,
    details: "N/A — trading agent has no media content (imageUrl absent)",
  };
}

// ── Assemble + sign + verify ──────────────────────────────────────────────────

/** Inputs for assembling an agent's ERC-8126 verification attestation. */
export interface BuildVerificationParams {
  /** Agent did:pkh OR a raw 0x address (converted to did:pkh). */
  did: string;
  /** Verifier wallet that signs the attestation. */
  verifier: ethers.Wallet | ethers.HDNodeWallet;
  provider: ethers.Provider;
  /** x402 API base URL for the WAV check. */
  apiBaseUrl: string;
  /** Token/contract targets for the ETV check (settlement token + protocol). */
  etvTargets: ContractTarget[];
  /** Core contracts for the SCV (explorer source-verified) check. */
  scvTargets: ContractTarget[];
  /** Optional explorer API key (Etherscan V2 multichain) for SCV. */
  explorerApiKey?: string;
  /** Optional paid path for the WAV 402 check. */
  paidPath?: string;
  /** Optional signer to demonstrate WV proof-of-possession. */
  holderSigner?: ethers.Wallet | ethers.HDNodeWallet;
}

/**
 * Run all five checks, roll up the risk score, and return a verifier-signed
 * ERC-8126-shaped attestation. Each check is independently fault-tolerant: a
 * network error degrades that dimension's score rather than throwing.
 */
export async function buildAgentVerification(
  params: BuildVerificationParams,
): Promise<AgentVerification> {
  const subjectDid = params.did.startsWith("did:")
    ? params.did
    : agentDid(params.did);
  const agentAddress = parseDidPkh(subjectDid).address;

  const [etv, scv, wav, wv] = await Promise.all([
    checkETV(params.provider, params.etvTargets),
    checkSCV(params.provider, params.scvTargets, {
      apiKey: params.explorerApiKey,
    }),
    checkWAV(params.apiBaseUrl, { paidPath: params.paidPath }),
    checkWV(params.provider, agentAddress, { holderSigner: params.holderSigner }),
  ]);
  const mcv = checkMCVNotApplicable();
  const checks = [etv, mcv, scv, wav, wv];

  const { overallRiskScore, riskTier, assessment } = computeRiskScore(checks);
  const proofIds = buildProofIds(checks);

  const issuedAtSec = Math.floor(Date.now() / 1000);
  const verifierAddr = await params.verifier.getAddress();
  const verifierDid = agentDid(verifierAddr);

  const proofValue = await params.verifier.signTypedData(
    VERIFIER_DOMAIN,
    VERIFIER_TYPES,
    verifierValue({
      subject: subjectDid,
      overallRiskScore,
      summaryProofId: proofIds.summaryProofId,
      issuedAt: issuedAtSec,
    }),
  );

  const iso = new Date(issuedAtSec * 1000).toISOString();
  return {
    "@context": [
      "https://www.w3.org/2018/credentials/v1",
      "https://pepelab.xyz/credentials/agent-verification/v1",
    ],
    type: ["VerifiableCredential", "AgentVerification"],
    subject: subjectDid,
    agentId: subjectDid,
    overallRiskScore,
    riskTier,
    assessment,
    checks,
    proofIds,
    verifier: verifierDid,
    issuedAt: iso,
    proof: {
      type: "EthereumEip712Signature2021",
      created: iso,
      proofPurpose: "assertionMethod",
      verificationMethod: `${verifierDid}#blockchainAccountId`,
      proofValue,
    },
  };
}

export interface VerifyAttestationResult {
  valid: boolean;
  reason?: string;
  verifier?: string;
  subject?: string;
  overallRiskScore?: number;
  riskTier?: RiskTier;
}

/**
 * Verify a verifier-signed attestation: recompute the proof digests from the
 * checks (tamper-evidence) AND recover the EIP-712 signer, requiring it to equal
 * the named verifier. Any tampering with a check changes its digest →
 * summaryProofId mismatch; tampering with the score/subject/summary breaks the
 * signature → `valid:false`.
 */
export function verifyAgentVerification(av: AgentVerification): VerifyAttestationResult {
  try {
    if (!av?.proof?.proofValue) return { valid: false, reason: "missing proof" };

    // 1) Recompute proof identifiers from the checks and compare.
    const recomputed = buildProofIds(av.checks);
    const fields: (keyof AgentVerificationProofIds)[] = [
      "etvProofId",
      "mcvProofId",
      "scvProofId",
      "wavProofId",
      "wvProofId",
      "summaryProofId",
    ];
    for (const f of fields) {
      if (recomputed[f] !== av.proofIds?.[f]) {
        return { valid: false, reason: `${f} mismatch — checks tampered` };
      }
    }

    // 2) Recompute the overall score from the checks and compare.
    const { overallRiskScore } = computeRiskScore(av.checks);
    if (overallRiskScore !== av.overallRiskScore) {
      return { valid: false, reason: "overallRiskScore does not match checks" };
    }

    // 3) Recover the verifier signature.
    const verifierAddr = parseDidPkh(av.verifier).address;
    const issuedAtSec = Math.floor(new Date(av.proof.created).getTime() / 1000);
    const recovered = ethers.verifyTypedData(
      VERIFIER_DOMAIN,
      VERIFIER_TYPES,
      verifierValue({
        subject: av.subject,
        overallRiskScore: av.overallRiskScore,
        summaryProofId: av.proofIds.summaryProofId,
        issuedAt: issuedAtSec,
      }),
      av.proof.proofValue,
    );
    if (recovered === ZERO || ethers.getAddress(recovered) !== ethers.getAddress(verifierAddr)) {
      return {
        valid: false,
        reason: `signature does not match verifier (recovered ${recovered}, expected ${verifierAddr})`,
      };
    }

    return {
      valid: true,
      verifier: verifierAddr,
      subject: av.subject,
      overallRiskScore: av.overallRiskScore,
      riskTier: av.riskTier,
    };
  } catch (err) {
    return { valid: false, reason: (err as Error).message };
  }
}
