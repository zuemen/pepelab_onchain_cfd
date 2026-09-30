// GET /risk/exposure —— 給客戶風控用的曝險報表（免費、唯讀）。
//
// 內容：現行 exchange 每個資產的多空 OI（名目）、保險金庫 totalAssets、V2 vault 的
// reserveStatus / reserveRatioBps、每個資產在 MockOracle 與 GuardedOracle 的價格與
// 年齡（並標出兩者是否一致）、adlEnabled、maxPriceAge、FUNDING_INTERVAL，以及每個
// 資產的 lastFundingUpdateAt 與距今秒數。
//
// 設計：
//   - **同一個區塊讀全部**：取 latest − 3 當 blockTag（公共節點在負載平衡後面，最新區塊
//     不一定每台都有），所有 eth_call 帶同一個 blockTag，報表內各欄位彼此一致。「距今」
//     一律以該區塊的 timestamp 為基準，回應附 asOfBlock 與 asOfBlockTime。
//   - 只有 header not found／429 類錯誤重試一次；逾時與 revert 不重試。整份報表總時限
//     20 秒，到點還沒讀完的欄位回 null＋REPORT_DEADLINE。
//   - **欄位級降級**：任一讀取失敗只讓該欄位變 null，並在 `unavailable` 以欄位路徑
//     記下原因代碼（CALL_REVERTED / BAD_DATA / RPC_TIMEOUT / RPC_ERROR / NOT_CONFIGURED）。
//     絕不回錯誤原文（可能含 RPC URL / key），也絕不整個 500。
//   - OI：合約若有 `longOpenSize(bytes32)` / `shortOpenSize(bytes32)`（部位數量），
//     用「數量 × 現價」算現值名目；現行合約沒有，就退回既有讀法 globalLong/ShortNotional
//     （開倉時的名目加總，18 位小數 USD）。每個資產標出用了哪一種方法。
//   - 快取 60 秒（single-flight，同時間多個請求只打一次 RPC）；節流由 app.ts 的免費
//     端點 per-IP 限流統一處理。
//   - RPC 並發上限 6（公共節點對爆量 eth_call 會回 429），每筆 8 秒逾時。
import { ethers } from "ethers";

export type ReadReason =
  | "CALL_REVERTED"
  | "BAD_DATA"
  | "RPC_TIMEOUT"
  | "RPC_ERROR"
  | "NOT_CONFIGURED"
  /** 整份報表的總時限（預設 20 秒）到了，這個欄位還沒讀完。 */
  | "REPORT_DEADLINE";

/**
 * 可重試的錯誤（複審 Low-8）：只有「節點還沒同步到這個區塊」與「被限流」值得馬上再試一次。
 * 逾時不重試——單筆已等了 8 秒，再等一次會讓整份報表拖到使用者放棄。
 */
const RETRYABLE_RE = /header not found|unknown block|block .*not found|missing trie node|\b429\b|too many requests|rate limit/i;
export function isRetryableReadError(err: unknown): boolean {
  const e = err as { code?: string; message?: string; shortMessage?: string; info?: { error?: { message?: string } }; error?: { message?: string } };
  if (e?.code === "TIMEOUT") return false;
  const text = [e?.info?.error?.message, e?.error?.message, e?.shortMessage, e?.message].filter(Boolean).join(" | ");
  return RETRYABLE_RE.test(text);
}

export const REPORT_DEADLINE_MS = 20_000;

/** 最小讀取介面：正式環境包 ethers provider，測試用假實作。 */
export interface ExposureReader {
  blockNumber(): Promise<number>;
  blockTimestamp(block: number): Promise<number>;
  /** `signature` 形如 "globalLongNotional(bytes32) view returns (uint256)"。 */
  call(address: string, signature: string, args: unknown[], blockTag?: number): Promise<ethers.Result>;
}

