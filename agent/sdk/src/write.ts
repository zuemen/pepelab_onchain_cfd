// 交易建構（不簽、不送）。
//
// 每個 builder 回傳 `{ to, data, value, request }`：
//   • to / data / value —— 交給任何簽署端（HSM、MPC、Fireblocks、wallet）使用的原始交易欄位；
//   • request —— 可直接展開給 viem `publicClient.simulateContract({ ...request, account })`
//     或 `walletClient.writeContract({ ...request, account })`。
// SDK 從不持有私鑰，也不替呼叫端送出交易。
//
// ⚠ 平倉（closePosition / closePositionForSession）刻意「沒有任何額外限制」：
//   不查資產模式、不查暫停、不查價格新鮮度、不查 VC 或政策閘門。這些 builder 是純函式，
//   不讀鏈、不接收 client —— 使用者退出部位的權利不應被 SDK 的任何判斷擋住。
//   鏈上若因暫停或 Halted 而拒絕，那是合約的決定，由 simulate 告訴呼叫端。
import { encodeFunctionData, getAddress, isAddress, type Abi, type Address, type Hex } from "viem";

import { AGENT_SESSION_MANAGER_ABI, ERC20_ABI, PERPETUAL_EXCHANGE_ABI } from "./abis.ts";
import { toAssetId, ZERO_ADDRESS, type SdkAddresses } from "./addresses.ts";

export interface ContractRequest {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

export interface UnsignedTx {
  to: Address;
  data: Hex;
  /** 附帶的原生幣（wei）。沒有時為 0n。 */
  value: bigint;
  /** viem simulateContract / writeContract 的參數（呼叫端補上 account）。 */
  request: ContractRequest;
}

export class TxBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TxBuildError";
  }
}

const UINT256_MAX = 2n ** 256n - 1n;

function uint(label: string, v: bigint | number | string, { positive = false } = {}): bigint {
  let b: bigint;
  try {
    b = BigInt(v);
  } catch {
    throw new TxBuildError(`${label} 不是整數：${String(v)}`);
  }
  if (b < 0n || b > UINT256_MAX) throw new TxBuildError(`${label} 超出 uint256 範圍：${b}`);
  if (positive && b === 0n) throw new TxBuildError(`${label} 必須 > 0`);
  return b;
}

/** 方向必須是真正的 boolean —— `Boolean(undefined)` 會悄悄變成做空（審查 L1）。 */
function bool(label: string, v: unknown): boolean {
  if (typeof v !== "boolean") throw new TxBuildError(`${label} 必須是 boolean（收到 ${typeof v}）`);
  return v;
}

function addr(label: string, a: string, { nonZero = true } = {}): Address {
  if (!isAddress(a)) throw new TxBuildError(`${label} 不是合法地址：${a}`);
  const g = getAddress(a);
  if (nonZero && g.toLowerCase() === ZERO_ADDRESS) throw new TxBuildError(`${label} 不可為零地址`);
  return g;
}

function build(address: Address, abi: Abi, functionName: string, args: readonly unknown[], value = 0n): UnsignedTx {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const request: ContractRequest = { address, abi, functionName, args };
  if (value > 0n) request.value = value;
  return { to: address, data, value, request };
}

type Addrs = Pick<SdkAddresses, "perpetualExchange" | "marginToken" | "sessionManager">;

function sessionManagerOf(a: Addrs): Address {
  if (!a.sessionManager) throw new TxBuildError(`此鏈沒有 AgentSessionManager 位址`);
  return a.sessionManager;
}

// ── 保證金 ───────────────────────────────────────────────────────────────────

/**
 * 存入保證金前的 ERC-20 approve（保證金代幣 → exchange）。
 * 預設只授權「這次要存入的量」（amount，18 位小數原始值）。無上限授權必須明確傳
 * `{ unlimited: true }`（exchange 或其 owner 出事時，無上限授權會讓錢包裡的全部保證金代幣暴露）。
 */
