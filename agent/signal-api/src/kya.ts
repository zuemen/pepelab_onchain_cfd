// x402 Know-Your-Agent（KYA）閘門 —— docs/SSI_AGENT_DELEGATION.md。
//
// 啟用時（X402_KYA_MODE=on），付費端點在把付款交給 facilitator **之前**要求 agent 出示
// Verifiable Presentation（header `X-Agent-Presentation`），內含使用者簽發的 v3 委託憑證：
//
//   1. presentation：格式、holder 簽章、時間（±120 秒）、綁定本請求（METHOD + 路徑）與本付款
//      （EIP-3009 nonce＋payer）；
//   2. 身分一致：presentation 簽者 ＝ 憑證主體（代理人 DID）＝ x402 付款人（authorization.from）；
//   3. 憑證：EIP-712 簽章、DID 鏈、有效期、綁定的 session manager ＝ 本服務設定的那一顆；
//      本端點在憑證允許的付費端點範圍內；
//   4. 撤銷：ADR-016 狀態清單，**fail-closed**（拿不到或驗不過＝拒絕）；
//   5. 鏈上：sessions(id)＋allowedAssets(id) 逐欄比對（含未撤銷、未到期）；
//   6. 錨定：SessionCredentialAnchor.isAnchored(sessionId, credentialHash)（X402_KYA_ANCHOR=required 時必須）；
//   7. 防重放：同一個 (payer, payment nonce) 只接受一次 presentation；
//   8. 花費：依 credentialHash 以 Upstash 原子預留（每期間＋總額），超過憑證上限 → 403；
//      結算沒有成功（facilitator 拒絕、handler 錯誤、402）→ 退回預留；結算結果不明 → 保留（保守）。
//
// 未付款的請求（還沒有付款 header）不檢查 presentation——它只會拿到 402，沒有錢移動；
// 402 回應會帶 `X-Agent-KYA: required` 告訴 agent 付款時要一併出示。
//
// 預設關閉（X402_KYA_MODE 未設＝off）：與加入 KYA 之前的行為逐位元相同。
import type { Context } from "hono";
import { ethers } from "ethers";
import {
  AGENT_KYA_HEADER,
  AGENT_KYA_SPEND_HEADER,
  AGENT_PRESENTATION_HEADER,
  SESSION_ANCHOR_ABI,
  acceptedDelegationChainIds,
  checkCredentialStatus,
  compareDelegationWithSession,
  delegationAsVerifyResult,
  formatUsdcAtomic,
  matchX402Endpoint,
  paymentAuthorizationOf,
  readOnchainSession,
  verifyDelegationCredential,
  verifyX402Presentation,
  type CredentialStatusResult,
  type OnchainSession,
  type VerifyResult,
} from "@pepelab/shared";

/** invalid＝X402_KYA_MODE 有值但無法辨識：fail-closed，付費端點一律 503（不當成 off）。 */
export type KyaMode = "off" | "on" | "invalid";
export type KyaAnchorPolicy = "required" | "optional" | "off";

export interface KyaConfig {
  mode: KyaMode;
  anchor: KyaAnchorPolicy;
  /** AgentSessionManager whose sessions back the credentials. */
  sessionManager: string | null;
  /** SessionCredentialAnchor address (null = not configured). */
  anchorAddress: string | null;
  acceptedChainIds: number[];
  maxSkewSec: number;
}

const isAddr = (v: string | undefined): v is string =>
  !!v && ethers.isAddress(v) && v.toLowerCase() !== "0x0000000000000000000000000000000000000000";

/**
 * 環境變數：
 *   X402_KYA_MODE            off（預設）｜on —— 其他任何值＝設定錯誤，付費端點 503（fail-closed，不會悄悄關閉）
 *   X402_KYA_ANCHOR          required（預設）｜optional｜off —— 是否要求鏈上錨定
 *   SESSION_MANAGER_ADDRESS  憑證必須綁定的 AgentSessionManager（與 agent 端同一個設定）
 *   SESSION_ANCHOR_ADDRESS   SessionCredentialAnchor 位址
 *   DELEGATION_VC_CHAIN_IDS  接受的 DID 鏈（逗號分隔；預設 AGENT_CHAIN_ID 與 84532）
 *   X402_KYA_MAX_SKEW_SEC    presentation 時間容忍（預設 120，上限 600）
 *   KYA_RPC_URL              讀 session／錨定用的 RPC（預設與 signal-api 相同的 provider）
 */
