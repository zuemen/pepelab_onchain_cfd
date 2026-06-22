// 不可否認稽核軌跡（Part E2）。每筆自主決策（下單或 skip）寫一行 JSONL，串起
// 「誰授權(VC) + 付費做了什麼功課(x402 settlement) + 做了什麼(開倉 tx)」，皆可獨立
// 在鏈上/密碼學上核對。agent 不建立 VC（那會破壞 SSI）——VC 由使用者本人簽發。
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import type { AuthorizationVC } from "./identity.ts";

export interface AuditRecord {
  ts: string;
  /** 誰授權（VC issuer 的 did:pkh）。 */
  issuerDid: string | null;
  /** 誰執行（agent 的 did:pkh）。 */
  agentDid: string;
  sessionId: number;
  vc: {
    /** VC 識別碼：proofValue 的 keccak 摘要（穩定、不洩漏簽章本身）。 */
    id: string | null;
    expiry: number | null;
    /** 本地 verifyAuthorizationVC + 一致性檢查是否通過。 */
    verified: boolean;
    reason?: string;
  };
  /** x402 付費憑證：買了哪個資源、價格、付款上鏈 tx。 */
  research: { resource: string; priceUsdc: string; settlementTx: string | null };
  /** agent 自主決策。 */
  decision: { edgeScore: number | null; side: "long" | "short" | "skip"; reason: string };
  /** 鏈上行動（skip 則 opened:false、txHash:null）。 */
  action: { opened: boolean; positionId: string | null; txHash: string | null };
  /** （加分）ERC-8126 agent 可信度標記。 */
  agentVerification?: { overallRiskScore: number; riskTier: string } | null;
}

/** 穩定的 VC 識別碼：proofValue 的 keccak 摘要（不外洩簽章原文）。 */
export function vcId(vc?: AuthorizationVC | null): string | null {
  if (!vc?.proof?.proofValue) return null;
  return ethers.id(vc.proof.proofValue);
}

/** 附加一筆稽核紀錄（JSONL）；自動建目錄。 */
export function appendAudit(filePath: string, rec: AuditRecord): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(rec) + "\n", "utf8");
}

/** 讀回所有稽核紀錄。 */
export function readAudit(filePath: string): AuditRecord[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AuditRecord);
}
