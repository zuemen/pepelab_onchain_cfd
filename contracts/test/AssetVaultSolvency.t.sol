// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/AssetVault.sol";
import "../src/SyntheticAsset.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @notice Documents the economic risk profile of AssetVault. These are not
///         bugs in the code as written — they are properties of the mint-burn
///         design that matter before anyone points it at real money.
contract AssetVaultSolvencyTest is Test {
    AssetVault     vault;
    MockUSDC       usdc;
    MockOracle     oracle;
    SyntheticAsset aapl;

    address owner = address(this);
    address alice = makeAddr("alice");

    bytes32 constant AID = keccak256("sAAPL");

    function setUp() public {
        usdc   = new MockUSDC();
        oracle = new MockOracle();
        vault  = new AssetVault(address(usdc), address(oracle));
        aapl   = new SyntheticAsset("Synthetic Apple", "sAAPL", AID, address(vault));
        vault.registerAsset(AID, address(aapl));
        oracle.addAsset(AID, 200e8);          // $200

        usdc.mint(alice, 100_000e18);
        usdc.mint(owner, 100_000e18);
        usdc.approve(address(vault), type(uint256).max);
        vault.fundVault(10_000e18);           // owner seeds 10k reserve
    }

    /// @dev The vault is the counterparty to every long. Price appreciation is
    ///      paid out of the shared owner-funded reserve, so a rising market
    ///      drains it — there is no fee, spread, or position cap to offset this.
    function test_priceRiseDrainsOwnerReserve() public {
        uint256 reserveBefore = usdc.balanceOf(address(vault));

        vm.startPrank(alice);
        usdc.approve(address(vault), 10_000e18);
        vault.mint(AID, 10_000e18);           // 50 sAAPL at $200
        vm.stopPrank();
        assertEq(aapl.balanceOf(alice), 50e18);

        oracle.updatePrice(AID, 400e8);        // market doubles

        vm.prank(alice);
        vault.redeem(AID, 50e18);              // owed 50 * $400 = 20,000

        // Alice paid 10k and took out 20k. The extra 10k came from the reserve.
        assertEq(usdc.balanceOf(alice), 100_000e18 + 10_000e18);
        assertEq(usdc.balanceOf(address(vault)), reserveBefore - 10_000e18);
        assertEq(usdc.balanceOf(address(vault)), 0);   // reserve fully drained
    }

    /// @dev With the reserve gone, the next redeemer cannot exit even though
    ///      their tokens are "worth" something. Last-out is stuck.
    function test_laterRedeemerCannotExitAfterDrain() public {
        address bob = makeAddr("bob");
        usdc.mint(bob, 100_000e18);

        vm.startPrank(alice);
        usdc.approve(address(vault), 10_000e18);
        vault.mint(AID, 10_000e18);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(vault), 10_000e18);
        vault.mint(AID, 10_000e18);
        vm.stopPrank();

        oracle.updatePrice(AID, 400e8);

        vm.prank(alice);
        vault.redeem(AID, 50e18);              // alice exits, taking 20k

        // bob holds 50 sAAPL worth 20k but the vault can no longer pay
        assertEq(aapl.balanceOf(bob), 50e18);
        vm.prank(bob);
        vm.expectRevert(bytes("vault dry"));
        vault.redeem(AID, 50e18);
    }

    /// @dev The vault accepts a price of any age. PerpetualExchange reverts with
    ///      StalePrice past maxPriceAge; AssetVault reads updatedAt and discards
    ///      it, so a dead keeper means trading against a frozen quote.
    function test_mintAcceptsArbitrarilyStalePrice() public {
        vm.warp(block.timestamp + 365 days);   // price is a year old

        vm.startPrank(alice);
        usdc.approve(address(vault), 2_000e18);
        vault.mint(AID, 2_000e18);             // succeeds regardless
        vm.stopPrank();

        assertEq(aapl.balanceOf(alice), 10e18);
    }
}
