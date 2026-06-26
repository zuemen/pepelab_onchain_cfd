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
import {
  verifyAuthorizationVC,
  type AuthorizationVC,
} from "./identity.ts";
import {
  buildAgentVerification,
  type ContractTarget,
} from "./verification.ts";

const ZERO = "0x0000000000000000000000000000000000000000";
// 官方 Base Sepolia USDC（與 signal-api SETTLEMENT_TOKEN 預設一致）。
const DEFAULT_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

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

  const usdc = process.env.X402_SETTLEMENT_TOKEN?.trim() || DEFAULT_USDC;
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
  const res = verifyAuthorizationVC(vc);
  if (!res.valid) return `授權憑證(VC)驗證失敗：${res.reason}`;
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
    return `讀取鏈上 session 失敗：${(err as Error).message}`;
  }
  return null;
}

/**
 * 在 session 限額內為 session.user 開一筆受限部位。
 * @param sessionId 鏈上 session id（由使用者 createSession 建立）
 * @param symbol    資產代號（sBTC…），轉 bytes32 assetId
 * @param isLong    多/空
 * @param marginUsdc 保證金（人類單位，內部轉 18-dec）
 * @param leverage  槓桿（受 session.maxLeverage 約束）
 * @param authVc    （可選）使用者簽發的授權 VC；提供時下單前**必須驗證通過**，
 *                  否則拒絕——這就是「可驗證的 agent 自主交易」(VC/SSI)。
 */
export async function openPositionForSession(params: {
  sessionId: number;
  symbol: string;
  isLong: boolean;
  marginUsdc: number;
  leverage: number;
  authVc?: AuthorizationVC;
}): Promise<WriteResult> {
  const r = resolveSession();
  if ("error" in r) return { ok: false, error: r.error };
  const { signer, mgr } = r;

  // VC/SSI 閘門：若帶了授權憑證，必須驗證通過（驗簽 + 鏈上 session 交叉比對）才下單。
  if (params.authVc) {
    const reason = await verifyVcAgainstChain(
      params.authVc,
      params.sessionId,
      signer.address,
      mgr,
    );
    if (reason) {
      return { ok: false, error: `拒絕下單（VC 驗證未過）：${reason}`, agent: signer.address };
    }

    // caps 預檢（省 gas、錯誤更清楚）：單筆保證金 / 槓桿不得超過 VC 授權上限。
    const caps = params.authVc.credentialSubject.authorization;
    if (params.marginUsdc > Number(caps.maxMarginPerTrade))
      return { ok: false, error: `單筆保證金 ${params.marginUsdc} 超過上限 ${caps.maxMarginPerTrade}`, agent: signer.address };
    if (params.leverage > Number(caps.maxLeverage))
      return { ok: false, error: `槓桿 ${params.leverage} 超過上限 ${caps.maxLeverage}`, agent: signer.address };
  }

  // ERC-8126 風險閘門（預設關，旗標開啟才生效）。
  const riskReason = await checkRiskGate(signer, makeProvider());
  if (riskReason) {
    return { ok: false, error: `拒絕下單（風險閘門）：${riskReason}`, agent: signer.address };
  }

  try {
    const assetId = assetIdOf(params.symbol);
    const margin = ethers.parseUnits(String(params.marginUsdc), 18);

    // 開倉需附 execution fee（native ETH），由 session manager 轉發給 exchange。
    const perp = makeContracts(makeProvider()).perp;
    const fee = (await perp.executionFee()) as bigint;

    const tx = await mgr.openPositionForSession(
      params.sessionId,
      assetId,
      params.isLong,
      margin,
      params.leverage,
      ZERO, // copiedFrom：self-open
      { value: fee },
    );
    const receipt = await tx.wait();

    // 從 SessionOpenedPosition 事件解出 positionId。
    let positionId: string | undefined;
    for (const log of receipt?.logs ?? []) {
      try {
        const parsed = mgr.interface.parseLog(log);
        if (parsed?.name === "SessionOpenedPosition") {
          positionId = parsed.args.positionId.toString();
          break;
        }
      } catch {
        /* 非本合約事件，略過 */
      }
    }

    return {
      ok: true,
      txHash: tx.hash,
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
  } catch (err) {
    return { ok: false, error: (err as Error).message, agent: signer.address };
  }
}

/** 平掉 session 使用者的一筆部位。 */
export async function closePositionForSession(params: {
  sessionId: number;
  positionId: number;
}): Promise<WriteResult> {
  const r = resolveSession();
  if ("error" in r) return { ok: false, error: r.error };
  const { signer, mgr } = r;

  try {
    const tx = await mgr.closePositionForSession(
      params.sessionId,
      params.positionId,
    );
    await tx.wait();
    return {
      ok: true,
      txHash: tx.hash,
      positionId: String(params.positionId),
      agent: signer.address,
      sessionId: params.sessionId,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message, agent: signer.address };
  }
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
