// 授權 VC 的撤銷（狀態清單）—— ADR-016。
//
// 設計摘要（細節與取捨見 docs/ADR-016-vc-credential-status.md）：
//   • 狀態清單由 **VC 的簽發者**（使用者錢包）以 EIP-712 簽章，domain 與 v2 VC 相同
//     （authDomainV2(session manager)），primary type 不同。一個簽發者、一個部署一份清單。
//   • 清單項目是憑證 id（jti）：v2 = credentialSubject.nonce；v1 = EIP-712 digest。
//     另有 revokedBefore：簽發者所有 issuedAt < revokedBefore 的憑證一律撤銷。
//   • 防重放：清單有 issuedAt／validUntil／單調遞增的 sequence。驗證端把每個簽發者接受過的
//     最高 sequence 與「看過的所有撤銷」記在狀態檔（sticky）：舊清單被拒、撤銷不會因為之後
//     拿到較舊或缺項的清單而「復活」。
//   • 驗證端快取清單，快取新鮮度上限 VC_STATUS_CACHE_MAX_AGE_SEC（預設 60 秒，上限 900 秒）。
//   • 失敗行為：寫入類（開倉、平倉、付款、開 session）拿不到或驗不過狀態 → 一律拒絕；
//     唯讀類依 VC_STATUS_READ_POLICY（預設 allow：放行但標 status=unknown 並帶警告）。
//     已知被撤銷（revoked）不論唯讀或寫入一律拒絕。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { MAX_CLOCK_SKEW_SEC, parseDidPkh, type TypedDataSigner, type VerifyResult } from "./identity.ts";
import { getSessionManagerAddress } from "./provider.ts";
import { isNotFound, retryTransientSync, withFileLockSync } from "./fileLock.ts";
import {
  AUTH_VC_CHAIN_ID,
  DEFAULT_STATUS_LIST_VALIDITY_SEC,
  MAX_STATUS_LIST_ENTRIES,
  MAX_STATUS_LIST_VALIDITY_SEC,
  STATUS_LIST_TYPES,
  assembleStatusList,
  buildStatusListTypedValue,
  canonicalRevokedIds,
  isCanonicalRevokedIds,
  statusListDomain,
  type CredentialStatusList,
} from "../../../frontend/src/contracts/agentAuthStatus";

export {
  DEFAULT_STATUS_LIST_VALIDITY_DAYS,
  DEFAULT_STATUS_LIST_VALIDITY_SEC,
  MAX_STATUS_LIST_ENTRIES,
  MAX_STATUS_LIST_VALIDITY_SEC,
  STATUS_LIST_PRIMARY_TYPE,
  STATUS_LIST_TYPES,
  assembleStatusList,
  buildStatusListTypedValue,
  canonicalRevokedIds,
  isCanonicalRevokedIds,
  statusListDomain,
} from "../../../frontend/src/contracts/agentAuthStatus";
export type { CredentialStatusList, StatusListFields } from "../../../frontend/src/contracts/agentAuthStatus";

const ZERO = "0x0000000000000000000000000000000000000000";
const TYPES: Record<string, ethers.TypedDataField[]> = STATUS_LIST_TYPES;
const isSafeUint = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// ── jti ───────────────────────────────────────────────────────────────────────

/**
 * 憑證 id（jti）。v2 = 簽進 EIP-712 的 `nonce`（每張憑證隨機 bytes32，本來就是 jti，
 * 不另立欄位）；v1 沒有 nonce，用 EIP-712 digest（同一份內容＝同一張憑證）。
 * 傳入的必須是 verifyAuthorizationVC 的結果（valid 與否都可，只要帶得出 nonce／digest）。
 */
export function credentialJti(res: Pick<VerifyResult, "version" | "nonce" | "digest">): string | null {
  const id = res.version === 2 ? res.nonce : res.digest;
  if (!id || !/^0x[0-9a-fA-F]{64}$/.test(id)) return null;
  return id.toLowerCase();
}

// ── 簽發 ──────────────────────────────────────────────────────────────────────

export interface IssueStatusListOptions {
  /** 單調遞增的版本號。必須大於這個簽發者先前發佈過的任何清單。 */
  sequence: number;
  /** 預設現在（unix 秒）。 */
  issuedAt?: number;
  /** 預設 issuedAt + 30 天；不得超過 issuedAt + 90 天。 */
  validUntil?: number;
  /** 撤銷所有 issuedAt < revokedBefore 的憑證；預設 0（不用）。不得晚於 issuedAt。 */
  revokedBefore?: number;
  /** 要撤銷的憑證 id（jti）。會正規化（小寫、去重、排序）。 */
  revoked?: string[];
  /** session manager 位址（domain 的 verifyingContract）。預設 SESSION_MANAGER_ADDRESS。 */
  verifyingContract?: string;
}

