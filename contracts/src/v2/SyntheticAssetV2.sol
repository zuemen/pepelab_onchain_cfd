// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/// @notice ERC-20 representing one synthetic asset, held directly in the user's
///         wallet (addable to MetaMask via EIP-747, transferable).
///
///         V2 change vs SyntheticAsset: the minter is a revocable ROLE, not an
///         immutable address. V1 hardcoded the vault, so replacing the vault
///         would have orphaned every token and every holder balance. Here a
///         vault upgrade is grantRole/revokeRole — no redeploy, no user impact.
///
///         Deliberately NOT upgradeable: the token's logic is fixed and holder
///         balances should live in a plain, auditable ERC-20. Only the authority
///         over minting needs to be mutable.
contract SyntheticAssetV2 is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice keccak256 of the symbol — matches the oracle asset id, so the
    ///         frontend can resolve a price from the token alone.
    bytes32 public immutable assetId;

    constructor(
        string memory name_,
        string memory symbol_,
        bytes32 assetId_,
        address admin_
    ) ERC20(name_, symbol_) {
        require(admin_ != address(0), "zero admin");
        assetId = assetId_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin_);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyRole(MINTER_ROLE) {
        _burn(from, amount);
    }
}