export function providerReader(provider: ethers.Provider): ExposureReader {
  const ifaces = new Map<string, { iface: ethers.Interface; fn: ethers.FunctionFragment }>();
  const get = (sig: string) => {
    let e = ifaces.get(sig);
    if (!e) {
      const iface = new ethers.Interface([`function ${sig}`]);
      e = { iface, fn: iface.fragments[0] as ethers.FunctionFragment };
      ifaces.set(sig, e);
    }
    return e;
  };
  return {
    blockNumber: () => provider.getBlockNumber(),
    blockTimestamp: async (n) => {
      const b = await provider.getBlock(n);
      if (!b) throw Object.assign(new Error("block not found"), { code: "BAD_DATA" });
      return Number(b.timestamp);
    },
    call: async (to, sig, args, blockTag) => {
      const { iface, fn } = get(sig);
      const data = iface.encodeFunctionData(fn, args);
      const ret = await provider.call({ to, data, blockTag });
      return iface.decodeFunctionResult(fn, ret);
    },
  };
}

export interface ExposureTargets {
  chainId: number;
  exchange: string;
  mockOracle: string;
  guardedOracle: string | null;
  /** exchange.insuranceVault() 讀不到時的備援位址。 */
  insuranceVaultFallback: string | null;
  assetVaultV2: string | null;
  assets: Record<string, string>; // symbol → bytes32 assetId
}

const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_UINT256 = (1n << 256n) - 1n;
const CALL_TIMEOUT_MS = 8_000;
const CONCURRENCY = 6;

const SIG = {
  adlEnabled: "adlEnabled() view returns (bool)",
  maxPriceAge: "maxPriceAge() view returns (uint256)",
  fundingInterval: "FUNDING_INTERVAL() view returns (uint256)",
  insuranceVault: "insuranceVault() view returns (address)",
  longNotional: "globalLongNotional(bytes32) view returns (uint256)",
  shortNotional: "globalShortNotional(bytes32) view returns (uint256)",
  longOpenSize: "longOpenSize(bytes32) view returns (uint256)",
  shortOpenSize: "shortOpenSize(bytes32) view returns (uint256)",
  lastFunding: "lastFundingUpdateAt(bytes32) view returns (uint256)",
  getPrice: "getPrice(bytes32) view returns (uint256 price, uint256 updatedAt)",
  totalAssets: "totalAssets() view returns (uint256)",
  usdc: "usdc() view returns (address)",
  decimals: "decimals() view returns (uint8)",
  reserveStatus:
    "reserveStatus() view returns (uint256 reserve_, uint256 liability, uint256 ratioBps, uint256 unpriced, bool stale, bool halted)",
  reserveRatioBps: "reserveRatioBps() view returns (uint256)",
} as const;

/** 節點端的暫時性錯誤（不是合約 revert）。 */
const TRANSIENT_RE =
  /header not found|missing trie node|unknown block|block .*not found|timeout|timed out|rate limit|too many requests|\b429\b|\b50[234]\b|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i;

/**
 * 錯誤 → 原因代碼。錯誤原文只用來分類，不外流。
 *
 * 注意（審查 Medium-6）：ethers v6 會把 eth_call 的**任何** JSON-RPC 錯誤都包成
 * CALL_EXCEPTION——包括負載平衡後面的節點還沒同步到該區塊時的 `header not found`。
 * 所以只有「節點明說 revert」或「帶回 revert data」才算 CALL_REVERTED；
 * 「missing revert data」＋節點錯誤是 RPC_ERROR（可重試）。
 */
export function classifyReadError(err: unknown): ReadReason {
  const e = err as {
    code?: string;
    data?: unknown;
    reason?: unknown;
    shortMessage?: string;
    message?: string;
    info?: { error?: { message?: string } };
    error?: { message?: string };
  };
  const code = e?.code;
  if (code === "NOT_CONFIGURED") return "NOT_CONFIGURED";
  if (code === "TIMEOUT") return "RPC_TIMEOUT";
  const inner = String(e?.info?.error?.message ?? e?.error?.message ?? "");
  if (TRANSIENT_RE.test(inner)) return "RPC_ERROR";
  if (code === "CALL_EXCEPTION") {
    if (/revert/i.test(inner)) return "CALL_REVERTED";
    if (e.data !== null && e.data !== undefined) return "CALL_REVERTED";
    if (e.reason !== null && e.reason !== undefined) return "CALL_REVERTED";
    const msg = String(e.shortMessage ?? e.message ?? "");
    if (/revert/i.test(msg) && !/missing revert data/i.test(msg)) return "CALL_REVERTED";
    return "RPC_ERROR";
  }
  if (code === "BAD_DATA") return "BAD_DATA";
  return "RPC_ERROR";
}

