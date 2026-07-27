// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Integration surface for AssetVaultV2. Institutions code against this.
interface IAssetVaultV2 {
    // ── views ────────────────────────────────────────────────────────────────
    function usdc() external view returns (address);
    function oracle() external view returns (address);
    function version() external view returns (string memory);
    function assetToken(bytes32 assetId) external view returns (address);

    function previewMint(bytes32 assetId, uint256 usdcAmount)
        external view returns (uint256 tokenOut, uint256 feePaid);
    function previewRedeem(bytes32 assetId, uint256 tokenAmount)
        external view returns (uint256 usdcOut, uint256 feePaid);

    function registeredAssets() external view returns (bytes32[] memory);
    function reserve() external view returns (uint256);
    function outstandingValue() external view returns (uint256);
    function reserveRatioBps() external view returns (uint256);
    function exposureOf(bytes32 assetId) external view returns (uint256);

    // ── user actions ─────────────────────────────────────────────────────────
    function mint(bytes32 assetId, uint256 usdcAmount) external returns (uint256 tokenOut);
    function redeem(bytes32 assetId, uint256 tokenAmount) external returns (uint256 usdcOut);

    // ── operator actions ─────────────────────────────────────────────────────
    function fundVault(uint256 usdcAmount) external;
    function withdrawFees(address to, uint256 amount) external;

    // ── events ───────────────────────────────────────────────────────────────
    event Minted(address indexed user, bytes32 indexed assetId, uint256 usdcIn, uint256 tokenOut, uint256 fee);
    event Redeemed(address indexed user, bytes32 indexed assetId, uint256 tokenIn, uint256 usdcOut, uint256 fee);
    event AssetRegistered(bytes32 indexed assetId, address token);
    event AssetUnregistered(bytes32 indexed assetId);
    event OracleChanged(address indexed oldOracle, address indexed newOracle);
    event VaultFunded(address indexed from, uint256 amount);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event RiskParamsUpdated(uint256 mintFeeBps, uint256 redeemFeeBps, uint256 minReserveRatioBps, uint256 maxPriceAge);
    event AssetCapUpdated(bytes32 indexed assetId, uint256 cap);
}
