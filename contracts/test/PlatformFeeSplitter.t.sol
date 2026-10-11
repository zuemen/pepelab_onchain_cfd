// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FeeRouter.sol";
import "../src/InsuranceVault.sol";
import "../src/MockUSDC.sol";
import "../src/MockCarbonCredit.sol";
import "../src/CarbonRetirement.sol";
import "../src/PlatformFeeSplitter.sol";

/// @notice Issue #105: part of the platform share is routed to carbon retirement
///         by making `PlatformFeeSplitter` the FeeRouter's platform payee. The
///         router's 70 / 20 / 10 split is unchanged; only who receives the 20 %
///         changes.
contract PlatformFeeSplitterTest is Test {
    MockUSDC            usdc;
    InsuranceVault      vault;
    FeeRouter           router;
    MockCarbonCredit    credit;
    CarbonRetirement    retirement;
    PlatformFeeSplitter splitter;

    address treasury = makeAddr("treasury");   // the real platform treasury
    address seller   = makeAddr("seller");
    address trader   = makeAddr("trader");
    address caller   = makeAddr("caller");     // authorized copyTracker / exchange mock
    address stranger = makeAddr("stranger");

    uint256 constant CARBON_BPS = 2500;        // 25 % of the platform share = 5 % of every fee
    uint256 constant PRICE      = 10e18;

    event PlatformFeesSplit(uint256 total, uint256 toCarbon, uint256 toTreasury);
    event FeeRouterBound(address indexed feeRouter);
    event CarbonRetired(uint256 amount, uint256 tonnesCO2e, uint256 timestamp);

    function setUp() public {
        usdc       = new MockUSDC();
        vault      = new InsuranceVault(address(usdc));
        credit     = new MockCarbonCredit(address(this));
        retirement = new CarbonRetirement(address(usdc), address(credit), seller, PRICE);
        splitter   = new PlatformFeeSplitter(address(usdc), treasury, address(retirement), CARBON_BPS);

        // The router's platform payee is the splitter — the only wiring change.
        router = new FeeRouter(address(usdc), address(splitter), address(vault));
        splitter.bindFeeRouter(address(router));
        vault.setFeeRouter(address(router));
        router.setCopyTracker(caller);
        router.setExchange(caller);

        usdc.mint(caller, 1_000_000e18);
        vm.prank(caller);
        usdc.approve(address(router), type(uint256).max);

        credit.issue(seller, 1_000_000e18);
        vm.prank(seller);
        credit.approve(address(retirement), type(uint256).max);
    }

    // ── 70 / 20 / 10 is unchanged ────────────────────────────────────────────

    function test_router_split_unchanged_withSplitterAsPayee() public {
        vm.prank(caller);
        router.distributeCopyFee(trader, 1_000e18);

        assertEq(router.traderEarnings(trader), 700e18);   // 70 %
        assertEq(router.platformEarnings(), 200e18);       // 20 %
        assertEq(vault.totalAssets(), 100e18);             // 10 %
        assertEq(router.PLATFORM_SHARE_BPS(), 2000);
        assertEq(router.VAULT_SHARE_BPS(), 1000);
        assertEq(router.platformTreasury(), address(splitter));
    }

    // ── distribute ───────────────────────────────────────────────────────────

    function test_distribute_pullsPlatformShareAndSplits() public {
        vm.prank(caller);
        router.distributeCopyFee(trader, 1_000e18);         // platform share 200

        vm.expectEmit(false, false, false, true, address(splitter));
        emit PlatformFeesSplit(200e18, 50e18, 150e18);
        vm.prank(stranger);                                  // permissionless crank
        (uint256 toCarbon, uint256 toTreasury) = splitter.distribute();

        assertEq(toCarbon, 50e18);
        assertEq(toTreasury, 150e18);
        assertEq(router.platformEarnings(), 0);
        assertEq(usdc.balanceOf(address(retirement)), 50e18);
        assertEq(usdc.balanceOf(treasury), 150e18);
        assertEq(usdc.balanceOf(address(splitter)), 0);
        assertEq(splitter.totalToCarbon(), 50e18);
        assertEq(splitter.totalToTreasury(), 150e18);
        // The trader's 70 % and the vault's 10 % are not touched by the splitter.
        assertEq(router.traderEarnings(trader), 700e18);
        assertEq(vault.totalAssets(), 100e18);
    }

    function test_distribute_coversEveryRevenueSource() public {
        vm.startPrank(caller);
        router.distributeCopyFee(trader, 1_000e18);         // platform 200
        router.receivePerformanceFee(trader, 500e18);       // platform 100
        vm.stopPrank();
        usdc.mint(stranger, 250e18);
        vm.startPrank(stranger);
        usdc.approve(address(router), 250e18);
        router.routeExternalRevenue(trader, 250e18);        // platform 50 (x402 path)
        vm.stopPrank();

        assertEq(splitter.pending(), 350e18);
        splitter.distribute();
        assertEq(usdc.balanceOf(address(retirement)), 87.5e18);  // 25 % of 350
        assertEq(usdc.balanceOf(treasury), 262.5e18);
        assertEq(splitter.pending(), 0);
    }

    function test_distribute_alsoSplitsDirectTransfers() public {
        usdc.mint(address(splitter), 40e18);                 // e.g. someone pays the payee directly
        splitter.distribute();
        assertEq(usdc.balanceOf(address(retirement)), 10e18);
        assertEq(usdc.balanceOf(treasury), 30e18);
    }

    function test_distribute_revertsWhenNothingToSplit() public {
        vm.expectRevert(PlatformFeeSplitter.NothingToDistribute.selector);
        splitter.distribute();
    }

    function test_distribute_worksBeforeBinding() public {
        PlatformFeeSplitter s = new PlatformFeeSplitter(address(usdc), treasury, address(retirement), CARBON_BPS);
        assertEq(s.pending(), 0);
        usdc.mint(address(s), 100e18);
        assertEq(s.pending(), 100e18);
        s.distribute();
        assertEq(usdc.balanceOf(treasury), 75e18);
    }

    // ── Non-discretionary: no path around the carbon slice ───────────────────

    function test_treasuryCannotWithdrawPlatformShareDirectly() public {
        vm.prank(caller);
        router.distributeCopyFee(trader, 1_000e18);
        vm.prank(treasury);
        vm.expectRevert(FeeRouter.Unauthorized.selector);
        router.withdrawPlatformFees();
    }

    function test_splitterHasNoOwnerOrSetters() public view {
        // Everything that decides where money goes is immutable.
        assertEq(splitter.treasury(), treasury);
        assertEq(splitter.carbonRetirement(), address(retirement));
        assertEq(splitter.carbonShareBps(), CARBON_BPS);
        assertEq(address(splitter.usdc()), address(usdc));
    }

    // ── bindFeeRouter ────────────────────────────────────────────────────────

    function test_bind_onlyDeployer() public {
        PlatformFeeSplitter s = new PlatformFeeSplitter(address(usdc), treasury, address(retirement), CARBON_BPS);
        FeeRouter r = new FeeRouter(address(usdc), address(s), address(vault));
        vm.prank(stranger);
        vm.expectRevert(PlatformFeeSplitter.Unauthorized.selector);
        s.bindFeeRouter(address(r));
    }

    function test_bind_onlyOnce() public {
        FeeRouter r2 = new FeeRouter(address(usdc), address(splitter), address(vault));
        vm.expectRevert(PlatformFeeSplitter.AlreadyBound.selector);
        splitter.bindFeeRouter(address(r2));
    }

    function test_bind_emits() public {
        PlatformFeeSplitter s = new PlatformFeeSplitter(address(usdc), treasury, address(retirement), CARBON_BPS);
        FeeRouter r = new FeeRouter(address(usdc), address(s), address(vault));
        vm.expectEmit(true, false, false, false, address(s));
        emit FeeRouterBound(address(r));
        s.bindFeeRouter(address(r));
        assertEq(address(s.feeRouter()), address(r));
    }

    function test_bind_rejectsRouterThatPaysSomeoneElse() public {
        PlatformFeeSplitter s = new PlatformFeeSplitter(address(usdc), treasury, address(retirement), CARBON_BPS);
        FeeRouter r = new FeeRouter(address(usdc), treasury, address(vault));
        vm.expectRevert(abi.encodeWithSelector(PlatformFeeSplitter.NotPlatformPayee.selector, address(r)));
        s.bindFeeRouter(address(r));
    }

    function test_bind_rejectsRouterInAnotherToken() public {
        MockUSDC other = new MockUSDC();
        PlatformFeeSplitter s = new PlatformFeeSplitter(address(usdc), treasury, address(retirement), CARBON_BPS);
        FeeRouter r = new FeeRouter(address(other), address(s), address(vault));
        vm.expectRevert(abi.encodeWithSelector(PlatformFeeSplitter.TokenMismatch.selector, address(other)));
        s.bindFeeRouter(address(r));
    }

    function test_bind_rejectsZero() public {
        PlatformFeeSplitter s = new PlatformFeeSplitter(address(usdc), treasury, address(retirement), CARBON_BPS);
        vm.expectRevert(PlatformFeeSplitter.ZeroAddress.selector);
        s.bindFeeRouter(address(0));
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    function test_constructor_rejectsBadShare() public {
        vm.expectRevert(abi.encodeWithSelector(PlatformFeeSplitter.InvalidShare.selector, 0));
        new PlatformFeeSplitter(address(usdc), treasury, address(retirement), 0);
        vm.expectRevert(abi.encodeWithSelector(PlatformFeeSplitter.InvalidShare.selector, 10_001));
        new PlatformFeeSplitter(address(usdc), treasury, address(retirement), 10_001);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(PlatformFeeSplitter.ZeroAddress.selector);
        new PlatformFeeSplitter(address(0), treasury, address(retirement), CARBON_BPS);
        vm.expectRevert(PlatformFeeSplitter.ZeroAddress.selector);
        new PlatformFeeSplitter(address(usdc), address(0), address(retirement), CARBON_BPS);
        vm.expectRevert(PlatformFeeSplitter.ZeroAddress.selector);
        new PlatformFeeSplitter(address(usdc), treasury, address(0), CARBON_BPS);
    }

    function test_constructor_rejectsRetirementInAnotherToken() public {
        MockUSDC other = new MockUSDC();
        CarbonRetirement r = new CarbonRetirement(address(other), address(credit), seller, PRICE);
        vm.expectRevert(abi.encodeWithSelector(PlatformFeeSplitter.TokenMismatch.selector, address(other)));
        new PlatformFeeSplitter(address(usdc), treasury, address(r), CARBON_BPS);
    }

    function test_constructor_fullShareAllowed() public {
        PlatformFeeSplitter s = new PlatformFeeSplitter(address(usdc), treasury, address(retirement), 10_000);
        usdc.mint(address(s), 99);
        (uint256 c, uint256 t) = s.distribute();
        assertEq(c, 99);
        assertEq(t, 0);
    }

    // ── End to end: fee → split → retire → burned ────────────────────────────

    function test_endToEnd_feeToBurnedCredit() public {
        vm.prank(caller);
        router.distributeCopyFee(trader, 4_000e18);          // platform 800 → carbon 200
        splitter.distribute();

        uint256 supplyBefore = credit.totalSupply();
        uint256 budget = retirement.budget();
        assertEq(budget, 200e18);
        vm.expectEmit(false, false, false, true, address(retirement));
        emit CarbonRetired(200e18, 20e18, block.timestamp);
        retirement.retire(budget);

        assertEq(credit.totalSupply(), supplyBefore - 20e18);
        assertEq(retirement.totalRetiredTonnes(), 20e18);
        assertEq(retirement.budget(), 0);
    }

    // ── Fuzz ─────────────────────────────────────────────────────────────────

    /// @dev For any fee and share: the router still splits 70/20/10, and the
    ///      splitter's two outputs sum exactly to the platform share.
    function testFuzz_split_conservesPlatformShare(uint256 fee, uint256 bps) public {
        fee = bound(fee, 1, 1_000_000e18);
        bps = bound(bps, 1, 10_000);
        PlatformFeeSplitter s = new PlatformFeeSplitter(address(usdc), treasury, address(retirement), bps);
        InsuranceVault v = new InsuranceVault(address(usdc));
        FeeRouter r = new FeeRouter(address(usdc), address(s), address(v));
        s.bindFeeRouter(address(r));
        v.setFeeRouter(address(r));
        r.setCopyTracker(caller);
        vm.prank(caller);
        usdc.approve(address(r), type(uint256).max);

        vm.prank(caller);
        r.distributeCopyFee(trader, fee);
        uint256 platformShare = fee * 2000 / 10_000;
        uint256 vaultShare    = fee * 1000 / 10_000;
        assertEq(r.platformEarnings(), platformShare);
        assertEq(r.traderEarnings(trader), fee - platformShare - vaultShare);

        if (platformShare == 0) {
            vm.expectRevert(PlatformFeeSplitter.NothingToDistribute.selector);
            s.distribute();
            return;
        }
        uint256 retirementBefore = usdc.balanceOf(address(retirement));
        uint256 treasuryBefore   = usdc.balanceOf(treasury);
        (uint256 toCarbon, uint256 toTreasury) = s.distribute();

        assertEq(toCarbon + toTreasury, platformShare);
        assertEq(toCarbon, platformShare * bps / 10_000);
        assertEq(usdc.balanceOf(address(retirement)) - retirementBefore, toCarbon);
        assertEq(usdc.balanceOf(treasury) - treasuryBefore, toTreasury);
        assertEq(usdc.balanceOf(address(s)), 0);
    }
}
