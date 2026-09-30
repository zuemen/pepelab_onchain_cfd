// Phase 2 write path：agent 經 AgentSessionManager 在 session 限額內代下單。
// 全程綁 session key（自管 EOA），永不持有使用者主錢包私鑰。所有寫操作都受
// 合約端的 per-trade cap / budget / leverage cap / expiry 約束。
//
// 設計守則：缺金鑰或缺 session manager 位址時，回明確的結構化錯誤而非 throw，
// 讓 MCP tool 與 demo agent 能優雅降級（dry-run），不 crash。
import { ethers } from "ethers";
import {
  makeProvider,
  makeContracts,
  makeSigner,
  makeSessionManager,
  getSessionManagerAddress,
} from "./provider.ts";
import { ADDRESSES, assetIdOf } from "./addresses.ts";
import { AGENT_SESSION_MANAGER_ABI } from "./abis.ts";
import { resolveSettlementToken } from "./env.ts";
import {
  verifyAuthorizationVC,
  type AuthorizationVC,
} from "./identity.ts";
import {
  buildAgentVerification,
  type ContractTarget,
} from "./verification.ts";
import {
  enforcePolicyGate,
  auditWriteAttempt,
  type GuardStage,
  type PolicyRequest,
} from "./policyGate.ts";
import { SigningGuardError } from "./signingGuard.ts";
import { checkAndRecordVcNonce } from "./vcNonce.ts";
import { redactSecrets } from "./redact.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * VC 是否可以被省略。**預設 false**（稽核 A-3）：舊版把 VC 閘門寫成「有帶才驗」，
 * 於是三個呼叫端都沒帶 → 等於沒有授權層。現在缺 VC 一律拒絕，只有明確的
 * opt-out（參數 `allowUnsignedForTesting:true`，或 env
 * `AGENT_ALLOW_UNSIGNED_TRADES=true`）才放行，且會在 stderr 大聲警告。
 */
function unsignedAllowed(flag?: boolean): boolean {
  if (flag === true) return true;
  return process.env.AGENT_ALLOW_UNSIGNED_TRADES?.trim().toLowerCase() === "true";
}

const NO_VC_ERROR =
  "拒絕下單：缺少使用者簽發的授權憑證(VC)。自主 agent 的每一筆鏈上動作都必須可" +
  "歸因到簽發者——請在前端 /sessions「Issue VC」簽發後，以 AGENT_AUTH_VC_PATH 提供。" +
  "（僅測試可用 allowUnsignedForTesting / AGENT_ALLOW_UNSIGNED_TRADES=true 明確關閉此閘門）";

/**
 * ERC-8126 風險分數下單閘門（**預設關閉**，向後相容）。
 * 開啟方式：RISK_GATE_ENABLED=true；門檻 RISK_SCORE_MAX（預設 40＝moderate 以內放行）。
 * 開啟後，除了授權 VC，agent 自身的 ERC-8126 風險分數必須 ≤ 門檻才放行。
 * 回 null＝通過（或未啟用）；回字串＝拒絕原因。
 */
async function checkRiskGate(
  signer: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
): Promise<string | null> {
  if (process.env.RISK_GATE_ENABLED?.trim().toLowerCase() !== "true") return null;
  const threshold = Number(process.env.RISK_SCORE_MAX ?? "40");

  // verifier 身分：VERIFIER_PRIVATE_KEY 優先，否則用一次性隨機錢包（仍可算分）。
  const vpk = process.env.VERIFIER_PRIVATE_KEY?.trim();
  const verifier =
    vpk && vpk.startsWith("0x") && vpk.length === 66
      ? new ethers.Wallet(vpk)
      : ethers.Wallet.createRandom();

  const usdc = resolveSettlementToken();
  const etvTargets: ContractTarget[] = [
    { label: "USDC (settlement)", address: usdc },
    { label: "PerpetualExchange", address: ADDRESSES.PerpetualExchange },
  ];
  const scvTargets: ContractTarget[] = [
    { label: "PerpetualExchange", address: ADDRESSES.PerpetualExchange },
    { label: "FeeRouter", address: ADDRESSES.FeeRouter },
  ];

  try {
    const av = await buildAgentVerification({
      did: signer.address,
      verifier,
      provider,
      apiBaseUrl: process.env.SIGNAL_API_PUBLIC_URL?.trim() || "http://localhost:4021",
      etvTargets,
      scvTargets,
      explorerApiKey:
        process.env.ETHERSCAN_API_KEY?.trim() || process.env.BASESCAN_API_KEY?.trim(),
      holderSigner: signer, // agent 對自己下單 → 可出示持有證明
    });
    if (av.overallRiskScore > threshold) {
      return `agent 風險分數 ${av.overallRiskScore}（${av.riskTier}）超過門檻 ${threshold}`;
    }
    return null;
  } catch (err) {
    return `風險閘門評估失敗：${(err as Error).message}`;
  }
}

