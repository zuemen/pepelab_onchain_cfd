// 舊版 PerpetualExchange 的讀取、預檢與錯誤分類（/legacy 頁的純邏輯部分）。
//
// 舊合約來自不同時期的原始碼，ABI 不一樣（2026-06 版 76 個函式、2026-09 版 90 個，
// Sepolia 早期版更少）。這裡不假設任何一版的完整 ABI，而是：
//
//   1. 只用五個從第一版到現在都沒變過的函式（freeMargin / getUserPositions /
//      positions / withdrawMargin / closePosition），加上 usdc / oracle 兩個 immutable；
//   2. 先讀 bytecode 做 selector 探測，確定函式真的存在才呼叫；
//   3. `positions(id)` 的回傳只解前 11 個欄位——Position struct 一路都是「在尾端追加」，
//      前 11 個欄位（id … isOpen）在每一版的位置都相同（見 docs/LEGACY_EXCHANGES.md）。
//
// 任何一個寫入動作送出前都先用 eth_call（from = 使用者）預檢；預檢失敗就不送，並把
// revert 分類成使用者看得懂的原因。分類結果裡的 needsOperator 代表「使用者自己無法
// 解決，要找營運方」，頁面據此顯示租戶的客服聯絡方式。

import type { LegacyExchange } from 'src/contracts/legacyExchanges';

import { id, Interface, AbiCoder, getAddress, dataSlice } from 'ethers';

import { t, interpolate } from 'src/locales';

import { classifyFreshness } from './priceFreshness';

// ----------------------------------------------------------------------

export const LEGACY_EXCHANGE_ABI = [
  'function freeMargin(address) view returns (uint256)',
  'function getUserPositions(address) view returns (uint256[])',
  'function withdrawMargin(uint256)',
  'function closePosition(uint256)',
  'function usdc() view returns (address)',
  'function oracle() view returns (address)',
  'function maxPriceAge() view returns (uint256)',
] as const;

const EXCHANGE = new Interface(LEGACY_EXCHANGE_ABI);
const AUX = new Interface([
  'function positions(uint256) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function getPrice(bytes32) view returns (uint256, uint256)',
  'function decimals() view returns (uint8)',
]);

const sel = (signature: string) => id(signature).slice(0, 10);

/** 頁面需要的函式 selector。測試把它們釘成實際的 4-byte 值。 */
export const LEGACY_SELECTORS = {
  freeMargin: sel('freeMargin(address)'),
  getUserPositions: sel('getUserPositions(address)'),
  positions: sel('positions(uint256)'),
  withdrawMargin: sel('withdrawMargin(uint256)'),
  closePosition: sel('closePosition(uint256)'),
  usdc: sel('usdc()'),
  oracle: sel('oracle()'),
  maxPriceAge: sel('maxPriceAge()'),
} as const;

export type LegacyCapability = keyof typeof LEGACY_SELECTORS;
export type LegacyCapabilities = Record<LegacyCapability, boolean>;

/**
 * 從 runtime bytecode 撈出所有 PUSH4 的運算元（Solidity dispatcher 用 PUSH4 比對 selector）。
 * 跳過其他 PUSHn 的資料區，否則資料裡剛好出現 0x63 會被誤當成 PUSH4。
 *
 * 這是「可能存在」的上界：PUSH4 也可能是一般常數，但一個 selector 不在這裡就一定不存在。
 * 頁面只把它當成「不在就不呼叫」的閘門，真正能不能成功仍以 eth_call 預檢為準。
 */
