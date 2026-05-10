// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/CopyTracker.sol";
import "../src/PerpetualExchange.sol";
import "../src/StrategyRegistry.sol";
import "../src/FeeRouter.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @dev Tests that verify the 0.3 % copy fee is correctly deducted and forwarded to FeeRouter.
contract CopyTrackerFeeTest is Test {
    MockUSDC          usdc;
    MockOracle        oracle;
    StrategyRegistry  registry;
    PerpetualExchange exchange;
    FeeRouter         feeRouter;
    CopyTracker       ct;

    address platform = makeAddr("platform");
    address slash    = makeAddr("slash");
    address alice    = makeAddr("alice");   // trader
    address bob      = makeAddr("bob");     // follower

    bytes32 constant BTC = keccak256("BTC");
    uint256 constant BTC_PRICE = 100_000e8;

    function setUp() public {
        usdc      = new MockUSDC();
        oracle    = new MockOracle();
        registry  = new StrategyRegistry(address(0));
        feeRouter = new FeeRouter(address(usdc), platform, slash);
        exchange  = new PerpetualExchange(address(usdc), address(oracle));
        ct        = new CopyTracker(
            address(usdc),
            address(exchange),
            address(registry),
            address(feeRouter),
            address(0)
        );

        // Wire
        exchange.setCopyTracker(address(ct));
        feeRouter.setCopyTracker(address(ct));

        oracle.addAsset(BTC, BTC_PRICE);

        // Register trader and publish single-asset strategy (100 % BTC long, 1×)
        vm.prank(alice);
        registry.registerTrader("Alice");

        StrategyRegistry.Allocation[] memory allocs = new StrategyRegistry.Allocation[](1);
        allocs[0] = StrategyRegistry.Allocation(BTC, 10_000, true, 1);
        vm.prank(alice);
        registry.publishStrategy(allocs);

        // Fund follower
        usdc.mint(bob, 1_000_000e18);
        vm.prank(bob);
        usdc.approve(address(ct), type(uint256).max);

        // Reserve USDC in exchange so withdrawals can be processed
        usdc.mint(address(exchange), 1_000_000e18);
    }

    // ── Fee amounts ──────────────────────────────────────────────────────────

    function test_fee_deductedFromTotalMargin() public {
        uint256 total = 10_000e18;
        uint256 fee   = total * ct.COPY_FEE_BPS() / 10_000;   // 30e18
        uint256 net   = total - fee;                           // 9_970e18

        vm.prank(bob);
        ct.followTrader(alice, total);

        // freeMargin credited = netMargin (all goes into one 100 % BTC position → 0 free)
        // 100 % weight: portion = net * 10000 / 10000 = net, all used for the position
        assertEq(exchange.freeMargin(bob), 0);

        // Position margin = net
        CopyTracker.CopyRecord[] memory recs = ct.getCopyRecords(bob);
        PerpetualExchange.Position memory pos = exchange.getPosition(recs[0].positionIds[0]);
        assertEq(pos.margin, net);
    }

    function test_fee_forwardedToFeeRouter() public {
        uint256 total = 10_000e18;
        uint256 fee   = total * ct.COPY_FEE_BPS() / 10_000;  // 30e18

        vm.prank(bob);
        ct.followTrader(alice, total);

        // Trader earns 70 % of fee = 21e18
        assertEq(feeRouter.traderEarnings(alice), fee * 7_000 / 10_000);
        // Platform earns 20 % = 6e18
        assertEq(feeRouter.platformEarnings(), fee * 2_000 / 10_000);
        // Slash pool received 10 % = 3e18
        assertEq(usdc.balanceOf(slash), fee * 1_000 / 10_000);
    }

    function test_fee_deductedFromFollowerBalance() public {
        uint256 total     = 10_000e18;
        uint256 balBefore = usdc.balanceOf(bob);

        vm.prank(bob);
        ct.followTrader(alice, total);

        assertEq(usdc.balanceOf(bob), balBefore - total);
    }

    function test_fee_traderCanWithdrawEarnings() public {
        vm.prank(bob);
        ct.followTrader(alice, 10_000e18);

        uint256 earned = feeRouter.traderEarnings(alice);
        uint256 balBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        feeRouter.withdrawTraderEarnings();

        assertEq(usdc.balanceOf(alice), balBefore + earned);
        assertEq(feeRouter.traderEarnings(alice), 0);
    }

    function test_fee_initialAmountRecordedAsTotalMargin() public {
        uint256 total = 10_000e18;

        vm.prank(bob);
        ct.followTrader(alice, total);

        // CopyRecord.initialAmount reflects what follower committed, not netMargin
        CopyTracker.CopyRecord[] memory recs = ct.getCopyRecords(bob);
        assertEq(recs[0].initialAmount, total);
    }

    function test_noFee_whenFeeRouterIsZero() public {
        // Deploy ct2 without feeRouter
        CopyTracker ct2 = new CopyTracker(
            address(usdc), address(exchange), address(registry), address(0), address(0)
        );
        exchange.setCopyTracker(address(ct2));

        usdc.mint(bob, 10_000e18);
        vm.prank(bob);
        usdc.approve(address(ct2), type(uint256).max);

        vm.prank(bob);
        ct2.followTrader(alice, 10_000e18);

        // Full 10_000e18 used as netMargin (no fee deducted)
        CopyTracker.CopyRecord[] memory recs = ct2.getCopyRecords(bob);
        PerpetualExchange.Position memory pos = exchange.getPosition(recs[0].positionIds[0]);
        assertEq(pos.margin, 10_000e18);
    }
}
