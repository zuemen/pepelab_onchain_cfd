// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice ADR-011 (P3-04) — a 1:1, 18-decimal claim on a 6-decimal USDC.
///
///         The V1 contracts (PerpetualExchange, InsuranceVault, FeeRouter,
///         TraderStake, CopyTracker, AssetVaultV2_x) account in an 18-decimal
///         settlement token and PerpetualExchange refuses anything else in its
///         constructor. Base mainnet's native USDC has 6 decimals. This
///         contract lets one tenant run the unchanged V1 bytecode on mainnet:
///         the tenant's whole set is deployed with THIS token as its
///         settlement token, and the only place real USDC moves is here.
///
///         1 USDC unit (1e-6) <-> 1e12 wrapper units (1e-18). Always.
///
///         Deliberately minimal — no owner, no pause, no upgrade, no fee, no
///         sweep. Every line here is in the audit scope of every tenant's
///         funds, so anything that can be done elsewhere is done elsewhere:
///           - emergency stop: the exchange's own pause / guardian; USDC's
///             own pause stops wrap/unwrap by itself.
///           - recovery of USDC sent here by mistake: none (see ADR-011 §4).
///
///         Invariants (test/settlement/WrappedUSDC18Invariant.t.sol):
///           I1  totalSupply() <= underlying.balanceOf(this) * SCALE
///           I2  totalSupply() % SCALE == 0  (mint and burn are whole units)
///           I3  unwrap never pays more underlying than amount / SCALE
///
///         Circle blacklist parity: a transfer, mint or burn whose `from` or
///         `to` is blacklisted on the underlying USDC reverts, exactly as a
///         USDC transfer would. Without this, a blacklisted holder could move
///         wrapper units to a clean address that unwraps them, i.e. the
///         wrapper would launder around the issuer's freeze. The probe is
///         fail-OPEN when the underlying has no `isBlacklisted(address)` (a
///         plain ERC-20, or a future FiatToken that renamed it): bricking every
///         tenant's funds because an upstream proxy changed a view is worse
///         than losing parity, and the edges (wrap pulls from the holder,
///         unwrap pays the recipient) are still enforced by USDC itself.
///         USDC's `paused()` is NOT mirrored: wrapper units keep moving while
///         USDC is paused so liquidations and internal settlement continue;
///         only wrap/unwrap stop (ADR-011 §3.2).
contract WrappedUSDC18 is ERC20 {
    using SafeERC20 for IERC20;

    /// @notice 10^(18 - 6).
    uint256 public constant SCALE = 1e12;

    IERC20 public immutable underlying;

    event Wrapped(address indexed payer, address indexed account, uint256 underlyingAmount, uint256 minted);
    event Unwrapped(address indexed account, address indexed recipient, uint256 burned, uint256 underlyingAmount);

    error InvalidUnderlying();
    error ZeroAmount();
    error InvalidRecipient();
    /// @notice `amount` is below one whole underlying unit (1e12 wrapper units).
    error BelowOneUnit(uint256 amount);
    /// @notice The underlying USDC reports `account` as blacklisted.
    error UnderlyingBlacklisted(address account);

    constructor(address underlying_, string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        if (underlying_ == address(0) || underlying_.code.length == 0) revert InvalidUnderlying();
        // Hard requirement (not try/catch like the exchange): SCALE is a
        // constant, so a non-6-decimal underlying would mis-scale forever.
        if (IERC20Metadata(underlying_).decimals() != 6) revert InvalidUnderlying();
        underlying = IERC20(underlying_);
    }

    /// @notice Pulls `underlyingAmount` USDC from the caller and mints the
    ///         equivalent 18-decimal amount to `account`.
    /// @dev Mints on the balance delta, not the argument: native USDC charges
    ///      no transfer fee today, but it is an upgradeable proxy, and minting
    ///      on what actually arrived keeps I1 true whatever it does later.
    function depositFor(address account, uint256 underlyingAmount) external returns (uint256 minted) {
        if (underlyingAmount == 0) revert ZeroAmount();
        if (account == address(0) || account == address(this)) revert InvalidRecipient();
        uint256 before = underlying.balanceOf(address(this));
        underlying.safeTransferFrom(msg.sender, address(this), underlyingAmount);
        uint256 received = underlying.balanceOf(address(this)) - before;
        // (A transfer that delivers nothing mints nothing; I1 holds either way.)
        minted = received * SCALE;
        _mint(account, minted);
        emit Wrapped(msg.sender, account, received, minted);
    }

    /// @notice Burns the caller's wrapper units and pays the underlying USDC
    ///         to `recipient`.
    /// @dev Rounds DOWN to a whole underlying unit and burns only what is
    ///      paid out: `amount % SCALE` (< 1e-6 USDC) stays in the caller's
    ///      balance, so nothing is destroyed and nothing is overpaid. Use
    ///      `maxUnwrappable(holder)` to unwrap everything payable.
    function withdrawTo(address recipient, uint256 amount) external returns (uint256 paid) {
        if (recipient == address(0) || recipient == address(this)) revert InvalidRecipient();
        uint256 burned = amount - (amount % SCALE);
        if (burned == 0) revert BelowOneUnit(amount);
        paid = burned / SCALE;
        _burn(msg.sender, burned);
        underlying.safeTransfer(recipient, paid);
        emit Unwrapped(msg.sender, recipient, burned, paid);
    }

    /// @notice The largest `amount` `holder` can pass to `withdrawTo` without
    ///         leaving more than the sub-unit dust behind.
    function maxUnwrappable(address holder) external view returns (uint256) {
        uint256 b = balanceOf(holder);
        return b - (b % SCALE);
    }

    /// @inheritdoc ERC20
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    /// @dev Blacklist parity on every movement (transfer, mint, burn).
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) _requireNotBlacklisted(from);
        if (to != address(0)) _requireNotBlacklisted(to);
        super._update(from, to, value);
    }

    function _requireNotBlacklisted(address account) private view {
        (bool ok, bytes memory ret) =
            address(underlying).staticcall(abi.encodeWithSignature("isBlacklisted(address)", account));
        // Fail-open on a missing / reverting / malformed probe — see contract NatSpec.
        if (ok && ret.length >= 32 && abi.decode(ret, (uint256)) != 0) revert UnderlyingBlacklisted(account);
    }
}