/**
 * 以連線錢包（MetaMask／viem／HSM）的 typed-data 簽章端簽發狀態清單。與 VC 的
 * `issueAuthorizationVCWithSigner` 用同一把簽發者金鑰、同一個 domain —— 不新增金鑰類型。
 */
export async function issueStatusListWithSigner(
  params: { issuerAddress: string; signTypedData: TypedDataSigner } & IssueStatusListOptions,
): Promise<CredentialStatusList> {
  const issuer = ethers.getAddress(params.issuerAddress);
  const issuedAt = params.issuedAt ?? Math.floor(Date.now() / 1000);
  const validUntil = params.validUntil ?? issuedAt + DEFAULT_STATUS_LIST_VALIDITY_SEC;
  const revokedBefore = params.revokedBefore ?? 0;
  const revoked = canonicalRevokedIds(params.revoked ?? []);
  const verifyingContract = params.verifyingContract ?? getSessionManagerAddress();
  if (!ethers.isAddress(verifyingContract) || verifyingContract.toLowerCase() === ZERO) {
    throw new Error("狀態清單需要 verifyingContract（session manager 位址）；請傳入或設定 SESSION_MANAGER_ADDRESS");
  }
  for (const [k, v] of Object.entries({ sequence: params.sequence, issuedAt, validUntil, revokedBefore })) {
    if (!isSafeUint(v)) throw new Error(`${k} 必須是非負整數：${v}`);
  }
  if (validUntil <= issuedAt) throw new Error(`validUntil(${validUntil}) 必須晚於 issuedAt(${issuedAt})`);
  if (validUntil - issuedAt > MAX_STATUS_LIST_VALIDITY_SEC) {
    throw new Error(`清單有效期不得超過 ${MAX_STATUS_LIST_VALIDITY_SEC / 86400} 天`);
  }
  if (revokedBefore > issuedAt) throw new Error(`revokedBefore(${revokedBefore}) 不得晚於 issuedAt(${issuedAt})`);
  if (revoked.length > MAX_STATUS_LIST_ENTRIES) throw new Error(`撤銷項目超過上限 ${MAX_STATUS_LIST_ENTRIES}`);

  const fields = { issuer, sequence: params.sequence, issuedAt, validUntil, revokedBefore, revoked };
  const vc = ethers.getAddress(verifyingContract);
  const signature = await params.signTypedData(statusListDomain(vc), TYPES, buildStatusListTypedValue(fields));
  return assembleStatusList({ ...fields, issuerAddress: issuer, signature, verifyingContract: vc });
}

/** 以本機金鑰簽發（測試／CLI 用）；瀏覽器流程用 issueStatusListWithSigner。 */
export async function issueStatusList(
  params: { issuer: ethers.Wallet | ethers.HDNodeWallet } & IssueStatusListOptions,
): Promise<CredentialStatusList> {
  return issueStatusListWithSigner({
    ...params,
    issuerAddress: await params.issuer.getAddress(),
    signTypedData: (d, t, v) => params.issuer.signTypedData(d, t, v),
  });
}

// ── 驗證清單本身 ──────────────────────────────────────────────────────────────

export type StatusListReason =
  | "STATUS_LIST_MALFORMED"
  | "STATUS_LIST_WRONG_CHAIN"
  | "STATUS_LIST_BAD_SIGNATURE"
  | "STATUS_LIST_WRONG_ISSUER"
  | "STATUS_LIST_WRONG_DOMAIN"
  | "STATUS_LIST_EXPIRED"
  | "STATUS_LIST_ISSUED_IN_FUTURE"
  | "STATUS_LIST_VALIDITY_TOO_LONG"
  | "STATUS_LIST_TOO_LARGE";

export interface VerifiedStatusList {
  issuer: string;
  sequence: number;
  issuedAt: number;
  validUntil: number;
  revokedBefore: number;
  revoked: string[];
  verifyingContract: string;
  /** EIP-712 digest：同 sequence 不同內容（equivocation）用它判斷。 */
  digest: string;
}

export type StatusListVerifyResult =
  | { valid: true; list: VerifiedStatusList }
  | { valid: false; reasonCode: StatusListReason; reason: string };

export interface VerifyStatusListOptions {
  /** 現在（**毫秒**）。省略為 Date.now()。 */
  now?: number;
  /** 必須是這個簽發者的清單。 */
  expectedIssuer?: string;
  /** 必須綁這個 session manager。 */
  expectedVerifyingContract?: string;
}