/** 讀取 blockTag 落後 latest 的區塊數（公共節點負載平衡，最新區塊不一定每台都有）。 */
export const BLOCK_LAG = 3;
const RETRY_DELAY_MS = 250;

type Settled<T> = { ok: true; v: T } | { ok: false; reason: ReadReason };

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

function limiter(n: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= n) return;
    const job = queue.shift();
    if (job) { active++; job(); }
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(() => { active--; next(); });
      });
      next();
    });
}

const isSet = (a: string | null | undefined): a is string =>
  !!a && a.toLowerCase() !== ZERO;

const fmt18 = (v: bigint) => Number(ethers.formatUnits(v, 18));
const fmt8 = (v: bigint) => Number(ethers.formatUnits(v, 8));

export interface OraclePoint {
  price: number | null;
  updatedAt: string | null;
  ageSec: number | null;
}

export interface AssetExposure {
  symbol: string;
  assetId: string;
  openInterest: {
    method: "openSize×markPrice" | "globalNotional" | null;
    longUsd: number | null;
    shortUsd: number | null;
    netUsd: number | null;
  };
  oracle: {
    mock: OraclePoint;
    guarded: OraclePoint;
    /** 兩顆價格完全相同＝true；任一讀不到＝null。 */
    agree: boolean | null;
    deviationBps: number | null;
  };
  funding: { lastFundingUpdateAt: string | null; sinceSec: number | null; neverSettled: boolean | null };
}

export interface ExposureReport {
  ok: true;
  chainId: number;
  asOfBlock: number | null;
  asOfBlockTime: string | null;
  generatedAt: string;
  contracts: {
    exchange: string;
    mockOracle: string;
    guardedOracle: string | null;
    insuranceVault: string | null;
    assetVaultV2: string | null;
  };
  exchange: { adlEnabled: boolean | null; maxPriceAgeSec: number | null; fundingIntervalSec: number | null };
  insuranceVault: { totalAssets: number | null; totalAssetsRaw: string | null; decimals: number | null };
  v2Vault: {
    reserveStatus: {
      reserveRaw: string;
      liabilityRaw: string;
      ratioBps: string;
      ratioUnbounded: boolean;
      unpriced: number;
      stale: boolean;
      halted: boolean;
    } | null;
    reserveRatioBps: string | null;
  };
  totals: { longUsd: number | null; shortUsd: number | null };
  assets: AssetExposure[];
  /** 欄位路徑 → 原因代碼；讀取失敗的欄位在報表中為 null。 */
  unavailable: Record<string, ReadReason>;
  notes: string[];
}

