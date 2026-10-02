// 不可否認稽核軌跡（Part E2）。每筆自主決策（下單或 skip）寫一行 JSONL，串起
// 「誰授權(VC) + 付費做了什麼功課(x402 settlement) + 做了什麼(開倉 tx)」，皆可獨立
// 在鏈上/密碼學上核對。agent 不建立 VC（那會破壞 SSI）——VC 由使用者本人簽發。
//
// 稽核 2026-08-06（四·Medium）修正的兩個「不可否認」缺口：
//   1. `vcId` 只綁簽章位元組，不綁紀錄內容 —— 同一張 VC 的摘要在每一筆紀錄都一樣，
//      所以把某筆的 decision/sessionId 改掉，VC 摘要仍然對得上。現在每筆額外寫一個
//      `vc.binding` = keccak(vcId‖issuerDid‖agentDid‖sessionId‖resource‖side)，
//      改內容就對不上。
//   2. JSONL 是 agent 可任意重寫的本地檔，沒有任何順序保證 —— 刪掉中間一筆、或把
//      兩筆對調都不會被發現。現在每筆帶 `prevHash`/`hash`，形成 hash chain：
//      任何刪改插入都會在該點之後斷鏈（見 `verifyAuditChain`）。
//   注意誠實邊界：hash chain 防的是「事後竄改既有紀錄」，不防「一開始就不寫」。
//   要防後者需要外部錨定（把 head hash 定期上鏈或交給第三方）。
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import type { AuthorizationVC } from "./identity.ts";
import { isNotFound, retryTransientSync, withFileLockSync } from "./fileLock.ts";

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
    /** VC 與**這一筆紀錄內容**的綁定摘要（見檔頭）。 */
    binding?: string | null;
  };
  /** x402 付費憑證：買了哪個資源、價格、付款上鏈 tx。 */
  research: { resource: string; priceUsdc: string; settlementTx: string | null };
  /** agent 自主決策。 */
  decision: { edgeScore: number | null; side: "long" | "short" | "skip"; reason: string };
  /** 鏈上行動（skip 則 opened:false、txHash:null）。 */
  action: { opened: boolean; positionId: string | null; txHash: string | null };
  /** （加分）ERC-8126 agent 可信度標記。 */
  agentVerification?: { overallRiskScore: number; riskTier: string } | null;
  /** hash chain：前一筆的 hash（第一筆為 null）。由 appendAudit 填入。 */
  prevHash?: string | null;
  /** 本筆內容（不含 hash 欄位本身）的 keccak 摘要。由 appendAudit 填入。 */
  hash?: string;
}

/** 穩定的 VC 識別碼：proofValue 的 keccak 摘要（不外洩簽章原文）。 */
export function vcId(vc?: AuthorizationVC | null): string | null {
  if (!vc?.proof?.proofValue) return null;
  return ethers.id(vc.proof.proofValue);
}

/** 遞迴排序 key 的決定性 JSON —— hash 必須與欄位順序無關。 */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`).join(",")}}`;
}

/**
 * VC ↔ 紀錄內容的綁定摘要。把 VC 摘要與「這一筆到底做了什麼」綁在一起，
 * 於是「同一張 VC 但內容被改過」的紀錄會立刻被抓到。
 */
export function vcBinding(rec: Pick<AuditRecord, "issuerDid" | "agentDid" | "sessionId" | "research" | "decision"> & {
  vcIdValue: string | null;
}): string | null {
  if (!rec.vcIdValue) return null;
  return ethers.id(
    canonicalJson({
      vcId: rec.vcIdValue,
      issuerDid: rec.issuerDid,
      agentDid: rec.agentDid,
      sessionId: rec.sessionId,
      resource: rec.research.resource,
      side: rec.decision.side,
    }),
  );
}

/** 任何可進 hash chain 的紀錄（交易決策、policy gate 寫入嘗試…）。 */
export interface ChainedRecord {
  prevHash?: string | null;
  hash?: string;
}

/** 本筆紀錄的 hash（不含 `hash` 欄位本身，含 `prevHash`）。 */
export function recordHash(rec: ChainedRecord): string {
  const { hash: _ignored, ...rest } = rec;
  return ethers.id(canonicalJson(rest));
}

/**
 * 讀出檔案最後一筆的 hash（沒有紀錄時回 null）。
 * 只讀檔尾（複審 Low-5）：舊版每次 append 都把整個 JSONL 讀進來 parse，稽核檔越長越慢、
 * 而且是在鎖內做——等於把所有寫入嘗試的延遲綁在檔案大小上。
 */
export function lastAuditHash(filePath: string): string | null {
  const line = readLastLine(filePath);
  if (!line) return null;
  return (JSON.parse(line) as ChainedRecord).hash ?? null;
}