/** 驗證清單的結構、簽章、簽發者、domain 與時效。純函式（無狀態；防重放見 StatusStateStore）。 */
export function verifyStatusList(doc: unknown, opts: VerifyStatusListOptions = {}): StatusListVerifyResult {
  const nowMs = opts.now ?? Date.now();
  const bad = (reasonCode: StatusListReason, reason: string): StatusListVerifyResult => ({ valid: false, reasonCode, reason });
  try {
    const d = doc as Partial<CredentialStatusList>;
    if (!d || typeof d !== "object" || !Array.isArray(d.type) || !d.type.includes("AgentCredentialStatusList")) {
      return bad("STATUS_LIST_MALFORMED", "不是 AgentCredentialStatusList");
    }
    if (!d.proof?.proofValue || d.proof.eip712Domain?.version !== "2") {
      return bad("STATUS_LIST_MALFORMED", "缺 proof 或 eip712Domain");
    }
    const { sequence, issuedAt, validUntil, revokedBefore, revoked } = d;
    if (![sequence, issuedAt, validUntil, revokedBefore].every(isSafeUint)) {
      return bad("STATUS_LIST_MALFORMED", "sequence／issuedAt／validUntil／revokedBefore 必須是非負整數");
    }
    if (!isCanonicalRevokedIds(revoked)) {
      return bad("STATUS_LIST_MALFORMED", "revoked 必須是小寫 bytes32、嚴格遞增排序（不可重複）");
    }
    if (revoked.length > MAX_STATUS_LIST_ENTRIES) {
      return bad("STATUS_LIST_TOO_LARGE", `撤銷項目 ${revoked.length} 超過上限 ${MAX_STATUS_LIST_ENTRIES}`);
    }
    const did = parseDidPkh(String(d.issuer));
    if (did.chainId !== AUTH_VC_CHAIN_ID) {
      return bad("STATUS_LIST_WRONG_CHAIN", `issuer DID 的 chainId(${did.chainId}) 非 ${AUTH_VC_CHAIN_ID}`);
    }
    const issuer = did.address;
    const vcAddr = String(d.proof.eip712Domain.verifyingContract);
    if (!ethers.isAddress(vcAddr)) return bad("STATUS_LIST_MALFORMED", "eip712Domain.verifyingContract 不是合法地址");
    const verifyingContract = ethers.getAddress(vcAddr);

    const fields = {
      issuer,
      sequence: sequence as number,
      issuedAt: issuedAt as number,
      validUntil: validUntil as number,
      revokedBefore: revokedBefore as number,
      revoked: revoked as string[],
    };
    const domain = statusListDomain(verifyingContract);
    const value = buildStatusListTypedValue(fields);
    const recovered = ethers.verifyTypedData(domain, TYPES, value, d.proof.proofValue);
    if (recovered === ZERO || ethers.getAddress(recovered) !== issuer) {
      return bad("STATUS_LIST_BAD_SIGNATURE", `簽章與 issuer 不符（還原出 ${recovered}）`);
    }
    if (opts.expectedIssuer && ethers.getAddress(opts.expectedIssuer) !== issuer) {
      return bad("STATUS_LIST_WRONG_ISSUER", `清單的簽發者(${issuer}) 不是 VC 的簽發者(${ethers.getAddress(opts.expectedIssuer)})`);
    }
    if (opts.expectedVerifyingContract && ethers.getAddress(opts.expectedVerifyingContract) !== verifyingContract) {
      return bad("STATUS_LIST_WRONG_DOMAIN", `清單綁定的 session manager(${verifyingContract}) 不是本驗證端使用的`);
    }
    if (fields.validUntil <= fields.issuedAt || fields.revokedBefore > fields.issuedAt) {
      return bad("STATUS_LIST_MALFORMED", "validUntil 必須晚於 issuedAt，revokedBefore 不得晚於 issuedAt");
    }
    if (fields.validUntil - fields.issuedAt > MAX_STATUS_LIST_VALIDITY_SEC) {
      return bad("STATUS_LIST_VALIDITY_TOO_LONG", `清單有效期超過 ${MAX_STATUS_LIST_VALIDITY_SEC / 86400} 天`);
    }
    if (fields.issuedAt * 1000 > nowMs + MAX_CLOCK_SKEW_SEC * 1000) {
      return bad("STATUS_LIST_ISSUED_IN_FUTURE", `清單 issuedAt 晚於現在 ${MAX_CLOCK_SKEW_SEC} 秒以上`);
    }
    if (fields.validUntil * 1000 <= nowMs) {
      return bad("STATUS_LIST_EXPIRED", `清單已於 ${new Date(fields.validUntil * 1000).toISOString()} 過期，請簽發者重新簽署`);
    }
    const digest = ethers.TypedDataEncoder.hash(domain, TYPES, value);
    return { valid: true, list: { ...fields, verifyingContract, digest } };
  } catch (err) {
    return bad("STATUS_LIST_MALFORMED", (err as Error).message);
  }
}

/** 單純比對：這張 VC 是否落在某份（已驗證的）撤銷資料裡。 */
export function isCredentialRevoked(
  res: Pick<VerifyResult, "version" | "nonce" | "digest" | "issuedAt">,
  view: { revokedBefore: number; revoked: readonly string[] | ReadonlySet<string> },
): boolean {
  const jti = credentialJti(res);
  const set = view.revoked instanceof Set ? view.revoked : new Set(view.revoked as readonly string[]);
  if (jti && set.has(jti)) return true;
  return Number(res.issuedAt ?? 0) < view.revokedBefore;
}

