// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/AssetVault.sol";
import "../src/SyntheticAsset.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @dev Oracle stub that reports a zero price, to exercise the vault's
///      "no price" guard. MockOracle itself can never return 0 — it rejects
///      zero prices on write and reverts AssetNotFound on unknown assets.
contract ZeroPriceOracle {
    function getPrice(bytes32) external pure returns (uint256, uint256) {
        return (0, 0);
    }
}

contract AssetVaultTest is Test {
    AssetVault      vault;
    MockUSDC        usdc;
    MockOracle      oracle;
    SyntheticAsset  aapl;

    address owner = address(this);
    address alice = makeAddr("alice");

    bytes32 constant AID = keccak256("sAAPL");
    uint256 constant PRICE_8 = 200e8; // $200 at 8 decimals

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();
        vault  = new AssetVault(address(usdc), address(oracle));

        aapl = new SyntheticAsset("Synthetic Apple", "sAAPL", AID, address(vault));
        vault.registerAsset(AID, address(aapl));

        oracle.addAsset(AID, PRICE_8);

        usdc.mint(alice, 10_000e18);

        // Seed the vault's USDC reserve so redemptions can be honored.
        usdc.mint(owner, 1_000_000e18);
        usdc.approve(address(vault), type(uint256).max);
        vault.fundVault(100_000e18);
    }

    // ── mint ──────────────────────────────────────────────────────────────────

    function test_mintGivesCorrectTokenAmount() public {
        vm.startPrank(alice);
        usdc.approve(address(vault), 2_000e18);
        vault.mint(AID, 2_000e18);          // $2000 / $200 = 10 sAAPL
        vm.stopPrank();

        assertEq(aapl.balanceOf(alice), 10e18);
        assertEq(usdc.balanceOf(alice), 8_000e18);
    }

    function test_mintPullsUsdcIntoVault() public {
        uint256 vaultBefore = usdc.balanceOf(address(vault));
        vm.startPrank(alice);
        usdc.approve(address(vault), 2_000e18);
        vault.mint(AID, 2_000e18);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(vault)) - vaultBefore, 2_000e18);
    }

    function test_previewMintMatchesMint() public {
        uint256 preview = vault.previewMint(AID, 2_000e18);
        vm.startPrank(alice);
        usdc.approve(address(vault), 2_000e18);
        vault.mint(AID, 2_000e18);
        vm.stopPrank();
        assertEq(preview, 10e18);
        assertEq(aapl.balanceOf(alice), preview);
    }

    function test_mintRevertsWhenAssetNotRegistered() public {
        vm.prank(alice);
        vm.expectRevert(bytes("asset not registered"));
        vault.mint(keccak256("sUNKNOWN"), 1_000e18);
    }

    /// @dev Registered with the vault but never added to the oracle: the oracle
    ///      itself reverts (AssetNotFound) before the vault's guard is reached.
    function test_mintRevertsWhenOracleHasNoAsset() public {
        bytes32 unknown = keccak256("sNONE");
        SyntheticAsset none = new SyntheticAsset("None", "sNONE", unknown, address(vault));
        vault.registerAsset(unknown, address(none));

        vm.startPrank(alice);
        usdc.approve(address(vault), 1_000e18);
        vm.expectRevert(abi.encodeWithSelector(MockOracle.AssetNotFound.selector, unknown));
        vault.mint(unknown, 1_000e18);
        vm.stopPrank();
    }

    /// @dev Exercises the vault's own `require(price > 0)` guard.
    function test_mintRevertsWhenNoPrice() public {
        ZeroPriceOracle zero = new ZeroPriceOracle();
        AssetVault v = new AssetVault(address(usdc), address(zero));
        SyntheticAsset t = new SyntheticAsset("Synthetic Apple", "sAAPL", AID, address(v));
        v.registerAsset(AID, address(t));

        vm.startPrank(alice);
        usdc.approve(address(v), 1_000e18);
        vm.expectRevert(bytes("no price"));
        v.mint(AID, 1_000e18);
        vm.stopPrank();
    }

    function test_mintRevertsOnZeroAmount() public {
        vm.prank(alice);
        vm.expectRevert(bytes("zero amount"));
        vault.mint(AID, 0);
    }

    // ── redeem ────────────────────────────────────────────────────────────────

    function test_redeemReturnsUsdc() public {
        vm.startPrank(alice);
        usdc.approve(address(vault), 2_000e18);
        vault.mint(AID, 2_000e18);

        uint256 balBefore = usdc.balanceOf(alice);
        vault.redeem(AID, 10e18);           // 10 sAAPL * $200 = $2000
        vm.stopPrank();

        assertEq(usdc.balanceOf(alice) - balBefore, 2_000e18);
        assertEq(aapl.balanceOf(alice), 0);
    }

    function test_redeemAtHigherPriceReturnsMoreUsdc() public {
        vm.startPrank(alice);
        usdc.approve(address(vault), 2_000e18);
        vault.mint(AID, 2_000e18);          // 10 sAAPL at $200
        vm.stopPrank();

        oracle.updatePrice(AID, 250e8);     // price rises to $250

        vm.prank(alice);
        vault.redeem(AID, 10e18);           // 10 * $250 = $2500
        assertEq(usdc.balanceOf(alice), 8_000e18 + 2_500e18);
    }

    function test_redeemRevertsWhenVaultDry() public {
        // Fresh vault with no owner-funded reserve.
        AssetVault dry = new AssetVault(address(usdc), address(oracle));
        SyntheticAsset t = new SyntheticAsset("Synthetic Apple", "sAAPL", AID, address(dry));
        dry.registerAsset(AID, address(t));

        vm.startPrank(alice);
        usdc.approve(address(dry), 2_000e18);
        dry.mint(AID, 2_000e18);   // vault now holds exactly alice's 2000
        dry.redeem(AID, 10e18);    // pays it all back — fine

        vm.expectRevert(bytes("vault dry"));
        dry.redeem(AID, 10e18);    // nothing left to pay out
        vm.stopPrank();
    }

    function test_previewRedeemMatchesRedeem() public {
        vm.startPrank(alice);
        usdc.approve(address(vault), 2_000e18);
        vault.mint(AID, 2_000e18);

        uint256 preview  = vault.previewRedeem(AID, 10e18);
        uint256 before_  = usdc.balanceOf(alice);
        vault.redeem(AID, 10e18);
        vm.stopPrank();

        assertEq(preview, 2_000e18);
        assertEq(usdc.balanceOf(alice) - before_, preview);
    }

    // ── access control ────────────────────────────────────────────────────────

    function test_onlyOwnerCanRegisterAsset() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.registerAsset(keccak256("sX"), address(0xdead));
    }

    function test_onlyOwnerCanFundVault() public {
        vm.prank(alice);
        vm.expectRevert();
        vault.fundVault(1e18);
    }

    function test_onlyVaultCanMintToken() public {
        vm.prank(alice);
        vm.expectRevert(bytes("only vault"));
        aapl.mint(alice, 1e18);
    }
}