export interface WriteResult {
  ok: boolean;
  /** 失敗原因（ok=false 時填）；UI/agent 直接展示。 */
  error?: string;
  txHash?: string;
  positionId?: string;
  agent?: string;
  sessionId?: number;
  detail?: Record<string, unknown>;
  /** 拒絕/失敗的原因代碼（穩定字串，與 policy 稽核紀錄的 reasonCode 相同）。 */
  reasonCode?: string;
  /** 停在哪一道閘（config / vc / policy / risk / precheck / signing / submit）。 */
  guardStage?: GuardStage;
}

/**
 * 每一次寫入嘗試都要留一筆結構化稽核（guardStage / reasonCode / allowed / sessionId /
 * agent 地址）。非 policy 階段的拒絕寫稽核失敗不改變結果（本來就拒絕），只記 stderr。
 */
function auditStage(
  req: PolicyRequest | (Omit<PolicyRequest, "agent"> & { agent: string | null }),
  guardStage: GuardStage,
  reasonCode: string,
  allowed: boolean,
  message?: string,
  txHash?: string | null,
): void {
  try {
    auditWriteAttempt({
      action: req.action,
      guardStage,
      reasonCode,
      allowed,
      sessionId: req.sessionId,
      agent: req.agent,
      request: {
        symbol: req.symbol,
        isLong: req.isLong,
        marginUsdc: req.marginUsdc,
        leverage: req.leverage,
        positionId: req.positionId,
      },
      message: message ? redactSecrets(message).slice(0, 300) : undefined,
      txHash: txHash ?? null,
    });
  } catch (err) {
    console.error(`[policy-audit] 稽核寫入失敗（${guardStage}/${reasonCode}）：${redactSecrets((err as Error).message)}`);
  }
}

/** 產生拒絕結果並寫稽核。 */
function reject(
  req: Parameters<typeof auditStage>[0],
  guardStage: GuardStage,
  reasonCode: string,
  error: string,
): WriteResult {
  auditStage(req, guardStage, reasonCode, false, error);
  return { ok: false, error, agent: req.agent ?? undefined, reasonCode, guardStage };
}

const SESSION_MANAGER_IFACE = new ethers.Interface(AGENT_SESSION_MANAGER_ABI);

/**
 * 從 receipt logs 解出 `SessionOpenedPosition.positionId`。只接受 `managerAddress`
 * 發出的 log（別的合約剛好有同名同簽章的事件也不會被誤認）。找不到回 undefined。
 */
export function parseSessionOpenedPositionId(
  logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }>,
  managerAddress: string,
): string | undefined {
  const mgr = managerAddress.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== mgr) continue;
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = SESSION_MANAGER_IFACE.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      parsed = null;
    }
    if (parsed?.name === "SessionOpenedPosition") return parsed.args.positionId.toString();
  }
  return undefined;
}

/** 取得綁 signer 的 session manager；缺金鑰/位址時回結構化錯誤。 */
function resolveSession():
  | { signer: ethers.Wallet; mgr: ethers.Contract }
  | { error: string } {
  const provider = makeProvider();
  const signer = makeSigner(provider);
  if (!signer) {
    return {
      error:
        "未設定有效 AGENT_PRIVATE_KEY（0x + 64 hex）。寫操作需要 session key；" +
        "請見 agent/.env.example。",
    };
  }
  const mgr = makeSessionManager(signer);
  if (!mgr) {
    return {
      error:
        `未設定 SESSION_MANAGER_ADDRESS（目前 ${getSessionManagerAddress()}）。` +
        "請把 Deploy.s.sol 印出的 AgentSessionMgr 位址填入 agent/.env。",
    };
  }
  return { signer, mgr };
}

