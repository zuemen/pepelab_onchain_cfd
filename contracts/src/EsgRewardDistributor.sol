// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IExchangeForReward {
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

interface IESGRegistryForReward {
    function compositeScore(bytes32 assetId) external view returns (uint8);
}

/// @title EsgRewardDistributor
/// @notice Distributes PEPE rewards for positions opened on high-ESG (composite >= threshold) assets.
///         Owner must seed the contract with PEPE tokens before rewards can be claimed.
contract EsgRewardDistributor is Ownable {
    using SafeERC20 for IERC20;

    IERC20                  public immutable pepe;
    IExchangeForReward      public immutable exchange;
    IESGRegistryForReward   public immutable esgRegistry;

    uint256 public highEsgThreshold  = 70;
    uint256 public rewardRateBps     = 100;          // 1% of notional
    uint256 public maxRewardPerClaim = 10_000e18;    // 10,000 PEPE

    /// @notice Minimum time a position must have been open before its ESG
    ///         reward can be claimed.
    /// @dev M7: this contract had no holding requirement at all — open, close
    ///         in the same block, claim 1% of notional in PEPE, repeat. Paired
    ///         with the `isOpen` check below, the reward now actually pays for
    ///         sustained exposure to the high-ESG asset rather than for a
    ///         round-trip.
    uint256 public minHoldSeconds = 30 days;

    mapping(uint256 => bool) public rewarded; // positionId => claimed

    event EsgRewardClaimed(address indexed trader, uint256 indexed positionId, uint256 reward);
    event MinHoldSecondsSet(uint256 oldValue, uint256 newValue);

    error NotPositionOwner();
    error AlreadyClaimed();
    error AssetNotHighEsg();
    error InsufficientBalance();
    error PositionNotOpen();
    error HoldTooShort();

    constructor(address _pepe, address _exchange, address _esgRegistry) Ownable(msg.sender) {
        pepe        = IERC20(_pepe);
        exchange    = IExchangeForReward(_exchange);
        esgRegistry = IESGRegistryForReward(_esgRegistry);
    }

    // ── User ────────────────────────────────────────────────────────────────────

    /// @dev M7: `isOpen` and `openedAt` were both ignored. The struct has
    ///      carried them since day one; reading them turns "opened a
    ///      high-ESG position once" into "is still holding it, and has been for
    ///      `minHoldSeconds`".
    function claimEsgReward(uint256 positionId) external {
        IExchangeForReward.Position memory pos = exchange.getPosition(positionId);
        if (pos.owner != msg.sender) revert NotPositionOwner();
        if (rewarded[positionId])    revert AlreadyClaimed();
        if (!pos.isOpen)             revert PositionNotOpen();
        if (block.timestamp - pos.openedAt < minHoldSeconds) revert HoldTooShort();

        uint8 score = esgRegistry.compositeScore(pos.asset);
        if (uint256(score) < highEsgThreshold) revert AssetNotHighEsg();

        uint256 notional = pos.margin * pos.leverage;
        uint256 reward   = notional * rewardRateBps / 10_000;
        if (reward > maxRewardPerClaim) reward = maxRewardPerClaim;

        if (pepe.balanceOf(address(this)) < reward) revert InsufficientBalance();

        rewarded[positionId] = true;
        pepe.safeTransfer(msg.sender, reward);

        emit EsgRewardClaimed(msg.sender, positionId, reward);
    }

    /// @notice Preview the reward amount for a position. Returns 0 whenever the
    ///         position is not currently claimable — low ESG score, already
    ///         closed, or not yet held long enough — so the preview cannot
    ///         promise a payout `claimEsgReward` would refuse.
    function previewReward(uint256 positionId) external view returns (uint256) {
        IExchangeForReward.Position memory pos = exchange.getPosition(positionId);
        if (!pos.isOpen) return 0;
        if (block.timestamp - pos.openedAt < minHoldSeconds) return 0;

        uint8 score = esgRegistry.compositeScore(pos.asset);
        if (uint256(score) < highEsgThreshold) return 0;

        uint256 notional = pos.margin * pos.leverage;
        uint256 reward   = notional * rewardRateBps / 10_000;
        if (reward > maxRewardPerClaim) reward = maxRewardPerClaim;
        return reward;
    }

    // ── Admin ────────────────────────────────────────────────────────────────────

    function setHighEsgThreshold(uint256 threshold) external onlyOwner {
        highEsgThreshold = threshold;
    }

    function setRewardRateBps(uint256 rateBps) external onlyOwner {
        rewardRateBps = rateBps;
    }

    function setMaxRewardPerClaim(uint256 maxReward) external onlyOwner {
        maxRewardPerClaim = maxReward;
    }

    function setMinHoldSeconds(uint256 secs) external onlyOwner {
        emit MinHoldSecondsSet(minHoldSeconds, secs);
        minHoldSeconds = secs;
    }

    function withdraw(uint256 amount) external onlyOwner {
        pepe.safeTransfer(owner(), amount);
    }
}