export function resolveKyaConfig(env: NodeJS.ProcessEnv = process.env): KyaConfig {
  const rawMode = env.X402_KYA_MODE?.trim().toLowerCase() || "off";
  // 安全閘門：只有未設或明確寫 off 才關閉。打錯字（true／1／enabled…）不能變成「以為開了、其實沒開」。
  const mode: KyaMode = rawMode === "off" ? "off" : rawMode === "on" || rawMode === "required" ? "on" : "invalid";
  if (mode === "invalid") console.error(`::error::[kya] X402_KYA_MODE=${rawMode} 無法辨識（只接受 on／off）→ 付費端點一律 503`);
  const rawAnchor = env.X402_KYA_ANCHOR?.trim().toLowerCase() || "required";
  const anchor: KyaAnchorPolicy = rawAnchor === "optional" || rawAnchor === "off" ? rawAnchor : "required";
  const skew = Number(env.X402_KYA_MAX_SKEW_SEC ?? "120");
  return {
    mode,
    anchor,
    sessionManager: isAddr(env.SESSION_MANAGER_ADDRESS?.trim()) ? ethers.getAddress(env.SESSION_MANAGER_ADDRESS!.trim()) : null,
    anchorAddress: isAddr(env.SESSION_ANCHOR_ADDRESS?.trim()) ? ethers.getAddress(env.SESSION_ANCHOR_ADDRESS!.trim()) : null,
    acceptedChainIds: acceptedDelegationChainIds(env),
    maxSkewSec: Number.isFinite(skew) && skew > 0 ? Math.min(skew, 600) : 120,
  };
}

// ── 鏈上讀取 ─────────────────────────────────────────────────────────────────

export interface KyaChainReader {
  /** 讀取端實際連的鏈：憑證的 chainId 必須是這條（DID 鏈＝session 所在的鏈）。 */
  chainId(): Promise<number>;
  session(sessionManager: string, sessionId: number): Promise<OnchainSession>;
  /** 錨定合約綁定的 AgentSessionManager：必須等於 SESSION_MANAGER_ADDRESS，否則錨定權限來自別的 manager。 */
  anchorSessionManager(anchor: string): Promise<string>;
  isAnchored(anchor: string, sessionId: number, credentialHash: string): Promise<boolean>;
}

export function providerKyaChainReader(provider: ethers.ContractRunner): KyaChainReader {
  return {
    chainId: async () => {
      const p = provider as Partial<Pick<ethers.Provider, "getNetwork">>;
      if (typeof p.getNetwork !== "function") throw new Error("KYA 的鏈上讀取來源沒有 getNetwork()");
      return Number((await p.getNetwork()).chainId);
    },
    session: (mgr, id) => readOnchainSession(provider, mgr, id),
    anchorSessionManager: async (anchor) => String(await new ethers.Contract(anchor, SESSION_ANCHOR_ABI, provider).sessionManager()),
    isAnchored: async (anchor, id, h) =>
      Boolean(await new ethers.Contract(anchor, SESSION_ANCHOR_ABI, provider).isAnchored(id, h)),
  };
}

// ── 花費帳（Upstash 原子預留）────────────────────────────────────────────────

export interface KyaSpendLimits {
  maxPerPeriod: bigint;
  periodSeconds: number;
  maxTotal: bigint;
  /** 總額 key 的 TTL（秒）：憑證到期後再留一天。 */
  totalTtlSec: number;
}

export type KyaReserveResult =
  | { ok: true; total: bigint; period: bigint }
  | { ok: false; which: "total" | "period"; total: bigint; period: bigint };

export interface KyaSpendStore {
  reserve(credentialHash: string, amount: bigint, limits: KyaSpendLimits, nowSec: number): Promise<KyaReserveResult>;
  release(credentialHash: string, amount: bigint, limits: KyaSpendLimits, nowSec: number): Promise<void>;
  /** 每個 (payer, payment nonce) 只放行一次：第一次回 true。 */
  claimPresentation(payer: string, paymentNonce: string, ttlSec: number): Promise<boolean>;
  read(credentialHash: string, periodSeconds: number, nowSec: number): Promise<{ total: bigint; period: bigint }>;
  readonly describe: string;
}

