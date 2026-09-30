// 唯讀 client（viem）。
//
// 一致性保證：每個方法先決定「一個」區塊（呼叫端給的 blockNumber，或 latest − latestBlockLag），
// 之後所有 eth_call 都帶同一個 blockNumber，年齡／到期以「該區塊的 timestamp」計算，
// 不用本機時鐘。同一個回傳物件裡的數字因此一定互相一致（不會價格是 N 區塊、OI 是 N+1 區塊）。
// 要讓多個方法對齊同一個區塊：先 `getBlockContext()`，再把 blockNumber 傳給每個方法。
//
// 不送交易、不需要私鑰。
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  ExecutionRevertedError,
  createPublicClient,
  getAddress,
  http,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { classifyTradeFreshness, type TradeFreshness } from "../../shared/src/freshness.ts";
import {
  AGENT_SESSION_MANAGER_ABI,
  ORACLE_ABI,
  PERPETUAL_EXCHANGE_ABI,
} from "./abis.ts";
import {
  ASSET_SYMBOLS,
  assetSymbolOf,
  resolveAddresses,
  toAssetId,
  ZERO_ADDRESS,
  type AddressOverrides,
  type AssetSymbol,
  type SdkAddresses,
} from "./addresses.ts";
import { amount, isoOrNull, margin, NATIVE_DECIMALS, price, type Amount } from "./format.ts";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface ReadClientConfig {
  chainId: number;
  /** 自備的 viem PublicClient（建議：自己控制 RPC、重試與逾時）。 */
  publicClient?: PublicClient;
  /** 未提供 publicClient 時，以此 RPC URL 建立 http transport。 */
  rpcUrl?: string;
  /** 只給本機 anvil／測試部署用；正式整合請不要覆寫。 */
  addresses?: AddressOverrides;
  /**
   * 是否用 Multicall3 合併讀取。預設：chain 設定裡有 multicall3 時啟用。
   * 兩條路徑都保證同一個 blockNumber。
   */
  multicall?: boolean;
  /**
   * 未指定 blockNumber 時，使用 latest − latestBlockLag。預設 0。
   * 公共 RPC 背後是負載平衡的多個節點，最新區塊可能還沒同步到每個節點（`header not found`）；
   * 遇到時可設 2–3（signal-api 的 /risk/exposure 用 3）。
   */
  latestBlockLag?: number;
}

export interface ReadOptions {
  /** 固定在這個區塊讀取；省略時取 latest − latestBlockLag。 */
  blockNumber?: bigint;
}

export interface BlockContext {
  blockNumber: bigint;
  /** 區塊時間（unix 秒）。所有年齡／到期都以它為基準。 */
  blockTimestamp: bigint;
}

/** P1 欄位（現行部署版可能沒有）：supported=false 代表合約沒有這個 getter。 */
export type Optional<T> = { supported: true; value: T } | { supported: false; value: null };

export type AssetMode = "Active" | "ReduceOnly" | "Halted";
export const ASSET_MODES: readonly AssetMode[] = ["Active", "ReduceOnly", "Halted"];

export interface PositionView {
  positionId: bigint;
  owner: Address;
  assetId: Hex;
  asset: AssetSymbol | null;
  isLong: boolean;
  isOpen: boolean;
  /** 18 位小數。 */
  entryPrice: Amount;
  margin: Amount;
  leverage: bigint;
  openedAt: bigint;
  closedAt: bigint;
  realizedPnL: Amount;
  copiedFrom: Address | null;
  /** 只對未平倉部位讀取；讀取失敗（例如價格過期導致 revert）時為 null。 */
  unrealizedPnL: Amount | null;
  pendingFunding: Amount | null;
}

export interface AccountView extends BlockContext {
  user: Address;
  freeMargin: Amount;
  health: { equity: Amount; maintenance: Amount; healthy: boolean } | null;
  /** 此地址曾經開過的全部部位 id（含已平倉）。 */
  positionIds: bigint[];
  /** 預設只含未平倉；`includeClosed: true` 時全部。 */
  positions: PositionView[];
}

