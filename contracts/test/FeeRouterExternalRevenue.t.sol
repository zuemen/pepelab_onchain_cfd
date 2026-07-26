// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FeeRouter.sol";
import "../src/InsuranceVault.sol";
import "../src/MockUSDC.sol";

/// @notice x402 revenue on-chain settlement: permissionless routeExternalRevenue
///         routes off-chain (x402 paid-signal) fees into the 70/20/10 split.
contract FeeRouterExternalRevenueTest is Test {
    InsuranceVault vault;
    FeeRouter      feeRouter;
    MockUSDC       usdc;

    address platform = makeAddr("platform");
    address trader   = makeAddr("trader");     // gets the 70% (whose signal was bought)
    address settler  = makeAddr("settler");    // x402 settlement key — NOT copyTracker/exchange

    event ExternalRevenueRouted(
        address indexed source, address indexed trader,
        uint256 fee, uint256 traderShare, uint256 platformShare, uint256 vaultShare
    );

    function setUp() public {
        usdc      = new MockUSDC();
        vault     = new InsuranceVault(address(usdc));
        feeRouter = new FeeRouter(address(usdc), platform, address(vault));
        vault.setFeeRouter(address(feeRouter));

        // settler holds USDC and approves the router — no privileged role
        usdc.mint(settler, 1_000_000e18);
        vm.prank(settler);
        usdc.approve(address(feeRouter), type(uint256).max);
    }

    function test_routeExternalRevenue_isPermissionless_andSplits() public {
        uint256 fee = 1_000e18;
        uint256 before = usdc.balanceOf(settler);

        vm.prank(settler); // not copyTracker/exchange — still allowed
        feeRouter.routeExternalRevenue(trader, fee);

        assertEq(feeRouter.traderEarnings(trader), 700e18); // 70%
        assertEq(feeRouter.platformEarnings(), 200e18);     // 20%
        assertEq(vault.totalAssets(), 100e18);              // 10%
        assertEq(usdc.balanceOf(settler), before - fee);    // pulled from caller
        assertEq(usdc.balanceOf(address(feeRouter)), 900e18); // 70+20 held; 10 went to vault
    }

    function test_routeExternalRevenue_emitsEvent() public {
        uint256 fee = 100e18;
        vm.expectEmit(true, true, false, true);
        emit ExternalRevenueRouted(settler, trader, fee, 70e18, 20e18, 10e18);
        vm.prank(settler);
        feeRouter.routeExternalRevenue(trader, fee);
    }

    function test_routeExternalRevenue_revertsOnZeroFee() public {
        vm.prank(settler);
        vm.expectRevert(FeeRouter.ZeroFee.selector);
        feeRouter.routeExternalRevenue(trader, 0);
    }

    function test_routeExternalRevenue_traderCanWithdraw70pct() public {
        vm.prank(settler);
        feeRouter.routeExternalRevenue(trader, 1_000e18);

        uint256 before = usdc.balanceOf(trader);
        vm.prank(trader);
        feeRouter.withdrawTraderEarnings();
        assertEq(usdc.balanceOf(trader), before + 700e18);
        assertEq(feeRouter.traderEarnings(trader), 0);
    }

    function test_routeExternalRevenue_accumulatesAcrossCalls() public {
        vm.startPrank(settler);
        feeRouter.routeExternalRevenue(trader, 100e18); // +70
        feeRouter.routeExternalRevenue(trader, 100e18); // +70
        vm.stopPrank();
        assertEq(feeRouter.traderEarnings(trader), 140e18);
        assertEq(feeRouter.platformEarnings(), 40e18);
    }

    function test_routeExternalRevenue_revertsWithoutApprovalOrFunds() public {
        address broke = makeAddr("broke");
        vm.prank(broke); // no USDC, no approval
        vm.expectRevert();
        feeRouter.routeExternalRevenue(trader, 1e18);
    }
}