export const KYA_SPEND_PREFIX = "x402:kya:spend:";
/** 花費帳 key 的 TTL 上限（秒）；憑證的期間長度與剩餘效期也不得超過（否則累計會比憑證早消失）。 */
export const KYA_MAX_TTL_SEC = 400 * 86_400;
/** 憑證上限的最大值（atomic USDC）：Lua number 能精確表示的整數範圍內。 */
export const KYA_MAX_ATOMIC = 2n ** 53n - 1n;
export const KYA_VP_PREFIX = "x402:kya:vp:";
export const kyaTotalKey = (h: string) => `${KYA_SPEND_PREFIX}${h.toLowerCase()}:total`;

/**
 * 每期間上限是「任何長度為 periodSeconds 的時間窗」內的上限，不是日曆對齊的固定窗。
 *
 * 舊版以 floor(now / period) 切固定窗：在窗口交界前後幾秒內可以連花兩個 maxPerPeriod（2 倍）。
 * 現在把期間切成 KYA_PERIOD_SLOTS 格，預留時加總「目前這格與前 KYA_PERIOD_SLOTS 格」
 * （共 KYA_PERIOD_SLOTS+1 格，涵蓋的時間 ≥ 一整個期間）。被加總的格子一定蓋住結尾在現在的
 * 那個時間窗，所以任何時間窗內的花費都不會超過上限；代價是保守：最多一格（期間的 1/10）
 * 的花費會被多算一段時間。
 */
export const KYA_PERIOD_SLOTS = 10;
export const kyaSlotSeconds = (periodSeconds: number) => Math.max(1, Math.ceil(periodSeconds / KYA_PERIOD_SLOTS));
/** 某時間點所在那一格的 key（預留寫這格；退回也以預留當下的時間找回同一格）。 */
export const kyaSlotKey = (h: string, periodSeconds: number, nowSec: number) =>
  `${KYA_SPEND_PREFIX}${h.toLowerCase()}:p${periodSeconds}:s${Math.floor(nowSec / kyaSlotSeconds(periodSeconds))}`;
/** 要加總的格子，由舊到新；最後一個是目前這格。 */
export const kyaWindowKeys = (h: string, periodSeconds: number, nowSec: number): string[] => {
  const slot = kyaSlotSeconds(periodSeconds);
  return Array.from({ length: KYA_PERIOD_SLOTS + 1 }, (_, i) =>
    kyaSlotKey(h, periodSeconds, nowSec - (KYA_PERIOD_SLOTS - i) * slot),
  );
};

// 檢查與遞增在同一支 Lua 裡（Upstash 單執行緒執行 EVAL）：並行請求不會一起越過上限。
// 金額是 atomic USDC（6 位小數），Lua number 精確到 2^53；閘門拒收上限超過 KYA_MAX_ATOMIC 的憑證。
// 腳本出錯時不會回滾已執行的寫入，所以**所有參數先驗完才寫**；數字以 %.0f 輸出（tostring 在 1e14 以上會變成科學記號）。
export const KYA_RESERVE_SCRIPT = `-- pepelab:kya_reserve
local a = tonumber(ARGV[1])
local mt = tonumber(ARGV[2])
local mp = tonumber(ARGV[3])
local pt = tonumber(ARGV[4])
local tt = tonumber(ARGV[5])
if not (a and mt and mp and pt and tt) or a < 0 or pt < 1 or tt < 1 or pt > ${KYA_MAX_TTL_SEC} or tt > ${KYA_MAX_TTL_SEC} then
  return redis.error_reply('kya_reserve: bad arguments')
end
local t = tonumber(redis.call('GET', KEYS[1]) or '0')
local p = 0
for i = 2, #KEYS do
  p = p + tonumber(redis.call('GET', KEYS[i]) or '0')
end
if t + a > mt then return {0, string.format('%.0f', t), string.format('%.0f', p), 'total'} end
if p + a > mp then return {0, string.format('%.0f', t), string.format('%.0f', p), 'period'} end
redis.call('INCRBY', KEYS[1], a)
redis.call('EXPIRE', KEYS[1], tt)
redis.call('INCRBY', KEYS[#KEYS], a)
redis.call('EXPIRE', KEYS[#KEYS], pt)
return {1, string.format('%.0f', t + a), string.format('%.0f', p + a), 'ok'}`;

