// VC/SSI 閘門（Part E1）+ 稽核共用工具。被 x402-autonomous / x402-loop / audit-verify 共用。
// SSI：issuer=使用者(簽 VC)、holder=agent(持 VC)、verifier=這裡 + 鏈上交叉比對。
// agent 不建立 VC——VC 由使用者本人在前端 /sessions 簽發，這裡只載入並出示/驗證。
import fs from "node:fs";
import {
  verifyAuthorizationVC, vcId, type AuthorizationVC,
} from "@pepelab/shared";

export const AUDIT_PATH = process.env.AUDIT_PATH?.trim() || "audit/trades.jsonl";

/** 載入使用者簽發的授權 VC（JSON）。缺檔/壞檔回 null（呼叫端據此拒絕下單）。 */
export function loadVc(p?: string): AuthorizationVC | null {
  const path = p ?? process.env.AGENT_AUTH_VC_PATH?.trim();
  if (!path) return null;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as AuthorizationVC;
  } catch (e) {
    console.error(`讀取 VC 失敗(${path})：${(e as Error).message}`);
    return null;
  }
}

export interface VcCheck {
  ok: boolean;
  reason: string;
  issuerDid: string | null;
  id: string | null;
  expiry: number | null;
}

/** 本地驗 VC（不上鏈）：驗章（含過期）+ sessionId 相符 + holder==本 agent。
 *  鏈上交叉比對（issuer==session.user、未撤銷）由 openPositionForSession 帶 authVc 時執行。 */
export function localVerifyVc(vc: AuthorizationVC | null, agentAddress: string, sessionId: number): VcCheck {
  if (!vc) return { ok: false, reason: "缺 VC（AGENT_AUTH_VC_PATH 未設或檔案不存在/解析失敗）", issuerDid: null, id: null, expiry: null };
  const id = vcId(vc);
  const expiry = vc.credentialSubject?.authorization?.expiry ?? null;
  const issuerDid = vc.issuer ?? null;
  const r = verifyAuthorizationVC(vc);
  if (!r.valid) return { ok: false, reason: `VC 驗章失敗：${r.reason}`, issuerDid, id, expiry };
  if (r.sessionId !== sessionId) return { ok: false, reason: `VC sessionId(${r.sessionId}) ≠ 請求 ${sessionId}`, issuerDid, id, expiry };
  if (r.agent && agentAddress && r.agent.toLowerCase() !== agentAddress.toLowerCase())
    return { ok: false, reason: `VC holder(${r.agent}) ≠ 本 agent(${agentAddress})`, issuerDid, id, expiry };
  return { ok: true, reason: "VC 有效（驗章 + sessionId + holder 相符）", issuerDid, id, expiry };
}

/** （E3 加分）查 agent 的 ERC-8126 可信度（免費端點，不付費）。失敗回 null。 */
export async function fetchAgentVerification(api: string, did: string): Promise<{ overallRiskScore: number; riskTier: string } | null> {
  try {
    const r = await fetch(`${api.replace(/\/$/, "")}/agent/${encodeURIComponent(did)}/verification`);
    const j = (await r.json()) as any;
    const v = j?.verification;
    if (v && typeof v.overallRiskScore === "number") return { overallRiskScore: v.overallRiskScore, riskTier: v.riskTier };
  } catch { /* best-effort */ }
  return null;
}
