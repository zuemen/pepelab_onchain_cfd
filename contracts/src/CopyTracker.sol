// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./PerpetualExchange.sol";
import "./StrategyRegistry.sol";

contract CopyTracker is ReentrancyGuard {
    // ── Immutables ───────────────────────────────────────────────────────────

    IERC20            public immutable usdc;
    PerpetualExchange public immutable exchange;
    StrategyRegistry  public immutable registry;

    // ── Data types ───────────────────────────────────────────────────────────

    struct CopyRecord {
        address   trader;
        uint256   versionId;
        uint256   initialAmount;
        uint256[] positionIds;
        uint256   copiedAt;
        bool      active;
    }

    // ── State ────────────────────────────────────────────────────────────────

    mapping(address => CopyRecord[]) public copyRecords;
    mapping(address => address[])    public followersByTrader;

    // ── Events ───────────────────────────────────────────────────────────────

    event TraderFollowed(
        address indexed follower,
        address indexed trader,
        uint256         versionId,
        uint256         totalMargin
    );
    event TraderUnfollowed(
        address indexed follower,
        address indexed trader,
        uint256         recordIdx
    );

    // ── Errors ───────────────────────────────────────────────────────────────

    error NoStrategyPublished();
    error InvalidRecordIndex();
    error RecordAlreadyInactive();

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc, address _exchange, address _registry) {
        usdc     = IERC20(_usdc);
        exchange = PerpetualExchange(_exchange);
        registry = StrategyRegistry(_registry);
    }

    // ── Core functions ───────────────────────────────────────────────────────

    function followTrader(address trader, uint256 totalMargin) external nonReentrant {
        // 1. Fetch latest published strategy
        (StrategyRegistry.Allocation[] memory allocations, uint256 versionId) =
            registry.getLatestStrategy(trader);
        // getLatestStrategy already reverts if no strategy; this is belt-and-suspenders
        if (allocations.length == 0) revert NoStrategyPublished();

        // 2. Pull USDC from follower → CopyTracker
        usdc.transferFrom(msg.sender, address(this), totalMargin);

        // 3. Approve exchange to pull the same amount from CopyTracker
        usdc.approve(address(exchange), totalMargin);

        // 4. Deposit on behalf of follower (exchange pulls from CopyTracker, credits follower)
        exchange.depositMarginFor(msg.sender, totalMargin);

        // 5. Open one position per allocation, proportionally sized
        uint256[] memory ids = new uint256[](allocations.length);
        for (uint256 i; i < allocations.length; ++i) {
            uint256 portion = totalMargin * allocations[i].weight / 10_000;
            ids[i] = exchange.openPositionFor(
                msg.sender,
                allocations[i].asset,
                allocations[i].isLong,
                portion,
                allocations[i].leverage
            );
        }

        // 6. Persist copy record (push empty then fill to handle nested uint256[])
        copyRecords[msg.sender].push();
        CopyRecord storage rec = copyRecords[msg.sender][copyRecords[msg.sender].length - 1];
        rec.trader        = trader;
        rec.versionId     = versionId;
        rec.initialAmount = totalMargin;
        rec.copiedAt      = block.timestamp;
        rec.active        = true;
        for (uint256 i; i < ids.length; ++i) {
            rec.positionIds.push(ids[i]);
        }

        followersByTrader[trader].push(msg.sender);

        emit TraderFollowed(msg.sender, trader, versionId, totalMargin);
    }

    function unfollowAndCloseAll(uint256 recordIdx) external nonReentrant {
        CopyRecord[] storage records = copyRecords[msg.sender];
        if (recordIdx >= records.length) revert InvalidRecordIndex();

        CopyRecord storage rec = records[recordIdx];
        if (!rec.active) revert RecordAlreadyInactive();

        for (uint256 i; i < rec.positionIds.length; ++i) {
            exchange.closePositionFor(msg.sender, rec.positionIds[i]);
        }

        rec.active = false;

        emit TraderUnfollowed(msg.sender, rec.trader, recordIdx);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function getCopyRecords(address follower) external view returns (CopyRecord[] memory) {
        return copyRecords[follower];
    }

    function getFollowerCount(address trader) external view returns (uint256) {
        return followersByTrader[trader].length;
    }
}
