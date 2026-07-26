// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./SyntheticAsset.sol";

interface IAssetOracle {
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt);
}

/// @notice TESTNET-ONLY mint/burn vault for the tokenized-asset layer.
///
///         Users pay USDC to mint a SyntheticAsset ERC-20 at the current oracle
///         price, and burn it back for USDC. This is a mint-burn model, NOT an
///         AMM: there is no curve and no slippage — price comes purely from the
///         oracle. USDC paid in stays in the vault; tokens are minted from thin
///         air. Redemptions are therefore paid out of the vault's USDC balance,
///         so the owner must seed a reserve via fundVault() for redeems to work
///         once prices move up.
///
///         Runs alongside the existing CFD engine rather than replacing it:
///         PerpetualExchange positions are untouched by this contract.
contract AssetVault is Ownable {
    IERC20       public immutable usdc;
    IAssetOracle public immutable oracle;

    /// @notice assetId (keccak256 of symbol) => SyntheticAsset address
    mapping(bytes32 => address) public assetToken;

    event Minted(address indexed user, bytes32 indexed assetId, uint256 usdcIn, uint256 tokenOut);
    event Redeemed(address indexed user, bytes32 indexed assetId, uint256 tokenIn, uint256 usdcOut);
    event AssetRegistered(bytes32 indexed assetId, address token);
    event VaultFunded(address indexed from, uint256 amount);

    constructor(address _usdc, address _oracle) Ownable(msg.sender) {
        require(_usdc != address(0) && _oracle != address(0), "zero address");
        usdc   = IERC20(_usdc);
        oracle = IAssetOracle(_oracle);
    }

    function registerAsset(bytes32 assetId, address token) external onlyOwner {
        require(token != address(0), "zero token");
        assetToken[assetId] = token;
        emit AssetRegistered(assetId, token);
    }

    /// @dev Oracle prices carry 8 decimals; both USDC and the synthetic tokens
    ///      carry 18, so the 1e8 factors below keep everything in 18-dec terms.
    function _price(bytes32 assetId) internal view returns (uint256 price) {
        (price, ) = oracle.getPrice(assetId);
        require(price > 0, "no price");
    }

    function previewMint(bytes32 assetId, uint256 usdcAmount) public view returns (uint256) {
        return usdcAmount * 1e8 / _price(assetId);
    }

    function previewRedeem(bytes32 assetId, uint256 tokenAmount) public view returns (uint256) {
        return tokenAmount * _price(assetId) / 1e8;
    }

    /// @notice Pay `usdcAmount` USDC, receive the equivalent value in tokens.
    function mint(bytes32 assetId, uint256 usdcAmount) external {
        address token = assetToken[assetId];
        require(token != address(0), "asset not registered");
        require(usdcAmount > 0, "zero amount");

        uint256 tokenAmount = previewMint(assetId, usdcAmount);
        require(tokenAmount > 0, "dust");

        require(usdc.transferFrom(msg.sender, address(this), usdcAmount), "usdc in failed");
        SyntheticAsset(token).mint(msg.sender, tokenAmount);

        emit Minted(msg.sender, assetId, usdcAmount, tokenAmount);
    }

    /// @notice Burn `tokenAmount` tokens, receive their current USDC value.
    function redeem(bytes32 assetId, uint256 tokenAmount) external {
        address token = assetToken[assetId];
        require(token != address(0), "asset not registered");
        require(tokenAmount > 0, "zero amount");

        uint256 usdcOut = previewRedeem(assetId, tokenAmount);
        require(usdc.balanceOf(address(this)) >= usdcOut, "vault dry");

        SyntheticAsset(token).burn(msg.sender, tokenAmount);
        require(usdc.transfer(msg.sender, usdcOut), "usdc out failed");

        emit Redeemed(msg.sender, assetId, tokenAmount, usdcOut);
    }

    /// @notice Owner injects USDC reserve so users can redeem.
    function fundVault(uint256 usdcAmount) external onlyOwner {
        require(usdc.transferFrom(msg.sender, address(this), usdcAmount), "fund failed");
        emit VaultFunded(msg.sender, usdcAmount);
    }
}
