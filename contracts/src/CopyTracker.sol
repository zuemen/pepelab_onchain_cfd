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
    uint256 public constant SLASH_RATIO_BPS    = 5000;  // slash 50 % of loss
    uint256 public constant MAX_SLASH_BPS      = 5000;  // cap: max 50 % of trader stake

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
    error TradingFeeExceedsMargin(uint256 fee, uint256 margin);

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

    function followTrader(address trader, uint256 totalMargin) external payable nonReentrant {
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

        // 4. Calculate total trading fee buffer (exchange deducts tradingFee per position)
        uint256 tradingFeeBps  = exchange.TRADING_FEE_BPS();
        uint256 totalTradingFee = 0;
        for (uint256 i; i < allocations.length; ++i) {
            uint256 weightedNotional = netMargin * allocations[i].weight * allocations[i].leverage / 10_000;
            totalTradingFee += weightedNotional * tradingFeeBps / 10_000;
        }
        if (totalTradingFee >= netMargin) revert TradingFeeExceedsMargin(totalTradingFee, netMargin);
        uint256 marginForPositions = netMargin - totalTradingFee;

        // 5. Approve exchange to pull full netMargin (margin budget + tradingFee budget)
        usdc.approve(address(exchange), netMargin);

        // 6. Deposit on behalf of follower
        exchange.depositMarginFor(msg.sender, netMargin);

        // 7. Open one position per allocation; portion based on marginForPositions
        uint256[] memory ids = new uint256[](allocations.length);
        uint256 feePerPosition = allocations.length > 0 ? msg.value / allocations.length : 0;
        for (uint256 i; i < allocations.length; ++i) {
            uint256 portion = marginForPositions * allocations[i].weight / 10_000;
            ids[i] = exchange.openPositionFor{value: feePerPosition}(
                msg.sender,
                allocations[i].asset,
                allocations[i].isLong,
                portion,
                allocations[i].leverage,
                trader
            );
        }

        // 8. Persist copy record
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
            uint256 finalAmount = marginAfter >= marginBefore ? marginAfter - marginBefore : 0;
            if (finalAmount < rec.initialAmount) {
                uint256 loss    = rec.initialAmount - finalAmount;
                uint256 lossBps = loss * 10_000 / rec.initialAmount;
                if (lossBps >= SLASH_TRIGGER_BPS) {
                    uint256 staked   = traderStake.stakedAmount(rec.trader);
                    // slash = 50% of loss, capped at MAX_SLASH_BPS of stake
                    uint256 slashAmt = loss * SLASH_RATIO_BPS / 10_000;
                    uint256 cap      = staked * MAX_SLASH_BPS / 10_000;
                    if (slashAmt > cap) slashAmt = cap;
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

    function previewCopyAllocation(address trader, uint256 totalMargin)
        external view returns (
            uint256 copyFee,
            uint256 totalTradingFee,
            uint256 marginForPositions,
            uint256[] memory portions
        )
    {
        (StrategyRegistry.Allocation[] memory allocs,) = registry.getLatestStrategy(trader);

        copyFee = address(feeRouter) != address(0) ? totalMargin * COPY_FEE_BPS / 10_000 : 0;
        uint256 netMargin    = totalMargin - copyFee;
        uint256 tradingFeeBps = exchange.TRADING_FEE_BPS();

        portions = new uint256[](allocs.length);
        totalTradingFee = 0;
        for (uint256 i; i < allocs.length; ++i) {
            uint256 wNotional = netMargin * allocs[i].weight * allocs[i].leverage / 10_000;
            totalTradingFee += wNotional * tradingFeeBps / 10_000;
        }

        if (totalTradingFee >= netMargin) {
            marginForPositions = 0;
            return (copyFee, totalTradingFee, 0, portions);
        }

        marginForPositions = netMargin - totalTradingFee;
        for (uint256 i; i < allocs.length; ++i) {
            portions[i] = marginForPositions * allocs[i].weight / 10_000;
        }
    }
}