/**
 * 驗證使用者簽發的授權 VC：驗簽 + 比對「持有者=本 agent」、「sessionId 相符」、
 * 並與鏈上 session 交叉比對（issuer==session.user、agent==session.agent）。
 * 回 null 代表通過；回字串代表拒絕原因（呼叫端據此拒絕下單）。
 */
async function verifyVcAgainstChain(
  vc: AuthorizationVC,
  sessionId: number,
  agentAddress: string,
  mgr: ethers.Contract,
): Promise<string | null> {
  // v2 VC 的 domain 綁 session manager 位址：必須等於本 agent 實際呼叫的那一顆。
  const res = verifyAuthorizationVC(vc, { expectedVerifyingContract: await mgr.getAddress() });
  if (!res.valid) return `授權憑證(VC)驗證失敗（${res.reasonCode ?? "VC_INVALID"}）：${res.reason}`;
  if (res.sessionId !== sessionId)
    return `VC sessionId(${res.sessionId}) 與請求(${sessionId}) 不符`;
  if (res.agent && ethers.getAddress(res.agent) !== ethers.getAddress(agentAddress))
    return `VC 授權的 agent(${res.agent}) 非本 session key(${agentAddress})`;

  // 交叉比對鏈上 session：VC 的 issuer 必須是 session.user、agent 必須是 session.agent。
  try {
    const s = await mgr.sessions(sessionId);
    if (res.issuer && ethers.getAddress(s.user) !== ethers.getAddress(res.issuer))
      return `VC 簽發者(${res.issuer}) 非鏈上 session.user(${s.user})`;
    if (res.agent && ethers.getAddress(s.agent) !== ethers.getAddress(res.agent))
      return `VC agent 與鏈上 session.agent(${s.agent}) 不符`;
    if (s.revoked) return "鏈上 session 已撤銷";

    // ── VC 宣稱的 caps 必須與鏈上 session 完全一致（防止 VC 與鏈上額度不符）──
    if (res.caps) {
      const c = res.caps;
      if (ethers.parseUnits(String(c.maxMarginPerTrade), 18) !== (s.maxMarginPerTrade as bigint))
        return `VC maxMarginPerTrade(${c.maxMarginPerTrade}) 與鏈上不符`;
      if (ethers.parseUnits(String(c.totalBudget), 18) !== (s.totalMarginBudget as bigint))
        return `VC totalBudget(${c.totalBudget}) 與鏈上不符`;
      if (Number(c.maxLeverage) !== Number(s.maxLeverage))
        return `VC maxLeverage(${c.maxLeverage}) 與鏈上不符`;
      if (Number(c.expiry) !== Number(s.expiry))
        return `VC expiry(${c.expiry}) 與鏈上 session 到期不符`;
    }
  } catch (err) {
    return `讀取鏈上 session 失敗：${redactSecrets((err as Error).message)}`;
  }

  // nonce 一次性（v2）＋取代＋不降級（v1/v2）檢查；鏈上比對通過後才記錄，避免無效 VC
  // 污染狀態。語意見 vcNonce.ts。
  const n = checkAndRecordVcNonce(res);
  if (!n.ok) return `授權憑證(VC) nonce 檢查未過（${n.reasonCode}）：${n.message}`;
  return null;
}

/**
 * 在 session 限額內為 session.user 開一筆受限部位。
 * @param sessionId 鏈上 session id（由使用者 createSession 建立）
 * @param symbol    資產代號（sBTC…），轉 bytes32 assetId
 * @param isLong    多/空
 * @param marginUsdc 保證金（人類單位，內部轉 18-dec）
 * @param leverage  槓桿（受 session.maxLeverage 約束）
 * @param authVc    使用者簽發的授權 VC。**必要**（稽核 A-3）：下單前必須驗證通過，
 *                  否則拒絕——這就是「可驗證的 agent 自主交易」(VC/SSI)。
 * @param allowUnsignedForTesting 明確的測試 opt-out，預設 false。
 */
