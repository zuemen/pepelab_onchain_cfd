// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TESTNET-ONLY ERC-20 representing one synthetic asset (sAAPL, sBTC…).
///         Unlike a CFD position on PerpetualExchange — which is only a ledger
///         entry — this token really lives in the holder's wallet: it can be
///         added to MetaMask (EIP-747) and transferred to anyone.
///
///         Mint and burn are restricted to the AssetVault, which backs supply
///         with USDC at the current oracle price. NEVER deploy to production.
contract SyntheticAsset is ERC20 {
    /// @notice keccak256 of the symbol — matches the MockOracle asset id, so
    ///         the frontend can look the price up from the token alone.
    bytes32 public immutable assetId;

    /// @notice The only address allowed to mint or burn.
    address public immutable vault;

    modifier onlyVault() {
        require(msg.sender == vault, "only vault");
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        bytes32 assetId_,
        address vault_
    ) ERC20(name_, symbol_) {
        assetId = assetId_;
        vault = vault_;
    }

    function mint(address to, uint256 amount) external onlyVault {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyVault {
        _burn(from, amount);
    }
}
