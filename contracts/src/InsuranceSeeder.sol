// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev The part of `InsuranceVault` the seeder uses. `deposit` mints to
///      `msg.sender` and is open to anyone; the shares are a plain ERC-20.
interface IInsuranceVaultSeedable {
    function usdc() external view returns (IERC20);
    function deposit(uint256 usdcAmount) external returns (uint256 shares);
    function previewWithdraw(uint256 shares) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title InsuranceSeeder
/// @notice Seeds an InsuranceVault and hands every resulting share to a
///         treasury in ONE transaction (INSURANCE_VAULT_SHARES.md §3.3).
/// @dev Why a contract: a broadcast sends approve, deposit and share transfer
///      as separate transactions, and the share amount of the transfer is
///      fixed at simulation time. Anyone can move the share price between
///      them (deposit 1 wei, withdraw part of it) so the hard-coded transfer
///      reverts on chain — again on every `--resume`. Here the transfer moves
///      whatever the deposit actually minted.
///
///      Stateless, no owner, no privilege anywhere: a caller can only spend
///      its own tokens, and every share and token the call touches leaves
///      the contract before it returns. Tokens or shares someone sent to the
///      contract beforehand are swept along (shares to the treasury, tokens
///      back to the caller), so a donation cannot block a seed.
contract InsuranceSeeder {
    using SafeERC20 for IERC20;

    error TokenNotVaultAsset();
    error BadTreasury();
    error SeedWorthTooLittle(uint256 worth, uint256 minValue);

    event Seeded(address indexed vault, address indexed payer, address indexed treasury, uint256 amount, uint256 shares);

    /// @param minValue Lower bound, in asset units, on what the shares this
    ///        deposit minted redeem for (`previewWithdraw`). The bound is on
    ///        value, not on the share count: anyone can raise the share price
    ///        before the seed for a few wei (deposit, then withdraw slices
    ///        that round to zero), so a share-count floor could be pushed
    ///        under and the seed blocked on every retry — while the seed's
    ///        value is untouched by that (the vault rounds in its favour, and
    ///        what the attacker leaves behind accrues to the holders). A
    ///        position worth less than `minValue` is refused.
    /// @return minted Shares minted by this deposit (all now with `treasury`).
    function seed(IInsuranceVaultSeedable vault, IERC20 token, uint256 amount, address treasury, uint256 minValue)
        external
        returns (uint256 minted)
    {
        if (address(vault.usdc()) != address(token)) revert TokenNotVaultAsset();
        if (treasury == address(0) || treasury == address(this)) revert BadTreasury();

        token.safeTransferFrom(msg.sender, address(this), amount);
        token.forceApprove(address(vault), amount);
        uint256 before = vault.balanceOf(address(this));
        vault.deposit(amount);
        uint256 held = vault.balanceOf(address(this));
        minted = held - before;
        uint256 worth = vault.previewWithdraw(minted);
        if (worth < minValue) revert SeedWorthTooLittle(worth, minValue);

        require(vault.transfer(treasury, held), "InsuranceSeeder: share transfer failed");
        require(vault.balanceOf(address(this)) == 0, "InsuranceSeeder: shares left behind");
        token.forceApprove(address(vault), 0);
        uint256 rest = token.balanceOf(address(this));
        if (rest > 0) token.safeTransfer(msg.sender, rest);

        emit Seeded(address(vault), msg.sender, treasury, amount, minted);
    }
}