export async function openPositionForSession(params: {
  sessionId: number;
  symbol: string;
  isLong: boolean;
  marginUsdc: number;
  leverage: number;
  authVc?: AuthorizationVC;
  allowUnsignedForTesting?: boolean;
}): Promise<WriteResult> {
  const base = {
    action: "open" as const,
    sessionId: params.sessionId,
    symbol: params.symbol,
    isLong: params.isLong,
    marginUsdc: params.marginUsdc,
    leverage: params.leverage,
  };
  const r = resolveSession();
  if ("error" in r) return reject({ ...base, agent: null }, "config", "SIGNER_OR_MANAGER_MISSING", r.error);
  const { signer, mgr } = r;
  const req: PolicyRequest = { ...base, agent: signer.address };

  // A-3：VC 預設必要。缺 VC 且未明確 opt-out → 直接拒絕（不送鏈、不花 gas）。
  if (!params.authVc) {
    if (!unsignedAllowed(params.allowUnsignedForTesting)) {
      return reject(req, "vc", "VC_MISSING", NO_VC_ERROR);
    }
    console.warn(
      "[write] ⚠ VC 閘門已被明確關閉（allowUnsignedForTesting / AGENT_ALLOW_UNSIGNED_TRADES）" +
        " —— 這筆下單無法歸因到任何簽發者，僅限測試環境。",
    );
  }

  // VC/SSI 閘門：帶了授權憑證就必須驗證通過（驗簽 + 鏈上 session 交叉比對）才下單。
  if (params.authVc) {
    const reason = await verifyVcAgainstChain(
      params.authVc,
      params.sessionId,
      signer.address,
      mgr,
    );
    if (reason) {
      return reject(req, "vc", "VC_INVALID", `拒絕下單（VC 驗證未過）：${reason}`);
    }

    // caps 預檢（省 gas、錯誤更清楚）：單筆保證金 / 槓桿不得超過 VC 授權上限。
    const caps = params.authVc.credentialSubject.authorization;
    if (params.marginUsdc > Number(caps.maxMarginPerTrade))
      return reject(req, "vc", "VC_MARGIN_CAP_EXCEEDED", `單筆保證金 ${params.marginUsdc} 超過上限 ${caps.maxMarginPerTrade}`);
    if (params.leverage > Number(caps.maxLeverage))
      return reject(req, "vc", "VC_LEVERAGE_CAP_EXCEEDED", `槓桿 ${params.leverage} 超過上限 ${caps.maxLeverage}`);
  }

  // ERC-8126 風險閘門（預設關，旗標開啟才生效）。
  const riskReason = await checkRiskGate(signer, makeProvider());
  if (riskReason) {
    return reject(req, "risk", "RISK_GATE_REJECTED", `拒絕下單（風險閘門）：${riskReason}`);
  }

  // Policy gate：送出交易前的最後一道、**無條件**執行（沒有 opt-out 參數）。
  // 放行時會預留額度；送出前失敗要 release。
  const gate = await enforcePolicyGate(req);
  if (!gate.allowed) {
    return {
      ok: false,
      error: `拒絕下單（policy gate ${gate.reasonCode}）：${gate.message}`,
      agent: signer.address,
      reasonCode: gate.reasonCode,
      guardStage: "policy",
    };
  }

  let signed: SignedTx;
  try {
    const assetId = assetIdOf(params.symbol);
    const margin = ethers.parseUnits(String(params.marginUsdc), 18);

    // 開倉需附 execution fee（native ETH），由 session manager 轉發給 exchange。
    const perp = makeContracts(makeProvider()).perp;
    const fee = (await perp.executionFee()) as bigint;

    // 先組好、**簽好**交易（簽章守門在 GuardedWallet.signTransaction 內執行：type-4 /
    // 無上限 approve・permit 在這一步就丟 SigningGuardError），拿到 tx hash 再廣播。
    const unsigned = await mgr.openPositionForSession.populateTransaction(
      params.sessionId,
      assetId,
      params.isLong,
      margin,
      params.leverage,
      ZERO, // copiedFrom：self-open
      { value: fee },
    );
    signed = await signTx(signer, unsigned);
  } catch (err) {
    return await handlePreBroadcastError(err, req, gate.release);
  }

  const out = await submitAndTrack(signer, signed, req, gate.release);
  if (out.kind !== "mined") return out.result;

  // 從 SessionOpenedPosition 事件解出 positionId（只認本 manager 發出的）。
  const positionId = parseSessionOpenedPositionId(out.receipt.logs ?? [], await mgr.getAddress());
  auditStage(req, "submit", "SUBMITTED", true, undefined, signed.hash);
  return {
    ok: true,
    txHash: signed.hash,
    positionId,
    agent: signer.address,
    sessionId: params.sessionId,
    detail: {
      symbol: params.symbol,
      isLong: params.isLong,
      marginUsdc: params.marginUsdc,
      leverage: params.leverage,
    },
  };
}