export function buildApproveMargin(a: Addrs, p: { amount: bigint } | { unlimited: true }): UnsignedTx {
  if ("unlimited" in p) {
    if (p.unlimited !== true) throw new TxBuildError("unlimited 必須明確為 true");
    return build(a.marginToken, ERC20_ABI as Abi, "approve", [a.perpetualExchange, UINT256_MAX]);
  }
  // amount 0 刻意拒絕；撤銷授權請用 buildRevokeMarginApproval（見下）。
  return build(a.marginToken, ERC20_ABI as Abi, "approve", [a.perpetualExchange, uint("amount", p.amount, { positive: true })]);
}

/**
 * 撤銷保證金代幣對 exchange 的授權：approve(exchange, 0)（#203 L-b）。
 *
 * 刻意做成獨立 builder，而不是讓 `buildApproveMargin({ amount: 0n })` 通過：金額 0 多半是上游
 * 換算或解析出錯（例如把 "0.0000001" 截成 0），悄悄變成「撤銷授權」會讓人以為存入流程正常，
 * 實際上卻把授權清掉。撤銷是一個要明確表達的意圖，所以用名稱表達，`amount: 0n` 照舊丟錯。
 */
export function buildRevokeMarginApproval(a: Pick<Addrs, "perpetualExchange" | "marginToken">): UnsignedTx {
  return build(addr("marginToken", a.marginToken), ERC20_ABI as Abi, "approve", [addr("perpetualExchange", a.perpetualExchange), 0n]);
}

/** depositMargin(amount)。需先 approve。 */
export function buildDepositMargin(a: Addrs, p: { amount: bigint }): UnsignedTx {
  return build(a.perpetualExchange, PERPETUAL_EXCHANGE_ABI as Abi, "depositMargin", [
    uint("amount", p.amount, { positive: true }),
  ]);
}

/** withdrawMargin(amount)。 */
export function buildWithdrawMargin(a: Addrs, p: { amount: bigint }): UnsignedTx {
  return build(a.perpetualExchange, PERPETUAL_EXCHANGE_ABI as Abi, "withdrawMargin", [
    uint("amount", p.amount, { positive: true }),
  ]);
}

// ── 開倉／平倉（自己的帳戶）────────────────────────────────────────────────

export interface OpenPositionParams {
  /** 資產代號（sBTC）或 bytes32 assetId。 */
  asset: string;
  isLong: boolean;
  /** 保證金（18 位小數原始值）。 */
  margin: bigint;
  /** 整數槓桿（合約上限 MAX_LEVERAGE，另受逐資產上限限制）。 */
  leverage: bigint | number;
  /**
   * 附帶的 executionFee（wei）。必填 —— 由 `read.getMarket(asset).executionFee.raw` 取得；
   * SDK 不猜數字（不足會 revert，多付合約會退回）。
   */
  executionFee: bigint;
}

export function buildOpenPosition(a: Addrs, p: OpenPositionParams): UnsignedTx {
  return build(
    a.perpetualExchange,
    PERPETUAL_EXCHANGE_ABI as Abi,
    "openPosition",
    [toAssetId(p.asset), bool("isLong", p.isLong), uint("margin", p.margin, { positive: true }), uint("leverage", p.leverage, { positive: true })],
    uint("executionFee", p.executionFee),
  );
}

/** closePosition(positionId)。無任何額外限制（見檔頭）。 */
export function buildClosePosition(a: Pick<Addrs, "perpetualExchange">, p: { positionId: bigint | number | string }): UnsignedTx {
  return build(a.perpetualExchange, PERPETUAL_EXCHANGE_ABI as Abi, "closePosition", [uint("positionId", p.positionId)]);
}

// ── Agent session ────────────────────────────────────────────────────────────

export interface CreateSessionParams {
  agent: string;
  /** 18 位小數原始值。 */
  maxMarginPerTrade: bigint;
  totalMarginBudget: bigint;
  maxLeverage: bigint | number;
  /** unix 秒。 */
  expiry: bigint | number;
  /**
   * 允許 agent 交易的資產（代號或 bytes32）。**不可為空** —— 合約把空陣列視為「全部允許」，
   * 對機構客戶來說那幾乎一定不是本意。真的要不限資產，請明確呼叫合約的 createSession，
   * 並在自己的審批流程留下紀錄；SDK 不提供這條捷徑。
   */
  allowedAssets: readonly string[];
  /** 驗證 expiry 用的「現在」（unix 秒）。預設本機時間；可傳鏈上區塊時間。 */
  nowSec?: bigint | number;
}

