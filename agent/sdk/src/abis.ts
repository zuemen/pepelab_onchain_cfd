// SDK 用到的最小 ABI（viem human-readable）。
//
// 為什麼不直接用 frontend/src/contracts/abi/*.json：那批 JSON 是現行部署版（沒有 P1 的
// assetMode / paused / OI 上限），而 master 的合約原始碼已經有了。SDK 兩邊都要能讀，
// 所以只列需要的函式，P1 的讀取另外標記「可能不存在」並以 allowFailure 處理。
//
// test/abi.test.ts 會把這裡每個函式的 selector 與 frontend ABI JSON 比對；
// 只有列在 P1_OPTIONAL_READS 的函式允許不在 JSON 裡，而且必須出現在
// contracts/src/PerpetualExchange.sol。
import { parseAbi } from "viem";

/** Position struct —— 只取原始 13 個欄位（合約是「只附加不插入」，舊解碼永遠正確）。 */
const POSITION_TUPLE =
  "(uint256 id, address owner, bytes32 asset, bool isLong, uint256 entryPrice, uint256 margin, uint256 leverage, uint256 openedAt, uint256 closedAt, int256 realizedPnL, bool isOpen, address copiedFrom, int256 entryFundingIndex)";

export const PERPETUAL_EXCHANGE_ABI = parseAbi([
  // ── 讀取（現行部署版皆有）
  "function freeMargin(address) view returns (uint256)",
  "function getUserPositions(address user) view returns (uint256[])",
  `function getPosition(uint256 positionId) view returns (${POSITION_TUPLE})`,
  "function getUnrealizedPnL(uint256 positionId) view returns (int256)",
  "function pendingFunding(uint256 positionId) view returns (int256)",
  "function getAccountHealth(address owner) view returns (int256 equity, uint256 maintenance, bool healthy)",
  "function getFundingRate(bytes32 asset) view returns (int256 rateBps)",
  "function globalLongNotional(bytes32) view returns (uint256)",
  "function globalShortNotional(bytes32) view returns (uint256)",
  "function maxPriceAge() view returns (uint256)",
  "function executionFee() view returns (uint256)",
  "function maxLeverageForAsset(bytes32 asset) view returns (uint256)",
  "function usdc() view returns (address)",
  "function oracle() view returns (address)",
  // ── 讀取（P1：master 原始碼有，現行部署版可能沒有 → 以 allowFailure 讀）
  "function assetMode(bytes32) view returns (uint8)",
  "function paused() view returns (bool)",
  "function longOpenSize(bytes32) view returns (uint256)",
  "function shortOpenSize(bytes32) view returns (uint256)",
  "function maxLongOI(bytes32) view returns (uint256)",
  "function maxShortOI(bytes32) view returns (uint256)",
  // ── 寫入（SDK 只建構，不簽）
  "function depositMargin(uint256 amount)",
  "function withdrawMargin(uint256 amount)",
  "function openPosition(bytes32 asset, bool isLong, uint256 margin, uint256 leverage) payable returns (uint256 positionId)",
  "function closePosition(uint256 positionId)",
]);

/** 可能不存在於現行部署版的讀取（P1 緊急控制與 OI 上限）。 */
export const P1_OPTIONAL_READS = [
  "assetMode",
  "paused",
  "longOpenSize",
  "shortOpenSize",
  "maxLongOI",
  "maxShortOI",
] as const;

export const ORACLE_ABI = parseAbi([
  "function getPrice(bytes32 assetId) view returns (uint256 price, uint256 updatedAt)",
]);

export const AGENT_SESSION_MANAGER_ABI = parseAbi([
  "function sessions(uint256) view returns (address user, address agent, uint256 maxMarginPerTrade, uint256 totalMarginBudget, uint256 spentMargin, uint256 maxLeverage, uint256 expiry, bool revoked)",
  "function allowedAssets(uint256 sessionId) view returns (bytes32[])",
  "function nextSessionId() view returns (uint256)",
  "function exchange() view returns (address)",
  "function createSessionWithAssets(address agent, uint256 maxMarginPerTrade, uint256 totalMarginBudget, uint256 maxLeverage, uint256 expiry, bytes32[] allowedAssets) returns (uint256 sessionId)",
  "function setSessionAssets(uint256 sessionId, bytes32[] assets)",
  "function revokeSession(uint256 sessionId)",
  "function openPositionForSession(uint256 sessionId, bytes32 asset, bool isLong, uint256 margin, uint256 leverage, address copiedFrom) payable returns (uint256 positionId)",
  "function closePositionForSession(uint256 sessionId, uint256 positionId)",
]);

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