/** 讀一次完整報表（不含快取）。永不丟錯。 */
export async function buildExposureReport(
  reader: ExposureReader,
  t: ExposureTargets,
  nowMs: number = Date.now(),
  opts: { deadlineMs?: number; callTimeoutMs?: number } = {},
): Promise<ExposureReport> {
  const unavailable: Record<string, ReadReason> = {};
  const run = limiter(CONCURRENCY);
  // 整份報表的總時限：到點還沒讀完的欄位回 null＋REPORT_DEADLINE，不讓一個慢節點拖垮整份。
  const deadlineAt = Date.now() + (opts.deadlineMs ?? REPORT_DEADLINE_MS);
  const callTimeout = opts.callTimeoutMs ?? CALL_TIMEOUT_MS;
  const DEADLINE = Symbol("deadline");
  // 只有 header-not-found／429 類重試一次；逾時、revert、BAD_DATA 不重試。
  const settle = async <T>(field: string | null, p: () => Promise<T>): Promise<Settled<T>> => {
    let reason: ReadReason = "RPC_ERROR";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const v = await run(() => {
          const remaining = deadlineAt - Date.now();
          if (remaining <= 0) return Promise.reject(DEADLINE);
          return withTimeout(p(), Math.min(callTimeout, remaining)).catch((e) => {
            throw Date.now() >= deadlineAt ? DEADLINE : e;
          });
        });
        return { ok: true, v };
      } catch (err) {
        if (err === DEADLINE) {
          reason = "REPORT_DEADLINE";
          break;
        }
        reason = classifyReadError(err);
        if (!isRetryableReadError(err) || attempt === 1) break;
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
    if (field) unavailable[field] = reason;
    return { ok: false, reason };
  };
  const notConfigured = (field: string): Settled<never> => {
    unavailable[field] = "NOT_CONFIGURED";
    return { ok: false, reason: "NOT_CONFIGURED" };
  };

  // 1) 區塊錨點：latest − BLOCK_LAG。公共節點在負載平衡後面，剛出的區塊不一定每台都有，
  //    釘在 latest 會隨機拿到 `header not found`。
  const latestBn = await settle("asOfBlock", () => reader.blockNumber());
  const bn: Settled<number> = latestBn.ok ? { ok: true, v: Math.max(0, latestBn.v - BLOCK_LAG) } : latestBn;
  const blockTag = bn.ok ? bn.v : undefined;
  const bts = bn.ok ? await settle("asOfBlockTime", () => reader.blockTimestamp(bn.v)) : notConfigured("asOfBlockTime");
  const refSec = bts.ok ? bts.v : Math.floor(nowMs / 1000);

  const call = (field: string | null, addr: string | null, sig: string, args: unknown[] = []) =>
    isSet(addr)
      ? settle(field, () => reader.call(addr, sig, args, blockTag))
      : Promise.resolve(field ? notConfigured(field) : ({ ok: false, reason: "NOT_CONFIGURED" } as const));

  // 2) exchange 參數＋保險金庫位址＋openSize 支援度探測（並行）
  const firstAsset = Object.values(t.assets)[0];
  const [adl, mpa, fi, iv, probe] = await Promise.all([
    call("exchange.adlEnabled", t.exchange, SIG.adlEnabled),
    call("exchange.maxPriceAgeSec", t.exchange, SIG.maxPriceAge),
    call("exchange.fundingIntervalSec", t.exchange, SIG.fundingInterval),
    call(null, t.exchange, SIG.insuranceVault),
    firstAsset ? call(null, t.exchange, SIG.longOpenSize, [firstAsset]) : Promise.resolve({ ok: false, reason: "NOT_CONFIGURED" } as const),
  ]);
  const vaultAddr = iv.ok && isSet(String(iv.v[0])) ? String(iv.v[0]) : t.insuranceVaultFallback;
  const openSizeSupported = probe.ok;

  // 3) 保險金庫、V2 vault、每個資產（全部並行，受 limiter 約束）
  const vaultTotalP = call("insuranceVault.totalAssets", vaultAddr, SIG.totalAssets);
  const vaultDecP = (async (): Promise<Settled<number>> => {
    const u = await call(null, vaultAddr, SIG.usdc);
    if (!u.ok) return { ok: false, reason: u.reason };
    const d = await call(null, String(u.v[0]), SIG.decimals);
    return d.ok ? { ok: true, v: Number(d.v[0]) } : { ok: false, reason: d.reason };
  })();
  const rsP = call("v2Vault.reserveStatus", t.assetVaultV2, SIG.reserveStatus);
  const rrP = call("v2Vault.reserveRatioBps", t.assetVaultV2, SIG.reserveRatioBps);

  const assetPs = Object.entries(t.assets).map(async ([symbol, id]): Promise<AssetExposure> => {
    const f = (k: string) => `assets.${symbol}.${k}`;
    const [mock, guarded, lf, ln, sn, lsz, ssz] = await Promise.all([
      call(f("oracle.mock"), t.mockOracle, SIG.getPrice, [id]),
      call(f("oracle.guarded"), t.guardedOracle, SIG.getPrice, [id]),
      call(f("funding.lastFundingUpdateAt"), t.exchange, SIG.lastFunding, [id]),
      call(null, t.exchange, SIG.longNotional, [id]),
      call(null, t.exchange, SIG.shortNotional, [id]),
      openSizeSupported ? call(null, t.exchange, SIG.longOpenSize, [id]) : Promise.resolve(null),
      openSizeSupported ? call(null, t.exchange, SIG.shortOpenSize, [id]) : Promise.resolve(null),
    ]);

    const point = (r: Settled<ethers.Result>): OraclePoint =>
      r.ok && Number(r.v[1]) > 0
        ? {
            price: fmt8(r.v[0] as bigint),
            updatedAt: new Date(Number(r.v[1]) * 1000).toISOString(),
            ageSec: Math.max(0, refSec - Number(r.v[1])),
          }
        : r.ok
          ? { price: fmt8(r.v[0] as bigint), updatedAt: null, ageSec: null } // 從未寫入過
          : { price: null, updatedAt: null, ageSec: null };
    const mp = mock.ok ? (mock.v[0] as bigint) : null;
    const gp = guarded.ok ? (guarded.v[0] as bigint) : null;
    const agree = mp !== null && gp !== null ? mp === gp : null;
    const deviationBps =
      mp !== null && gp !== null && mp > 0n ? Number(((gp > mp ? gp - mp : mp - gp) * 10_000n) / mp) : null;

    // OI：優先「數量 × 現價（exchange 讀的 MockOracle）」；否則退回 globalNotional。
    let method: AssetExposure["openInterest"]["method"] = null;
    let longUsd: number | null = null;
    let shortUsd: number | null = null;
    if (lsz?.ok && ssz?.ok && mp !== null) {
      method = "openSize×markPrice";
      longUsd = fmt18(((lsz.v[0] as bigint) * mp) / 10n ** 8n);
      shortUsd = fmt18(((ssz.v[0] as bigint) * mp) / 10n ** 8n);
    } else if (ln.ok && sn.ok) {
      method = "globalNotional";
      longUsd = fmt18(ln.v[0] as bigint);
      shortUsd = fmt18(sn.v[0] as bigint);
    } else {
      unavailable[f("openInterest")] = !ln.ok ? ln.reason : !sn.ok ? sn.reason : "RPC_ERROR";
    }

    return {
      symbol,
      assetId: id,
      openInterest: {
        method,
        longUsd,
        shortUsd,
        netUsd: longUsd !== null && shortUsd !== null ? longUsd - shortUsd : null,
      },
      oracle: { mock: point(mock), guarded: point(guarded), agree, deviationBps },
      // lastFundingUpdateAt == 0 ＝ 這個資產從未結算過 funding（不是讀取失敗）。
      funding: {
        lastFundingUpdateAt: lf.ok && Number(lf.v[0]) > 0 ? new Date(Number(lf.v[0]) * 1000).toISOString() : null,
        sinceSec: lf.ok && Number(lf.v[0]) > 0 ? Math.max(0, refSec - Number(lf.v[0])) : null,
        neverSettled: lf.ok ? Number(lf.v[0]) === 0 : null,
      },
    };
  });

  const [vaultTotal, vaultDec, rs, rr, assets] = await Promise.all([
    vaultTotalP, vaultDecP, rsP, rrP, Promise.all(assetPs),
  ]);

  const oiKnown = assets.filter((a) => a.openInterest.longUsd !== null);
  const notes = [
    `距今時間（ageSec / sinceSec）以 asOfBlock 的區塊時間為基準${bts.ok ? "" : "（區塊時間讀不到，改用伺服器時間）"}。`,
    openSizeSupported
      ? "OI 以 longOpenSize/shortOpenSize（部位數量，18 位小數）× MockOracle 現價計算的現值名目。"
      : probe.reason === "CALL_REVERTED" || probe.reason === "BAD_DATA"
        ? "現行 exchange 沒有 longOpenSize/shortOpenSize，OI 退回 globalLong/ShortNotional（開倉時名目加總，非現值）。"
        : `longOpenSize 探測失敗（${probe.reason}），本次 OI 退回 globalLong/ShortNotional（開倉時名目加總，非現值）。`,
    "價格為 8 位小數 USD；exchange 結算讀的是 MockOracle，GuardedOracle 為 V2 hardened stack 的鏡像，兩者由 keeper 同步寫入。",
    "reserveRaw / liabilityRaw / totalAssetsRaw 為代幣最小單位的整數字串。",
  ];

  let reserveStatus: ExposureReport["v2Vault"]["reserveStatus"] = null;
  if (rs.ok) {
    const ratio = rs.v[2] as bigint;
    reserveStatus = {
      reserveRaw: (rs.v[0] as bigint).toString(),
      liabilityRaw: (rs.v[1] as bigint).toString(),
      ratioBps: ratio.toString(),
      ratioUnbounded: ratio === MAX_UINT256,
      unpriced: Number(rs.v[3]),
      stale: Boolean(rs.v[4]),
      halted: Boolean(rs.v[5]),
    };
  }
  if (!vaultDec.ok && vaultTotal.ok) unavailable["insuranceVault.decimals"] = vaultDec.reason;

  return {
    ok: true,
    chainId: t.chainId,
    asOfBlock: bn.ok ? bn.v : null,
    asOfBlockTime: bts.ok ? new Date(bts.v * 1000).toISOString() : null,
    generatedAt: new Date(nowMs).toISOString(),
    contracts: {
      exchange: t.exchange,
      mockOracle: t.mockOracle,
      guardedOracle: t.guardedOracle,
      insuranceVault: isSet(vaultAddr) ? vaultAddr : null,
      assetVaultV2: t.assetVaultV2,
    },
    exchange: {
      adlEnabled: adl.ok ? Boolean(adl.v[0]) : null,
      maxPriceAgeSec: mpa.ok ? Number(mpa.v[0]) : null,
      fundingIntervalSec: fi.ok ? Number(fi.v[0]) : null,
    },
    insuranceVault: {
      totalAssets: vaultTotal.ok && vaultDec.ok ? Number(ethers.formatUnits(vaultTotal.v[0] as bigint, vaultDec.v)) : null,
      totalAssetsRaw: vaultTotal.ok ? (vaultTotal.v[0] as bigint).toString() : null,
      decimals: vaultDec.ok ? vaultDec.v : null,
    },
    v2Vault: { reserveStatus, reserveRatioBps: rr.ok ? (rr.v[0] as bigint).toString() : null },
    totals: {
      longUsd: oiKnown.length === assets.length ? sum(assets.map((a) => a.openInterest.longUsd!)) : null,
      shortUsd: oiKnown.length === assets.length ? sum(assets.map((a) => a.openInterest.shortUsd!)) : null,
    },
    assets,
    unavailable,
    notes,
  };
}

