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
        uint256 stakedAmount;
        uint256 unstakeRequestedAt;   // 0 if no pending unstake
        uint256 pendingUnstake;
        uint256 totalSlashed;
        uint256 slashCount;
    }

    mapping(address => StakeInfo) private _stakes;

    // ── Events ───────────────────────────────────────────────────────────────
    event Staked(address indexed trader, uint256 amount);
    event UnstakeRequested(address indexed trader, uint256 amount, uint256 availableAt);
    event UnstakeExecuted(address indexed trader, uint256 amount);
    event UnstakeCancelled(address indexed trader);
    event Slashed(address indexed trader, uint256 amount, address indexed recipient);
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
        _stakes[msg.sender].stakedAmount += amount;
        if (_stakes[msg.sender].stakedAmount < MIN_STAKE) revert BelowMinStake();
        usdc.transferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function requestUnstake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        StakeInfo storage s = _stakes[msg.sender];
        if (amount > s.stakedAmount) revert InsufficientStake();
        s.pendingUnstake     = amount;
        s.unstakeRequestedAt = block.timestamp;
        emit UnstakeRequested(msg.sender, amount, block.timestamp + UNSTAKE_COOLDOWN);
    }

    function executeUnstake() external nonReentrant {
        StakeInfo storage s = _stakes[msg.sender];
        if (s.pendingUnstake == 0) revert NoPendingUnstake();
        uint256 availableAt = s.unstakeRequestedAt + UNSTAKE_COOLDOWN;
        if (block.timestamp < availableAt) revert CooldownNotElapsed(availableAt);
        uint256 amount       = s.pendingUnstake;
        s.pendingUnstake     = 0;
        s.unstakeRequestedAt = 0;
        s.stakedAmount      -= amount;
        usdc.transfer(msg.sender, amount);
        emit UnstakeExecuted(msg.sender, amount);
    }

    function cancelUnstake() external {
        StakeInfo storage s = _stakes[msg.sender];
        if (s.pendingUnstake == 0) revert NoPendingUnstake();
        s.pendingUnstake     = 0;
        s.unstakeRequestedAt = 0;
        emit UnstakeCancelled(msg.sender);
    }

    // ── Slash (called by CopyTracker) ────────────────────────────────────────
    function slash(address trader, uint256 amount, address recipient) external nonReentrant {
        if (msg.sender != copyTracker) revert NotCopyTracker();
        StakeInfo storage s = _stakes[trader];
        uint256 maxSlash = s.stakedAmount * MAX_SLASH_BPS / 10_000;
        if (amount > maxSlash) revert SlashExceedsMax();
        if (amount > s.stakedAmount) revert InsufficientStake();
        s.stakedAmount -= amount;
        s.totalSlashed += amount;
        s.slashCount   += 1;
        usdc.transfer(recipient, amount);
        emit Slashed(trader, amount, recipient);
    }

    // ── Views ────────────────────────────────────────────────────────────────
    function isEligible(address trader) external view returns (bool) {
        return _stakes[trader].stakedAmount >= MIN_STAKE;
    }

    function getStake(address trader) external view returns (StakeInfo memory) {
        return _stakes[trader];
    }

    function stakedAmount(address trader) external view returns (uint256) {
        return _stakes[trader].stakedAmount;
    }

    function reputationScore(address trader) external view returns (uint256) {
        StakeInfo memory s = _stakes[trader];
        uint256 base    = s.stakedAmount * 100 / MIN_STAKE;
        uint256 penalty = s.slashCount * 10;
        return base > penalty ? base - penalty : 0;
    }
}
