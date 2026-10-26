// 自動同步執行者用到的合約介面（集中一處）。
//
// ⚠ 整合注意：CopyTracker 的自動同步版（ADR-024）與這個執行者是平行開發的。下面的
// 新函式／事件／錯誤片段是手寫的，已對照 contracts/src/CopyTracker.sol 的宣告；abi.test.ts 會
// 直接解析合約原始碼逐一核對名稱與參數型別（topic0／selector 只看型別），合約改了就會失敗。
// 合約定版後也可以改用 forge 產物（contracts/out/CopyTracker.sol/CopyTracker.json 的 abi），
// 其他檔案都只透過這裡取介面。
//
// 執行者對 ABI 的依賴刻意壓到最小：
//   - 事件只靠 topic0（事件型別）與 topic1（第一個 indexed 參數＝跟隨者或交易者）就能運作；
//     data 欄位解不開時仍會照常把那位跟隨者列入檢查（engine.ts 的 followerFromLog）。
//   - 錯誤只靠名稱分類（errors.ts）；參數只用來寫進日誌與通知。
// 所以就算定版時某個參數型別變了，最壞情況是日誌少幾個欄位，不會漏掉同步。

/** CopyTracker 既有的介面（ABI 已穩定，與 frontend/src/contracts/abi/CopyTracker.json 相同）。 */
export const COPY_TRACKER_BASE_ABI = [
  "function exchange() view returns (address)",
  "function registry() view returns (address)",
  "function getCopyRecords(address follower) view returns (tuple(address trader, uint256 versionId, uint256 initialAmount, uint256[] positionIds, uint256 copiedAt, bool active, uint256 deployedAmount)[])",
  "function getFollowerCount(address trader) view returns (uint256)",
  "function followersByTrader(address trader, uint256 index) view returns (address)",
  "event TraderFollowed(address indexed follower, address indexed trader, uint256 versionId, uint256 totalMargin)",
  "event TraderUnfollowed(address indexed follower, address indexed trader, uint256 recordIdx)",
  "error NoStrategyPublished()",
  "error InvalidRecordIndex()",
  "error RecordAlreadyInactive()",
  "error TradingFeeExceedsMargin(uint256 fee, uint256 margin)",
  "error PositionStillOpen(uint256 positionId)",
  "error StrategyVersionMismatch(uint256 expected, uint256 actual)",
  "error TraderNotEligible(address trader)",
] as const;

/** 自動同步（ADR-024）新增的介面（abi.test.ts 對照合約原始碼核對）。 */
export const COPY_TRACKER_SYNC_ABI = [
  "function MAX_TIP_WEI() view returns (uint256)",
  "function MIN_SYNC_INTERVAL() view returns (uint32)",
  "function totalSyncGas() view returns (uint256)",
  "function syncGasBalance(address follower) view returns (uint256)",
  "function syncConfig(address follower, uint256 recordIdx) view returns (bool autoSync, uint8 maxLeverage, uint32 minSyncInterval, uint96 tipWei)",
  "function getSyncState(address follower, uint256 recordIdx) view returns (tuple(uint64 lastSyncedAt, uint32 syncCount, bool followerClosed, uint256 scoredBasis, int256 scoredRealized))",
  "function pendingSync(address follower, uint256 recordIdx) view returns (bool syncable, uint256 latestVersion, uint256 cost)",
  "function syncReadyAt(address follower, uint256 recordIdx) view returns (uint256)",
  // 跟隨者開啟自動同步時同意的每腿執行費；交易所現行費率高於它時第三方同步 revert ExecutionFeeAboveCap。
  "function syncExecFeeCap(address follower, uint256 recordIdx) view returns (uint256)",
  // 跟隨者指定的執行者（personal 模式）；0 = 任何人。非 0 且不是本執行者時，resyncFor revert NotSyncExecutor。
  "function syncExecutor(address follower, uint256 recordIdx) view returns (address)",
  // payable：附帶的 ETH 會先存進跟隨者的油箱。執行者永遠不附帶（guard.ts 強制 value = 0）。
  "function resyncFor(address follower, uint256 recordIdx) payable",
  "event AutoSyncSet(address indexed follower, uint256 indexed recordIdx, bool enabled, uint8 maxLeverage, uint32 minSyncInterval, uint96 tipWei)",
  "event Resynced(address indexed follower, uint256 indexed recordIdx, address indexed trader, uint256 fromVersion, uint256 toVersion, address executor, uint256 redeployedMargin, uint256 legs)",
  "event SyncGasDeposited(address indexed follower, uint256 amount)",
  "event SyncGasWithdrawn(address indexed follower, uint256 amount)",
  "event SyncExecutorSet(address indexed follower, uint256 indexed recordIdx, address indexed executor)",
  "error AutoSyncDisabled()",
  "error NotSyncExecutor(address executor)",
  "error AlreadySynced(uint256 recordVersion, uint256 latestVersion)",
  "error SyncCooldown(uint256 readyAt)",
  "error ExecutionFeeAboveCap(uint256 fee, uint256 cap)",
  "error InsufficientSyncGas(uint256 required, uint256 available)",
  "error InvalidSyncConfig()",
  "error NothingToRedeploy()",
  "error SyncDisturbedOtherPositions()",
  "error EthTransferFailed()",
] as const;

