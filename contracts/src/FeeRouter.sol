// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IInsuranceVault {
    function depositFromProtocol(uint256 amount) external;
}

/// @dev Fee split: 70% trader / 20% platform treasury / 10% insurance vault
contract FeeRouter is Ownable {
    // ── Immutables ───────────────────────────────────────────────────────────

    IERC20           public immutable usdc;
    address          public immutable platformTreasury;
    IInsuranceVault  public immutable insuranceVault;

    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant PLATFORM_SHARE_BPS = 2000;  // 20 %
    uint256 public constant VAULT_SHARE_BPS    = 1000;  // 10 % — trader gets remaining 70 %

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
        uint256 vaultShare
    );
    event PerformanceFeeDistributed(
        address indexed trader,
        uint256 fee,
        uint256 traderShare,
        uint256 platformShare,
        uint256 vaultShare
    );
    event TraderEarningsWithdrawn(address indexed trader, uint256 amount);
    event PlatformFeesWithdrawn(address indexed to, uint256 amount, uint256 timestamp);
    event ExternalRevenueRouted(
        address indexed source,
        address indexed trader,
        uint256 fee,
        uint256 traderShare,
        uint256 platformShare,
        uint256 vaultShare
    );

    // ── Errors ───────────────────────────────────────────────────────────────

    error Unauthorized();
    error NothingToWithdraw();
    error ZeroFee();

    // ── Modifiers ────────────────────────────────────────────────────────────

    modifier onlyAuthorized() {
        if (msg.sender != copyTracker && msg.sender != exchange) revert Unauthorized();
        _;
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc, address _platformTreasury, address _insuranceVault)
        Ownable(msg.sender)
    {
        usdc             = IERC20(_usdc);
        platformTreasury = _platformTreasury;
        insuranceVault   = IInsuranceVault(_insuranceVault);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setCopyTracker(address _ct) external onlyOwner { copyTracker = _ct; }
    function setExchange(address _ex)    external onlyOwner { exchange    = _ex; }

    // ── Fee entry points ─────────────────────────────────────────────────────

    /// @dev CopyTracker must approve this contract for `fee` USDC before calling.
    function distributeCopyFee(address trader, uint256 fee) external onlyAuthorized {
        usdc.transferFrom(msg.sender, address(this), fee);
        (uint256 t, uint256 p, uint256 v) = _split(trader, fee);
        emit CopyFeeDistributed(trader, fee, t, p, v);
    }

    /// @dev PerpetualExchange must transfer `fee` USDC to this contract before calling.
    function receivePerformanceFee(address trader, uint256 fee) external onlyAuthorized {
        (uint256 t, uint256 p, uint256 v) = _split(trader, fee);
        emit PerformanceFeeDistributed(trader, fee, t, p, v);
    }

    /// @notice Permissionless settlement entry for off-chain revenue — notably
    ///         x402 paid-signal fees. Anyone holding USDC can route it into the
    ///         protocol's existing 70/20/10 split, crediting the 70% trader share
    ///         to `trader` (e.g. the trader whose signal an agent bought). No
    ///         privileged role required; caller must approve this contract for
    ///         `fee` USDC first. Reuses the same `_split` accounting as on-chain fees.
    function routeExternalRevenue(address trader, uint256 fee) external {
        if (fee == 0) revert ZeroFee();
        usdc.transferFrom(msg.sender, address(this), fee);
        (uint256 t, uint256 p, uint256 v) = _split(trader, fee);
        emit ExternalRevenueRouted(msg.sender, trader, fee, t, p, v);
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
        emit PlatformFeesWithdrawn(platformTreasury, amt, block.timestamp);
    }

    // ── Internal ─────────────────────────────────────────────────────────────

    /// @dev Credits the 70/20/10 split and routes the vault share. Returns the
    ///      computed shares so each entry point can emit its own event.
    function _split(address trader, uint256 fee)
        internal
        returns (uint256 traderShare, uint256 platformShare, uint256 vaultShare)
    {
        platformShare = fee * PLATFORM_SHARE_BPS / 10_000;
        vaultShare    = fee * VAULT_SHARE_BPS    / 10_000;
        traderShare   = fee - platformShare - vaultShare;

        traderEarnings[trader] += traderShare;
        platformEarnings       += platformShare;

        // Route vault share to InsuranceVault; vault calls transferFrom back to pull USDC
        usdc.approve(address(insuranceVault), vaultShare);
        insuranceVault.depositFromProtocol(vaultShare);
    }
}