// ── 送出與追蹤（審查 Low-9）─────────────────────────────────────────────────
//
// 舊版 `await contract.fn()` 在廣播那一步丟錯時（逾時、節點 5xx…），我們不知道交易
// 有沒有進 mempool，卻把 policy 預留還回去 → 可能「交易其實上鏈了、額度卻被退回」。
// 現在：先簽、先記 tx hash（稽核 SIGNED），再廣播；廣播出錯時查 hash 與 pending nonce，
// **只有確認沒送出**才返還額度，查不出來就當作可能已送出（不返還、回 TX_STATUS_UNKNOWN）。

export interface SignedTx {
  raw: string;
  hash: string;
  nonce: number;
  from: string;
}

/** 補齊 nonce / gas / fee 後簽章（GuardedWallet 會先過簽章守門）。 */
async function signTx(signer: ethers.Wallet, unsigned: ethers.TransactionRequest): Promise<SignedTx> {
  const pop = await signer.populateTransaction(unsigned);
  const raw = await signer.signTransaction(pop);
  return { raw, hash: ethers.keccak256(raw), nonce: Number(pop.nonce), from: signer.address };
}

/** submitSigned 需要的 provider 子集（測試可注入假 provider）。 */
export interface SubmitProvider {
  broadcastTransaction(raw: string): Promise<unknown>;
  getTransaction(hash: string): Promise<unknown | null>;
  getTransactionReceipt(hash: string): Promise<unknown | null>;
  getTransactionCount(address: string, blockTag: "pending"): Promise<number>;
  waitForTransaction(hash: string, confirms?: number, timeout?: number): Promise<ethers.TransactionReceipt | null>;
}

export type SubmitOutcome =
  | { kind: "mined"; receipt: ethers.TransactionReceipt }
  | { kind: "reverted"; receipt: ethers.TransactionReceipt }
  /** 已廣播（或確認已進 mempool）但在等待時間內沒有收據。 */
  | { kind: "pending" }
  /** 確認沒有送出 → 可以返還額度。 */
  | { kind: "not_sent"; error: string }
  /** 無法判斷是否送出 → 不返還額度。 */
  | { kind: "unknown"; error: string };

/** 廣播出錯後判斷交易到底有沒有出去。 */
export async function broadcastStatus(
  p: SubmitProvider,
  tx: SignedTx,
): Promise<"sent" | "not_sent" | "unknown"> {
  try {
    if (await p.getTransaction(tx.hash)) return "sent";
    if (await p.getTransactionReceipt(tx.hash)) return "sent";
    // pending nonce 已超過這筆的 nonce：nonce 被用掉了（多半就是這筆；也可能是別筆）→ 保守視為已送出
    if ((await p.getTransactionCount(tx.from, "pending")) > tx.nonce) return "sent";
    return "not_sent";
  } catch {
    return "unknown";
  }
}

export async function submitSigned(
  p: SubmitProvider,
  tx: SignedTx,
  opts: { waitTimeoutMs?: number } = {},
): Promise<SubmitOutcome> {
  try {
    await p.broadcastTransaction(tx.raw);
  } catch (err) {
    const status = await broadcastStatus(p, tx);
    const error = redactSecrets((err as Error)?.message ?? String(err));
    if (status === "not_sent") return { kind: "not_sent", error };
    if (status === "unknown") return { kind: "unknown", error };
    // sent：照常等收據
  }
  try {
    const receipt = await p.waitForTransaction(tx.hash, 1, opts.waitTimeoutMs ?? 120_000);
    if (!receipt) return { kind: "pending" };
    return receipt.status === 0 ? { kind: "reverted", receipt } : { kind: "mined", receipt };
  } catch {
    return { kind: "pending" };
  }
}