export interface OracleView {
  price: Amount;
  updatedAt: bigint;
  updatedAtIso: string | null;
  /** 以交易所 maxPriceAge 判斷（與鏈上開倉／平倉／清算的判準相同），基準為該區塊時間。 */
  freshness: TradeFreshness;
}

export interface MarketView extends BlockContext {
  asset: AssetSymbol | null;
  assetId: Hex;
  oracle: OracleView;
  /** P1 逐資產模式。 */
  mode: Optional<AssetMode>;
  /** P1 全域暫停。 */
  paused: Optional<boolean>;
  fundingRateBps: bigint;
  maxLeverage: bigint;
  /** 開倉需附的 ETH（wei）。 */
  executionFee: Amount;
  openInterest: {
    /** 開倉時名目加總（18 位小數 USD）。 */
    longNotional: Amount;
    shortNotional: Amount;
    /** P1：未平倉數量（base 單位，18 位小數）。 */
    longOpenSize: Optional<Amount>;
    shortOpenSize: Optional<Amount>;
    /** P1：數量 × 該區塊的 oracle 價（18 位小數 USD），與合約 OI 上限同單位。 */
    longOpenValue: Optional<Amount>;
    shortOpenValue: Optional<Amount>;
    /** P1：OI 上限（18 位小數 USD，0 = 未設上限）。 */
    maxLongOI: Optional<Amount>;
    maxShortOI: Optional<Amount>;
  };
  /**
   * 僅供參考的「此刻開倉是否可能成功」：價格新鮮、且（若合約支援）資產為 Active、未暫停。
   * 不含 KYC、槓桿、OI 上限、保證金等其他條件。**不要拿它去擋平倉** —— SDK 從不限制平倉。
   */
  openLikelyAllowed: boolean;
}

export interface SessionView extends BlockContext {
  sessionManager: Address;
  sessionId: bigint;
  /** user 為 0x0 → 此 id 不存在。 */
  exists: boolean;
  user: Address;
  agent: Address;
  maxMarginPerTrade: Amount;
  totalMarginBudget: Amount;
  spentMargin: Amount;
  remainingBudget: Amount;
  maxLeverage: bigint;
  expiry: bigint;
  revoked: boolean;
  /** 以區塊時間判斷（合約：block.timestamp > expiry 即失效）。 */
  expired: boolean;
  active: boolean;
  /** 允許的資產；空陣列代表「不限資產」（見 unrestricted）。 */
  allowedAssets: { assetId: Hex; asset: AssetSymbol | null }[];
  /** true = 沒有資產白名單，agent 可交易所有資產。 */
  unrestricted: boolean;
}

export class ReadCallError extends Error {
  readonly functionName: string;
  readonly address: Address;
  constructor(functionName: string, address: Address, cause: unknown) {
    super(`讀取 ${functionName} @ ${address} 失敗：${(cause as Error)?.message?.split("\n")[0] ?? cause}`);
    this.name = "ReadCallError";
    this.functionName = functionName;
    this.address = address;
    (this as { cause?: unknown }).cause = cause;
  }
}

// ── 內部：同一區塊的批次讀取 ─────────────────────────────────────────────────

interface Call {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}
type CallResult = { ok: true; value: unknown } | { ok: false; error: unknown };

/**
 * 合約層面的失敗（revert／沒有這個函式）→ true；RPC／網路錯誤 → false。
 * 節點回報 revert 的方式不一：Base Sepolia 回 code 3，部分 geth 回 -32000 "execution reverted"
 * （viem 會把後者辨識成 ExecutionRevertedError），兩種都算。
 */
function isContractLevelFailure(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return Boolean(
    err.walk(
      (e) =>
        e instanceof ContractFunctionRevertedError ||
        e instanceof ContractFunctionZeroDataError ||
        e instanceof ExecutionRevertedError,
    ),
  );
}

// ── Client ───────────────────────────────────────────────────────────────────