// ── 驗證端狀態（防重放＋撤銷不復活）───────────────────────────────────────────

export interface IssuerStatusState {
  /** 接受過的最高 sequence。 */
  sequence: number;
  /** 該 sequence 清單的 digest。 */
  digest: string;
  validUntil: number;
  /** 看過的最大 revokedBefore。 */
  revokedBefore: number;
  /** 看過的所有撤銷 id 的聯集（sticky）。 */
  revoked: string[];
  acceptedAt: number;
}

export type StateFailure = "STATUS_STATE_UNREADABLE" | "STATUS_STATE_WRITE_FAILED" | "STATUS_STATE_LOCK_FAILED";

export type AcceptResult =
  | { ok: true; state: IssuerStatusState }
  | { ok: false; reasonCode: "STATUS_LIST_REPLAYED" | "STATUS_LIST_EQUIVOCATION" | StateFailure; message: string };

/** 驗證端持久狀態。鍵 = `${verifyingContract}|${issuer}`（小寫）。 */
export interface StatusStateStore {
  /** 讀不到（檔案壞掉等）丟錯；沒有紀錄回 null。 */
  get(key: string): IssuerStatusState | null;
  accept(key: string, list: VerifiedStatusList, nowSec: number): AcceptResult;
}

export function stateKey(verifyingContract: string, issuer: string): string {
  return `${verifyingContract.toLowerCase()}|${issuer.toLowerCase()}`;
}

function merge(cur: IssuerStatusState | undefined, list: VerifiedStatusList, nowSec: number): AcceptResult {
  if (!cur) {
    return {
      ok: true,
      state: {
        sequence: list.sequence,
        digest: list.digest,
        validUntil: list.validUntil,
        revokedBefore: list.revokedBefore,
        revoked: [...list.revoked],
        acceptedAt: nowSec,
      },
    };
  }
  if (list.sequence < cur.sequence) {
    return {
      ok: false,
      reasonCode: "STATUS_LIST_REPLAYED",
      message: `收到舊版狀態清單（sequence ${list.sequence} < 已接受的 ${cur.sequence}），拒絕`,
    };
  }
  if (list.sequence === cur.sequence) {
    if (list.digest !== cur.digest) {
      return {
        ok: false,
        reasonCode: "STATUS_LIST_EQUIVOCATION",
        message: `同一個 sequence(${list.sequence}) 出現兩份內容不同的清單，拒絕`,
      };
    }
    return { ok: true, state: cur };
  }
  return {
    ok: true,
    state: {
      sequence: list.sequence,
      digest: list.digest,
      validUntil: list.validUntil,
      revokedBefore: Math.max(cur.revokedBefore, list.revokedBefore),
      revoked: [...new Set([...cur.revoked, ...list.revoked])].sort(),
      acceptedAt: nowSec,
    },
  };
}

/** 記憶體版（SDK、測試、單 process 使用）。 */
export function memoryStatusStateStore(): StatusStateStore {
  const m = new Map<string, IssuerStatusState>();
  return {
    get: (key) => m.get(key) ?? null,
    accept: (key, list, nowSec) => {
      const r = merge(m.get(key), list, nowSec);
      if (r.ok) m.set(key, r.state);
      return r;
    },
  };
}

interface StatusStateFile {
  version: 1;
  issuers: Record<string, IssuerStatusState>;
}

