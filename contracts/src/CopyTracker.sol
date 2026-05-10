// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./PerpetualExchange.sol";
import "./StrategyRegistry.sol";

interface IFeeRouterCopy {
    function distributeCopyFee(address trader, uint256 fee) external;
}

interface ITraderStakeForCT {
    function slash(address trader, uint256 amount, address recipient) external;
    function stakedAmount(address trader) external view returns (uint256);
}

contract CopyTracker is ReentrancyGuard {
    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant COPY_FEE_BPS      = 30;    // 0.3 % of totalMargin
    uint256 public constant SLASH_TRIGGER_BPS  = 3000;  // 30 % loss triggers slash
    uint256 public constant SLASH_RATIO_BPS    = 5000;  // slash 50 % of trader's stake

    // ── Immutables ───────────────────────────────────────────────────────────

    IERC20             public immutable usdc;
    PerpetualExchange  public immutable exchange;
    StrategyRegistry   public immutable registry;
    IFeeRouterCopy     public immutable feeRouter;    // address(0) = fee disabled
    ITraderStakeForCT  public immutable traderStake;  // address(0) = slash disabled

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
    event TraderSlashed(
        address indexed trader,
        address indexed follower,
        uint256         slashAmount
    );

    // ── Errors ───────────────────────────────────────────────────────────────

    error NoStrategyPublished();
    error InvalidRecordIndex();
    error RecordAlreadyInactive();

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(
        address _usdc,
        address _exchange,
        address _registry,
        address _feeRouter,    // pass address(0) to disable copy fee
        address _traderStake   // pass address(0) to disable slashing
    ) {
        usdc        = IERC20(_usdc);
        exchange    = PerpetualExchange(_exchange);
        registry    = StrategyRegistry(_registry);
        feeRouter   = IFeeRouterCopy(_feeRouter);
        traderStake = ITraderStakeForCT(_traderStake);
    }

    // ── Core functions ───────────────────────────────────────────────────────

    function followTrader(address trader, uint256 totalMargin) external nonReentrant {
        // 1. Fetch latest published strategy
        (StrategyRegistry.Allocation[] memory allocations, uint256 versionId) =
            registry.getLatestStrategy(trader);
        if (allocations.length == 0) revert NoStrategyPublished();

        // 2. Pull USDC from follower → CopyTracker
        usdc.transferFrom(msg.sender, address(this), totalMargin);

        // 3. Deduct copy fee when feeRouter is configured
        uint256 netMargin = totalMargin;
        if (address(feeRouter) != address(0)) {
            uint256 fee = totalMargin * COPY_FEE_BPS / 10_000;
            netMargin   = totalMargin - fee;
            usdc.approve(address(feeRouter), fee);
            feeRouter.distributeCopyFee(trader, fee);
        }

        // 4. Approve exchange to pull netMargin from CopyTracker
        usdc.approve(address(exchange), netMargin);

        // 5. Deposit on behalf of follower (exchange pulls from CopyTracker, credits follower)
        exchange.depositMarginFor(msg.sender, netMargin);

        // 6. Open one position per allocation; copiedFrom = trader for perf-fee tracking
        uint256[] memory ids = new uint256[](allocations.length);
        for (uint256 i; i < allocations.length; ++i) {
            uint256 portion = netMargin * allocations[i].weight / 10_000;
            ids[i] = exchange.openPositionFor(
                msg.sender,
                allocations[i].asset,
                allocations[i].isLong,
                portion,
                allocations[i].leverage,
                trader
            );
        }

        // 7. Persist copy record
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

        // Track freeMargin delta to measure position returns
        uint256 marginBefore = exchange.freeMargin(msg.sender);

        for (uint256 i; i < rec.positionIds.length; ++i) {
            exchange.closePositionFor(msg.sender, rec.positionIds[i]);
        }

        uint256 marginAfter = exchange.freeMargin(msg.sender);

        // Slash logic: if traderStake configured and loss ≥ SLASH_TRIGGER_BPS
        if (address(traderStake) != address(0)) {
            uint256 finalAmount = marginAfter - marginBefore;
            if (finalAmount < rec.initialAmount) {
                uint256 loss    = rec.initialAmount - finalAmount;
                uint256 lossBps = loss * 10_000 / rec.initialAmount;
                if (lossBps >= SLASH_TRIGGER_BPS) {
                    uint256 staked   = traderStake.stakedAmount(rec.trader);
                    uint256 slashAmt = staked * SLASH_RATIO_BPS / 10_000;
                    if (slashAmt > 0) {
                        try traderStake.slash(rec.trader, slashAmt, msg.sender) {
                            emit TraderSlashed(rec.trader, msg.sender, slashAmt);
                        } catch {}
                    }
                }
            }
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
