// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IOracle {
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt);
}

interface IFeeRouterPerp {
    function receivePerformanceFee(address trader, uint256 fee) external;
}

contract PerpetualExchange is Ownable {
    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant MAX_LEVERAGE            = 5;
    uint256 public constant MIN_MARGIN              = 10e18;
    uint256 public constant PERFORMANCE_FEE_BPS     = 1000;  // 10% of profit on copied positions

    // Owner-adjustable fees (kept as public vars so tests and admin can override)
    uint256 public TRADING_FEE_BPS         = 10;   // 0.1% swap fee (Uniswap concept)
    uint256 public BORROW_FEE_BPS_PER_HOUR = 1;    // 0.01% borrow rate per hour (Aave concept)

    // Funding rate: 5 min for demo (change to 8 hours = 28800 for production)
    uint256 public constant FUNDING_INTERVAL        = 5 minutes;
    uint256 public constant MAX_FUNDING_RATE_BPS    = 75;    // 0.75% per interval cap

    uint256 public executionFee = 0.001 ether; // Fee paid in native ETH to cover platform/Keeper gas

    // ── Immutables ───────────────────────────────────────────────────────────

    IERC20  public immutable usdc;
    IOracle public immutable oracle;

    // ── Data types ───────────────────────────────────────────────────────────

    struct Position {
        uint256 id;
        address owner;
        bytes32 asset;
        bool    isLong;
        uint256 entryPrice;        // 18 decimals
        uint256 margin;            // 18 decimals (USDC)
        uint256 leverage;          // 1, 2, or 5
        uint256 openedAt;
        uint256 closedAt;
        int256  realizedPnL;
        bool    isOpen;
        address copiedFrom;        // address(0) for self-opened positions
        int256  entryFundingIndex; // locked cumulativeFundingIndex at open time
    }

    // ── State ────────────────────────────────────────────────────────────────

    mapping(uint256 => Position)      public positions;
    mapping(address => uint256[])     public userPositions;
    mapping(address => uint256)       public freeMargin;

    // Global Open Interest (OI) for Funding Rate calculations
    mapping(bytes32 => uint256)       public globalLongNotional;
    mapping(bytes32 => uint256)       public globalShortNotional;

    // Funding rate state
    mapping(bytes32 => int256)        public cumulativeFundingIndex;  // 18-dec, can be negative
    mapping(bytes32 => uint256)       public lastFundingUpdateAt;

    uint256                           public nextPositionId;
    address                           public copyTracker;
    IFeeRouterPerp                    public feeRouter;

    // ── Events ───────────────────────────────────────────────────────────────

    event PositionOpened(
        uint256 indexed positionId,
        address indexed owner,
        bytes32 indexed asset,
        bool    isLong,
        uint256 entryPrice,
        uint256 margin,
        uint256 leverage
    );
    event PositionClosed(
        uint256 indexed positionId,
        address indexed owner,
        int256  pnl,
        uint256 closeAmount
    );
    event MarginDeposited(address indexed user, uint256 amount);
    event MarginWithdrawn(address indexed user, uint256 amount);
    event PositionLiquidated(
        uint256 indexed positionId,
        address indexed owner,
        address indexed liquidator,
        int256  pnl
    );
    event PerformanceFeePaid(
        uint256 indexed positionId,
        address indexed copiedFrom,
        uint256 fee
    );
    event FundingSettled(
        bytes32 indexed asset,
        int256  rateBps,
        int256  newIndex
    );

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotCopyTracker();
    error CopyTrackerNotSet();
    error InsufficientFreeMargin();
    error MarginTooLow();
    error InvalidLeverage();
    error NotPositionOwner();
    error PositionAlreadyClosed();
    error PositionIsHealthy();
    error FundingIntervalNotElapsed();

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc, address _oracle) Ownable(msg.sender) {
        usdc   = IERC20(_usdc);
        oracle = IOracle(_oracle);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setCopyTracker(address _copyTracker) external onlyOwner {
        copyTracker = _copyTracker;
    }

    function setFeeRouter(address _feeRouter) external onlyOwner {
        feeRouter = IFeeRouterPerp(_feeRouter);
    }

    function setExecutionFee(uint256 _fee) external onlyOwner {
        executionFee = _fee;
    }

    function setTradingFeeBps(uint256 _bps) external onlyOwner {
        TRADING_FEE_BPS = _bps;
    }

    function setBorrowFeePerHour(uint256 _bps) external onlyOwner {
        BORROW_FEE_BPS_PER_HOUR = _bps;
    }

    function withdrawExecutionFees() external onlyOwner {
        uint256 balance = address(this).balance;
        (bool success, ) = msg.sender.call{value: balance}("");
        require(success, "ETH transfer failed");
    }

    // ── Margin management ────────────────────────────────────────────────────

    function depositMargin(uint256 amount) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        freeMargin[msg.sender] += amount;
        emit MarginDeposited(msg.sender, amount);
    }

    /// @dev CopyTracker pulls USDC from itself, credits freeMargin to `user`.
    function depositMarginFor(address user, uint256 amount) external {
        if (msg.sender != copyTracker) revert NotCopyTracker();
        usdc.transferFrom(msg.sender, address(this), amount);
        freeMargin[user] += amount;
        emit MarginDeposited(user, amount);
    }

    function withdrawMargin(uint256 amount) external {
        if (freeMargin[msg.sender] < amount) revert InsufficientFreeMargin();
        freeMargin[msg.sender] -= amount;
        usdc.transfer(msg.sender, amount);
        emit MarginWithdrawn(msg.sender, amount);
    }

    // ── Position lifecycle ───────────────────────────────────────────────────

    function openPosition(
        bytes32 asset,
        bool    isLong,
        uint256 margin,
        uint256 leverage
    ) external payable returns (uint256 positionId) {
        require(msg.value >= executionFee, "Insufficient execution fee");
        return _openPosition(msg.sender, asset, isLong, margin, leverage, address(0));
    }

    function openPositionFor(
        address user,
        bytes32 asset,
        bool    isLong,
        uint256 margin,
        uint256 leverage,
        address copiedFrom
    ) external payable returns (uint256 positionId) {
        require(msg.value >= executionFee, "Insufficient execution fee");
        if (copyTracker == address(0)) revert CopyTrackerNotSet();
        if (msg.sender != copyTracker) revert NotCopyTracker();
        return _openPosition(user, asset, isLong, margin, leverage, copiedFrom);
    }

    function closePosition(uint256 positionId) external {
        _closePosition(msg.sender, positionId);
    }

    /// @dev Lets copyTracker close a position on behalf of its owner (e.g. unfollow flow).
    function closePositionFor(address owner, uint256 positionId) external {
        if (msg.sender != copyTracker) revert NotCopyTracker();
        _closePosition(owner, positionId);
    }

    // ── Liquidation Engine ───────────────────────────────────────────────────

    /// @notice Anyone can call this to liquidate an underwater position and protect the protocol.
    /// @dev If (margin + PnL - fees) < Maintenance Margin (5% of notional), the position is liquidated.
    function liquidatePosition(uint256 positionId) external {
        Position storage pos = positions[positionId];
        if (!pos.isOpen) revert PositionAlreadyClosed();

        int256 pnl = _calcPnL(pos);
        
        uint256 notional     = pos.margin * pos.leverage;
        uint256 tradingFee   = notional * TRADING_FEE_BPS / 10000;
        uint256 borrowed     = pos.margin * (pos.leverage - 1);
        uint256 hoursElapsed = (block.timestamp - pos.openedAt) / 3600;
        uint256 borrowFee    = borrowed * BORROW_FEE_BPS_PER_HOUR * hoursElapsed / 10000;
        
        int256 totalFees   = int256(tradingFee + borrowFee);
        int256 closeAmount = int256(pos.margin) + pnl - totalFees;
        
        // Maintenance margin is 5% of notional size. If value drops below this, it's liquidated.
        uint256 maintenanceMargin = notional * 500 / 10000;
        
        if (closeAmount > int256(maintenanceMargin)) {
            revert PositionIsHealthy();
        }

        pos.isOpen      = false;
        pos.closedAt    = block.timestamp;
        pos.realizedPnL = pnl;

        // Optional: Pay a small liquidator reward here from remaining margin.
        // For simplicity in this iteration, we just close it with 0 returned to owner.

        emit PositionLiquidated(positionId, pos.owner, msg.sender, pnl);
        emit PositionClosed(positionId, pos.owner, pnl, 0);
    }

    // ── Funding Rate ─────────────────────────────────────────────────────────

    /// @notice Settle funding for an asset. Anyone can call once per FUNDING_INTERVAL.
    function settleFunding(bytes32 asset) external {
        if (block.timestamp < lastFundingUpdateAt[asset] + FUNDING_INTERVAL)
            revert FundingIntervalNotElapsed();

        uint256 longOI  = globalLongNotional[asset];
        uint256 shortOI = globalShortNotional[asset];
        lastFundingUpdateAt[asset] = block.timestamp;

        if (longOI + shortOI == 0) return;

        // imbalance ∈ (-1e18, +1e18)
        int256 imbalance = (int256(longOI) - int256(shortOI)) * int256(1e18)
                         / int256(longOI + shortOI);
        int256 fundingRateBps = imbalance * int256(MAX_FUNDING_RATE_BPS) / int256(1e18);

        // 1 bps × 1e14 = 1e-4 fraction of notional (18-dec USDC)
        cumulativeFundingIndex[asset] += fundingRateBps * int256(1e14);

        emit FundingSettled(asset, fundingRateBps, cumulativeFundingIndex[asset]);
    }

    /// @notice Current per-interval funding rate in BPS (positive = longs pay, negative = shorts pay).
    function getFundingRate(bytes32 asset) external view returns (int256 rateBps) {
        uint256 longOI  = globalLongNotional[asset];
        uint256 shortOI = globalShortNotional[asset];
        if (longOI + shortOI == 0) return 0;
        int256 imbalance = (int256(longOI) - int256(shortOI)) * int256(1e18)
                         / int256(longOI + shortOI);
        return imbalance * int256(MAX_FUNDING_RATE_BPS) / int256(1e18);
    }

    /// @notice Accrued funding for an open position (positive = trader owes, negative = trader receives).
    function pendingFunding(uint256 positionId) external view returns (int256) {
        Position storage pos = positions[positionId];
        if (!pos.isOpen) return 0;
        return _calcFunding(pos);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function getUnrealizedPnL(uint256 positionId) external view returns (int256) {
        Position storage pos = positions[positionId];
        if (!pos.isOpen) return pos.realizedPnL;
        return _calcPnL(pos);
    }

    function getPositionValue(uint256 positionId) external view returns (uint256) {
        Position storage pos = positions[positionId];
        if (!pos.isOpen) return 0;
        int256 val = int256(pos.margin) + _calcPnL(pos);
        return val > 0 ? uint256(val) : 0;
    }

    function getUserPositions(address user) external view returns (uint256[] memory) {
        return userPositions[user];
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    function _openPosition(
        address owner,
        bytes32 asset,
        bool    isLong,
        uint256 margin,
        uint256 leverage,
        address copiedFrom
    ) internal returns (uint256 positionId) {
        if (margin < MIN_MARGIN)                       revert MarginTooLow();
        if (leverage == 0 || leverage > MAX_LEVERAGE)  revert InvalidLeverage();
        uint256 notional   = margin * leverage;
        uint256 tradingFee = notional * TRADING_FEE_BPS / 10000;

        if (freeMargin[owner] < margin + tradingFee)   revert InsufficientFreeMargin();

        // oracle returns 8-decimal price; scale to 18 dec for internal accounting
        (uint256 rawPrice,) = oracle.getPrice(asset);
        uint256 entryPrice  = rawPrice * 1e10;

        freeMargin[owner] -= (margin + tradingFee);

        if (isLong) {
            globalLongNotional[asset] += notional;
        } else {
            globalShortNotional[asset] += notional;
        }

        positionId = nextPositionId++;
        positions[positionId] = Position({
            id:               positionId,
            owner:            owner,
            asset:            asset,
            isLong:           isLong,
            entryPrice:       entryPrice,
            margin:           margin,
            leverage:         leverage,
            openedAt:         block.timestamp,
            closedAt:         0,
            realizedPnL:      0,
            isOpen:           true,
            copiedFrom:       copiedFrom,
            entryFundingIndex: cumulativeFundingIndex[asset]
        });
        userPositions[owner].push(positionId);

        emit PositionOpened(positionId, owner, asset, isLong, entryPrice, margin, leverage);
    }

    function _closePosition(address caller, uint256 positionId) internal {
        Position storage pos = positions[positionId];
        if (caller != pos.owner) revert NotPositionOwner();
        if (!pos.isOpen)         revert PositionAlreadyClosed();

        int256 pnl         = _calcPnL(pos);
        
        // DeFi Mechanics: Trading Fee (Uniswap) + Borrow Fee (Aave)
        uint256 notional     = pos.margin * pos.leverage;
        uint256 tradingFee   = notional * TRADING_FEE_BPS / 10000;
        
        uint256 borrowed     = pos.margin * (pos.leverage - 1);
        uint256 hoursElapsed = (block.timestamp - pos.openedAt) / 3600;
        uint256 borrowFee    = borrowed * BORROW_FEE_BPS_PER_HOUR * hoursElapsed / 10000;
        
        int256 totalFees      = int256(tradingFee + borrowFee);
        int256 fundingPayment = _calcFunding(pos); // positive = trader pays, negative = trader receives
        int256 closeAmount    = int256(pos.margin) + pnl - totalFees - fundingPayment;
        if (closeAmount < 0) closeAmount = 0;

        // Performance fee: 10 % of profit on copied positions when feeRouter is set
        uint256 perfFee = 0;
        if (pos.copiedFrom != address(0) && pnl > 0 && address(feeRouter) != address(0)) {
            perfFee     = uint256(pnl) * PERFORMANCE_FEE_BPS / 10_000;
            closeAmount -= int256(perfFee);
        }

        pos.isOpen      = false;
        pos.closedAt    = block.timestamp;
        pos.realizedPnL = pnl;

        if (pos.isLong) {
            globalLongNotional[pos.asset] -= notional;
        } else {
            globalShortNotional[pos.asset] -= notional;
        }

        freeMargin[pos.owner] += uint256(closeAmount);

        if (perfFee > 0) {
            usdc.transfer(address(feeRouter), perfFee);
            feeRouter.receivePerformanceFee(pos.copiedFrom, perfFee);
            emit PerformanceFeePaid(positionId, pos.copiedFrom, perfFee);
        }

        emit PositionClosed(positionId, pos.owner, pnl, uint256(closeAmount));
    }

    /// PnL math (all values in 18-decimal USDC):
    ///   notional    = margin × leverage
    ///   size        = notional × 1e18 / entryPrice   (qty of asset, 18-dec fixed-point)
    ///   priceChange = currentPrice - entryPrice
    ///   pnl         = priceChange × size / 1e18
    ///   if short:   pnl = -pnl
    function _calcPnL(Position storage pos) internal view returns (int256) {
        (uint256 rawPrice,) = oracle.getPrice(pos.asset);
        uint256 currentPrice = rawPrice * 1e10;

        uint256 notional    = pos.margin * pos.leverage;
        uint256 size        = notional * 1e18 / pos.entryPrice;
        int256  priceChange = int256(currentPrice) - int256(pos.entryPrice);
        int256  pnl         = priceChange * int256(size) / 1e18;

        if (!pos.isLong) pnl = -pnl;
        return pnl;
    }

    /// @dev Funding owed by this position since it was opened.
    ///      Positive = position pays (deducted on close), negative = position receives.
    function _calcFunding(Position storage pos) internal view returns (int256) {
        int256 indexDiff = cumulativeFundingIndex[pos.asset] - pos.entryFundingIndex;
        uint256 notional = pos.margin * pos.leverage;
        int256 funding   = int256(notional) * indexDiff / int256(1e18);
        // Long pays when index rises (positive funding); short receives (flip sign)
        return pos.isLong ? funding : -funding;
    }
}