function sum(xs: number[]): number {
  return Math.round(xs.reduce((a, b) => a + b, 0) * 1e6) / 1e6;
}

/**
 * 60 秒快取＋single-flight。有欄位因**暫時性**原因讀不到（NOT_CONFIGURED 以外）的報表
 * 只快取 10 秒（盡快重試）；NOT_CONFIGURED 是部署狀態、重讀也不會變，照常 60 秒。
 * `get()` 回傳這一份的實際 TTL 與剩餘秒數，路由據此設定 Cache-Control，兩者一致。
 */
export function createExposureService(
  reader: ExposureReader,
  targets: ExposureTargets,
  opts: { ttlMs?: number; degradedTtlMs?: number; now?: () => number; deadlineMs?: number } = {},
) {
  const ttl = opts.ttlMs ?? 60_000;
  const degradedTtl = opts.degradedTtlMs ?? 10_000;
  const now = opts.now ?? Date.now;
  let cached: { at: number; ttl: number; report: ExposureReport } | null = null;
  let inflight: Promise<{ at: number; ttl: number; report: ExposureReport }> | null = null;

  const view = (c: { at: number; ttl: number; report: ExposureReport }, hit: boolean, t: number) => {
    const ageMs = Math.max(0, t - c.at);
    return {
      report: c.report,
      cacheHit: hit,
      ageSec: Math.floor(ageMs / 1000),
      ttlSec: Math.round(c.ttl / 1000),
      /** 這一份還能被快取多久（秒），= Cache-Control max-age。 */
      remainingSec: Math.max(0, Math.floor((c.ttl - ageMs) / 1000)),
    };
  };

  return {
    async get() {
      const t = now();
      if (cached && t - cached.at < cached.ttl) return view(cached, true, t);
      if (!inflight) {
        inflight = buildExposureReport(reader, targets, t, { deadlineMs: opts.deadlineMs })
          .then((report) => {
            const transient = Object.values(report.unavailable).some((r) => r !== "NOT_CONFIGURED");
            cached = { at: now(), ttl: transient ? degradedTtl : ttl, report };
            return cached;
          })
          .finally(() => {
            inflight = null;
          });
      }
      const c = await inflight;
      return view(c, false, now());
    },
  };
}
