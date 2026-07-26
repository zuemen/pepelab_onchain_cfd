// Phase 1 全 read-only：只取需要的 view 函式（human-readable ABI，ethers v6）。
// 與 contracts/src 介面對齊；若合約 ABI 變動，這裡同步即可。

export const PERPETUAL_EXCHANGE_ABI = [
  "function getUserPositions(address user) view returns (uint256[])",
  "function getUnrealizedPnL(uint256 positionId) view returns (int256)",
  "function pendingFunding(uint256 positionId) view returns (int256)",
  "function getFundingRate(bytes32 asset) view returns (int256 rateBps)",
  "function globalLongNotional(bytes32) view returns (uint256)",
  "function globalShortNotional(bytes32) view returns (uint256)",
  "function executionFee() view returns (uint256)",
  "function freeMargin(address) view returns (uint256)",
  "function getPosition(uint256 positionId) view returns (tuple(uint256 id, address owner, bytes32 asset, bool isLong, uint256 entryPrice, uint256 margin, uint256 leverage, uint256 openedAt, uint256 closedAt, int256 realizedPnL, bool isOpen, address copiedFrom, int256 entryFundingIndex))",
] as const;

// Phase 2 session-key delegation layer (write path). Agents call these within
// the bounded session limits set by the user via createSession.
export const AGENT_SESSION_MANAGER_ABI = [
  "function nextSessionId() view returns (uint256)",
  "function sessions(uint256) view returns (address user, address agent, uint256 maxMarginPerTrade, uint256 totalMarginBudget, uint256 spentMargin, uint256 maxLeverage, uint256 expiry, bool revoked)",
  "function openPositionForSession(uint256 sessionId, bytes32 asset, bool isLong, uint256 margin, uint256 leverage, address copiedFrom) payable returns (uint256 positionId)",
  "function closePositionForSession(uint256 sessionId, uint256 positionId)",
] as const;

export const MOCK_ORACLE_ABI = [
  "function getPrice(bytes32 assetId) view returns (uint256 price, uint256 updatedAt)",
  "function isStale(bytes32 assetId) view returns (bool)",
] as const;

export const STRATEGY_REGISTRY_ABI = [
  "function traders(address) view returns (bool isRegistered, string displayName, uint256 createdAt)",
  "function getLatestStrategy(address trader) view returns (tuple(bytes32 asset, uint256 weight, bool isLong, uint256 leverage)[] allocations, uint256 versionId)",
  "function getStrategyCount(address trader) view returns (uint256)",
  "function getAllTraders() view returns (address[])",
  "function isEligibleTrader(address trader) view returns (bool)",
] as const;
