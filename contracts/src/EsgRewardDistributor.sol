// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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
    IERC20                  public immutable pepe;
    IExchangeForReward      public immutable exchange;
    IESGRegistryForReward   public immutable esgRegistry;

    uint256 public highEsgThreshold  = 70;
    uint256 public rewardRateBps     = 100;          // 1% of notional
    uint256 public maxRewardPerClaim = 10_000e18;    // 10,000 PEPE

    mapping(uint256 => bool) public rewarded; // positionId => claimed

    event EsgRewardClaimed(address indexed trader, uint256 indexed positionId, uint256 reward);

    error NotPositionOwner();
    error AlreadyClaimed();
    error AssetNotHighEsg();
    error InsufficientBalance();

    constructor(address _pepe, address _exchange, address _esgRegistry) Ownable(msg.sender) {
        pepe        = IERC20(_pepe);
        exchange    = IExchangeForReward(_exchange);
        esgRegistry = IESGRegistryForReward(_esgRegistry);
    }

    // ── User ────────────────────────────────────────────────────────────────────

    function claimEsgReward(uint256 positionId) external {
        IExchangeForReward.Position memory pos = exchange.getPosition(positionId);
        if (pos.owner != msg.sender) revert NotPositionOwner();
        if (rewarded[positionId])    revert AlreadyClaimed();

        uint8 score = esgRegistry.compositeScore(pos.asset);
        if (uint256(score) < highEsgThreshold) revert AssetNotHighEsg();

        uint256 notional = pos.margin * pos.leverage;
        uint256 reward   = notional * rewardRateBps / 10_000;
        if (reward > maxRewardPerClaim) reward = maxRewardPerClaim;

        if (pepe.balanceOf(address(this)) < reward) revert InsufficientBalance();

        rewarded[positionId] = true;
        pepe.transfer(msg.sender, reward);

        emit EsgRewardClaimed(msg.sender, positionId, reward);
    }

    /// @notice Preview the reward amount for a position (0 if asset ESG score below threshold).
    function previewReward(uint256 positionId) external view returns (uint256) {
        IExchangeForReward.Position memory pos = exchange.getPosition(positionId);
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

    function withdraw(uint256 amount) external onlyOwner {
        pepe.transfer(owner(), amount);
    }
}