function readStateFile(file: string): StatusStateFile {
  // 不用 existsSync（EPERM 會被當成不存在 → 狀態歸零；同 vcNonce.ts 的教訓）。
  let raw: string;
  try {
    raw = retryTransientSync(() => fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (isNotFound(e)) return { version: 1, issuers: {} };
    throw e;
  }
  const s = JSON.parse(raw);
  if (s?.version !== 1 || !s.issuers || typeof s.issuers !== "object") throw new Error("vc status 狀態檔格式不符");
  for (const e of Object.values(s.issuers) as IssuerStatusState[]) {
    if (!isSafeUint(e?.sequence) || typeof e.digest !== "string" || !isSafeUint(e.revokedBefore) || !Array.isArray(e.revoked)) {
      throw new Error("vc status 紀錄格式不符");
    }
  }
  return s as StatusStateFile;
}

/**
 * 檔案版（預設 agent/.state/vc-status-state.json，env VC_STATUS_STATE_PATH）。MCP、tg-bot、
 * x402 agent 在同一台機器共用；檔案鎖序列化讀改寫（fileLock.ts）。檔案讀不到或格式不符 → 丟錯，
 * 呼叫端視為狀態未知（寫入拒絕）。刪除檔案＝忘記已接受的 sequence 與撤銷（見 ADR-016 §7）。
 */
export function fileStatusStateStore(file: string, opts: { lockTimeoutMs?: number } = {}): StatusStateStore {
  return {
    get: (key) => readStateFile(file).issuers[key] ?? null,
    accept: (key, list, nowSec) => {
      try {
        return withFileLockSync(
          file,
          (): AcceptResult => {
            let s: StatusStateFile;
            try {
              s = readStateFile(file);
            } catch {
              return { ok: false, reasonCode: "STATUS_STATE_UNREADABLE", message: "VC 狀態檔無法讀取或格式不符（fail-closed）" };
            }
            const cur = s.issuers[key];
            const r = merge(cur, list, nowSec);
            if (!r.ok || r.state === cur) return r;
            s.issuers[key] = r.state;
            try {
              fs.mkdirSync(path.dirname(file), { recursive: true });
              const tmp = `${file}.${process.pid}.tmp`;
              retryTransientSync(() => fs.writeFileSync(tmp, JSON.stringify(s), "utf8"));
              retryTransientSync(() => fs.renameSync(tmp, file));
            } catch {
              return { ok: false, reasonCode: "STATUS_STATE_WRITE_FAILED", message: "VC 狀態檔無法寫入（fail-closed）" };
            }
            return r;
          },
          { timeoutMs: opts.lockTimeoutMs },
        );
      } catch {
        return { ok: false, reasonCode: "STATUS_STATE_LOCK_FAILED", message: "VC 狀態檔鎖取得失敗" };
      }
    },
  };
}

// ── 清單來源 ──────────────────────────────────────────────────────────────────

export type StatusFetch =
  | { kind: "list"; doc: unknown }
  /** 來源明確回答「這個簽發者沒有發佈過清單」。 */
  | { kind: "none" }
  | { kind: "unavailable"; reason: string };

export interface StatusSource {
  readonly describe: string;
  fetch(issuer: string): Promise<StatusFetch>;
}

const issuerFile = (issuer: string) => `${ethers.getAddress(issuer).toLowerCase()}.json`;

/**
 * 本機目錄：`<dir>/<issuer 小寫>.json`。檔案不存在（含目錄不存在）＝沒有清單——目錄是驗證端
 * 自己的信任範圍（由營運者以 `vc-status install` 放入）。讀不到或不是 JSON → unavailable。
 */
export function dirStatusSource(dir: string): StatusSource {
  return {
    describe: `dir:${dir}`,
    fetch: async (issuer) => {
      let raw: string;
      try {
        raw = retryTransientSync(() => fs.readFileSync(path.join(dir, issuerFile(issuer)), "utf8"));
      } catch (e) {
        if (isNotFound(e)) return { kind: "none" };
        return { kind: "unavailable", reason: `讀取狀態清單失敗：${(e as NodeJS.ErrnoException).code ?? "IO"}` };
      }
      try {
        return { kind: "list", doc: JSON.parse(raw) };
      } catch {
        return { kind: "unavailable", reason: "狀態清單檔不是合法 JSON" };
      }
    },
  };
}

/** HTTP 來源的目錄標記檔：證明 base URL 真的指向一個狀態清單目錄（防設定錯誤時 404 被當成「沒有撤銷」）。 */
export const STATUS_DIRECTORY_TYPE = "AgentCredentialStatusDirectory";

export interface HttpStatusSourceOptions {
  fetchImpl?: (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
    status: number;
    text(): Promise<string>;
  }>;
  /** 單次請求逾時（毫秒），預設 3000。 */
  timeoutMs?: number;
}

/**
 * HTTP(S) 來源：`<base>/<issuer 小寫>.json`，任何靜態主機都可以（清單自帶簽章，主機不需被信任，
 * 只影響可用性）。第一次使用先取 `<base>/index.json`，必須是
 * `{"type":"AgentCredentialStatusDirectory"}`；成功後才把 404 視為「沒有清單」。
 * 其餘狀態碼、逾時、網路錯誤 → unavailable。
 */
export function httpStatusSource(baseUrl: string, opts: HttpStatusSourceOptions = {}): StatusSource {
  const base = baseUrl.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new Error(`VC_STATUS_URL 必須是 http(s) URL：${baseUrl}`);
  const doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? 3000;
  let directoryOk = false;

  async function get(url: string): Promise<{ status: number; body: string } | { error: string }> {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 逾時以 race 實作（不只靠 abort）：注入的 fetch 不理 signal、或卡在讀 body，照樣會逾時。
    const timeout = new Promise<{ error: string }>((resolve) => {
      timer = setTimeout(() => {
        ac.abort();
        resolve({ error: "逾時" });
      }, timeoutMs);
    });
    const attempt = (async () => {
      try {
        const r = await doFetch(url, { signal: ac.signal, headers: { accept: "application/json" } });
        return { status: r.status, body: await r.text() };
      } catch (e) {
        return { error: ac.signal.aborted ? "逾時" : (e as Error).name || "network" };
      }
    })();
    try {
      return await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    describe: `http:${base}`,
    fetch: async (issuer) => {
      if (!directoryOk) {
        const idx = await get(`${base}/index.json`);
        if ("error" in idx) return { kind: "unavailable", reason: `狀態清單目錄無法連線（${idx.error}）` };
        let t: unknown;
        try {
          t = JSON.parse(idx.body)?.type;
        } catch {
          t = undefined;
        }
        if (idx.status !== 200 || t !== STATUS_DIRECTORY_TYPE) {
          return { kind: "unavailable", reason: `狀態清單目錄標記不符（HTTP ${idx.status}）` };
        }
        directoryOk = true;
      }
      const r = await get(`${base}/${issuerFile(issuer)}`);
      if ("error" in r) return { kind: "unavailable", reason: `狀態清單無法取得（${r.error}）` };
      if (r.status === 404) return { kind: "none" };
      if (r.status !== 200) return { kind: "unavailable", reason: `狀態清單 HTTP ${r.status}` };
      try {
        return { kind: "list", doc: JSON.parse(r.body) };
      } catch {
        return { kind: "unavailable", reason: "狀態清單不是合法 JSON" };
      }
    },
  };
}

// ── 檢查器（快取＋新鮮度＋失敗行為）──────────────────────────────────────────

export type StatusAction = "write" | "read";
export type ReadPolicy = "allow" | "deny";

export const DEFAULT_STATUS_CACHE_MAX_AGE_SEC = 60;
/** 快取新鮮度的硬上限：設定再大也不會超過（＝撤銷發佈後最遲多久生效，在來源可用的前提下）。 */
export const MAX_STATUS_CACHE_MAX_AGE_SEC = 900;

export type CredentialStatusReason =
  | "STATUS_ACTIVE"
  | "STATUS_NO_LIST"
  | "VC_REVOKED"
  | "STATUS_UNAVAILABLE"
  | "STATUS_LIST_WITHHELD"
  | "STATUS_JTI_MISSING"
  | "STATUS_LIST_REPLAYED"
  | "STATUS_LIST_EQUIVOCATION"
  | StatusListReason
  | StateFailure;

export interface CredentialStatusResult {
  /** 是否放行這個動作。 */
  ok: boolean;
  status: "active" | "revoked" | "unknown";
  reasonCode: CredentialStatusReason;
  message: string;
  jti?: string;
  listSequence?: number;
  listValidUntil?: number;
  /** 本次是否沿用快取的清單（未打來源）。 */
  fromCache?: boolean;
  warnings?: string[];
}

export interface VcStatusCheckerOptions {
  source: StatusSource;
  store: StatusStateStore;
  /** 時鐘（毫秒）。測試注入；預設 Date.now。 */
  now?: () => number;
  /** 快取新鮮度上限（秒），預設 60，最大 900。0 = 每次都打來源。 */
  cacheMaxAgeSec?: number;
  /** 唯讀動作在狀態未知時：allow（預設，放行並警告）或 deny。 */
  readPolicy?: ReadPolicy;
}

export interface CheckOptions {
  action: StatusAction;
  /** 本驗證端使用的 session manager（清單 domain 必須綁它）。預設 VC 的 verifyingContract，再退 SESSION_MANAGER_ADDRESS。 */
  verifyingContract?: string;
}

export interface VcStatusChecker {
  check(res: VerifyResult, opts: CheckOptions): Promise<CredentialStatusResult>;
  /** 清掉快取（測試／換設定）。 */
  clearCache(): void;
  readonly describe: string;
}

type CacheEntry = { fetchedAt: number } & ({ kind: "list"; list: VerifiedStatusList } | { kind: "none" });

export function createVcStatusChecker(o: VcStatusCheckerOptions): VcStatusChecker {
  const now = o.now ?? (() => Date.now());
  const maxAgeMs =
    Math.min(Math.max(0, Number.isFinite(o.cacheMaxAgeSec) ? Number(o.cacheMaxAgeSec) : DEFAULT_STATUS_CACHE_MAX_AGE_SEC), MAX_STATUS_CACHE_MAX_AGE_SEC) *
    1000;
  const readPolicy: ReadPolicy = o.readPolicy ?? "allow";
  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<CacheEntry | CredentialStatusResult>>();

  const unknown = (
    action: StatusAction,
    reasonCode: CredentialStatusReason,
    message: string,
    extra: Partial<CredentialStatusResult> = {},
  ): CredentialStatusResult => {
    if (action === "read" && readPolicy === "allow") {
      return {
        ok: true,
        status: "unknown",
        reasonCode,
        message,
        ...extra,
        warnings: [`VC 狀態未知（${reasonCode}）：唯讀動作依 VC_STATUS_READ_POLICY=allow 放行`],
      };
    }
    return { ok: false, status: "unknown", reasonCode, message, ...extra };
  };

  async function load(key: string, issuer: string, vcAddr: string, nowMs: number): Promise<CacheEntry | CredentialStatusResult> {
    const f = await o.source.fetch(issuer);
    if (f.kind === "unavailable") {
      return { ok: false, status: "unknown", reasonCode: "STATUS_UNAVAILABLE", message: `無法取得狀態清單：${f.reason}` };
    }
    if (f.kind === "none") return { kind: "none", fetchedAt: nowMs };
    const v = verifyStatusList(f.doc, { now: nowMs, expectedIssuer: issuer, expectedVerifyingContract: vcAddr });
    if (!v.valid) return { ok: false, status: "unknown", reasonCode: v.reasonCode, message: v.reason };
    const a = o.store.accept(key, v.list, Math.floor(nowMs / 1000));
    if (!a.ok) return { ok: false, status: "unknown", reasonCode: a.reasonCode, message: a.message };
    return { kind: "list", list: v.list, fetchedAt: nowMs };
  }

  return {
    describe: o.source.describe,
    clearCache: () => cache.clear(),
    async check(res, opts) {
      const action = opts.action;
      const nowMs = now();
      const jti = credentialJti(res);
      if (!res.issuer || !jti) {
        return unknown(action, "STATUS_JTI_MISSING", "無法從 VC 取得簽發者或憑證 id（jti）");
      }
      const issuer = ethers.getAddress(res.issuer);
      const vcAddrRaw = opts.verifyingContract ?? res.verifyingContract ?? getSessionManagerAddress();
      if (!ethers.isAddress(vcAddrRaw) || vcAddrRaw.toLowerCase() === ZERO) {
        return unknown(action, "STATUS_UNAVAILABLE", "未設定 session manager 位址，無法定位狀態清單", { jti });
      }
      const vcAddr = ethers.getAddress(vcAddrRaw);
      const key = stateKey(vcAddr, issuer);

      // 1) 已知的撤銷優先（sticky）：來源掛了也照樣拒絕被撤銷的憑證。
      let known: IssuerStatusState | null;
      try {
        known = o.store.get(key);
      } catch {
        return unknown(action, "STATUS_STATE_UNREADABLE", "VC 狀態檔無法讀取或格式不符", { jti });
      }
      if (known && isCredentialRevoked(res, known)) {
        return { ok: false, status: "revoked", reasonCode: "VC_REVOKED", message: `授權憑證已被簽發者撤銷（清單 sequence ${known.sequence}）`, jti, listSequence: known.sequence };
      }

      // 2) 取得目前的清單（快取在新鮮度上限內才沿用）。
      let entry: CacheEntry | undefined;
      let fromCache = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        entry = cache.get(key);
        fromCache = true;
        if (!entry || maxAgeMs === 0 || nowMs - entry.fetchedAt > maxAgeMs || nowMs < entry.fetchedAt) {
          fromCache = false;
          let p = inflight.get(key);
          if (!p) {
            p = load(key, issuer, vcAddr, nowMs).finally(() => inflight.delete(key));
            inflight.set(key, p);
          }
          let got: CacheEntry | CredentialStatusResult;
          try {
            got = await p;
          } catch (e) {
            // 自訂來源或狀態儲存丟例外：一律視為狀態未知，不讓例外穿出去（寫入端拿到結構化的拒絕）。
            got = { ok: false, status: "unknown", reasonCode: "STATUS_UNAVAILABLE", message: `狀態檢查失敗：${(e as Error)?.message ?? e}` };
          }
          if (!("kind" in got)) {
            cache.delete(key);
            return unknown(action, got.reasonCode, got.message, { jti });
          }
          entry = got;
          cache.set(key, entry);
        }
        if (entry.kind !== "none") break;

        // 曾經接受過這個簽發者的清單，來源卻說沒有 → 視為被扣住（withheld），不當成「沒有撤銷」。
        // 快取的「沒有」可能只是比別的 process 接受新清單還早 → 先丟掉快取重取一次。
        let after: IssuerStatusState | null;
        try {
          after = o.store.get(key);
        } catch {
          return unknown(action, "STATUS_STATE_UNREADABLE", "VC 狀態檔無法讀取或格式不符", { jti });
        }
        if (!after) {
          return { ok: true, status: "active", reasonCode: "STATUS_NO_LIST", message: "簽發者沒有發佈狀態清單（沒有撤銷）", jti, fromCache };
        }
        cache.delete(key);
        if (!fromCache) {
          return unknown(action, "STATUS_LIST_WITHHELD", `來源沒有回傳這個簽發者的清單，但本驗證端已接受過 sequence ${after.sequence}`, {
            jti,
            listSequence: after.sequence,
          });
        }
      }
      if (!entry || entry.kind !== "list") {
        return unknown(action, "STATUS_UNAVAILABLE", "無法取得狀態清單", { jti });
      }

      const list = entry.list;
      if (list.validUntil * 1000 <= nowMs) {
        cache.delete(key);
        return unknown(action, "STATUS_LIST_EXPIRED", `狀態清單已於 ${new Date(list.validUntil * 1000).toISOString()} 過期，請簽發者重新簽署`, {
          jti,
          listSequence: list.sequence,
        });
      }
      // 以 sticky 狀態（含本份清單與之前看過的所有撤銷）判斷。
      let merged: IssuerStatusState | null;
      try {
        merged = o.store.get(key);
      } catch {
        return unknown(action, "STATUS_STATE_UNREADABLE", "VC 狀態檔無法讀取或格式不符", { jti });
      }
      const view = merged ?? list;
      const seq = merged?.sequence ?? list.sequence;
      if (isCredentialRevoked(res, view) || isCredentialRevoked(res, list)) {
        return { ok: false, status: "revoked", reasonCode: "VC_REVOKED", message: `授權憑證已被簽發者撤銷（清單 sequence ${seq}）`, jti, listSequence: seq };
      }
      return {
        ok: true,
        status: "active",
        reasonCode: "STATUS_ACTIVE",
        message: `狀態清單 sequence ${seq}：未撤銷`,
        jti,
        listSequence: seq,
        listValidUntil: list.validUntil,
        fromCache,
      };
    },
  };
}

// ── 由環境變數組出預設檢查器 ─────────────────────────────────────────────────

function agentStateDir(): string {
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".state");
  } catch {
    return path.resolve(".state");
  }
}