/**
 * 從檔尾往前讀，回最後一個非空行（檔案不存在或全空回 null）。
 * 只有 ENOENT 算「不存在」：fs.existsSync 遇 EPERM／EACCES 也回 false，會讓下一筆的 prevHash
 * 變成 null、hash chain 分岔（PR #213 審查 Medium-1）。其他錯誤（暫時性錯誤重試用盡後）照樣丟出，
 * 呼叫端（appendChainedRecord／appendAudit）因此寫入失敗 → fail-closed。
 */
export function readLastLine(filePath: string, chunk = 64 * 1024): string | null {
  let fd: number;
  try {
    fd = retryTransientSync(() => fs.openSync(filePath, "r"));
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
  try {
    // 以 byte 為單位往前找換行（0x0a），最後才一次 decode——不會把多位元組的 UTF-8
    // 字元（稽核訊息是中文）切在 chunk 邊界上。
    let pos = fs.fstatSync(fd).size;
    let tail = Buffer.alloc(0);
    while (pos > 0) {
      const len = Math.min(chunk, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, pos);
      tail = Buffer.concat([buf, tail]);
      let end = tail.length;
      while (end > 0 && (tail[end - 1] === 0x0a || tail[end - 1] === 0x0d || tail[end - 1] === 0x20)) end--;
      if (end === 0) continue;
      const nl = tail.lastIndexOf(0x0a, end - 1);
      if (nl >= 0) return tail.subarray(nl + 1, end).toString("utf8");
      if (pos === 0) return tail.subarray(0, end).toString("utf8");
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 通用版 append：任何紀錄型別都用同一條 hash chain 規則（prevHash＝前一筆 hash，
 * hash＝不含 hash 欄位的 canonical JSON 摘要），可用 `verifyAuditChain` 驗。
 * policy gate 的寫入嘗試稽核（policyGate.ts）走這裡，寫到自己的檔案。
 */
export function appendChainedRecord<T extends ChainedRecord>(filePath: string, rec: T): T {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // 讀 prevHash → 寫本筆 必須是原子的：多個 process 同時 append 會讓 hash chain 分岔。
  return withFileLockSync(filePath, () => {
    const chained: T = { ...rec, prevHash: lastAuditHash(filePath) };
    chained.hash = recordHash(chained);
    fs.appendFileSync(filePath, JSON.stringify(chained) + "\n", "utf8");
    return chained;
  });
}

/**
 * 附加一筆稽核紀錄（JSONL）；自動建目錄、自動補上 vc.binding 與 hash chain。
 * 呼叫端不需要（也不應該）自己算這些欄位。
 */
export function appendAudit(filePath: string, rec: AuditRecord): AuditRecord {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const chained: AuditRecord = {
    ...rec,
    vc: {
      ...rec.vc,
      binding:
        rec.vc.binding ??
        vcBinding({
          vcIdValue: rec.vc.id,
          issuerDid: rec.issuerDid,
          agentDid: rec.agentDid,
          sessionId: rec.sessionId,
          research: rec.research,
          decision: rec.decision,
        }),
    },
  };
  return withFileLockSync(filePath, () => {
    chained.prevHash = lastAuditHash(filePath);
    chained.hash = recordHash(chained);
    fs.appendFileSync(filePath, JSON.stringify(chained) + "\n", "utf8");
    return chained;
  });
}

/** 讀回所有稽核紀錄。 */
export function readAudit(filePath: string): AuditRecord[] {
  // 同上：讀不到（EPERM 等）時丟錯，不回空陣列 —— 否則 verifyAuditChain([]) 會把「讀不到」驗成「完整」。
  let raw: string;
  try {
    raw = retryTransientSync(() => fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AuditRecord);
}

export interface ChainIssue {
  index: number;
  problem: string;
}

/**
 * 驗證整條 hash chain：每筆的 hash 必須等於重算值，且 prevHash 必須等於前一筆的
 * hash。回空陣列代表整條鏈完整（沒有事後竄改、刪除或重排）。
 */
export function verifyAuditChain(records: ChainedRecord[]): ChainIssue[] {
  const issues: ChainIssue[] = [];
  let prev: string | null = null;
  records.forEach((rec, i) => {
    if (!rec.hash) {
      issues.push({ index: i, problem: "缺 hash 欄位（舊格式或被移除）" });
    } else if (recordHash(rec) !== rec.hash) {
      issues.push({ index: i, problem: "hash 與內容不符 → 本筆已被竄改" });
    }
    const declaredPrev = rec.prevHash ?? null;
    if (declaredPrev !== prev) {
      issues.push({
        index: i,
        problem: `prevHash(${declaredPrev ?? "null"}) 與前一筆 hash(${prev ?? "null"}) 不符 → 有紀錄被刪除/插入/重排`,
      });
    }
    prev = rec.hash ?? null;
  });
  return issues;
}
