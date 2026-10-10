// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev The slice of `FeeRouter` this splitter talks to.
interface IFeeRouterPlatformPayee {
    function usdc() external view returns (address);
    function platformTreasury() external view returns (address);
    function platformEarnings() external view returns (uint256);
    function withdrawPlatformFees() external;
}

/// @dev The slice of `CarbonRetirement` checked at construction.
interface ICarbonRetirementBudget {
    function usdc() external view returns (address);
}

/// @title PlatformFeeSplitter —— 平台份額分流：一部分導向碳權退役
/// @notice Sits in `FeeRouter`'s platform-payee slot (`platformTreasury`) and
///         splits whatever the platform share pays out: a fixed
///         `carbonShareBps` to `CarbonRetirement`, the rest to the real treasury.
/// @dev    Issue #105, ADR-022. `FeeRouter.PLATFORM_SHARE_BPS` is a `constant`
///         and `platformTreasury` is `immutable`, so the router itself is left
///         byte-for-byte unchanged: the 70 / 20 / 10 trader / platform / vault
///         split, its events and all existing tests are untouched, and so is
///         `PerpetualExchange.PERFORMANCE_FEE_BPS = 1000`. Routing part of the
///         platform share to retirement is done purely by *who the platform
///         payee is* — a router deployed with this contract as its
///         `platformTreasury`.
///
///         Non-discretionary by construction: no owner, no setters.
///         `carbonShareBps`, `treasury` and `carbonRetirement` are immutable, and
///         `FeeRouter.withdrawPlatformFees` only pays `platformTreasury`, so the
///         treasury has no path to the platform share that skips the carbon
///         slice. The one privileged step is `bindFeeRouter`, callable once by
///         the deployer (router and splitter each need the other's address); it
///         checks the router really pays this contract in the same token.
///
///         `distribute` is permissionless — any keeper or user can crank it; the
///         caller decides only *when*, never *where the money goes*.
contract PlatformFeeSplitter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant BPS = 10_000;

    IERC20  public immutable usdc;
    /// @notice Receives the non-carbon remainder of the platform share.
    address public immutable treasury;
    /// @notice Receives `carbonShareBps` of the platform share as retirement budget.
    address public immutable carbonRetirement;
    /// @notice Share of the platform share routed to retirement, in bps (0 < x ≤ 10000).
    uint256 public immutable carbonShareBps;
    /// @notice The only address allowed to call `bindFeeRouter`, once.
    address public immutable deployer;

    /// @notice The FeeRouter whose platform share this splitter collects. Set once.
    IFeeRouterPlatformPayee public feeRouter;

    uint256 public totalToCarbon;
    uint256 public totalToTreasury;

    event FeeRouterBound(address indexed feeRouter);
    event PlatformFeesSplit(uint256 total, uint256 toCarbon, uint256 toTreasury);

    error ZeroAddress();
    error InvalidShare(uint256 bps);
    error Unauthorized();
    error AlreadyBound();
    error NotPlatformPayee(address router);
    error TokenMismatch(address token);
    error NothingToDistribute();

    constructor(address _usdc, address _treasury, address _carbonRetirement, uint256 _carbonShareBps) {
        if (_usdc == address(0) || _treasury == address(0) || _carbonRetirement == address(0)) {
            revert ZeroAddress();
        }
        if (_carbonShareBps == 0 || _carbonShareBps > BPS) revert InvalidShare(_carbonShareBps);
        // A budget in the wrong token could never be spent by retire() — it would
        // sit in CarbonRetirement forever. Refuse the mismatch up front.
        address retirementToken = ICarbonRetirementBudget(_carbonRetirement).usdc();
        if (retirementToken != _usdc) revert TokenMismatch(retirementToken);
        usdc             = IERC20(_usdc);
        treasury         = _treasury;
        carbonRetirement = _carbonRetirement;
        carbonShareBps   = _carbonShareBps;
        deployer         = msg.sender;
    }

    /// @notice One-time wiring to the FeeRouter deployed with this contract as
    ///         its `platformTreasury`.
    function bindFeeRouter(address router) external {
        if (msg.sender != deployer) revert Unauthorized();
        if (address(feeRouter) != address(0)) revert AlreadyBound();
        if (router == address(0)) revert ZeroAddress();
        IFeeRouterPlatformPayee r = IFeeRouterPlatformPayee(router);
        if (r.platformTreasury() != address(this)) revert NotPlatformPayee(router);
        address routerToken = r.usdc();
        if (routerToken != address(usdc)) revert TokenMismatch(routerToken);
        feeRouter = r;
        emit FeeRouterBound(router);
    }

    /// @notice Pull any accrued platform share from the bound FeeRouter, then
    ///         split this contract's whole balance: `carbonShareBps` to
    ///         `carbonRetirement`, the remainder to `treasury`.
    /// @dev    The carbon slice rounds down; the treasury gets the exact
    ///         remainder, so `toCarbon + toTreasury == total` always.
    function distribute() external nonReentrant returns (uint256 toCarbon, uint256 toTreasury) {
        IFeeRouterPlatformPayee r = feeRouter;
        if (address(r) != address(0) && r.platformEarnings() > 0) {
            r.withdrawPlatformFees();
        }

        uint256 total = usdc.balanceOf(address(this));
        if (total == 0) revert NothingToDistribute();

        toCarbon   = total * carbonShareBps / BPS;
        toTreasury = total - toCarbon;
        totalToCarbon   += toCarbon;
        totalToTreasury += toTreasury;

        if (toCarbon > 0)   usdc.safeTransfer(carbonRetirement, toCarbon);
        if (toTreasury > 0) usdc.safeTransfer(treasury, toTreasury);

        emit PlatformFeesSplit(total, toCarbon, toTreasury);
    }

    /// @notice Platform share waiting to be split (accrued in the router plus held here).
    function pending() external view returns (uint256) {
        uint256 accrued = address(feeRouter) == address(0) ? 0 : feeRouter.platformEarnings();
        return accrued + usdc.balanceOf(address(this));
    }
}
