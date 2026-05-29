// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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
/// @notice Trade mining, tier upgrades, copy rewards, daily check-in,
///         and ESG hold rewards powered by PEPE tokens.
contract PepeIncentives is Ownable, Pausable {
    // ── Errors ───────────────────────────────────────────────────────────────

    error NotPositionOwner();
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

    // ── Events ───────────────────────────────────────────────────────────────

    event TradeMined(address indexed trader, uint256 indexed positionId, uint256 reward);
    event TierClaimed(address indexed trader, uint8 tier, uint256 reward);
    event CopyClaimed(address indexed follower, address indexed trader, uint256 reward);
    event DailyCheckIn(address indexed user, uint256 day, uint8 streak, uint256 reward);
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

    // Daily check-in
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

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address pepe_, address exchange_, address copyTracker_) Ownable(msg.sender) {
        pepe        = IERC20(pepe_);
        exchange    = IPerpExchange(exchange_);
        copyTracker = ICopyTracker(copyTracker_);
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
        pepe.transfer(msg.sender, reward);
        emit TradeMined(msg.sender, positionId, reward);
    }

    // ── Tier Upgrade ─────────────────────────────────────────────────────────

    function claimTierReward(uint8 tier, uint256[] calldata positionIds) external whenNotPaused {
        if (tier > 3) revert InvalidTier();
        if ((tierClaimed[msg.sender] & (1 << tier)) != 0) revert TierAlreadyClaimed();

        uint256 cumNotional;
        for (uint256 i; i < positionIds.length; i++) {
            IPerpExchange.Position memory pos = exchange.getPosition(positionIds[i]);
            if (pos.owner != msg.sender) continue;
            cumNotional += pos.margin * pos.leverage;
        }
        if (cumNotional < tierThresholds[tier]) revert TierThresholdNotMet();

        uint256 reward = tierRewards[tier];
        if (pepe.balanceOf(address(this)) < reward) revert InsufficientPool();

        tierClaimed[msg.sender] |= uint8(1 << tier);
        pepe.transfer(msg.sender, reward);
        emit TierClaimed(msg.sender, tier, reward);
    }

    // ── Copy Reward ───────────────────────────────────────────────────────────

    function claimCopyReward(address trader) external whenNotPaused {
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
        pepe.transfer(msg.sender, copyReward);
        pepe.transfer(trader,     copyReward);
        emit CopyClaimed(msg.sender, trader, copyReward);
    }

    // ── Daily Check-in ────────────────────────────────────────────────────────

    function dailyCheckIn() external whenNotPaused {
        uint256 today = block.timestamp / 1 days;
        if (today == lastCheckIn[msg.sender]) revert AlreadyCheckedIn();

        uint8 currentStreak;
        if (lastCheckIn[msg.sender] > 0 && today == lastCheckIn[msg.sender] + 1) {
            uint8 next = streak[msg.sender] + 1;
            currentStreak = next > dailyStreakCap ? dailyStreakCap : next;
        } else {
            currentStreak = 1;
        }

        lastCheckIn[msg.sender] = today;
        streak[msg.sender]      = currentStreak;

        uint256 reward = dailyBase + dailyStreakBonus * (currentStreak - 1);
        if (pepe.balanceOf(address(this)) < reward) revert InsufficientPool();

        pepe.transfer(msg.sender, reward);
        emit DailyCheckIn(msg.sender, today, currentStreak, reward);
    }

    // ── ESG Hold Reward ───────────────────────────────────────────────────────

    /// @notice Claim reward for holding an ESG-qualified position ≥ 30 days.
    function claimEsgHoldReward(uint256 positionId) external whenNotPaused {
        IPerpExchange.Position memory pos = exchange.getPosition(positionId);
        if (pos.owner != msg.sender)        revert NotPositionOwner();
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
        pepe.transfer(msg.sender, reward);
        emit EsgHoldClaimed(msg.sender, positionId, reward);
    }

    // ── Owner Functions ───────────────────────────────────────────────────────

    function withdraw(uint256 amount) external onlyOwner {
        pepe.transfer(owner(), amount);
    }

    function setTradeMining(uint256 bps, uint256 cap) external onlyOwner {
        tradeMiningBps = bps;
        tradeMiningCap = cap;
    }

    function setDailyParams(uint256 base, uint256 bonus, uint8 cap) external onlyOwner {
        dailyBase        = base;
        dailyStreakBonus = bonus;
        dailyStreakCap   = cap;
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
