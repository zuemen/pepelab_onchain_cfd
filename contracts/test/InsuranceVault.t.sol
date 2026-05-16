// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/InsuranceVault.sol";
import "../src/MockUSDC.sol";

contract InsuranceVaultTest is Test {
    InsuranceVault vault;
    MockUSDC       usdc;

    address owner   = address(this);
    address alice   = makeAddr("alice");
    address bob     = makeAddr("bob");
    address feeRtr  = makeAddr("feeRouter");
    address exch    = makeAddr("exchange");
    address stranger = makeAddr("stranger");

    function setUp() public {
        usdc  = new MockUSDC();
        vault = new InsuranceVault(address(usdc));

        vault.setFeeRouter(feeRtr);
        vault.setExchange(exch);

        usdc.mint(alice, 100_000e18);
        usdc.mint(bob,   100_000e18);
        usdc.mint(feeRtr, 100_000e18);
        usdc.mint(exch,   100_000e18);

        vm.prank(alice);   usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);     usdc.approve(address(vault), type(uint256).max);
        vm.prank(feeRtr);  usdc.approve(address(vault), type(uint256).max);
        vm.prank(exch);    usdc.approve(address(vault), type(uint256).max);
    }

    // ── deposit ───────────────────────────────────────────────────────────────

    function test_deposit_mintsShares1to1_initially() public {
        vm.prank(alice);
        uint256 shares = vault.deposit(1_000e18);

        assertEq(shares, 1_000e18);
        assertEq(vault.balanceOf(alice), 1_000e18);
        assertEq(vault.totalAssets(), 1_000e18);
        assertEq(vault.totalSupply(), 1_000e18);
    }

    function test_deposit_sharePriceRises_afterProtocolDeposit() public {
        // Alice deposits 1000 → 1000 shares (1:1)
        vm.prank(alice);
        vault.deposit(1_000e18);

        // Protocol injects 500 more → totalAssets = 1500, supply = 1000
        vm.prank(feeRtr);
        vault.depositFromProtocol(500e18);

        // Bob deposits 1500 → should get 1500 * 1000 / 1500 = 1000 shares
        vm.prank(bob);
        uint256 bobShares = vault.deposit(1_500e18);

        assertEq(bobShares, 1_000e18);
        assertEq(vault.totalAssets(), 1_000e18 + 500e18 + 1_500e18);
        assertEq(vault.totalSupply(), 2_000e18);
    }

    // ── withdraw ──────────────────────────────────────────────────────────────

    function test_withdraw_returnsProportionalUsdc() public {
        vm.prank(alice);
        vault.deposit(1_000e18);

        // Protocol adds 1000 more → share price = 2:1
        vm.prank(feeRtr);
        vault.depositFromProtocol(1_000e18);

        // Alice withdraws all 1000 shares → gets 2000 USDC
        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 usdcOut = vault.withdraw(1_000e18);

        assertEq(usdcOut, 2_000e18);
        assertEq(usdc.balanceOf(alice), balBefore + 2_000e18);
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.totalSupply(), 0);
    }

    // ── getSharePrice ─────────────────────────────────────────────────────────

    function test_getSharePrice_correct() public {
        assertEq(vault.getSharePrice(), 1e18);  // no supply → 1:1

        vm.prank(alice);
        vault.deposit(1_000e18);
        assertEq(vault.getSharePrice(), 1e18);  // 1000 assets / 1000 supply = 1:1

        vm.prank(feeRtr);
        vault.depositFromProtocol(500e18);       // totalAssets = 1500
        assertEq(vault.getSharePrice(), 1.5e18); // 1500e18 * 1e18 / 1000e18
    }

    // ── depositFromProtocol ───────────────────────────────────────────────────

    function test_depositFromProtocol_updatesTotalAssets() public {
        uint256 before = vault.totalAssets();
        vm.prank(feeRtr);
        vault.depositFromProtocol(300e18);

        assertEq(vault.totalAssets(), before + 300e18);
        assertEq(usdc.balanceOf(address(vault)), 300e18);
    }

    function test_depositFromProtocol_revertsIfNotAuthorized() public {
        vm.prank(stranger);
        vm.expectRevert(InsuranceVault.NotAuthorized.selector);
        vault.depositFromProtocol(100e18);
    }

    // ── bailout ───────────────────────────────────────────────────────────────

    function test_bailout_sendsUsdcToTrader() public {
        vm.prank(feeRtr);
        vault.depositFromProtocol(1_000e18);  // seed vault

        address traderAddr = makeAddr("trader");
        uint256 balBefore = usdc.balanceOf(traderAddr);

        vm.prank(exch);
        vault.bailout(200e18, traderAddr);

        assertEq(usdc.balanceOf(traderAddr), balBefore + 200e18);
        assertEq(vault.totalAssets(), 800e18);
    }

    function test_bailout_revertsIfInsufficientVault() public {
        // vault is empty
        address traderAddr = makeAddr("trader");

        vm.prank(exch);
        vm.expectRevert(InsuranceVault.InsufficientVault.selector);
        vault.bailout(100e18, traderAddr);
    }
}