export function defaultStatusStatePath(): string {
  return process.env.VC_STATUS_STATE_PATH?.trim() || path.join(agentStateDir(), "vc-status-state.json");
}

export function defaultStatusDir(): string {
  return process.env.VC_STATUS_DIR?.trim() || path.join(agentStateDir(), "vc-status");
}

/** VC_STATUS_READ_POLICY：allow（預設）／deny；無法辨識的值當 deny（保守）。 */
export function readPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): ReadPolicy {
  const v = env.VC_STATUS_READ_POLICY?.trim().toLowerCase();
  if (!v || v === "allow") return "allow";
  if (v !== "deny") console.error(`::error::[vc-status] VC_STATUS_READ_POLICY=${v} 無法辨識，改用 deny`);
  return "deny";
}

let memo: { key: string; checker: VcStatusChecker } | null = null;

/**
 * 依環境變數建立（並記住）預設檢查器：
 *   VC_STATUS_URL                 設了 → HTTP 來源；否則本機目錄 VC_STATUS_DIR（預設 agent/.state/vc-status）
 *   VC_STATUS_STATE_PATH          驗證端狀態檔（預設 agent/.state/vc-status-state.json）
 *   VC_STATUS_CACHE_MAX_AGE_SEC   快取新鮮度上限（預設 60，最大 900）
 *   VC_STATUS_READ_POLICY         allow（預設）／deny
 * 設定改變時自動重建（測試可切換）。
 */