export const KYA_RELEASE_SCRIPT = `-- pepelab:kya_release
local a = tonumber(ARGV[1])
for i = 1, 2 do
  local v = tonumber(redis.call('GET', KEYS[i]) or '0')
  if v > 0 then
    local n = v - a
    if n < 0 then n = 0 end
    redis.call('SET', KEYS[i], tostring(n), 'KEEPTTL')
  end
end
return 1`;

function upstashCreds(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

async function upstash<T>(cmd: (string | number)[]): Promise<T> {
  const c = upstashCreds();
  if (!c) throw new Error("KYA 花費帳需要 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN");
  const res = await fetch(c.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const body = (await res.json()) as { result?: T; error?: string };
  if (!res.ok || body.error) throw new Error(`Upstash ${cmd[0]} 失敗：${body.error ?? res.statusText}`);
  return body.result as T;
}

/** 與 ledger.ts（#253）同一個 Upstash、同樣的 EVAL 原子腳本風格。 */
export function upstashKyaSpendStore(): KyaSpendStore {
  return {
    describe: "upstash",
    async reserve(h, amount, l, nowSec) {
      // 閘門已拒收超出範圍的憑證；這裡再夾一次，讓腳本的參數檢查永遠不會在寫入途中失敗。
      const periodTtl = Math.min(KYA_MAX_TTL_SEC, Math.max(60, l.periodSeconds * 2));
      const win = kyaWindowKeys(h, l.periodSeconds, nowSec);
      const r = await upstash<[number, string, string, string]>([
        "EVAL", KYA_RESERVE_SCRIPT, 1 + win.length, kyaTotalKey(h), ...win,
        amount.toString(), l.maxTotal.toString(), l.maxPerPeriod.toString(), periodTtl, Math.min(KYA_MAX_TTL_SEC, Math.max(60, l.totalTtlSec)),
      ]);
      const total = BigInt(r[1]);
      const period = BigInt(r[2]);
      return Number(r[0]) === 1 ? { ok: true, total, period } : { ok: false, which: r[3] === "period" ? "period" : "total", total, period };
    },
    async release(h, amount, l, nowSec) {
      await upstash(["EVAL", KYA_RELEASE_SCRIPT, 2, kyaTotalKey(h), kyaSlotKey(h, l.periodSeconds, nowSec), amount.toString()]);
    },
    async claimPresentation(payer, nonce, ttlSec) {
      const r = await upstash<string | null>(["SET", `${KYA_VP_PREFIX}${payer.toLowerCase()}:${nonce.toLowerCase()}`, "1", "NX", "EX", ttlSec]);
      return r === "OK";
    },
    async read(h, periodSeconds, nowSec) {
      const [t, slots] = await Promise.all([
        upstash<string | null>(["GET", kyaTotalKey(h)]),
        upstash<(string | null)[]>(["MGET", ...kyaWindowKeys(h, periodSeconds, nowSec)]),
      ]);
      return { total: BigInt(t ?? "0"), period: slots.reduce((acc, v) => acc + BigInt(v ?? "0"), 0n) };
    },
  };
}

/** 單一 process 的記憶體帳（測試、本機）。多實例部署不可用——各實例的累計互不相通。 */
export function memoryKyaSpendStore(): KyaSpendStore {
  const m = new Map<string, bigint>();
  const seen = new Set<string>();
  return {
    describe: "memory",
    async reserve(h, amount, l, nowSec) {
      const tk = kyaTotalKey(h);
      const win = kyaWindowKeys(h, l.periodSeconds, nowSec);
      const ck = win[win.length - 1]!;
      const t = m.get(tk) ?? 0n;
      const p = win.reduce((acc, k) => acc + (m.get(k) ?? 0n), 0n);
      if (t + amount > l.maxTotal) return { ok: false, which: "total", total: t, period: p };
      if (p + amount > l.maxPerPeriod) return { ok: false, which: "period", total: t, period: p };
      m.set(tk, t + amount);
      m.set(ck, (m.get(ck) ?? 0n) + amount);
      return { ok: true, total: t + amount, period: p + amount };
    },
    async release(h, amount, l, nowSec) {
      for (const k of [kyaTotalKey(h), kyaSlotKey(h, l.periodSeconds, nowSec)]) {
        const v = m.get(k) ?? 0n;
        m.set(k, v > amount ? v - amount : 0n);
      }
    },
    async claimPresentation(payer, nonce) {
      const k = `${payer.toLowerCase()}:${nonce.toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    },
    async read(h, periodSeconds, nowSec) {
      return {
        total: m.get(kyaTotalKey(h)) ?? 0n,
        period: kyaWindowKeys(h, periodSeconds, nowSec).reduce((acc, k) => acc + (m.get(k) ?? 0n), 0n),
      };
    },
  };
}

// ── 閘門 ─────────────────────────────────────────────────────────────────────

export interface KyaGateOptions {
  config: KyaConfig;
  chain: KyaChainReader;
  spend: KyaSpendStore;
  /** ADR-016 撤銷檢查（預設 shared 的 checkCredentialStatus，寫入語意＝fail-closed）。 */
  statusCheck?: (res: VerifyResult, verifyingContract: string) => Promise<CredentialStatusResult>;
  now?: () => number;
}

/** 通過時的預留：結算後 finalize。 */
export interface KyaHold {
  credentialHash: string;
  amount: bigint;
  limits: KyaSpendLimits;
  reservedAtSec: number;
  spentTotal: bigint;
  spentPeriod: bigint;
  sessionId: number;
  agent: string;
}

export type KyaDecision =
  | { ok: true; hold: KyaHold }
  | { ok: false; status: 400 | 403 | 409 | 503; body: Record<string, unknown> };

export interface KyaGate {
  readonly config: KyaConfig;
  /** 付費請求（帶付款 header）在交給付費牆前呼叫。 */
  authorize(c: Context, paymentHeader: string): Promise<KyaDecision>;
  /** 付費牆跑完後呼叫：結算成功＝保留；結算失敗＝退回；結果不明＝保留。回傳要加在回應上的 header。 */
  finalize(hold: KyaHold, res: Response, protocol: "v1" | "v2"): Promise<Record<string, string>>;
  /**
   * 付費牆丟例外（沒有回應）時呼叫。settleAttempted＝授權可能已經送去結算 → 結果不明，保留預留；
   * 否則（結算前就失敗）退回。
   */
  abandon(hold: KyaHold, settleAttempted: boolean): Promise<void>;
  /** 免費查詢：某張憑證目前的 x402 花費（前端進度條）。 */
  spendOf(credentialHash: string, periodSeconds: number): Promise<{ total: bigint; period: bigint }>;
}

const NOTE_UNPAID = "未扣款：付款授權沒有送給 facilitator。";

export function createKyaGate(o: KyaGateOptions): KyaGate {
  const cfg = o.config;
  const now = o.now ?? (() => Date.now());
  const statusCheck =
    o.statusCheck ?? ((res: VerifyResult, vc: string) => checkCredentialStatus(res, { action: "write", verifyingContract: vc }));
  const deny = (status: 400 | 403 | 409 | 503, error: string, message: string, extra: Record<string, unknown> = {}): KyaDecision => ({
    ok: false,
    status,
    body: { ok: false, error, message, kya: true, ...extra, note: NOTE_UNPAID },
  });

  const release = async (hold: KyaHold) => {
    try {
      await o.spend.release(hold.credentialHash, hold.amount, hold.limits, hold.reservedAtSec);
    } catch (e) {
      // 退不回去＝多算，不是少算：使用者的上限只會更保守。記 log 讓營運方對帳。
      console.error(`::error::[kya] 退回預留失敗（${hold.credentialHash}，${hold.amount}）：`, e);
    }
  };
  // 部署設定（鏈、錨定合約綁定的 manager）不會在執行中改變：確認過一次就記住；讀取失敗不記，下次重讀。
  let chainIdOk: number | null = null;
  let anchorManagerOk = false;

  return {
    config: cfg,
    async authorize(c, paymentHeader) {
      if (cfg.mode === "invalid") {
        return deny(503, "kya_misconfigured", "X402_KYA_MODE 的值無法辨識（只接受 on／off），付費端點暫停服務。");
      }
      if (!cfg.sessionManager) {
        return deny(503, "kya_misconfigured", "X402_KYA_MODE=on 但未設定 SESSION_MANAGER_ADDRESS，無法驗證委託憑證。");
      }
      if (cfg.anchor === "required" && !cfg.anchorAddress) {
        return deny(503, "kya_misconfigured", "X402_KYA_ANCHOR=required 但未設定 SESSION_ANCHOR_ADDRESS。");
      }
      const vpHeader = c.req.header(AGENT_PRESENTATION_HEADER);
      if (!vpHeader) {
        return deny(403, "kya_presentation_required", `本服務要求代理人出示委託憑證：付款時請一併帶 ${AGENT_PRESENTATION_HEADER}（v3 AgentDelegationCredential 的 Verifiable Presentation）。`);
      }
      const payment = paymentAuthorizationOf(paymentHeader);
      if (!payment) return deny(400, "kya_payment_unreadable", "付款 header 解不出 EIP-3009 authorization（KYA 需要付款人與 nonce）。");

      const nowMs = now();
      const nowSec = Math.floor(nowMs / 1000);
      const vp = verifyX402Presentation(vpHeader, { method: c.req.method, path: c.req.path, payment }, { now: nowMs, maxSkewSec: cfg.maxSkewSec });
      if (!vp.ok) return deny(403, "kya_presentation_invalid", vp.reason ?? "presentation 驗證失敗", { reasonCode: vp.reasonCode });

      const r3 = verifyDelegationCredential(vp.credential!, {
        now: nowMs,
        expectedSessionManager: cfg.sessionManager,
        acceptedChainIds: cfg.acceptedChainIds,
      });
      if (!r3.valid) return deny(403, "kya_credential_invalid", r3.reason ?? "委託憑證驗證失敗", { reasonCode: r3.reasonCode });
      const f = r3.fields!;
      const hash = r3.credentialHash!;

      // 憑證的鏈必須是讀取端實際連的那條（session 與錨定都從這條鏈讀；錨定只存 hash，不分鏈）。
      if (chainIdOk === null) {
        let id: number;
        try {
          id = await o.chain.chainId();
        } catch (e) {
          console.error("[kya] 讀取 chainId 失敗：", e);
          return deny(503, "kya_chain_unavailable", "無法確認鏈上讀取來源的 chainId，不發出付款。");
        }
        // 讀取端的鏈不在接受清單裡＝伺服器設定錯（KYA_RPC_URL／DELEGATION_VC_CHAIN_IDS），不是請求方的錯。
        if (!cfg.acceptedChainIds.includes(id)) {
          console.error(`::error::[kya] 讀取端 RPC 的 chainId ${id} 不在 DELEGATION_VC_CHAIN_IDS [${cfg.acceptedChainIds.join(", ")}]`);
          return deny(503, "kya_misconfigured", "KYA 的鏈上讀取來源與接受的鏈設定不一致，付費端點暫停服務。");
        }
        chainIdOk = id;
      }
      if (r3.chainId !== chainIdOk) {
        return deny(403, "kya_credential_invalid", `委託憑證簽給 chainId ${r3.chainId}，本服務讀取的是 chainId ${chainIdOk}。`, {
          reasonCode: "VC_WRONG_CHAIN",
          credentialHash: hash,
        });
      }

      // 花費帳只能正確表示這個範圍內的額度與期間（Lua 精度、key TTL）；超出就拒收，而不是少算。
      if (
        f.x402.periodSeconds * 2 > KYA_MAX_TTL_SEC ||
        f.validUntil - nowSec + 86_400 > KYA_MAX_TTL_SEC ||
        BigInt(f.x402.maxTotal) > KYA_MAX_ATOMIC
      ) {
        return deny(403, "kya_credential_invalid", "委託憑證的 x402 額度、期間或效期超出本服務支援的範圍，請重新簽發較短效期的憑證。", {
          reasonCode: "KYA_ALLOWANCE_OUT_OF_RANGE",
          credentialHash: hash,
        });
      }

      const endpoint = matchX402Endpoint(f.x402.endpoints, c.req.method, c.req.path);
      if (!endpoint) {
        return deny(403, "kya_endpoint_not_allowed", `委託憑證沒有授權代理人付費呼叫 ${c.req.method} ${c.req.path}（允許：${f.x402.endpoints.join("、")}）。`, {
          credentialHash: hash,
        });
      }

      // 撤銷（ADR-016）：寫入語意，拿不到或驗不過＝拒絕。
      let st: CredentialStatusResult;
      try {
        st = await statusCheck(delegationAsVerifyResult(r3), cfg.sessionManager);
      } catch (e) {
        st = { ok: false, status: "unknown", reasonCode: "STATUS_UNAVAILABLE", message: (e as Error).message };
      }
      if (!st.ok) {
        // 完整訊息可能含設定（狀態清單網址、檔案路徑）：只寫 log，對外只回原因代碼。
        console.error(`[kya] 撤銷檢查未通過（${hash}，${st.reasonCode}）：${st.message}`);
        return st.status === "revoked"
          ? deny(403, "kya_credential_revoked", "委託憑證已被簽發者撤銷。", { credentialHash: hash, statusReason: st.reasonCode })
          : deny(503, "kya_status_unverified", "無法確認委託憑證的撤銷狀態（fail-closed），不發出付款。", { credentialHash: hash, statusReason: st.reasonCode });
      }

      // 鏈上 session 逐欄比對。
      let onchain: OnchainSession;
      try {
        onchain = await o.chain.session(cfg.sessionManager, f.sessionId);
      } catch (e) {
        console.error("[kya] 讀取鏈上 session 失敗：", e);
        return deny(503, "kya_chain_unavailable", "無法讀取鏈上 session（RPC 暫時無法使用），不發出付款。");
      }
      const mm = compareDelegationWithSession(f, onchain, nowSec);
      if (mm) return deny(403, "kya_session_mismatch", mm.message, { reasonCode: mm.code, credentialHash: hash });

      // 錨定。
      if (cfg.anchor !== "off" && cfg.anchorAddress) {
        // 錨定權限來自錨定合約自己綁定的 manager：綁的不是本服務的那顆，錨定就沒有意義（fail-closed）。
        if (!anchorManagerOk) {
          let bound: string;
          try {
            bound = await o.chain.anchorSessionManager(cfg.anchorAddress);
          } catch (e) {
            console.error("[kya] 讀取錨定合約的 sessionManager 失敗：", e);
            return deny(503, "kya_chain_unavailable", "無法讀取 SessionCredentialAnchor，不發出付款。");
          }
          if (!ethers.isAddress(bound) || ethers.getAddress(bound) !== cfg.sessionManager) {
            console.error(`::error::[kya] SESSION_ANCHOR_ADDRESS 綁定的 manager ${bound} ≠ SESSION_MANAGER_ADDRESS ${cfg.sessionManager}`);
            return deny(503, "kya_misconfigured", "SessionCredentialAnchor 綁定的 session manager 與本服務設定不符，付費端點暫停服務。");
          }
          anchorManagerOk = true;
        }
        let anchored: boolean;
        try {
          anchored = await o.chain.isAnchored(cfg.anchorAddress, f.sessionId, hash);
        } catch (e) {
          console.error("[kya] 讀取錨定失敗：", e);
          if (cfg.anchor === "required") return deny(503, "kya_chain_unavailable", "無法讀取 SessionCredentialAnchor，不發出付款。");
          anchored = false;
        }
        if (!anchored && cfg.anchor === "required") {
          return deny(403, "kya_not_anchored", `委託憑證沒有被 session #${f.sessionId} 的使用者錨定在鏈上（或已被新憑證取代）。`, {
            credentialHash: hash,
          });
        }
      }

      // 防重放：同一筆付款授權只能配一次 presentation。
      let first: boolean;
      try {
        first = await o.spend.claimPresentation(payment.from, payment.nonce, Math.max(600, cfg.maxSkewSec * 2));
      } catch (e) {
        console.error("[kya] 花費帳無法使用：", e);
        return deny(503, "kya_ledger_unavailable", "KYA 花費帳暫時無法使用（fail-closed），不發出付款。");
      }
      if (!first) return deny(409, "kya_presentation_replayed", "這筆付款授權已經出示過 presentation（重放）。");

      // 花費預留（每期間＋總額）。
      const limits: KyaSpendLimits = {
        maxPerPeriod: BigInt(f.x402.maxPerPeriod),
        periodSeconds: f.x402.periodSeconds,
        maxTotal: BigInt(f.x402.maxTotal),
        totalTtlSec: Math.max(60, f.validUntil - nowSec + 86_400),
      };
      let r: KyaReserveResult;
      try {
        r = await o.spend.reserve(hash, payment.value, limits, nowSec);
      } catch (e) {
        console.error("[kya] 花費帳無法使用：", e);
        return deny(503, "kya_ledger_unavailable", "KYA 花費帳暫時無法使用（fail-closed），不發出付款。");
      }
      if (!r.ok) {
        const cap = r.which === "total" ? limits.maxTotal : limits.maxPerPeriod;
        const used = r.which === "total" ? r.total : r.period;
        return deny(
          403,
          "kya_spend_limit_exceeded",
          `超過委託憑證的 x402 ${r.which === "total" ? "總額" : "每期間"}上限：已花 ${formatUsdcAtomic(used)}，本筆 ${formatUsdcAtomic(payment.value)}，上限 ${formatUsdcAtomic(cap)} USDC。`,
          {
            credentialHash: hash,
            limit: r.which,
            spentAtomic: used.toString(),
            requestAtomic: payment.value.toString(),
            capAtomic: cap.toString(),
          },
        );
      }
      return {
        ok: true,
        hold: {
          credentialHash: hash,
          amount: payment.value,
          limits,
          reservedAtSec: nowSec,
          spentTotal: r.total,
          spentPeriod: r.period,
          sessionId: f.sessionId,
          agent: payment.from,
        },
      };
    },

    async finalize(hold, res, protocol): Promise<Record<string, string>> {
      const settled = await settlementOutcome(res, protocol);
      if (settled === "failed") {
        await release(hold);
        return {};
      }
      return {
        [AGENT_KYA_SPEND_HEADER]: `total=${hold.spentTotal};period=${hold.spentPeriod};maxTotal=${hold.limits.maxTotal};maxPerPeriod=${hold.limits.maxPerPeriod};hash=${hold.credentialHash}`,
      };
    },

    async abandon(hold, settleAttempted) {
      if (!settleAttempted) return release(hold);
      console.error(`::error::[kya] 付費牆在結算途中丟出例外，結果不明 → 保留預留（${hold.credentialHash}，${hold.amount}）`);
    },

    spendOf(credentialHash, periodSeconds) {
      return o.spend.read(credentialHash, periodSeconds, Math.floor(now() / 1000));
    },
  };
}

