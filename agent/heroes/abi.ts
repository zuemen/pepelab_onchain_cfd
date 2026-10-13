// 回放與價格寫入用到的 ABI 片段（ethers 的 human-readable 格式）。
// 簽章對照 contracts/src；只列用到的，不是完整 ABI。

const ALLOCATION = "tuple(bytes32 asset, uint256 weight, bool isLong, uint256 leverage)";

export const EXCHANGE_ABI = [
  "event PositionOpened(uint256 indexed positionId, address indexed owner, bytes32 indexed asset, bool isLong, uint256 entryPrice, uint256 margin, uint256 leverage)",
  "event PositionClosed(uint256 indexed positionId, address indexed owner, int256 pnl, uint256 closeAmount)",
  "event PositionLiquidated(uint256 indexed positionId, address indexed owner, address indexed liquidator, int256 pnl)",
  "function executionFee() view returns (uint256)",
  "function freeMargin(address) view returns (uint256)",
  "function getUserPositions(address) view returns (uint256[])",
  "function getPositionValue(uint256) view returns (uint256)",
  "function tradingFeeBpsForAsset(bytes32) view returns (uint256)",
  "function maintenanceMarginBpsForAsset(bytes32) view returns (uint256)",
  "function depositMargin(uint256 amount)",
  "function openPosition(bytes32 asset, bool isLong, uint256 margin, uint256 leverage) payable returns (uint256)",
  "function closePosition(uint256 positionId)",
  "function liquidatePosition(uint256 positionId)",
];

export const REGISTRY_ABI = [
  "event StrategyPublished(address indexed trader, uint256 versionId, uint256 createdAt)",
  "function registerTrader(string displayName)",
  "function isEligibleTrader(address trader) view returns (bool)",
  `function publishStrategy(${ALLOCATION}[] allocations)`,
  `function getLatestStrategy(address trader) view returns (${ALLOCATION}[] allocations, uint256 versionId)`,
  `function getStrategyVersion(address trader, uint256 versionId) view returns (${ALLOCATION}[] allocations, uint256 createdAt)`,
];

export const COPY_ABI = [
  "event TraderFollowed(address indexed follower, address indexed trader, uint256 versionId, uint256 totalMargin)",
  "event TraderUnfollowed(address indexed follower, address indexed trader, uint256 recordIdx)",
  "event TraderSlashed(address indexed trader, address indexed follower, uint256 slashAmount)",
  "function followTrader(address trader, uint256 totalMargin) payable",
  "function unfollowAndCloseAll(uint256 recordIdx)",
  "function getCopyRecords(address follower) view returns (tuple(address trader, uint256 versionId, uint256 initialAmount, uint256[] positionIds, uint256 copiedAt, bool active, uint256 deployedAmount)[])",
  "function getFollowerCount(address trader) view returns (uint256)",
];

export const STAKE_ABI = ["function stake(uint256 amount)"];

export const USDC_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

export const ORACLE_ABI = [
  "function updatePrice(bytes32 assetId, uint256 newPrice)",
  "function getPrice(bytes32 assetId) view returns (uint256 price, uint256 updatedAt)",
];

export const KYC_ABI = ["function batchVerify(address[] users)"];
