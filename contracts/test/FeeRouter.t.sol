// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FeeRouter.sol";
import "../src/InsuranceVault.sol";
import "../src/MockUSDC.sol";

contract FeeRouterTest is Test {
    InsuranceVault vault;
    FeeRouter      feeRouter;
    MockUSDC       usdc;

    address owner    = address(this);
    address platform = makeAddr("platform");
    address trader   = makeAddr("trader");
    address caller   = makeAddr("caller");  // authorized copyTracker/exchange mock
    address stranger = makeAddr("stranger");

    function setUp() public {
        usdc      = new MockUSDC();
        vault     = new InsuranceVault(address(usdc));
        feeRouter = new FeeRouter(address(usdc), platform, address(vault));

        // Wire: authorize vault to accept deposits from feeRouter
        vault.setFeeRouter(address(feeRouter));

        // Authorize caller as copyTracker
        feeRouter.setCopyTracker(caller);

        // Give caller some USDC so it can pay fees
        usdc.mint(caller, 1_000_000e18);
        vm.prank(caller);
        usdc.approve(address(feeRouter), type(uint256).max);

        // Seed feeRouter with USDC for performance-fee tests (simulate transfer-first pattern)
        usdc.mint(address(feeRouter), 1_000_000e18);
    }

    // ── distributeCopyFee ────────────────────────────────────────────────────

    function test_distributeCopyFee_splitsCorrectly() public {
        uint256 fee = 1_000e18;

        uint256 callerBefore = usdc.balanceOf(caller);

        vm.prank(caller);
        feeRouter.distributeCopyFee(trader, fee);

        // Trader: 70 %
        assertEq(feeRouter.traderEarnings(trader), 700e18);
        // Platform: 20 %
        assertEq(feeRouter.platformEarnings(), 200e18);
        // Insurance vault: 10 % — via depositFromProtocol
        assertEq(vault.totalAssets(), 100e18);
        // Caller paid the fee
        assertEq(usdc.balanceOf(caller), callerBefore - fee);
    }

    function test_distributeCopyFee_accumulatesAcrossCalls() public {
        vm.startPrank(caller);
        feeRouter.distributeCopyFee(trader, 1_000e18);
        feeRouter.distributeCopyFee(trader, 2_000e18);
        vm.stopPrank();

        assertEq(feeRouter.traderEarnings(trader), 2_100e18);  // 700 + 1400
        assertEq(feeRouter.platformEarnings(), 600e18);         // 200 + 400
    }

    function test_distributeCopyFee_revertsForUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(FeeRouter.Unauthorized.selector);
        feeRouter.distributeCopyFee(trader, 100e18);
    }

    // ── receivePerformanceFee ─────────────────────────────────────────────────

    function test_receivePerformanceFee_splitsCorrectly() public {
        uint256 fee = 500e18;

        // authorize caller as exchange too
        feeRouter.setExchange(caller);

        uint256 vaultBefore = vault.totalAssets();

        vm.prank(caller);
        feeRouter.receivePerformanceFee(trader, fee);

        assertEq(feeRouter.traderEarnings(trader), 350e18);           // 70 %
        assertEq(feeRouter.platformEarnings(), 100e18);                // 20 %
        assertEq(vault.totalAssets(), vaultBefore + 50e18);           // 10 %
    }

    function test_receivePerformanceFee_revertsForUnauthorized() public {
        vm.prank(stranger);
        vm.expectRevert(FeeRouter.Unauthorized.selector);
        feeRouter.receivePerformanceFee(trader, 100e18);
    }

    // ── withdrawTraderEarnings ────────────────────────────────────────────────

    function test_withdrawTraderEarnings_transfersAndClears() public {
        vm.prank(caller);
        feeRouter.distributeCopyFee(trader, 1_000e18);

        uint256 balBefore = usdc.balanceOf(trader);
        vm.prank(trader);
        feeRouter.withdrawTraderEarnings();

        assertEq(usdc.balanceOf(trader), balBefore + 700e18);
        assertEq(feeRouter.traderEarnings(trader), 0);
    }

    function test_withdrawTraderEarnings_revertsOnZero() public {
        vm.prank(trader);
        vm.expectRevert(FeeRouter.NothingToWithdraw.selector);
        feeRouter.withdrawTraderEarnings();
    }

    // ── withdrawPlatformFees ──────────────────────────────────────────────────

    function test_withdrawPlatformFees_transfersAndClears() public {
        vm.prank(caller);
        feeRouter.distributeCopyFee(trader, 1_000e18);  // platform gets 200e18

        uint256 balBefore = usdc.balanceOf(platform);
        vm.prank(platform);
        feeRouter.withdrawPlatformFees();

        assertEq(usdc.balanceOf(platform), balBefore + 200e18);
        assertEq(feeRouter.platformEarnings(), 0);
    }

    function test_withdrawPlatformFees_revertsForNonTreasury() public {
        vm.prank(caller);
        feeRouter.distributeCopyFee(trader, 1_000e18);

        vm.prank(stranger);
        vm.expectRevert(FeeRouter.Unauthorized.selector);
        feeRouter.withdrawPlatformFees();
    }

    function test_withdrawPlatformFees_revertsOnZero() public {
        vm.prank(platform);
        vm.expectRevert(FeeRouter.NothingToWithdraw.selector);
        feeRouter.withdrawPlatformFees();
    }

    // ── Admin setters ─────────────────────────────────────────────────────────

    function test_setCopyTracker_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        feeRouter.setCopyTracker(stranger);
    }

    function test_setExchange_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        feeRouter.setExchange(stranger);
    }
}