/** StrategyRegistry：執行者只讀交易者最新版本與資格，並監聽發版事件。 */
export const STRATEGY_REGISTRY_ABI = [
  "function getLatestStrategy(address trader) view returns (tuple(bytes32 asset, uint256 weight, bool isLong, uint256 leverage)[] allocations, uint256 versionId)",
  "function getStrategyCount(address trader) view returns (uint256)",
  "function isEligibleTrader(address trader) view returns (bool)",
  "event StrategyPublished(address indexed trader, uint256 versionId, uint256 createdAt)",
] as const;

/**
 * PerpetualExchange 的錯誤：resyncFor 在交易所開／平倉失敗時原樣冒泡上來，執行者靠它們
 * 判斷「為什麼這次同步不了」（KYC、休市、報價過期、未平倉量上限……）。
 */
export const PERPETUAL_EXCHANGE_ERRORS_ABI = [
  "function executionFee() view returns (uint256)",
  "error NotCopyTracker()",
  "error CopyTrackerNotSet()",
  "error InsufficientFreeMargin()",
  "error MarginTooLow()",
  "error InvalidLeverage()",
  "error NotPositionOwner()",
  "error PositionAlreadyClosed()",
  "error StalePrice(bytes32 asset, uint256 updatedAt)",
  "error InvalidPrice(bytes32 asset)",
  "error NotKycVerified(address user)",
  "error NotPositionAgent(uint256 positionId, address caller)",
  "error AssetNotActive(bytes32 asset, uint8 mode)",
  "error AssetHalted(bytes32 asset)",
  "error EnforcedPause()",
  "error GracePeriodActive(bytes32 asset, uint256 until)",
  "error OpenInterestCapExceeded(bytes32 asset, bool isLong, uint256 resultingOI, uint256 cap)",
  "error CopiedFromNotAllowed(address caller)",
] as const;

export const COPY_TRACKER_ABI = [...COPY_TRACKER_BASE_ABI, ...COPY_TRACKER_SYNC_ABI] as const;

/** 解碼 revert 用：CopyTracker、交易所的錯誤合在一起（Error(string)／Panic 由 ethers 內建處理）。 */
export const REVERT_DECODE_ABI = [...COPY_TRACKER_ABI, ...PERPETUAL_EXCHANGE_ERRORS_ABI] as const;

/** 執行者金鑰唯一允許簽的函式（guard.ts）。 */
export const RESYNC_FOR_SIGNATURE = "function resyncFor(address follower, uint256 recordIdx)";