export interface PepeReadClient {
  readonly chainId: number;
  readonly addresses: SdkAddresses;
  readonly publicClient: PublicClient;
  getBlockContext(opts?: ReadOptions): Promise<BlockContext>;
  getAccount(user: string, opts?: ReadOptions & { includeClosed?: boolean }): Promise<AccountView>;
  getPosition(positionId: bigint | number, opts?: ReadOptions): Promise<PositionView & BlockContext>;
  getMarket(asset: string, opts?: ReadOptions): Promise<MarketView>;
  /** 多個資產，同一區塊。預設全部已知資產。 */
  getMarkets(assets?: readonly string[], opts?: ReadOptions): Promise<MarketView[]>;
  getSession(sessionId: bigint | number, opts?: ReadOptions): Promise<SessionView>;
}

export function createReadClient(cfg: ReadClientConfig): PepeReadClient {
  const addresses = resolveAddresses(cfg.chainId, cfg.addresses);
  let client: PublicClient;
  if (cfg.publicClient) {
    const cid = cfg.publicClient.chain?.id;
    if (cid !== undefined && cid !== cfg.chainId) {
      throw new Error(`publicClient 的 chain.id(${cid}) 與 chainId(${cfg.chainId}) 不一致`);
    }
    client = cfg.publicClient;
  } else if (cfg.rpcUrl) {
    client = createPublicClient({ transport: http(cfg.rpcUrl) }) as PublicClient;
  } else {
    throw new Error("createReadClient 需要 publicClient 或 rpcUrl（SDK 不替你挑 RPC）");
  }
  const lag = BigInt(Math.max(0, Math.floor(cfg.latestBlockLag ?? 0)));
  const useMulticall = cfg.multicall ?? Boolean(client.chain?.contracts?.multicall3);

  async function getBlockContext(opts: ReadOptions = {}): Promise<BlockContext> {
    let bn = opts.blockNumber;
    if (bn === undefined) {
      const latest = await client.getBlockNumber({ cacheTime: 0 });
      bn = latest > lag ? latest - lag : latest;
    }
    const block = await client.getBlock({ blockNumber: bn });
    return { blockNumber: bn, blockTimestamp: block.timestamp };
  }

  async function batch(calls: Call[], blockNumber: bigint): Promise<CallResult[]> {
    if (calls.length === 0) return [];
    if (useMulticall) {
      // RPC 層級的錯誤會整批丟出（不吞）；個別呼叫的 revert 以 failure 回來。
      const res = (await client.multicall({
        contracts: calls as never,
        allowFailure: true,
        blockNumber,
      })) as { status: "success" | "failure"; result?: unknown; error?: unknown }[];
      return res.map((r) => (r.status === "success" ? { ok: true, value: r.result } : { ok: false, error: r.error }));
    }
    return Promise.all(
      calls.map(async (c): Promise<CallResult> => {
        try {
          const value = await client.readContract({ ...c, blockNumber } as never);
          return { ok: true, value };
        } catch (error) {
          if (isContractLevelFailure(error)) return { ok: false, error };
          throw error; // RPC／網路錯誤：不假裝成「合約不支援」
        }
      }),
    );
  }

  const need = <T>(r: CallResult, c: Call): T => {
    if (!r.ok) throw new ReadCallError(c.functionName, c.address, r.error);
    return r.value as T;
  };
  const opt = <T>(r: CallResult): Optional<T> =>
    r.ok ? { supported: true, value: r.value as T } : { supported: false, value: null };
  const maybe = <T>(r: CallResult): T | null => (r.ok ? (r.value as T) : null);

  const ex = (functionName: string, args?: readonly unknown[]): Call => ({
    address: addresses.perpetualExchange,
    abi: PERPETUAL_EXCHANGE_ABI as Abi,
    functionName,
    args,
  });

  type RawPosition = {
    id: bigint; owner: Address; asset: Hex; isLong: boolean; entryPrice: bigint; margin: bigint;
    leverage: bigint; openedAt: bigint; closedAt: bigint; realizedPnL: bigint; isOpen: boolean;
    copiedFrom: Address; entryFundingIndex: bigint;
  };

  const toPositionView = (p: RawPosition, upnl: bigint | null, pf: bigint | null): PositionView => ({
    positionId: p.id,
    owner: p.owner,
    assetId: p.asset,
    asset: assetSymbolOf(p.asset),
    isLong: p.isLong,
    isOpen: p.isOpen,
    entryPrice: margin(p.entryPrice),
    margin: margin(p.margin),
    leverage: p.leverage,
    openedAt: p.openedAt,
    closedAt: p.closedAt,
    realizedPnL: margin(p.realizedPnL),
    copiedFrom: p.copiedFrom.toLowerCase() === ZERO_ADDRESS ? null : p.copiedFrom,
    unrealizedPnL: upnl === null ? null : margin(upnl),
    pendingFunding: pf === null ? null : margin(pf),
  });

  /** 讀一批部位（同一區塊），未平倉的另外讀 PnL 與 funding。 */
  async function readPositions(ids: bigint[], blockNumber: bigint): Promise<PositionView[]> {
    const posCalls = ids.map((id) => ex("getPosition", [id]));
    const raw = (await batch(posCalls, blockNumber)).map((r, i) => need<RawPosition>(r, posCalls[i]!));
    const open = raw.filter((p) => p.isOpen);
    const extraCalls = open.flatMap((p) => [ex("getUnrealizedPnL", [p.id]), ex("pendingFunding", [p.id])]);
    const extra = await batch(extraCalls, blockNumber);
    const byId = new Map<bigint, [bigint | null, bigint | null]>();
    open.forEach((p, i) => byId.set(p.id, [maybe<bigint>(extra[2 * i]!), maybe<bigint>(extra[2 * i + 1]!)]));
    return raw.map((p) => {
      const [u, f] = byId.get(p.id) ?? [null, null];
      return toPositionView(p, u, f);
    });
  }

  async function getAccount(user: string, opts: ReadOptions & { includeClosed?: boolean } = {}): Promise<AccountView> {
    const owner = getAddress(user);
    const ctx = await getBlockContext(opts);
    const calls = [ex("freeMargin", [owner]), ex("getAccountHealth", [owner]), ex("getUserPositions", [owner])];
    const [fm, health, ids] = await batch(calls, ctx.blockNumber);
    const positionIds = need<readonly bigint[]>(ids!, calls[2]!).slice();
    const h = maybe<readonly [bigint, bigint, boolean]>(health!);
    const all = await readPositions(positionIds, ctx.blockNumber);
    return {
      ...ctx,
      user: owner,
      freeMargin: margin(need<bigint>(fm!, calls[0]!)),
      health: h ? { equity: margin(h[0]), maintenance: margin(h[1]), healthy: h[2] } : null,
      positionIds,
      positions: opts.includeClosed ? all : all.filter((p) => p.isOpen),
    };
  }

  async function getPosition(positionId: bigint | number, opts: ReadOptions = {}) {
    const ctx = await getBlockContext(opts);
    const [p] = await readPositions([BigInt(positionId)], ctx.blockNumber);
    return { ...ctx, ...p! };
  }

  async function getMarkets(assets: readonly string[] = ASSET_SYMBOLS, opts: ReadOptions = {}): Promise<MarketView[]> {
    const ctx = await getBlockContext(opts);
    const ids = assets.map(toAssetId);
    const global = [ex("maxPriceAge"), ex("executionFee"), ex("paused")];
    const perAsset = (id: Hex): Call[] => [
      { address: addresses.oracle, abi: ORACLE_ABI as Abi, functionName: "getPrice", args: [id] },
      ex("getFundingRate", [id]),
      ex("maxLeverageForAsset", [id]),
      ex("globalLongNotional", [id]),
      ex("globalShortNotional", [id]),
      ex("assetMode", [id]),
      ex("longOpenSize", [id]),
      ex("shortOpenSize", [id]),
      ex("maxLongOI", [id]),
      ex("maxShortOI", [id]),
    ];
    const PER = 10;
    const calls = [...global, ...ids.flatMap(perAsset)];
    const res = await batch(calls, ctx.blockNumber);
    const maxPriceAge = need<bigint>(res[0]!, calls[0]!);
    const executionFee = need<bigint>(res[1]!, calls[1]!);
    const paused = opt<boolean>(res[2]!);

    return ids.map((assetId, i): MarketView => {
      const o = global.length + i * PER;
      const r = (k: number) => res[o + k]!;
      const c = (k: number) => calls[o + k]!;
      const [p, updatedAt] = need<readonly [bigint, bigint]>(r(0), c(0));
      const freshness = classifyTradeFreshness({
        updatedAtSec: Number(updatedAt),
        nowSec: Number(ctx.blockTimestamp),
        maxPriceAgeSec: Number(maxPriceAge),
      });
      const modeRaw = opt<number>(r(5));
      const mode: Optional<AssetMode> = modeRaw.supported
        ? { supported: true, value: ASSET_MODES[modeRaw.value] ?? (() => { throw new Error(`未知的 assetMode ${modeRaw.value}`); })() }
        : { supported: false, value: null };
      const size = (k: number): Optional<Amount> => {
        const v = opt<bigint>(r(k));
        return v.supported ? { supported: true, value: margin(v.value) } : v;
      };
      const value = (s: Optional<Amount>): Optional<Amount> =>
        s.supported ? { supported: true, value: margin((s.value.raw * p) / 10n ** 8n) } : s;
      const longOpenSize = size(6);
      const shortOpenSize = size(7);
      return {
        ...ctx,
        asset: assetSymbolOf(assetId),
        assetId,
        oracle: { price: price(p), updatedAt, updatedAtIso: isoOrNull(updatedAt), freshness },
        mode,
        paused,
        fundingRateBps: need<bigint>(r(1), c(1)),
        maxLeverage: need<bigint>(r(2), c(2)),
        executionFee: amount(executionFee, NATIVE_DECIMALS),
        openInterest: {
          longNotional: margin(need<bigint>(r(3), c(3))),
          shortNotional: margin(need<bigint>(r(4), c(4))),
          longOpenSize,
          shortOpenSize,
          longOpenValue: value(longOpenSize),
          shortOpenValue: value(shortOpenSize),
          maxLongOI: size(8),
          maxShortOI: size(9),
        },
        openLikelyAllowed:
          freshness.fresh && p > 0n &&
          (!mode.supported || mode.value === "Active") &&
          (!paused.supported || paused.value === false),
      };
    });
  }

  async function getMarket(asset: string, opts: ReadOptions = {}): Promise<MarketView> {
    const [m] = await getMarkets([asset], opts);
    return m!;
  }

  async function getSession(sessionId: bigint | number, opts: ReadOptions = {}): Promise<SessionView> {
    const mgr = addresses.sessionManager;
    if (!mgr) throw new Error(`chainId ${cfg.chainId} 沒有 AgentSessionManager 位址`);
    const sid = BigInt(sessionId);
    const ctx = await getBlockContext(opts);
    const calls: Call[] = [
      { address: mgr, abi: AGENT_SESSION_MANAGER_ABI as Abi, functionName: "sessions", args: [sid] },
      { address: mgr, abi: AGENT_SESSION_MANAGER_ABI as Abi, functionName: "allowedAssets", args: [sid] },
    ];
    const [s, a] = await batch(calls, ctx.blockNumber);
    const [user, agent, maxPer, budget, spent, maxLev, expiry, revoked] =
      need<readonly [Address, Address, bigint, bigint, bigint, bigint, bigint, boolean]>(s!, calls[0]!);
    const allowed = need<readonly Hex[]>(a!, calls[1]!);
    const exists = user.toLowerCase() !== ZERO_ADDRESS;
    const expired = ctx.blockTimestamp > expiry;
    return {
      ...ctx,
      sessionManager: mgr,
      sessionId: sid,
      exists,
      user,
      agent,
      maxMarginPerTrade: margin(maxPer),
      totalMarginBudget: margin(budget),
      spentMargin: margin(spent),
      remainingBudget: margin(budget > spent ? budget - spent : 0n),
      maxLeverage: maxLev,
      expiry,
      revoked,
      expired,
      active: exists && !revoked && !expired,
      allowedAssets: allowed.map((id) => ({ assetId: id, asset: assetSymbolOf(id) })),
      unrestricted: allowed.length === 0,
    };
  }

  return {
    chainId: cfg.chainId,
    addresses,
    publicClient: client,
    getBlockContext,
    getAccount,
    getPosition,
    getMarket,
    getMarkets,
    getSession,
  };
}
