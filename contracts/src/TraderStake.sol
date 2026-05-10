// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract TraderStake is Ownable, ReentrancyGuard {
    // ── Constants ────────────────────────────────────────────────────────────
    uint256 public constant MIN_STAKE        = 100e18;
    uint256 public constant UNSTAKE_COOLDOWN = 1 days;
    uint256 public constant MAX_SLASH_BPS    = 5000;   // 50%

    // ── Immutables ───────────────────────────────────────────────────────────
    IERC20 public immutable usdc;

    // ── State ────────────────────────────────────────────────────────────────
    address public copyTracker;

    struct StakeInfo {
        uint256 amount;
        uint256 totalSlashed;
        uint256 unstakeRequestedAt;   // 0 if no pending unstake
        uint256 unstakeAmount;
    }

    mapping(address => StakeInfo) public stakes;

    // ── Events ───────────────────────────────────────────────────────────────
    event Staked(address indexed trader, uint256 amount);
    event UnstakeRequested(address indexed trader, uint256 amount, uint256 availableAt);
    event Unstaked(address indexed trader, uint256 amount);
    event UnstakeCancelled(address indexed trader);
    event Slashed(address indexed trader, uint256 amount, address indexed recipient);
    event ReputationUpdated(address indexed trader, uint256 newScore);
    event CopyTrackerSet(address indexed ct);

    // ── Errors ───────────────────────────────────────────────────────────────
    error BelowMinStake();
    error NoPendingUnstake();
    error CooldownNotElapsed(uint256 availableAt);
    error InsufficientStake();
    error SlashExceedsMax();
    error NotCopyTracker();
    error ZeroAmount();

    // ── Constructor ──────────────────────────────────────────────────────────
    constructor(address _usdc) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
    }

    // ── Admin ────────────────────────────────────────────────────────────────
    function setCopyTracker(address _ct) external onlyOwner {
        copyTracker = _ct;
        emit CopyTrackerSet(_ct);
    }

    // ── Staking ──────────────────────────────────────────────────────────────
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        stakes[msg.sender].amount += amount;
        if (stakes[msg.sender].amount < MIN_STAKE) revert BelowMinStake();
        usdc.transferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function requestUnstake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        StakeInfo storage s = stakes[msg.sender];
        if (amount > s.amount) revert InsufficientStake();
        s.unstakeAmount      = amount;
        s.unstakeRequestedAt = block.timestamp;
        emit UnstakeRequested(msg.sender, amount, block.timestamp + UNSTAKE_COOLDOWN);
    }

    function executeUnstake() external nonReentrant {
        StakeInfo storage s = stakes[msg.sender];
        if (s.unstakeAmount == 0) revert NoPendingUnstake();
        uint256 availableAt = s.unstakeRequestedAt + UNSTAKE_COOLDOWN;
        if (block.timestamp < availableAt) revert CooldownNotElapsed(availableAt);
        uint256 amt          = s.unstakeAmount;
        s.unstakeAmount      = 0;
        s.unstakeRequestedAt = 0;
        s.amount            -= amt;
        usdc.transfer(msg.sender, amt);
        emit Unstaked(msg.sender, amt);
    }

    function cancelUnstake() external {
        StakeInfo storage s = stakes[msg.sender];
        if (s.unstakeAmount == 0) revert NoPendingUnstake();
        s.unstakeAmount      = 0;
        s.unstakeRequestedAt = 0;
        emit UnstakeCancelled(msg.sender);
    }

    // ── Slash (called by CopyTracker only) ───────────────────────────────────
    function slash(address trader, uint256 amount, address recipient) external nonReentrant {
        if (msg.sender != copyTracker) revert NotCopyTracker();
        StakeInfo storage s = stakes[trader];
        uint256 maxSlash = s.amount * MAX_SLASH_BPS / 10_000;
        if (amount > maxSlash) revert SlashExceedsMax();
        if (amount > s.amount) revert InsufficientStake();
        s.amount       -= amount;
        s.totalSlashed += amount;
        usdc.transfer(recipient, amount);
        emit Slashed(trader, amount, recipient);
        emit ReputationUpdated(trader, reputationScore(trader));
    }

    // ── Views ────────────────────────────────────────────────────────────────
    function isEligible(address trader) external view returns (bool) {
        return stakes[trader].amount >= MIN_STAKE;
    }

    function getStake(address trader) external view returns (StakeInfo memory) {
        return stakes[trader];
    }

    // Keep named helper for CopyTracker interface
    function stakedAmount(address trader) external view returns (uint256) {
        return stakes[trader].amount;
    }

    function reputationScore(address trader) public view returns (uint256) {
        StakeInfo memory s = stakes[trader];
        if (s.amount == 0) return 0;
        // score = stake * 100 / (stake + totalSlashed * 5)
        uint256 denom = s.amount + s.totalSlashed * 5;
        return s.amount * 100 / denom;
    }
}
