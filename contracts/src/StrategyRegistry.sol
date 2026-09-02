// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface ITraderStakeForReg {
    function isEligible(address trader) external view returns (bool);
}

contract StrategyRegistry {
    // ── Constants ────────────────────────────────────────────────────────────

    /// @notice A published strategy must spread across at least this many
    ///         assets. Below this, "diversified configuration" is just a
    ///         word — nothing stops a single-asset bet from being published
    ///         under it.
    uint256 public constant MIN_ALLOCATION_ASSETS = 3;

    /// @notice No single asset may carry more than this share of a published
    ///         strategy. Paired with MIN_ALLOCATION_ASSETS: 3 assets alone
    ///         doesn't stop one of them being a 98% bet dressed up as a
    ///         "diversified" strategy — the two constants together are what
    ///         make the word mean something.
    uint256 public constant MAX_ALLOCATION_WEIGHT_BPS = 5_000; // 50%

    // ── Data types ──────────────────────────────────────────────────────────

    struct Allocation {
        bytes32 asset;
        uint256 weight;    // bps; all weights must sum to 10 000
        bool    isLong;
        uint256 leverage;  // valid values: 1, 2, or 5
    }

    struct StrategyVersion {
        Allocation[] allocations;
        uint256 createdAt;
    }

    struct TraderProfile {
        bool    isRegistered;
        string  displayName;
        uint256 createdAt;
    }

    // ── Immutables ───────────────────────────────────────────────────────────

    // address(0) = no stake gate (backward-compatible with existing tests)
    ITraderStakeForReg public immutable stakeContract;

    // ── Storage ─────────────────────────────────────────────────────────────

    mapping(address => TraderProfile)    public traders;
    // auto-getter: strategies(addr, idx) → (createdAt) only; use getLatestStrategy for full data
    mapping(address => StrategyVersion[]) private _strategies;
    address[] public traderList;

    // ── Events ───────────────────────────────────────────────────────────────

    event TraderRegistered(address indexed trader, string displayName);
    event StrategyPublished(address indexed trader, uint256 versionId, uint256 createdAt);

    // ── Errors ───────────────────────────────────────────────────────────────

    error AlreadyRegistered();
    error NotRegistered();
    error EmptyAllocations();
    error TooFewAssets(uint256 got);
    error DuplicateAsset(uint256 firstIndex, uint256 secondIndex);
    error InvalidWeightSum(uint256 got);
    error ZeroWeight(uint256 index);
    error WeightExceedsMax(uint256 index, uint256 weight);
    error InvalidLeverage(uint256 index, uint256 leverage);
    error InsufficientStake();

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyRegistered() {
        if (!traders[msg.sender].isRegistered) revert NotRegistered();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _stake) {
        stakeContract = ITraderStakeForReg(_stake);
    }

    // ── External functions ───────────────────────────────────────────────────

    function registerTrader(string calldata displayName) external {
        if (traders[msg.sender].isRegistered) revert AlreadyRegistered();

        traders[msg.sender] = TraderProfile({
            isRegistered: true,
            displayName:  displayName,
            createdAt:    block.timestamp
        });
        traderList.push(msg.sender);

        emit TraderRegistered(msg.sender, displayName);
    }

    function publishStrategy(Allocation[] memory allocations) external onlyRegistered {
        if (allocations.length == 0) revert EmptyAllocations();
        // Checked separately from EmptyAllocations rather than folded into a
        // single "< MIN_ALLOCATION_ASSETS" test — a caller who published
        // nothing gets a distinct, more specific error than one who published
        // too little.
        if (allocations.length < MIN_ALLOCATION_ASSETS) revert TooFewAssets(allocations.length);

        // Stake eligibility gate — bypassed when stakeContract == address(0)
        if (address(stakeContract) != address(0)) {
            if (!stakeContract.isEligible(msg.sender)) revert InsufficientStake();
        }

        uint256 totalWeight;
        for (uint256 i; i < allocations.length; ++i) {
            if (allocations[i].weight == 0) revert ZeroWeight(i);
            if (allocations[i].weight > MAX_ALLOCATION_WEIGHT_BPS) revert WeightExceedsMax(i, allocations[i].weight);
            if (!_validLeverage(allocations[i].leverage)) revert InvalidLeverage(i, allocations[i].leverage);
            // MIN_ALLOCATION_ASSETS counts array length, not distinct assets —
            // without this check, three line items on the same asset (even
            // split long/short) would pass every check above and be accepted
            // as "diversified". Pairwise against everything already seen;
            // O(n^2) is fine at the handful-of-assets scale this is meant for
            // (same assumption ESGRegistryV2's attestor sort already makes).
            for (uint256 j; j < i; ++j) {
                if (allocations[j].asset == allocations[i].asset) revert DuplicateAsset(j, i);
            }
            totalWeight += allocations[i].weight;
        }
        if (totalWeight != 10_000) revert InvalidWeightSum(totalWeight);

        // Push a new empty StrategyVersion and fill it — avoids copying structs with nested arrays
        _strategies[msg.sender].push();
        StrategyVersion storage sv = _strategies[msg.sender][_strategies[msg.sender].length - 1];
        sv.createdAt = block.timestamp;
        for (uint256 i; i < allocations.length; ++i) {
            sv.allocations.push(allocations[i]);
        }

        uint256 versionId = _strategies[msg.sender].length - 1;
        emit StrategyPublished(msg.sender, versionId, block.timestamp);
    }

    function getLatestStrategy(address trader)
        external
        view
        returns (Allocation[] memory allocations, uint256 versionId)
    {
        uint256 len = _strategies[trader].length;
        require(len > 0, "StrategyRegistry: no strategies");
        versionId   = len - 1;
        allocations = _strategies[trader][versionId].allocations;
    }

    function getStrategyVersion(address trader, uint256 versionId)
        external
        view
        returns (Allocation[] memory allocations, uint256 createdAt)
    {
        StrategyVersion storage sv = _strategies[trader][versionId];
        allocations = sv.allocations;
        createdAt   = sv.createdAt;
    }

    function getStrategyCount(address trader) external view returns (uint256) {
        return _strategies[trader].length;
    }

    function getAllTraders() external view returns (address[] memory) {
        return traderList;
    }

    function isEligibleTrader(address trader) external view returns (bool) {
        if (address(stakeContract) == address(0)) return true;
        return stakeContract.isEligible(trader);
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    function _validLeverage(uint256 lev) internal pure returns (bool) {
        return lev == 1 || lev == 2 || lev == 5;
    }
}
