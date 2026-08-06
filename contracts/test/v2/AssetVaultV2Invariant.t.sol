// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../../src/v2/AssetVaultV2_2.sol";
import "../../src/v2/SyntheticAssetV2.sol";
import "../../src/MockUSDC.sol";
import "../../src/MockOracle.sol";

/// @dev Drives the vault with randomised sequences. Bounds inputs to the
///      plausible range so the fuzzer spends its time on real states rather
///      than on reverts.
contract VaultHandler is Test {
    AssetVaultV2_2     public vault;
    SyntheticAssetV2 public token;
    MockUSDC         public usdc;
    MockOracle       public oracle;
    bytes32          public assetId;

    address[3] public actors;

    uint256 public mintCalls;
    uint256 public redeemCalls;

    constructor(
        AssetVaultV2_2 v,
        SyntheticAssetV2 t,
        MockUSDC u,
        MockOracle o,
        bytes32 id
    ) {
        vault = v; token = t; usdc = u; oracle = o; assetId = id;
        actors = [makeAddr("a1"), makeAddr("a2"), makeAddr("a3")];
        for (uint256 i = 0; i < actors.length; i++) {
            // PA-3: MockUSDC.mint is owner-gated now, and the handler is not
            // the owner — the test contract that deployed the token is.
            vm.prank(u.owner());
            usdc.mint(actors[i], 1_000_000e18);
            vm.prank(actors[i]);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function mint(uint256 actorSeed, uint256 amount) external {
        address who = _actor(actorSeed);
        amount = bound(amount, 1e18, 50_000e18);
        if (usdc.balanceOf(who) < amount) return;

        vm.prank(who);
        try vault.mint(assetId, amount) { mintCalls++; } catch { /* guard fired */ }
    }

    function redeem(uint256 actorSeed, uint256 amount) external {
        address who = _actor(actorSeed);
        uint256 bal = token.balanceOf(who);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);

        vm.prank(who);
        try vault.redeem(assetId, amount) { redeemCalls++; } catch { /* vault dry */ }
    }

    /// @dev Prices move, which is the whole source of the vault's risk.
    function movePrice(uint256 seed) external {
        (uint256 current, ) = oracle.getPrice(assetId);
        // +/- 20%, never zero
        uint256 next = bound(seed, (current * 80) / 100, (current * 120) / 100);
        if (next == 0) next = 1;
        oracle.updatePrice(assetId, next);
    }

    /// @dev Keeps the oracle fresh; without this every call reverts StalePrice
    ///      after an hour of simulated time and the run stops exercising logic.
    function warp(uint256 seed) external {
        vm.warp(block.timestamp + bound(seed, 1, 30 minutes));
        (uint256 current, ) = oracle.getPrice(assetId);
        oracle.updatePrice(assetId, current);
    }
}

/// @notice Properties that must hold after ANY sequence of user actions and
///         price moves. Unit tests check the cases we thought of; these check
///         the ones we did not.
contract AssetVaultV2InvariantTest is Test {
    AssetVaultV2_2     vault;
    SyntheticAssetV2 token;
    MockUSDC         usdc;
    MockOracle       oracle;
    VaultHandler     handler;

    address admin = address(this);
    bytes32 constant AID = keccak256("sAAPL");

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();
        oracle.addAsset(AID, 200e8);

        AssetVaultV2_2 impl = new AssetVaultV2_2();
        vault = AssetVaultV2_2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2_2.initialize, (address(usdc), address(oracle), admin))
        )));

        token = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AID, admin);
        token.grantRole(token.MINTER_ROLE(), address(vault));
        vault.registerAsset(AID, address(token));
        vault.setAssetCap(AID, 100_000e18);
        vault.setRiskParams(30, 30, 11_000, 1 hours);

        usdc.mint(admin, 2_000_000e18);
        usdc.approve(address(vault), type(uint256).max);
        vault.fundVault(500_000e18);

        handler = new VaultHandler(vault, token, usdc, oracle, AID);
        // The handler needs to move prices, and updatePrice is onlyOwner.
        oracle.transferOwnership(address(handler));

        targetContract(address(handler));
    }

    /// @dev Accrued fees are operator revenue and must never be counted as
    ///      collateral available to redeemers. If this breaks, the vault can
    ///      pay out money it does not have.
    function invariant_reserveNeverCountsAccruedFees() public view {
        uint256 bal = usdc.balanceOf(address(vault));
        assertLe(vault.reserve() + vault.accruedFees(), bal);
    }

    /// @dev The vault must always hold at least the fees it owes the operator.
    function invariant_balanceCoversAccruedFees() public view {
        assertGe(usdc.balanceOf(address(vault)), vault.accruedFees());
    }

    /// @dev Tracked exposure must equal real token supply. A drift here means
    ///      the cap and ratio checks are guarding a number that is not real.
    function invariant_exposureMatchesTokenSupply() public view {
        assertEq(vault.exposureOf(AID), token.totalSupply());
    }

    /// @dev The per-asset cap is the operator's stated maximum exposure. No
    ///      sequence of mints and price moves may exceed it.
    function invariant_exposureNeverExceedsCap() public view {
        assertLe(vault.exposureOf(AID), vault.assetCap(AID));
    }

    /// @dev Registration is bounded so mint() can never grow past the block gas
    ///      limit.
    function invariant_registeredAssetsWithinCeiling() public view {
        assertLe(vault.registeredAssets().length, vault.MAX_REGISTERED_ASSETS());
    }
}