export function scanPush4Selectors(bytecode: string): Set<string> {
  const hex = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
  const out = new Set<string>();
  const n = Math.floor(hex.length / 2);
  for (let i = 0; i < n; i += 1) {
    const op = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (op === 0x63 && i + 4 < n) {
      out.add(`0x${hex.slice((i + 1) * 2, (i + 5) * 2).toLowerCase()}`);
    }
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return out;
}

export function probeCapabilities(bytecode: string): LegacyCapabilities {
  const present = scanPush4Selectors(bytecode);
  const caps = {} as LegacyCapabilities;
  for (const [name, s] of Object.entries(LEGACY_SELECTORS) as [LegacyCapability, string][]) {
    caps[name] = present.has(s);
  }
  return caps;
}

/** 讀出使用者資產所需的最少函式。缺任何一個就無法判斷使用者在這個合約上有什麼。 */
export function canReadAssets(c: LegacyCapabilities): boolean {
  return c.freeMargin && c.getUserPositions && c.positions;
}

// ----------------------------------------------------------------------

/** `positions(id)` 前 11 個欄位——每一版 Position struct 共同的前綴。 */
export interface LegacyPositionPrefix {
  id: bigint;
  owner: string;
  asset: string;
  isLong: boolean;
  entryPrice: bigint;
  margin: bigint;
  leverage: bigint;
  openedAt: bigint;
  closedAt: bigint;
  realizedPnL: bigint;
  isOpen: boolean;
}

const PREFIX_TYPES = [
  'uint256', 'address', 'bytes32', 'bool', 'uint256', 'uint256',
  'uint256', 'uint256', 'uint256', 'int256', 'bool',
] as const;

/**
 * 解 public getter `positions(uint256)` 的回傳。各版本的 struct 全是靜態欄位，getter
 * 會把它們攤平成連續的 32-byte word；這裡只切前 11 個 word 來解，不受尾端追加的欄位
 * （copiedFrom、entryFundingIndex、tradingFeeBps…）影響。
 */
export function decodePositionPrefix(data: string): LegacyPositionPrefix {
  const words = dataSlice(data, 0, 32 * PREFIX_TYPES.length);
  const r = AbiCoder.defaultAbiCoder().decode([...PREFIX_TYPES], words);
  return {
    id: r[0] as bigint,
    owner: getAddress(r[1] as string),
    asset: (r[2] as string).toLowerCase(),
    isLong: r[3] as boolean,
    entryPrice: r[4] as bigint,
    margin: r[5] as bigint,
    leverage: r[6] as bigint,
    openedAt: r[7] as bigint,
    closedAt: r[8] as bigint,
    realizedPnL: r[9] as bigint,
    isOpen: r[10] as boolean,
  };
}

// ----------------------------------------------------------------------
// revert 分類

export type LegacyBlockKind =
  | 'stalePrice'
  | 'oracleInvalid'
  | 'feeRouterRevoked'
  | 'vaultRevoked'
  | 'exchangeUnderfunded'
  | 'insufficientFreeMargin'
  | 'notOwner'
  | 'alreadyClosed'
  | 'paused'
  | 'unsupported'
  | 'unknown';

export interface LegacyBlock {
  kind: LegacyBlockKind;
  /** 使用者自己無法解決，需要營運方（合約 owner）處理。 */
  needsOperator: boolean;
  /** StalePrice 帶回的 updatedAt（秒）。 */
  updatedAt?: number;
  /** 原始 revert data 的前 4 bytes，供聯絡客服時附上。 */
  selector?: string;
}

export type Preflight = { ok: true } | { ok: false; block: LegacyBlock };

const ERRORS = new Interface([
  'error StalePrice(bytes32 asset, uint256 updatedAt)',
  'error InvalidPrice(bytes32 asset)',
  'error Unauthorized()',
  'error NotAuthorized()',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error InsufficientFreeMargin()',
  'error NotPositionOwner()',
  'error PositionAlreadyClosed()',
  'error EnforcedPause()',
]);

/** 主要錯誤的 selector，測試把它們釘成實際值。 */
export const LEGACY_ERROR_SELECTORS = {
  StalePrice: sel('StalePrice(bytes32,uint256)'),
  InvalidPrice: sel('InvalidPrice(bytes32)'),
  /** FeeRouter.onlyAuthorized：msg.sender 不是 FeeRouter 目前登記的 exchange。 */
  Unauthorized: sel('Unauthorized()'),
  /** InsuranceVault：msg.sender 不是 vault 目前登記的 exchange。 */
  NotAuthorized: sel('NotAuthorized()'),
  ERC20InsufficientBalance: sel('ERC20InsufficientBalance(address,uint256,uint256)'),
  InsufficientFreeMargin: sel('InsufficientFreeMargin()'),
  NotPositionOwner: sel('NotPositionOwner()'),
  PositionAlreadyClosed: sel('PositionAlreadyClosed()'),
  EnforcedPause: sel('EnforcedPause()'),
} as const;

/** 舊價格超過這個年齡（秒）就視為預言機已停止餵這個資產，不再叫使用者「稍後重試」。 */
export const ABANDONED_PRICE_AGE_SEC = 7 * 24 * 3600;

/** 從 ethers / JSON-RPC 的各種錯誤包裝裡挖出 revert data。 */
export function revertDataOf(err: unknown): string | null {
  const e = err as {
    data?: unknown;
    error?: { data?: unknown } | null;
    info?: { error?: { data?: unknown } | null } | null;
  } | null;
  const candidates = [e?.data, e?.error?.data, e?.info?.error?.data];
  for (const c of candidates) {
    if (typeof c === 'string' && /^0x[0-9a-fA-F]*$/.test(c) && c.length >= 10) return c.toLowerCase();
    // 有些節點把 data 包成 { data: '0x…' }
    const inner = (c as { data?: unknown } | null | undefined)?.data;
    if (typeof inner === 'string' && /^0x[0-9a-fA-F]*$/.test(inner) && inner.length >= 10) return inner.toLowerCase();
  }
  return null;
}

function messageOf(err: unknown): string {
  const e = err as { shortMessage?: string; reason?: string; message?: string } | null;
  return `${e?.reason ?? ''} ${e?.shortMessage ?? ''} ${e?.message ?? ''}`.toLowerCase();
}

/**
 * 把一次預檢（eth_call）的失敗分類。`nowSec` 用來判斷 StalePrice 是「稍後重試」還是
 * 「預言機已不再餵這個資產」。
 */
export function classifyLegacyRevert(err: unknown, nowSec: number): LegacyBlock {
  const data = revertDataOf(err);
  const selector = data ? data.slice(0, 10) : undefined;
  const S = LEGACY_ERROR_SELECTORS;

  switch (selector) {
    case S.StalePrice: {
      let updatedAt: number | undefined;
      try {
        updatedAt = Number(ERRORS.decodeErrorResult('StalePrice', data as string)[1]);
      } catch {
        /* 解不開就只報類別 */
      }
      const abandoned = updatedAt !== undefined && nowSec - updatedAt > ABANDONED_PRICE_AGE_SEC;
      return { kind: 'stalePrice', needsOperator: abandoned, updatedAt, selector };
    }
    case S.InvalidPrice:
      return { kind: 'oracleInvalid', needsOperator: true, selector };
    case S.Unauthorized:
      return { kind: 'feeRouterRevoked', needsOperator: true, selector };
    case S.NotAuthorized:
      return { kind: 'vaultRevoked', needsOperator: true, selector };
    case S.ERC20InsufficientBalance:
      return { kind: 'exchangeUnderfunded', needsOperator: true, selector };
    case S.InsufficientFreeMargin:
      return { kind: 'insufficientFreeMargin', needsOperator: false, selector };
    case S.NotPositionOwner:
      return { kind: 'notOwner', needsOperator: false, selector };
    case S.PositionAlreadyClosed:
      return { kind: 'alreadyClosed', needsOperator: false, selector };
    case S.EnforcedPause:
      return { kind: 'paused', needsOperator: true, selector };
    default:
      break;
  }

  // OpenZeppelin v4 的 ERC20 用 require 字串（Sepolia 早期的 MockUSDC 可能是這種）。
  const msg = messageOf(err);
  if (msg.includes('transfer amount exceeds balance')) {
    return { kind: 'exchangeUnderfunded', needsOperator: true, selector };
  }
  return { kind: 'unknown', needsOperator: true, selector };
}

// ----------------------------------------------------------------------
// 讀取

/** 讀鏈的最小介面——ethers 的 Provider 直接符合，測試可以給假的。 */
export interface LegacyReader {
  getCode(address: string): Promise<string>;
  call(tx: { to: string; from?: string; data: string }): Promise<string>;
}

export interface LegacyPositionView extends LegacyPositionPrefix {
  /** 預言機對這個資產的最後更新時間（秒）；讀不到為 null。 */
  oracleUpdatedAt: number | null;
  close: Preflight;
}

export interface LegacyWithdrawPlan {
  /** 這次能提領的金額 = min(可用保證金, 合約 USDC 餘額)。 */
  amount: bigint;
  /** 可用保證金裡，合約目前付不出來的部分。 */
  shortfall: bigint;
  preflight: Preflight;
}

export type LegacyScanStatus = 'ok' | 'noCode' | 'unsupported' | 'readFailed';

export interface LegacyExchangeScan {
  exchange: LegacyExchange;
  status: LegacyScanStatus;
  capabilities: LegacyCapabilities | null;
  freeMargin: bigint;
  /** 合約持有的 USDC；讀不到為 null。 */
  exchangeBalance: bigint | null;
  usdcDecimals: number;
  maxPriceAgeSec: number | null;
  withdraw: LegacyWithdrawPlan | null;
  positions: LegacyPositionView[];
}

/** 一個使用者在一個舊合約上最多讀幾個 position id（getUserPositions 在早期版本只增不減）。 */
export const MAX_POSITION_IDS = 200;

export function planWithdraw(freeMargin: bigint, exchangeBalance: bigint | null): { amount: bigint; shortfall: bigint } {
  if (freeMargin <= 0n) return { amount: 0n, shortfall: 0n };
  if (exchangeBalance === null) return { amount: freeMargin, shortfall: 0n };
  const amount = freeMargin < exchangeBalance ? freeMargin : exchangeBalance;
  return { amount, shortfall: freeMargin - amount };
}

async function preflight(reader: LegacyReader, tx: { to: string; from: string; data: string }, nowSec: number): Promise<Preflight> {
  try {
    await reader.call(tx);
    return { ok: true };
  } catch (err) {
    return { ok: false, block: classifyLegacyRevert(err, nowSec) };
  }
}

export function preflightWithdraw(reader: LegacyReader, exchange: string, account: string, amount: bigint, nowSec: number) {
  return preflight(reader, { to: exchange, from: account, data: EXCHANGE.encodeFunctionData('withdrawMargin', [amount]) }, nowSec);
}

export function preflightClose(reader: LegacyReader, exchange: string, account: string, positionId: bigint, nowSec: number) {
  return preflight(reader, { to: exchange, from: account, data: EXCHANGE.encodeFunctionData('closePosition', [positionId]) }, nowSec);
}

export function encodeWithdraw(amount: bigint): string {
  return EXCHANGE.encodeFunctionData('withdrawMargin', [amount]);
}

export function encodeClose(positionId: bigint): string {
  return EXCHANGE.encodeFunctionData('closePosition', [positionId]);
}

async function readOne<T>(reader: LegacyReader, to: string, iface: Interface, fn: string, args: unknown[]): Promise<T> {
  const raw = await reader.call({ to, data: iface.encodeFunctionData(fn, args) });
  return iface.decodeFunctionResult(fn, raw)[0] as T;
}

async function optional<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

const emptyScan = (exchange: LegacyExchange, status: LegacyScanStatus, capabilities: LegacyCapabilities | null): LegacyExchangeScan => ({
  exchange,
  status,
  capabilities,
  freeMargin: 0n,
  exchangeBalance: null,
  usdcDecimals: 18,
  maxPriceAgeSec: null,
  withdraw: null,
  positions: [],
});

/**
 * 讀一個舊合約上、`account` 的全部資產，並對每個可行動作做預檢。
 *
 * 逐筆循序呼叫而不是 Promise.all：Base Sepolia 的公開節點在同時大量 eth_call 時會
 * 丟掉一部分（見 rpcBatch.ts），而這裡的呼叫數很少，循序比較穩。
 */
export async function scanLegacyExchange(
  reader: LegacyReader,
  exchange: LegacyExchange,
  account: string,
  nowSec: number
): Promise<LegacyExchangeScan> {
  const to = exchange.address;
  let code: string;
  try {
    code = await reader.getCode(to);
  } catch {
    return emptyScan(exchange, 'readFailed', null);
  }
  if (!code || code === '0x') return emptyScan(exchange, 'noCode', null);

  const caps = probeCapabilities(code);
  if (!canReadAssets(caps)) return emptyScan(exchange, 'unsupported', caps);

  try {
    const freeMargin = await readOne<bigint>(reader, to, EXCHANGE, 'freeMargin', [account]);
    const ids = await readOne<bigint[]>(reader, to, EXCHANGE, 'getUserPositions', [account]);

    const me = account.toLowerCase();
    const open: LegacyPositionPrefix[] = [];
    for (const pid of [...ids].slice(0, MAX_POSITION_IDS)) {
      const raw = await reader.call({ to, data: AUX.encodeFunctionData('positions', [pid]) });
      const p = decodePositionPrefix(raw);
      if (p.isOpen && p.owner.toLowerCase() === me) open.push(p);
    }

    // 沒有任何資產就不必再讀餘額、價格或預檢。
    if (freeMargin === 0n && open.length === 0) {
      return emptyScan(exchange, 'ok', caps);
    }

    const usdc = caps.usdc ? await optional(readOne<string>(reader, to, EXCHANGE, 'usdc', [])) : null;
    const exchangeBalance = usdc ? await optional(readOne<bigint>(reader, usdc, AUX, 'balanceOf', [to])) : null;
    const usdcDecimals = usdc
      ? Number((await optional(readOne<bigint>(reader, usdc, AUX, 'decimals', []))) ?? 18n)
      : 18;
    const maxAge = caps.maxPriceAge ? await optional(readOne<bigint>(reader, to, EXCHANGE, 'maxPriceAge', [])) : null;
    const oracle = caps.oracle ? await optional(readOne<string>(reader, to, EXCHANGE, 'oracle', [])) : null;

    let withdraw: LegacyWithdrawPlan | null = null;
    if (freeMargin > 0n) {
      const plan = planWithdraw(freeMargin, exchangeBalance);
      let pf: Preflight;
      if (!caps.withdrawMargin) pf = { ok: false, block: { kind: 'unsupported', needsOperator: true } };
      else if (plan.amount === 0n) pf = { ok: false, block: { kind: 'exchangeUnderfunded', needsOperator: true } };
      else pf = await preflightWithdraw(reader, to, account, plan.amount, nowSec);
      withdraw = { ...plan, preflight: pf };
    }

    const positions: LegacyPositionView[] = [];
    for (const p of open) {
      let oracleUpdatedAt: number | null = null;
      if (oracle) {
        const raw = await optional(reader.call({ to: oracle, data: AUX.encodeFunctionData('getPrice', [p.asset]) }));
        if (raw) {
          try {
            oracleUpdatedAt = Number(AUX.decodeFunctionResult('getPrice', raw)[1]);
          } catch {
            oracleUpdatedAt = null;
          }
        }
      }
      const close: Preflight = caps.closePosition
        ? await preflightClose(reader, to, account, p.id, nowSec)
        : { ok: false, block: { kind: 'unsupported', needsOperator: true } };
      positions.push({ ...p, oracleUpdatedAt, close });
    }

    return {
      exchange,
      status: 'ok',
      capabilities: caps,
      freeMargin,
      exchangeBalance,
      usdcDecimals,
      maxPriceAgeSec: maxAge === null ? null : Number(maxAge),
      withdraw,
      positions,
    };
  } catch {
    return emptyScan(exchange, 'readFailed', caps);
  }
}

// ----------------------------------------------------------------------
// 顯示決策

export function scanHasAssets(s: LegacyExchangeScan): boolean {
  return s.freeMargin > 0n || s.positions.length > 0;
}

/** Portfolio 的入口只在使用者真的有舊資產時出現。讀取中、讀取失敗、全空都不顯示。 */
export function legacyEntryVisible(scans: readonly LegacyExchangeScan[] | null | undefined): boolean {
  return !!scans && scans.some(scanHasAssets);
}

/**
 * 預檢通過、但價格已超過合約的時效上限：代表這個舊合約根本不檢查價格時效
 * （Sepolia 早期版本），平倉會以這個舊價格結算。要讓使用者知道，而不是悄悄成交。
 */
export function settlesAtStalePrice(p: LegacyPositionView, maxPriceAgeSec: number | null, nowSec: number, fallbackSec: number): boolean {
  if (!p.close.ok || p.oracleUpdatedAt === null) return false;
  return nowSec - p.oracleUpdatedAt > (maxPriceAgeSec ?? fallbackSec);
}

/** 這個合約上是否有任何一件事需要營運方處理（用來決定要不要顯示客服聯絡區塊）。 */
export function needsOperator(s: LegacyExchangeScan): boolean {
  if (s.status === 'unsupported' || s.status === 'noCode') return false;
  if (s.withdraw && (s.withdraw.shortfall > 0n || (!s.withdraw.preflight.ok && s.withdraw.preflight.block.needsOperator))) return true;
  return s.positions.some((p) => !p.close.ok && p.close.block.needsOperator);
}

/** 「最後更新於 X 前」的 X。沿用價格新鮮度的人類可讀年齡。 */
export function ageLabel(updatedAtSec: number, nowSec: number): string {
  return classifyFreshness({ updatedAtSec, nowSec, maxPriceAgeSec: Number.MAX_SAFE_INTEGER }).label;
}

/** 預檢失敗時對使用者說的那句話。 */
export function legacyBlockMessage(block: LegacyBlock, nowSec: number): string {
  const b = t.legacy.block;
  switch (block.kind) {
    case 'stalePrice': {
      const age = block.updatedAt !== undefined ? ageLabel(block.updatedAt, nowSec) : t.freshness.unknownAge;
      return interpolate(block.needsOperator ? b.stalePriceAbandoned : b.stalePrice, { age });
    }
    case 'oracleInvalid':
      return b.oracleInvalid;
    case 'feeRouterRevoked':
      return b.feeRouterRevoked;
    case 'vaultRevoked':
      return b.vaultRevoked;
    case 'exchangeUnderfunded':
      return b.exchangeUnderfunded;
    case 'insufficientFreeMargin':
      return b.insufficientFreeMargin;
    case 'notOwner':
      return b.notOwner;
    case 'alreadyClosed':
      return b.alreadyClosed;
    case 'paused':
      return b.paused;
    case 'unsupported':
      return b.unsupported;
    default:
      return interpolate(b.unknown, { code: block.selector ?? '—' });
  }
}
