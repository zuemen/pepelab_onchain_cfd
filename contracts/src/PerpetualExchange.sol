// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IOracle {
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt);
}

contract PerpetualExchange is Ownable {
    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant MAX_LEVERAGE = 5;
    uint256 public constant MIN_MARGIN   = 10e18;

    // ── Immutables ───────────────────────────────────────────────────────────

    IERC20  public immutable usdc;
    IOracle public immutable oracle;

    // ── Data types ───────────────────────────────────────────────────────────

    struct Position {
        uint256 id;
        address owner;
        bytes32 asset;
        bool    isLong;
        uint256 entryPrice;   // 18 decimals
        uint256 margin;       // 18 decimals (USDC)
        uint256 leverage;     // 1, 2, or 5
        uint256 openedAt;
        uint256 closedAt;
        int256  realizedPnL;
        bool    isOpen;
    }

    // ── State ────────────────────────────────────────────────────────────────

    mapping(uint256 => Position)      public positions;
    mapping(address => uint256[])     public userPositions;
    mapping(address => uint256)       public freeMargin;
    uint256                           public nextPositionId;
    address                           public copyTracker;

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

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotCopyTracker();
    error CopyTrackerNotSet();
    error InsufficientFreeMargin();
    error MarginTooLow();
    error InvalidLeverage();
    error NotPositionOwner();
    error PositionAlreadyClosed();

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc, address _oracle) Ownable(msg.sender) {
        usdc   = IERC20(_usdc);
        oracle = IOracle(_oracle);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setCopyTracker(address _copyTracker) external onlyOwner {
        copyTracker = _copyTracker;
    }

    // ── Margin management ────────────────────────────────────────────────────

    function depositMargin(uint256 amount) external {
        usdc.transferFrom(msg.sender, address(this), amount);
        freeMargin[msg.sender] += amount;
        emit MarginDeposited(msg.sender, amount);
    }

    /// @dev copyTracker pulls USDC from itself, credits freeMargin to `user`
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
    ) external returns (uint256 positionId) {
        return _openPosition(msg.sender, asset, isLong, margin, leverage);
    }

    function openPositionFor(
        address user,
        bytes32 asset,
        bool    isLong,
        uint256 margin,
        uint256 leverage
    ) external returns (uint256 positionId) {
        if (copyTracker == address(0)) revert CopyTrackerNotSet();
        if (msg.sender != copyTracker) revert NotCopyTracker();
        return _openPosition(user, asset, isLong, margin, leverage);
    }

    function closePosition(uint256 positionId) external {
        _closePosition(msg.sender, positionId);
    }

    /// @dev Lets copyTracker close a position on behalf of its owner (e.g. unfollow flow)
    function closePositionFor(address owner, uint256 positionId) external {
        if (msg.sender != copyTracker) revert NotCopyTracker();
        _closePosition(owner, positionId);
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
        uint256 leverage
    ) internal returns (uint256 positionId) {
        if (margin < MIN_MARGIN)                       revert MarginTooLow();
        if (leverage == 0 || leverage > MAX_LEVERAGE)  revert InvalidLeverage();
        if (freeMargin[owner] < margin)                revert InsufficientFreeMargin();

        // oracle returns 8-decimal price; scale to 18 dec for internal accounting
        (uint256 rawPrice,) = oracle.getPrice(asset);
        uint256 entryPrice  = rawPrice * 1e10;

        freeMargin[owner] -= margin;

        positionId = nextPositionId++;
        positions[positionId] = Position({
            id:          positionId,
            owner:       owner,
            asset:       asset,
            isLong:      isLong,
            entryPrice:  entryPrice,
            margin:      margin,
            leverage:    leverage,
            openedAt:    block.timestamp,
            closedAt:    0,
            realizedPnL: 0,
            isOpen:      true
        });
        userPositions[owner].push(positionId);

        emit PositionOpened(positionId, owner, asset, isLong, entryPrice, margin, leverage);
    }

    function _closePosition(address caller, uint256 positionId) internal {
        Position storage pos = positions[positionId];
        if (caller != pos.owner) revert NotPositionOwner();
        if (!pos.isOpen)         revert PositionAlreadyClosed();

        int256 pnl         = _calcPnL(pos);
        int256 closeAmount = int256(pos.margin) + pnl;
        if (closeAmount < 0) closeAmount = 0;

        pos.isOpen      = false;
        pos.closedAt    = block.timestamp;
        pos.realizedPnL = pnl;

        freeMargin[pos.owner] += uint256(closeAmount);

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
}
