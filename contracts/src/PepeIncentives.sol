// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

// ── Interfaces ────────────────────────────────────────────────────────────────

interface IPerpExchange {
    struct Position {
        uint256 id;
        address owner;
        bytes32 asset;
        bool    isLong;
        uint256 entryPrice;
        uint256 margin;
        uint256 leverage;
        uint256 openedAt;
        uint256 closedAt;
        int256  realizedPnL;
        bool    isOpen;
        address copiedFrom;
        int256  entryFundingIndex;
    }

    function getPosition(uint256 positionId) external view returns (Position memory);
}

interface ICopyTracker {
    struct CopyRecord {
        address   trader;
        uint256   versionId;
        uint256   initialAmount;
        uint256[] positionIds;
        uint256   copiedAt;
        bool      active;
    }

    function getCopyRecords(address follower) external view returns (CopyRecord[] memory);
}

interface IESGRegistry {
    function compositeScore(bytes32 assetId) external view returns (uint8);
}

// ── PepeIncentives ────────────────────────────────────────────────────────────

/// @title  PepeIncentives
/// @notice Trade mining, tier upgrades, copy rewards and ESG hold rewards
///         paid in PEPE, plus a daily check-in that is NOT paid in PEPE.
///
///         Daily check-in (issues #101 / #169): a check-in is credited as
///         non-transferable achievement points kept in this contract's own
///         accounting (`achievementPoints`). No token leaves the contract and
///         there is no function that moves points between accounts or turns
///         them into anything: anything transferable acquires a price, and
///         anything with a price gets farmed.
///
///         The owner cannot credit points directly, but it does set the
///         per-check-in amounts (`setDailyParams`), bounded by
///         MAX_DAILY_BASE / MAX_DAILY_STREAK_BONUS / MAX_DAILY_STREAK_CAP and
///         announced by `DailyParamsSet`. An owner that raises them and checks
///         in itself gets at most MAX_POINTS_PER_CHECK_IN a day, like anyone.
///
///         Not upgradeable (no proxy; `pepe`, `exchange`, `copyTracker` are
///         immutable). A change here reaches a chain only by deploying a new
///         instance; state in an old instance (streaks, claimed flags) is not
///         carried over.
contract PepeIncentives is Ownable, Pausable {
    using SafeERC20 for IERC20;

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotPositionOwner();
    error PositionIdsNotSorted();
    error SelfCopyNotAllowed();
    error PositionNotOpen();
    error AlreadyMined();
    error AlreadyCheckedIn();
    error TierAlreadyClaimed();
    error CopyAlreadyClaimed();
    error NotFollowing();
    error InvalidTier();
    error InsufficientPool();
    error TierThresholdNotMet();
    error HoldTooShort();
    error EsgScoreTooLow();
    error EsgHoldAlreadyClaimed();
    error InvalidDailyParams();

    // ── Events ───────────────────────────────────────────────────────────────

    event TradeMined(address indexed trader, uint256 indexed positionId, uint256 reward);
    event TierClaimed(address indexed trader, uint8 tier, uint256 reward);
    event CopyClaimed(address indexed follower, address indexed trader, uint256 reward);
    /// @notice A check-in credited achievement points. Named apart from the
    ///         old build's `DailyCheckIn`, whose last field was a PEPE amount
    ///         actually transferred, so an indexer cannot count these as PEPE.
    /// @param points Achievement points credited by this check-in (18 decimals).
    ///               Not a token amount: nothing is transferred.
    event CheckInPointsCredited(address indexed user, uint256 day, uint8 streak, uint256 points);
    event DailyParamsSet(uint256 base, uint256 streakBonus, uint8 streakCap);
    event EsgHoldClaimed(address indexed trader, uint256 indexed positionId, uint256 reward);

    // ── State ─────────────────────────────────────────────────────────────────

    IERC20        public immutable pepe;
    IPerpExchange public immutable exchange;
    ICopyTracker  public immutable copyTracker;
    IESGRegistry  public esgRegistry;

    // Trade mining
    uint256 public tradeMiningBps = 50;         // 0.5% of notional
    uint256 public tradeMiningCap = 5_000e18;   // max 5 000 PEPE per position
    mapping(uint256 => bool) public minedPosition;

    // Tier rewards  (bit 0=Bronze, 1=Silver, 2=Gold, 3=Diamond)
    uint256[4] public tierThresholds = [10_000e18, 50_000e18, 200_000e18, 1_000_000e18];
    uint256[4] public tierRewards    = [500e18,    2_000e18,  10_000e18,  50_000e18];
    mapping(address => uint8) public tierClaimed; // bitmask

    // Copy rewards
    uint256 public copyReward = 200e18;         // 200 PEPE each side
    mapping(bytes32 => bool) public copyClaimed; // keccak256(follower, trader)

    // Daily check-in. `dailyBase` / `dailyStreakBonus` are amounts of achievement
    // points (18 decimals, the scale they always had), not of PEPE.
    //
    // Bounds on `setDailyParams`. One check-in credits at most
    // MAX_DAILY_BASE + MAX_DAILY_STREAK_BONUS * (MAX_DAILY_STREAK_CAP - 1)
    // = 30_000e18 (3e22), so `totalAchievementPoints` (uint256, ~1.16e77)
    // would need ~3.9e54 check-ins to overflow: it cannot be made to revert
    // check-ins through the parameters.
    uint256 public constant MAX_DAILY_BASE         = 1_000e18;
    uint256 public constant MAX_DAILY_STREAK_BONUS = 1_000e18;
    uint8   public constant MAX_DAILY_STREAK_CAP   = 30;
    uint256 public constant MAX_POINTS_PER_CHECK_IN =
        MAX_DAILY_BASE + MAX_DAILY_STREAK_BONUS * (uint256(MAX_DAILY_STREAK_CAP) - 1);
    uint256 public dailyBase        = 50e18;
    uint256 public dailyStreakBonus = 10e18;
    uint8   public dailyStreakCap   = 7;
    mapping(address => uint256) public lastCheckIn; // day index (unix / 86400)
    mapping(address => uint8)   public streak;

    // ESG hold reward
    uint256 public esgHoldBps      = 200;        // 2% of notional
    uint256 public esgHoldCap      = 20_000e18;  // max 20 000 PEPE per position
    uint256 public esgMinHoldDays  = 30;
    uint8   public esgMinScore     = 70;
    mapping(uint256 => bool) public esgHoldClaimed;

    // Achievement points (appended after the existing state).
    //
    /// @notice Non-transferable achievement points credited by `dailyCheckIn`,
    ///         18 decimals. Only ever increases, and only for the account that
    ///         checked in. There is deliberately no transfer, approve, spend
    ///         or burn path, and no direct owner credit; the owner only tunes
    ///         the bounded per-check-in amounts (`setDailyParams`).
    mapping(address => uint256) public achievementPoints;
    /// @notice Sum of `achievementPoints` over all accounts.
    uint256 public totalAchievementPoints;

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(
        address pepe_,
        address exchange_,
        address copyTracker_,
        address esgRegistry_
    ) Ownable(msg.sender) {
        pepe        = IERC20(pepe_);
        exchange    = IPerpExchange(exchange_);
        copyTracker = ICopyTracker(copyTracker_);
        esgRegistry = IESGRegistry(esgRegistry_);
    }

    // ── Trade Mining ──────────────────────────────────────────────────────────

    function claimTradeMining(uint256 positionId) external whenNotPaused {
        IPerpExchange.Position memory pos = exchange.getPosition(positionId);
        if (pos.owner != msg.sender)   revert NotPositionOwner();
        if (minedPosition[positionId]) revert AlreadyMined();

        uint256 notional = pos.margin * pos.leverage;
        uint256 reward   = notional * tradeMiningBps / 10_000;
        if (reward > tradeMiningCap) reward = tradeMiningCap;
        if (pepe.balanceOf(address(this)) < reward) revert InsufficientPool();

        minedPosition[positionId] = true;
        pepe.safeTransfer(msg.sender, reward);
        emit TradeMined(msg.sender, positionId, reward);
    }

    // ── Tier Upgrade ─────────────────────────────────────────────────────────

    /// @param positionIds MUST be strictly increasing.
    /// @dev PA-4: the loop used to sum whatever it was handed, so the same
    ///      position could be listed 1,000 times and a single 1,000-notional
    ///      trade cleared the 1,000,000 Diamond threshold outright (audit PoC).
    ///      Requiring a strictly increasing list makes duplicates
    ///      unrepresentable in O(n) with no extra storage — cheaper and more
    ///      robust than a seen-mapping, which would also have to be cleared.
    function claimTierReward(uint8 tier, uint256[] calldata positionIds) external whenNotPaused {
        if (tier > 3) revert InvalidTier();
        if ((tierClaimed[msg.sender] & (1 << tier)) != 0) revert TierAlreadyClaimed();

        uint256 cumNotional;
        uint256 prevId;
        bool first = true;
        for (uint256 i; i < positionIds.length; i++) {
            uint256 id = positionIds[i];
            if (!first && id <= prevId) revert PositionIdsNotSorted();
            prevId = id;
            first  = false;

            IPerpExchange.Position memory pos = exchange.getPosition(id);
            if (pos.owner != msg.sender) continue;
            cumNotional += pos.margin * pos.leverage;
        }
        if (cumNotional < tierThresholds[tier]) revert TierThresholdNotMet();

        uint256 reward = tierRewards[tier];
        if (pepe.balanceOf(address(this)) < reward) revert InsufficientPool();

        tierClaimed[msg.sender] |= uint8(1 << tier);
        pepe.safeTransfer(msg.sender, reward);
        emit TierClaimed(msg.sender, tier, reward);
    }

    // ── Copy Reward ───────────────────────────────────────────────────────────

    /// @dev Low: `trader == msg.sender` used to be allowed, so a self-follow
    ///      paid the same address twice (`copyReward * 2`) for copying itself.
    function claimCopyReward(address trader) external whenNotPaused {
        if (trader == msg.sender) revert SelfCopyNotAllowed();

        ICopyTracker.CopyRecord[] memory records = copyTracker.getCopyRecords(msg.sender);
        bool isFollowing;
        for (uint256 i; i < records.length; i++) {
            if (records[i].trader == trader && records[i].active) {
                isFollowing = true;
                break;
            }
        }
        if (!isFollowing) revert NotFollowing();

        bytes32 k = keccak256(abi.encodePacked(msg.sender, trader));
        if (copyClaimed[k]) revert CopyAlreadyClaimed();

        uint256 totalNeeded = copyReward * 2;
        if (pepe.balanceOf(address(this)) < totalNeeded) revert InsufficientPool();

        copyClaimed[k] = true;
        pepe.safeTransfer(msg.sender, copyReward);
        pepe.safeTransfer(trader,     copyReward);
        emit CopyClaimed(msg.sender, trader, copyReward);
    }

    // ── Daily Check-in ────────────────────────────────────────────────────────

    /// @notice Check in once per UTC day. Credits non-transferable achievement
    ///         points to the caller: `dailyBase`, plus `dailyStreakBonus` for
    ///         each consecutive day, up to a `dailyStreakCap`-day streak.
    /// @dev    Issues #101 / #169: this used to `safeTransfer` PEPE. It now moves
    ///         no token at all, so it neither needs nor checks the reward pool.
    function dailyCheckIn() external whenNotPaused {
        uint256 today = block.timestamp / 1 days;
        if (today == lastCheckIn[msg.sender]) revert AlreadyCheckedIn();

        uint8 currentStreak;
        if (lastCheckIn[msg.sender] > 0 && today == lastCheckIn[msg.sender] + 1) {
            // uint256 arithmetic: `streak + 1` in uint8 would overflow (and
            // revert every later check-in) once a cap of 255 is reached.
            uint256 next = uint256(streak[msg.sender]) + 1;
            currentStreak = next > dailyStreakCap ? dailyStreakCap : uint8(next);
        } else {
            currentStreak = 1;
        }

        lastCheckIn[msg.sender] = today;
        streak[msg.sender]      = currentStreak;

        uint256 points = dailyBase + dailyStreakBonus * (currentStreak - 1);
        achievementPoints[msg.sender] += points;
        totalAchievementPoints        += points;

        emit CheckInPointsCredited(msg.sender, today, currentStreak, points);
    }

    // ── ESG Hold Reward ───────────────────────────────────────────────────────

    /// @notice Claim reward for holding an ESG-qualified position ≥ 30 days.
    /// @dev M6: `isOpen` was never read, so "holding" only ever meant "opened
    ///      30 days ago". Open + close in the same block, wait a month, collect
    ///      the hold reward for a position that was held for zero seconds. The
    ///      `Position` struct already carried `isOpen`/`closedAt`; this reads it.
    function claimEsgHoldReward(uint256 positionId) external whenNotPaused {
        IPerpExchange.Position memory pos = exchange.getPosition(positionId);
        if (pos.owner != msg.sender)        revert NotPositionOwner();
        if (!pos.isOpen)                    revert PositionNotOpen();
        if (esgHoldClaimed[positionId])     revert EsgHoldAlreadyClaimed();
        if (block.timestamp - pos.openedAt < esgMinHoldDays * 1 days) revert HoldTooShort();

        if (address(esgRegistry) != address(0)) {
            if (esgRegistry.compositeScore(pos.asset) < esgMinScore) revert EsgScoreTooLow();
        }

        uint256 notional = pos.margin * pos.leverage;
        uint256 reward   = notional * esgHoldBps / 10_000;
        if (reward > esgHoldCap) reward = esgHoldCap;
        if (pepe.balanceOf(address(this)) < reward) revert InsufficientPool();

        esgHoldClaimed[positionId] = true;
        pepe.safeTransfer(msg.sender, reward);
        emit EsgHoldClaimed(msg.sender, positionId, reward);
    }

    // ── Owner Functions ───────────────────────────────────────────────────────

    function withdraw(uint256 amount) external onlyOwner {
        pepe.safeTransfer(owner(), amount);
    }

    function setTradeMining(uint256 bps, uint256 cap) external onlyOwner {
        tradeMiningBps = bps;
        tradeMiningCap = cap;
    }

    /// @param cap Longest streak that still adds a bonus; at least 1 (a cap of
    ///            0 would make the second consecutive check-in revert).
    /// @notice Per-check-in achievement points: `base` + `bonus` per extra
    ///         consecutive day, up to a `cap`-day streak. Bounded (see
    ///         MAX_DAILY_*), so the owner cannot hand itself an arbitrary
    ///         amount by checking in, nor overflow `totalAchievementPoints`.
    function setDailyParams(uint256 base, uint256 bonus, uint8 cap) external onlyOwner {
        if (cap == 0 || cap > MAX_DAILY_STREAK_CAP || base > MAX_DAILY_BASE || bonus > MAX_DAILY_STREAK_BONUS) {
            revert InvalidDailyParams();
        }
        dailyBase        = base;
        dailyStreakBonus = bonus;
        dailyStreakCap   = cap;
        emit DailyParamsSet(base, bonus, cap);
    }

    function setCopyReward(uint256 amount) external onlyOwner {
        copyReward = amount;
    }

    function setTierParams(
        uint256[4] calldata thresholds,
        uint256[4] calldata rewards
    ) external onlyOwner {
        for (uint256 i; i < 4; i++) {
            tierThresholds[i] = thresholds[i];
            tierRewards[i]    = rewards[i];
        }
    }

    function setEsgParams(uint256 bps, uint256 cap, uint256 minDays, uint8 minScore) external onlyOwner {
        esgHoldBps     = bps;
        esgHoldCap     = cap;
        esgMinHoldDays = minDays;
        esgMinScore    = minScore;
    }

    function setEsgRegistry(address reg) external onlyOwner {
        esgRegistry = IESGRegistry(reg);
    }

    function pause()   external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }
}
