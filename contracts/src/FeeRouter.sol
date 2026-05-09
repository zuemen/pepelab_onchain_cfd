// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Fee split: 70% trader / 20% platform treasury / 10% slash pool
contract FeeRouter is Ownable {
    // ── Immutables ───────────────────────────────────────────────────────────

    IERC20  public immutable usdc;
    address public immutable platformTreasury;
    address public immutable slashPool;

    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant PLATFORM_SHARE_BPS  = 2000;  // 20 %
    uint256 public constant SLASH_POOL_SHARE_BPS = 1000;  // 10 % — trader gets remaining 70 %

    // ── State ────────────────────────────────────────────────────────────────

    mapping(address => uint256) public traderEarnings;
    uint256                     public platformEarnings;

    address public copyTracker;
    address public exchange;

    // ── Events ───────────────────────────────────────────────────────────────

    event CopyFeeDistributed(
        address indexed trader,
        uint256 fee,
        uint256 traderShare,
        uint256 platformShare,
        uint256 slashShare
    );
    event PerformanceFeeDistributed(
        address indexed trader,
        uint256 fee,
        uint256 traderShare,
        uint256 platformShare,
        uint256 slashShare
    );
    event TraderEarningsWithdrawn(address indexed trader, uint256 amount);
    event PlatformFeesWithdrawn(uint256 amount);

    // ── Errors ───────────────────────────────────────────────────────────────

    error Unauthorized();
    error NothingToWithdraw();

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyAuthorized() {
        if (msg.sender != copyTracker && msg.sender != exchange) revert Unauthorized();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc, address _platformTreasury, address _slashPool)
        Ownable(msg.sender)
    {
        usdc             = IERC20(_usdc);
        platformTreasury = _platformTreasury;
        slashPool        = _slashPool;
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setCopyTracker(address _ct) external onlyOwner { copyTracker = _ct; }
    function setExchange(address _ex)    external onlyOwner { exchange    = _ex; }

    // ── Fee entry points ─────────────────────────────────────────────────────

    /// @dev CopyTracker must approve this contract for `fee` USDC before calling.
    function distributeCopyFee(address trader, uint256 fee) external onlyAuthorized {
        usdc.transferFrom(msg.sender, address(this), fee);
        _split(trader, fee, true);
    }

    /// @dev PerpetualExchange must transfer `fee` USDC to this contract before calling.
    function receivePerformanceFee(address trader, uint256 fee) external onlyAuthorized {
        _split(trader, fee, false);
    }

    // ── Withdrawals ──────────────────────────────────────────────────────────

    function withdrawTraderEarnings() external {
        uint256 amt = traderEarnings[msg.sender];
        if (amt == 0) revert NothingToWithdraw();
        traderEarnings[msg.sender] = 0;
        usdc.transfer(msg.sender, amt);
        emit TraderEarningsWithdrawn(msg.sender, amt);
    }

    function withdrawPlatformFees() external {
        if (msg.sender != platformTreasury) revert Unauthorized();
        uint256 amt = platformEarnings;
        if (amt == 0) revert NothingToWithdraw();
        platformEarnings = 0;
        usdc.transfer(platformTreasury, amt);
        emit PlatformFeesWithdrawn(amt);
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    function _split(address trader, uint256 fee, bool isCopy) internal {
        uint256 platformShare = fee * PLATFORM_SHARE_BPS / 10_000;
        uint256 slashShare    = fee * SLASH_POOL_SHARE_BPS / 10_000;
        uint256 traderShare   = fee - platformShare - slashShare;

        traderEarnings[trader] += traderShare;
        platformEarnings       += platformShare;
        usdc.transfer(slashPool, slashShare);

        if (isCopy) emit CopyFeeDistributed(trader, fee, traderShare, platformShare, slashShare);
        else        emit PerformanceFeeDistributed(trader, fee, traderShare, platformShare, slashShare);
    }
}