/** 送出並把非成功的結果轉成 WriteResult（含稽核與額度返還決策）。 */
async function submitAndTrack(
  signer: ethers.Wallet,
  tx: SignedTx,
  req: PolicyRequest,
  release: () => Promise<void>,
): Promise<{ kind: "mined"; receipt: ethers.TransactionReceipt } | { kind: "done"; result: WriteResult }> {
  // 先把 hash 記下來：就算之後 process 當掉，稽核裡也有這筆簽出去的交易可追。
  auditStage(req, "submit", "SIGNED", true, undefined, tx.hash);
  const out = await submitSigned(signer.provider as unknown as SubmitProvider, tx);
  const fail = (reasonCode: string, error: string): { kind: "done"; result: WriteResult } => {
    auditStage(req, "submit", reasonCode, false, error, tx.hash);
    return {
      kind: "done",
      result: { ok: false, error, agent: signer.address, reasonCode, guardStage: "submit", txHash: tx.hash },
    };
  };
  switch (out.kind) {
    case "mined":
      return out;
    case "reverted":
      return fail("TX_REVERTED", `交易已上鏈但 revert（${tx.hash}）`);
    case "pending":
      return fail("TX_PENDING", `交易已送出但尚未在時限內確認，請以 tx hash 追蹤：${tx.hash}`);
    case "not_sent":
      await release();
      return fail("SUBMIT_FAILED", `交易未送出（已確認 mempool 與 nonce 皆無此筆）：${out.error}`);
    case "unknown":
      return fail("TX_STATUS_UNKNOWN", `無法確認交易是否已送出，額度不返還，請以 tx hash 追蹤：${tx.hash}`);
  }
}

/**
 * 廣播**之前**的錯誤（組交易、估 gas、簽章守門）：交易不可能已送出 → 返還額度。
 * 簽章守門擋下 → guardStage=signing。
 */
async function handlePreBroadcastError(
  err: unknown,
  req: PolicyRequest,
  release: () => Promise<void>,
): Promise<WriteResult> {
  await release();
  if (err instanceof SigningGuardError) {
    return reject(req, "signing", err.reasonCode, `拒絕簽章：${err.message}`);
  }
  const msg = redactSecrets((err as Error)?.message ?? String(err));
  return reject(req, "submit", "SUBMIT_FAILED", msg);
}

/**
 * 平掉 session 使用者的一筆部位。
 *
 * 稽核 A-4：平倉會實現虧損，破壞力與開倉對稱，舊版卻**完全沒有授權層**（沒有 VC、
 * 沒有風險閘、連「這個部位是不是這個 session 的」都沒查）。現在與開倉同一套：
 *   1. VC 預設必要（同 `allowUnsignedForTesting` opt-out）
 *   2. VC 驗簽 + 鏈上 session 交叉比對（issuer==session.user、agent==session.agent、未撤銷）
 *   3. 額外的鏈上檢查：該 positionId 必須仍開著、且 owner == session.user
 *      （否則 agent 可以拿別人的 positionId 呼叫）
 */