export class EmptyAssetListError extends TxBuildError {
  constructor(fn: string) {
    super(
      `${fn}：allowedAssets 不可為空。AgentSessionManager 把空陣列視為「不限資產」，` +
        `agent 將能交易所有資產。請明確列出允許的資產。`,
    );
    this.name = "EmptyAssetListError";
  }
}

function assetList(fn: string, assets: readonly string[] | undefined): Hex[] {
  if (!Array.isArray(assets) || assets.length === 0) throw new EmptyAssetListError(fn);
  const ids = assets.map(toAssetId);
  return [...new Set(ids)];
}

export function buildCreateSessionWithAssets(a: Addrs, p: CreateSessionParams): UnsignedTx {
  const assets = assetList("createSessionWithAssets", p.allowedAssets);
  const expiry = uint("expiry", p.expiry, { positive: true });
  const now = BigInt(p.nowSec ?? Math.floor(Date.now() / 1000));
  if (expiry <= now) throw new TxBuildError(`expiry(${expiry}) 必須晚於現在(${now})`);
  return build(sessionManagerOf(a), AGENT_SESSION_MANAGER_ABI as Abi, "createSessionWithAssets", [
    addr("agent", p.agent),
    uint("maxMarginPerTrade", p.maxMarginPerTrade, { positive: true }),
    uint("totalMarginBudget", p.totalMarginBudget, { positive: true }),
    uint("maxLeverage", p.maxLeverage, { positive: true }),
    expiry,
    assets,
  ]);
}

/**
 * setSessionAssets —— 同樣拒絕空陣列。現行部署的 AgentSessionManager 把空陣列當成「清除限制
 * （全部資產都允許）」；master 原始碼已改為 revert EmptyAssetList，但舊部署仍會接受，所以 SDK
 * 這一層的拒絕要保留。
 */
export function buildSetSessionAssets(a: Addrs, p: { sessionId: bigint | number; allowedAssets: readonly string[] }): UnsignedTx {
  const assets = assetList("setSessionAssets", p.allowedAssets);
  return build(sessionManagerOf(a), AGENT_SESSION_MANAGER_ABI as Abi, "setSessionAssets", [uint("sessionId", p.sessionId), assets]);
}

export function buildRevokeSession(a: Addrs, p: { sessionId: bigint | number }): UnsignedTx {
  return build(sessionManagerOf(a), AGENT_SESSION_MANAGER_ABI as Abi, "revokeSession", [uint("sessionId", p.sessionId)]);
}

/** Agent（session key）在 session 限額內開倉。copiedFrom 固定為 0x0（非 0 會被 exchange 拒絕）。 */
export function buildOpenPositionForSession(
  a: Addrs,
  p: Omit<OpenPositionParams, "executionFee"> & { sessionId: bigint | number; executionFee: bigint },
): UnsignedTx {
  return build(
    sessionManagerOf(a),
    AGENT_SESSION_MANAGER_ABI as Abi,
    "openPositionForSession",
    [
      uint("sessionId", p.sessionId),
      toAssetId(p.asset),
      bool("isLong", p.isLong),
      uint("margin", p.margin, { positive: true }),
      uint("leverage", p.leverage, { positive: true }),
      ZERO_ADDRESS,
    ],
    uint("executionFee", p.executionFee),
  );
}

/** Agent 平倉（只能平自己 session 開的部位，由合約檢查）。無任何額外限制。 */
export function buildClosePositionForSession(
  a: Pick<Addrs, "sessionManager">,
  p: { sessionId: bigint | number | string; positionId: bigint | number | string },
): UnsignedTx {
  if (!a.sessionManager) throw new TxBuildError(`此鏈沒有 AgentSessionManager 位址`);
  return build(a.sessionManager, AGENT_SESSION_MANAGER_ABI as Abi, "closePositionForSession", [
    uint("sessionId", p.sessionId),
    uint("positionId", p.positionId),
  ]);
}
