// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./WrappedUSDC18.sol";

interface IMarginDepositFor {
    function depositMarginFor(address user, uint256 amount) external;
}

/// @notice ADR-011 (P3-04) — USDC (6 dec) -> WrappedUSDC18 -> exchange margin
///         in ONE user transaction: permit (optional), pull, wrap, deposit.
///
///         Uses `PerpetualExchange.depositMarginFor`, which only an
///         `authorizedAgents` address may call; the tenant admin authorizes
///         this router with `setAgentAuthorized(router, true)`. That flag ALSO
///         opens `openPositionFor` / `closePositionFor` to the caller, so the
///         router is written to make that grant harmless: it is immutable,
///         ownerless, has no arbitrary-call path, and its only external call
///         into the exchange is `depositMarginFor` (ADR-011 §3.4).
///
///         Exit is not routed: `withdrawMargin` pays `msg.sender`, so the user
///         withdraws wrapper units and calls `WrappedUSDC18.withdrawTo` (no
///         approval needed — it burns the caller's own balance).
///
///         Holds nothing between transactions: every unit pulled in is wrapped
///         and deposited in the same call.
contract SettlementDepositRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    WrappedUSDC18 public immutable wrapper;
    IMarginDepositFor public immutable exchange;

    event DepositRouted(address indexed payer, address indexed account, uint256 usdcAmount, uint256 margin);

    error InvalidParam();
    error ZeroAmount();

    constructor(address wrapper_, address exchange_) {
        if (wrapper_ == address(0) || exchange_ == address(0)) revert InvalidParam();
        wrapper = WrappedUSDC18(wrapper_);
        usdc = wrapper.underlying();
        exchange = IMarginDepositFor(exchange_);
    }

    /// @notice Caller has already approved this router for `usdcAmount`.
    ///         Credits the margin to `account` (usually the caller).
    function depositMargin(address account, uint256 usdcAmount) external nonReentrant returns (uint256 margin) {
        return _route(account, usdcAmount);
    }

    /// @notice EIP-2612 permit on USDC, then the same as `depositMargin`.
    /// @dev The permit is try/caught: anyone who sees the signature in the
    ///      mempool can submit it first, which would otherwise make this call
    ///      revert (griefing). If the permit was already consumed the
    ///      allowance is there and the transfer succeeds; if not, the
    ///      transfer reverts on its own.
    function depositMarginWithPermit(
        address account,
        uint256 usdcAmount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 margin) {
        try IERC20Permit(address(usdc)).permit(msg.sender, address(this), usdcAmount, deadline, v, r, s) {} catch {}
        return _route(account, usdcAmount);
    }

    function _route(address account, uint256 usdcAmount) private returns (uint256 margin) {
        if (usdcAmount == 0) revert ZeroAmount();
        if (account == address(0)) revert InvalidParam();
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        usdc.forceApprove(address(wrapper), usdcAmount);
        margin = wrapper.depositFor(address(this), usdcAmount);
        IERC20(address(wrapper)).forceApprove(address(exchange), margin);
        exchange.depositMarginFor(account, margin);
        emit DepositRouted(msg.sender, account, usdcAmount, margin);
    }
}