export async function closePositionForSession(params: {
  sessionId: number;
  positionId: number;
  authVc?: AuthorizationVC;
  allowUnsignedForTesting?: boolean;
}): Promise<WriteResult> {
  const base = { action: "close" as const, sessionId: params.sessionId, positionId: params.positionId };
  const r = resolveSession();
  if ("error" in r) return reject({ ...base, agent: null }, "config", "SIGNER_OR_MANAGER_MISSING", r.error);
  const { signer, mgr } = r;
  const req: PolicyRequest = { ...base, agent: signer.address };

  if (!params.authVc) {
    if (!unsignedAllowed(params.allowUnsignedForTesting)) {
      return reject(req, "vc", "VC_MISSING", NO_VC_ERROR.replace("拒絕下單", "拒絕平倉"));
    }
    console.warn("[write] ⚠ 平倉的 VC 閘門已被明確關閉，僅限測試環境。");
  }

  if (params.authVc) {
    const reason = await verifyVcAgainstChain(
      params.authVc,
      params.sessionId,
      signer.address,
      mgr,
    );
    if (reason) {
      return reject(req, "vc", "VC_INVALID", `拒絕平倉（VC 驗證未過）：${reason}`);
    }
  }

  // 鏈上交叉比對：部位必須存在、仍開著、且屬於這個 session 的 user。
  try {
    const s = await mgr.sessions(params.sessionId);
    const perp = makeContracts(makeProvider()).perp;
    const pos: any = await perp.getPosition(params.positionId);
    const owner = String(pos?.owner ?? ZERO);
    if (ethers.getAddress(owner) === ethers.getAddress(ZERO))
      return reject(req, "precheck", "POSITION_NOT_FOUND", `position #${params.positionId} 不存在`);
    if (ethers.getAddress(owner) !== ethers.getAddress(s.user))
      return reject(
        req,
        "precheck",
        "POSITION_NOT_SESSION_USER",
        `拒絕平倉：position #${params.positionId} 的 owner(${owner}) 非本 session 的 user(${s.user})`,
      );
    if (!pos.isOpen)
      return reject(req, "precheck", "POSITION_ALREADY_CLOSED", `position #${params.positionId} 已平倉`);
  } catch (err) {
    return reject(
      req,
      "precheck",
      "PRECHECK_READ_FAILED",
      `平倉前的鏈上比對失敗：${redactSecrets((err as Error).message)}`,
    );
  }

  // Policy gate（平倉只套頻率上限；保證金／槓桿／資產規則只適用開倉）。
  const gate = await enforcePolicyGate(req);
  if (!gate.allowed) {
    return {
      ok: false,
      error: `拒絕平倉（policy gate ${gate.reasonCode}）：${gate.message}`,
      agent: signer.address,
      reasonCode: gate.reasonCode,
      guardStage: "policy",
    };
  }

  let signed: SignedTx;
  try {
    const unsigned = await mgr.closePositionForSession.populateTransaction(
      params.sessionId,
      params.positionId,
    );
    signed = await signTx(signer, unsigned);
  } catch (err) {
    return await handlePreBroadcastError(err, req, gate.release);
  }
  const out = await submitAndTrack(signer, signed, req, gate.release);
  if (out.kind !== "mined") return out.result;
  auditStage(req, "submit", "SUBMITTED", true, undefined, signed.hash);
  return {
    ok: true,
    txHash: signed.hash,
    positionId: String(params.positionId),
    agent: signer.address,
    sessionId: params.sessionId,
  };
}

/** 讀 session 設定（限額/預算/到期），給 agent 在下單前自我檢查。 */
export async function getSession(sessionId: number): Promise<WriteResult> {
  const provider = makeProvider();
  const signer = makeSigner(provider);
  // 唯讀也可用 provider；但沿用 signer 一致性，缺則退回 provider。
  const mgr = signer
    ? makeSessionManager(signer)
    : (() => {
        const addr = getSessionManagerAddress();
        if (addr === ZERO) return null;
        return new ethers.Contract(
          addr,
          // 延遲 import 會增加複雜度，直接用最小 ABI 片段。
          ["function sessions(uint256) view returns (address user, address agent, uint256 maxMarginPerTrade, uint256 totalMarginBudget, uint256 spentMargin, uint256 maxLeverage, uint256 expiry, bool revoked)"],
          provider,
        );
      })();
  if (!mgr) {
    return {
      ok: false,
      error: `未設定 SESSION_MANAGER_ADDRESS（目前 ${getSessionManagerAddress()}）。`,
    };
  }
  try {
    const s = await mgr.sessions(sessionId);
    return {
      ok: true,
      sessionId,
      detail: {
        user: s.user,
        agent: s.agent,
        maxMarginPerTrade: ethers.formatUnits(s.maxMarginPerTrade, 18),
        totalMarginBudget: ethers.formatUnits(s.totalMarginBudget, 18),
        spentMargin: ethers.formatUnits(s.spentMargin, 18),
        maxLeverage: Number(s.maxLeverage),
        expiry: Number(s.expiry),
        revoked: s.revoked,
      },
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
