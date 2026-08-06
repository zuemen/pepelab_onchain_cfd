// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title  PepeStaking
/// @notice Synthetix-style PEPE staking with owner-supplied yield.
///         Users stake PEPE; owner calls notifyRewardAmount() to fund rewards.
///         Rewards accrue per-second proportional to stake share.
contract PepeStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Errors ───────────────────────────────────────────────────────────────

    error ZeroAmount();
    error InsufficientStake();
    /// @dev PA-9: emitted when the requested reward rate could not be paid out
    ///      of the reward budget (balance minus staked principal).
    error RewardExceedsBudget(uint256 required, uint256 available);

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

    /// @notice PEPE in this contract that is NOT someone's staked principal —
    ///         i.e. the only pot rewards may be paid from.
    /// @dev PA-9: principal and rewards share one balance, so without this
    ///         separation `notifyRewardAmount` could promise a rate the
    ///         contract could only honour by paying out other users' stakes.
    ///         The Synthetix reference implementation has exactly this check;
    ///         it was the one piece missing here.
    function rewardBudget() public view returns (uint256) {
        uint256 bal = pepe.balanceOf(address(this));
        return bal > totalStaked ? bal - totalStaked : 0;
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
        pepe.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function withdraw(uint256 amount) external nonReentrant updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        if (balanceOf[msg.sender] < amount) revert InsufficientStake();
        totalStaked          -= amount;
        balanceOf[msg.sender] -= amount;
        pepe.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function claimYield() external nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            pepe.safeTransfer(msg.sender, reward);
            emit YieldClaimed(msg.sender, reward);
        }
    }

    function exit() external nonReentrant updateReward(msg.sender) {
        uint256 staked = balanceOf[msg.sender];
        uint256 reward = rewards[msg.sender];

        if (staked > 0) {
            totalStaked           -= staked;
            balanceOf[msg.sender]  = 0;
            pepe.safeTransfer(msg.sender, staked);
            emit Withdrawn(msg.sender, staked);
        }

        if (reward > 0) {
            rewards[msg.sender] = 0;
            pepe.safeTransfer(msg.sender, reward);
            emit YieldClaimed(msg.sender, reward);
        }
    }

    // ── Owner Functions ───────────────────────────────────────────────────────

    /// @notice Fund a new reward period. Owner must have approved this contract.
    /// @dev PA-9: the Synthetix solvency check. Without it the owner could set
    ///      `rewardRate` arbitrarily high (e.g. notify 1 PEPE, then notify
    ///      again to roll a huge leftover, or simply mis-fund) and the first
    ///      claimants would be paid out of the staked principal — the last
    ///      stakers would find `withdraw` reverting on an empty contract.
    ///      Rewards may now only be promised out of `rewardBudget()`, which
    ///      excludes `totalStaked` by construction.
    function notifyRewardAmount(uint256 amount) external onlyOwner updateReward(address(0)) {
        if (amount > 0) pepe.safeTransferFrom(msg.sender, address(this), amount);

        if (block.timestamp >= periodFinish) {
            rewardRate = amount / REWARD_DURATION;
        } else {
            uint256 remaining = periodFinish - block.timestamp;
            uint256 leftover  = remaining * rewardRate;
            rewardRate = (amount + leftover) / REWARD_DURATION;
        }

        uint256 required  = rewardRate * REWARD_DURATION;
        uint256 available = rewardBudget();
        if (required > available) revert RewardExceedsBudget(required, available);

        lastUpdateTime = block.timestamp;
        periodFinish   = block.timestamp + REWARD_DURATION;
        emit RewardNotified(amount, periodFinish);
    }
}
