// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  PepeStaking
/// @notice Synthetix-style PEPE staking with owner-supplied yield.
///         Users stake PEPE; owner calls notifyRewardAmount() to fund rewards.
///         Rewards accrue per-second proportional to stake share.
contract PepeStaking is Ownable, ReentrancyGuard {
    // ── Errors ───────────────────────────────────────────────────────────────

    error ZeroAmount();
    error InsufficientStake();

    // ── Events ───────────────────────────────────────────────────────────────

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event YieldClaimed(address indexed user, uint256 reward);
    event RewardNotified(uint256 amount, uint256 periodFinish);

    // ── State ─────────────────────────────────────────────────────────────────

    IERC20 public immutable pepe;

    uint256 public constant REWARD_DURATION = 7 days;

    uint256 public periodFinish;
    uint256 public rewardRate;
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;

    uint256 public totalStaked;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    // ── Constructor ───────────────────────────────────────────────────────────

    constructor(address pepe_) Ownable(msg.sender) {
        pepe = IERC20(pepe_);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored
            + (lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * 1e18 / totalStaked;
    }

    function earned(address account) public view returns (uint256) {
        return balanceOf[account]
            * (rewardPerToken() - userRewardPerTokenPaid[account]) / 1e18
            + rewards[account];
    }

    // ── Modifiers ─────────────────────────────────────────────────────────────

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    // ── User Functions ────────────────────────────────────────────────────────

    function stake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        totalStaked          += amount;
        balanceOf[msg.sender] += amount;
        pepe.transferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf[msg.sender] < amount) revert InsufficientStake();
        totalStaked          -= amount;
        balanceOf[msg.sender] -= amount;
        pepe.transfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function claimYield() external nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            pepe.transfer(msg.sender, reward);
            emit YieldClaimed(msg.sender, reward);
        }
    }

    function exit() external nonReentrant updateReward(msg.sender) {
        uint256 staked = balanceOf[msg.sender];
        uint256 reward = rewards[msg.sender];

        if (staked > 0) {
            totalStaked           -= staked;
            balanceOf[msg.sender]  = 0;
            pepe.transfer(msg.sender, staked);
            emit Withdrawn(msg.sender, staked);
        }

        if (reward > 0) {
            rewards[msg.sender] = 0;
            pepe.transfer(msg.sender, reward);
            emit YieldClaimed(msg.sender, reward);
        }
    }

    // ── Owner Functions ───────────────────────────────────────────────────────

    /// @notice Fund a new reward period. Owner must have approved this contract.
    function notifyRewardAmount(uint256 amount) external onlyOwner updateReward(address(0)) {
        pepe.transferFrom(msg.sender, address(this), amount);

        if (block.timestamp >= periodFinish) {
            rewardRate = amount / REWARD_DURATION;
        } else {
            uint256 remaining = periodFinish - block.timestamp;
            uint256 leftover  = remaining * rewardRate;
            rewardRate = (amount + leftover) / REWARD_DURATION;
        }

        lastUpdateTime = block.timestamp;
        periodFinish   = block.timestamp + REWARD_DURATION;
        emit RewardNotified(amount, periodFinish);
    }
}