export function defaultVcStatusChecker(): VcStatusChecker {
  const url = process.env.VC_STATUS_URL?.trim() || "";
  const dir = defaultStatusDir();
  const statePath = defaultStatusStatePath();
  const maxAgeRaw = process.env.VC_STATUS_CACHE_MAX_AGE_SEC?.trim();
  const maxAge = maxAgeRaw ? Number(maxAgeRaw) : DEFAULT_STATUS_CACHE_MAX_AGE_SEC;
  const readPolicy = readPolicyFromEnv();
  const key = JSON.stringify([url, url ? "" : dir, statePath, maxAge, readPolicy]);
  if (memo?.key === key) return memo.checker;
  const source = url ? httpStatusSource(url) : dirStatusSource(dir);
  const checker = createVcStatusChecker({
    source,
    store: fileStatusStateStore(statePath),
    cacheMaxAgeSec: Number.isFinite(maxAge) ? maxAge : DEFAULT_STATUS_CACHE_MAX_AGE_SEC,
    readPolicy,
  });
  memo = { key, checker };
  return checker;
}

/** 便利函式：以預設檢查器檢查一個已驗簽的 VC。 */
export async function checkCredentialStatus(res: VerifyResult, opts: CheckOptions): Promise<CredentialStatusResult> {
  // 設定錯誤（例如 VC_STATUS_URL 不是 http(s)）或任何意外例外都轉成「狀態未知」，不丟出去：
  // 寫入一律拒絕；唯讀依 VC_STATUS_READ_POLICY。
  try {
    return await defaultVcStatusChecker().check(res, opts);
  } catch (e) {
    const message = `VC 狀態檢查無法執行（設定或內部錯誤）：${(e as Error)?.message ?? e}`;
    if (opts.action === "read" && readPolicyFromEnv() === "allow") {
      return { ok: true, status: "unknown", reasonCode: "STATUS_UNAVAILABLE", message, warnings: [message] };
    }
    return { ok: false, status: "unknown", reasonCode: "STATUS_UNAVAILABLE", message };
  }
}