/**
 * 付費牆跑完後，這筆錢的結果：
 *   settled — 回應帶結算成功的證明（v1 X-PAYMENT-RESPONSE；v2 PAYMENT-RESPONSE success:true）；
 *   unknown — v2 的 settlement_pending／settle 階段的 429・502（保留預留，寧可多算）；
 *   failed  — 其餘（402、handler 錯誤、facilitator 拒絕、結算前的 facilitator 失敗）：買方沒有被扣款，退回預留。
 *
 * v1 的限制（docs/SSI_AGENT_DELEGATION.md）：x402-hono 0.5.3 把 settle 階段的錯誤一律改成 402，
 * 與「facilitator 拒絕」分不開 → 判成 failed（退回）。結算其實上鏈時會少算一筆；要精確請用 v2。
 */
export async function settlementOutcome(res: Response, protocol: "v1" | "v2"): Promise<"settled" | "unknown" | "failed"> {
  const h = res.headers.get(protocol === "v2" ? "PAYMENT-RESPONSE" : "X-PAYMENT-RESPONSE");
  if (h) {
    try {
      const j = JSON.parse(Buffer.from(h, "base64").toString("utf8")) as { success?: boolean; errorReason?: string };
      if (j?.success === true) return "settled";
      if (j?.errorReason === "settlement_pending") return "unknown";
    } catch {
      return "unknown";
    }
  }
  if (res.status === 429 || res.status === 502 || res.status === 504) {
    const body = (await res.clone().json().catch(() => null)) as { phase?: unknown; error?: unknown } | null;
    if (protocol === "v2") {
      // facilitatorFailureResponse 帶 phase：verify／supported 階段失敗＝沒有扣款；settle 階段＝結果不明。
      if (body?.phase === "verify" || body?.phase === "supported") return "failed";
      if (body?.phase === "settle") return "unknown";
      return res.status === 429 ? "failed" : "unknown";
    }
    // v1：facilitator_* 只來自 runV1 的 catch（verify 丟例外）或 verify 的限流 402 改寫——都在 settle 之前
    // （x402-hono 0.5.3 的 settle 錯誤在套件內就變成 402），錢沒有動 → 退回。
    if (body?.error === "facilitator_unavailable" || body?.error === "facilitator_rate_limited") return "failed";
    return res.status === 429 ? "failed" : "unknown";
  }
  return "failed";
}

/** 402 回應上要加的宣告（KYA 開啟時）。 */
export const KYA_ADVERTISE_HEADERS: Record<string, string> = {
  [AGENT_KYA_HEADER]: `required; header=${AGENT_PRESENTATION_HEADER}; credential=AgentDelegationCredential; spec=https://pepelab.xyz/credentials/agent-delegation/v3`,
};
