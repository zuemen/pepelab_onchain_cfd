// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/AgentSessionManager.sol";
import "../src/CopyTracker.sol";
import "../src/StrategyRegistry.sol";
import "../src/InsuranceVault.sol";
import "../src/FeeRouter.sol";
import "../src/TraderStake.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @notice Regression suite for the 2026-08-06 audit: InsuranceVault (H-4),
///         CopyTracker (H-5), AgentSessionManager (M-8), FeeRouter and
///         TraderStake (Low). Every test fails on the pre-fix contracts.
contract AuditFixesPeripheryTest is Test {
    MockUSDC usdc;

    address alice = makeAddr("alice");
    address bob   = makeAddr("bob");

    function setUp() public {
        usdc = new MockUSDC();
        usdc.mint(alice, 1_000_000e18);
        usdc.mint(bob,   1_000_000e18);
        usdc.mint(address(this), 1_000_000e18);
    }

    // ── H-4: a drained vault must not dilute the next depositor ───────────────

    /// @dev PoC: alice deposits 1,000 → bailouts drain totalAssets to 0 → the
    ///      `|| totalAssets == 0` branch minted bob 1,000 shares 1:1 against a
    ///      share price of ZERO, so bob instantly owned half of his own money and
    ///      alice's worthless shares were resurrected at his expense.
    function test_H4_depositIntoDrainedVaultIsRefused() public {
        InsuranceVault vault = new InsuranceVault(address(usdc));
        address exchangeStub = makeAddr("exchangeStub");
        vault.setExchange(exchangeStub);

        vm.prank(alice); usdc.approve(address(vault), type(uint256).max);
        vm.prank(alice); vault.deposit(1_000e18);

        // Drain it the way a bailout does.
        vm.prank(exchangeStub);
        vault.bailout(1_000e18, makeAddr("bankruptTrader"));
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.totalSupply(), 1_000e18);   // alice's shares still exist

        vm.prank(bob); usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        vm.expectRevert(InsuranceVault.VaultInsolvent.selector);
        vault.deposit(1_000e18);

        // And alice's shares are still worth nothing, as they should be.
        assertEq(vault.previewWithdraw(1_000e18), 0);
    }

    /// @dev The vault must be recoverable, otherwise refusing deposits would
    ///      brick it permanently.
    function test_H4_recapitalizeRestoresDeposits() public {
        InsuranceVault vault = new InsuranceVault(address(usdc));
        address exchangeStub = makeAddr("exchangeStub");
        vault.setExchange(exchangeStub);

        vm.prank(alice); usdc.approve(address(vault), type(uint256).max);
        vm.prank(alice); vault.deposit(1_000e18);
        vm.prank(exchangeStub); vault.bailout(1_000e18, makeAddr("t"));

        usdc.approve(address(vault), type(uint256).max);
        vault.recapitalize(1_000e18);              // owner eats the loss, explicitly
        assertEq(vault.totalAssets(), 1_000e18);

        vm.prank(bob); usdc.approve(address(vault), type(uint256).max);
        vm.prank(bob);
        uint256 shares = vault.deposit(1_000e18);
        assertEq(shares, 1_000e18);                // priced at 1:1 again, fairly
    }

    // ── FeeRouter (Low): performance fee must be pulled, not just booked ──────

    /// @dev `receivePerformanceFee` used to be pure accounting: an authorized
    ///      caller could credit a trader's earnings against USDC already sitting
    ///      in the router — i.e. against other traders' unwithdrawn balances.
    function test_low_performanceFeeMustBeBackedByRealTransfer() public {
        InsuranceVault vault = new InsuranceVault(address(usdc));
        FeeRouter router = new FeeRouter(address(usdc), makeAddr("platform"), address(vault));
        vault.setFeeRouter(address(router));
        router.setExchange(alice);                 // alice plays "the exchange"

        // Router already holds someone else's money.
        usdc.mint(address(router), 10_000e18);

        vm.prank(alice);
        vm.expectRevert();                         // no approval → cannot conjure a credit
        router.receivePerformanceFee(bob, 1_000e18);

        vm.prank(alice); usdc.approve(address(router), type(uint256).max);
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice); router.receivePerformanceFee(bob, 1_000e18);

        assertEq(usdc.balanceOf(alice), aliceBefore - 1_000e18, "caller must actually pay");
        assertEq(router.traderEarnings(bob), 700e18);
    }

    // ── TraderStake (Low): slash during cooldown must not brick the unstake ───

    function test_low_executeUnstakeSurvivesSlashDuringCooldown() public {
        TraderStake stake = new TraderStake(address(usdc));
        address ct = makeAddr("copyTracker");
        stake.setCopyTracker(ct);

        vm.prank(alice); usdc.approve(address(stake), type(uint256).max);
        vm.prank(alice); stake.stake(1_000e18);

        vm.prank(alice); stake.requestUnstake(1_000e18);

        // Slashed while the cooldown runs: amount 500 ≤ 50% of stake.
        vm.prank(ct); stake.slash(alice, 500e18, bob);

        vm.warp(block.timestamp + stake.UNSTAKE_COOLDOWN() + 1);

        uint256 before_ = usdc.balanceOf(alice);
        vm.prank(alice);
        stake.executeUnstake();                    // used to revert on underflow
        assertEq(usdc.balanceOf(alice) - before_, 500e18, "pays out what is left");
        assertEq(stake.stakedAmount(alice), 0);
    }
}

/// @notice CopyTracker (H-5) and AgentSessionManager (M-8) need a live exchange.
contract AuditFixesAgentTest is Test {
    PerpetualExchange   exchange;
    AgentSessionManager manager;
    CopyTracker         ct;
    StrategyRegistry    registry;
    MockUSDC            usdc;
    MockOracle          oracle;

    address alice   = makeAddr("alice");   // session user / follower
    address trader  = makeAddr("trader");
    address agent   = makeAddr("agent");

    bytes32 constant BTC = keccak256("BTC");
    bytes32 constant ETH = keccak256("ETH"); // #97: StrategyRegistry now rejects a repeated asset
    bytes32 constant SOL = keccak256("SOL");
    uint256 constant BTC_PRICE = 100_000e8;
    uint256 constant ETH_PRICE =   4_000e8;
    uint256 constant SOL_PRICE =   1_000e8;

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        registry = new StrategyRegistry(address(0));
        ct       = new CopyTracker(address(usdc), address(exchange), address(registry), address(0), address(0));
        manager  = new AgentSessionManager(address(exchange));

        oracle.addAsset(BTC, BTC_PRICE);
        oracle.addAsset(ETH, ETH_PRICE);
        oracle.addAsset(SOL, SOL_PRICE);

        exchange.setCopyTracker(address(ct));
        exchange.setAgentAuthorized(address(manager), true);
        exchange.setExecutionFee(0);
        exchange.setTradingFeeBps(0);
        exchange.setBorrowFeePerHour(0);

        usdc.mint(alice, 1_000_000e18);
        usdc.mint(address(exchange), 10_000_000e18);
        vm.prank(alice); usdc.approve(address(exchange), type(uint256).max);
        vm.prank(alice); usdc.approve(address(ct), type(uint256).max);
    }

    /// @dev #97: StrategyRegistry now requires at least 3 DISTINCT assets and
    ///      rejects the same asset appearing twice AT ALL — including the
    ///      original long+short-on-the-same-asset pair this helper used to
    ///      publish (code review caught this: a long/short pair on one asset
    ///      is still 100% exposed to that one asset's price series, exactly
    ///      the concentration this rule exists to block). Legs 1 and 2 are
    ///      now genuinely different, unrelated assets whose price this file
    ///      never moves — low-risk, unaffected positions that none of this
    ///      file's assertions inspect beyond confirming they stay open. Only
    ///      index 0 (5x long on `asset`, the one that gets crashed) keeps its
    ///      original role; direction on legs 1/2 was never asserted on, so it
    ///      isn't preserved as meaningful.
    function _publish(bytes32 asset) internal {
        vm.prank(trader);
        registry.registerTrader("Trader");

        StrategyRegistry.Allocation[] memory a = new StrategyRegistry.Allocation[](3);
        a[0] = StrategyRegistry.Allocation({asset: asset, weight: 4_000, isLong: true, leverage: 5});
        a[1] = StrategyRegistry.Allocation({asset: ETH,   weight: 3_000, isLong: true, leverage: 1});
        a[2] = StrategyRegistry.Allocation({asset: SOL,   weight: 3_000, isLong: true, leverage: 1});
        vm.prank(trader);
        registry.publishStrategy(a);
    }

    // ── H-5: unfollow must survive an already-liquidated position ─────────────

    /// @dev PoC: one liquidated position reverted PositionAlreadyClosed inside
    ///      the unfollow loop, so `rec.active` stayed true forever — the follower
    ///      could never unfollow and, worse, the slash that the very same loss
    ///      should have triggered could never fire.
    function test_H5_unfollowSurvivesLiquidatedPosition() public {
        _publish(BTC);

        vm.prank(alice);
        ct.followTrader(trader, 10_000e18);

        CopyTracker.CopyRecord[] memory recs = ct.getCopyRecords(alice);
        assertEq(recs.length, 1);
        assertTrue(recs[0].active);

        // Crash the price so the 5× long leg becomes liquidatable, then liquidate
        // it out from under the copy record.
        oracle.updatePrice(BTC, 70_000e8);
        exchange.liquidatePosition(recs[0].positionIds[0]);
        assertFalse(exchange.getPosition(recs[0].positionIds[0]).isOpen);
        // The ETH leg's price never moved, so it must not have been swept up
        // by the BTC-only crash — asserted, not just claimed in _publish's
        // doc comment (code review flagged the comment-only version).
        assertTrue(exchange.getPosition(recs[0].positionIds[2]).isOpen, "ETH leg unaffected by the BTC crash");

        vm.prank(alice);
        ct.unfollowAndCloseAll(0);                 // used to revert forever

        recs = ct.getCopyRecords(alice);
        assertFalse(recs[0].active, "record must be releasable");
        assertFalse(exchange.getPosition(recs[0].positionIds[1]).isOpen, "other legs still close");
        assertFalse(exchange.getPosition(recs[0].positionIds[2]).isOpen, "ETH leg closes too on unfollow");
    }

    // ── M-8: a session may only close what it opened ──────────────────────────

    function test_M8_sessionCannotCloseUserPositionItDidNotOpen() public {
        vm.prank(alice); exchange.depositMargin(10_000e18);
        vm.prank(alice); uint256 own = exchange.openPosition(BTC, true, 1_000e18, 1);

        vm.prank(alice);
        uint256 sid = manager.createSession(agent, 1_000e18, 3_000e18, 5, block.timestamp + 1 days);

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AgentSessionManager.PositionNotFromSession.selector, sid, own)
        );
        manager.closePositionForSession(sid, own);
        assertTrue(exchange.getPosition(own).isOpen);
    }

    function test_M8_sessionCannotCloseAnotherSessionsPosition() public {
        vm.prank(alice); exchange.depositMargin(10_000e18);

        vm.prank(alice);
        uint256 s1 = manager.createSession(agent, 1_000e18, 3_000e18, 5, block.timestamp + 1 days);
        vm.prank(alice);
        uint256 s2 = manager.createSession(agent, 1_000e18, 3_000e18, 5, block.timestamp + 1 days);

        vm.prank(agent);
        uint256 pid = manager.openPositionForSession(s1, BTC, true, 1_000e18, 1, address(0));
        assertEq(manager.sessionOfPosition(pid), s1);

        vm.prank(agent);
        vm.expectRevert(
            abi.encodeWithSelector(AgentSessionManager.PositionNotFromSession.selector, s2, pid)
        );
        manager.closePositionForSession(s2, pid);

        vm.prank(agent);
        manager.closePositionForSession(s1, pid);  // its own session still can
        assertFalse(exchange.getPosition(pid).isOpen);
    }

    function test_M8_zeroLeverageSessionIsRejected() public {
        vm.prank(alice);
        vm.expectRevert(AgentSessionManager.ZeroLeverage.selector);
        manager.createSession(agent, 1_000e18, 3_000e18, 0, block.timestamp + 1 days);
    }

    // ── CopyTracker (Low): ETH remainder must not be stranded ─────────────────

    /// @dev `msg.value / allocations.length` leaves a remainder, and CopyTracker
    ///      has no owner and no withdrawal function, so that dust was locked in
    ///      the contract forever. It is now returned to the follower.
    function test_low_copyTrackerRefundsEthRemainder() public {
        exchange.setExecutionFee(1);   // forces a non-trivial per-position fee
        _publish(BTC);

        vm.deal(alice, 1 ether);
        uint256 balBefore = alice.balance;

        // 4 wei over three allocations (#97: _publish now opens 3 legs) →
        // 1 wei per position (3 spent), 1 wei remainder.
        vm.prank(alice);
        ct.followTrader{value: 4}(trader, 10_000e18);

        assertEq(address(ct).balance, 0, "no ETH may be stranded in the tracker");
        assertEq(balBefore - alice.balance, 3, "only the three execution fees are spent");
    }

    // ── CopyTracker (Low): slash basis must exclude protocol fees ─────────────

    /// @dev The loss baseline was the GROSS deposit, so the copy fee and the
    ///      exchange trading fees were scored as the trader's losses: a flat
    ///      market registered a loss on every single follow.
    function test_low_slashBasisExcludesProtocolFees() public {
        exchange.setTradingFeeBps(10);   // reintroduce the fee wedge
        _publish(BTC);

        vm.prank(alice);
        ct.followTrader(trader, 10_000e18);

        CopyTracker.CopyRecord[] memory recs = ct.getCopyRecords(alice);
        assertLt(recs[0].deployedAmount, recs[0].initialAmount, "fees are excluded");

        // Price never moves: closing everything returns exactly the deployed
        // margin less the close-side trading fee — no strategy loss at all.
        uint256 before_ = exchange.freeMargin(alice);
        vm.prank(alice);
        ct.unfollowAndCloseAll(0);
        uint256 returned = exchange.freeMargin(alice) - before_;

        // Measured against the deployed basis, a flat market is ~flat (only the
        // close-side fee); measured against the gross deposit it would have shown
        // a loss of the full fee wedge before the market did anything.
        assertGt(returned * 10_000 / recs[0].deployedAmount, 9_900, "flat market is flat");
        assertLt(returned, recs[0].initialAmount);
    }
}

/// @dev USDT-style token: transfer/transferFrom/approve return NOTHING. A bare
///      `IERC20(token).transfer(...)` reverts on ABI decode against this, which
///      is exactly why M-4 asked for SafeERC20 in the core contracts.
contract VoidReturnToken {
    string public name = "VoidUSD";
    uint8  public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external { allowance[msg.sender][s] = a; }
    function transfer(address to, uint256 a) external {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
    }
    function transferFrom(address f, address to, uint256 a) external {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
    }
}

contract AuditFixesSafeErc20Test is Test {
    /// @dev M-4: the exchange must work against a non-compliant stablecoin. On
    ///      the pre-fix contract `depositMargin` reverted decoding a bool that
    ///      the token never returned.
    function test_M4_coreWorksWithNonCompliantErc20() public {
        VoidReturnToken tok = new VoidReturnToken();
        MockOracle oracle   = new MockOracle();
        bytes32 BTC = keccak256("BTC");
        oracle.addAsset(BTC, 100_000e8);

        PerpetualExchange ex = new PerpetualExchange(address(tok), address(oracle), address(0));
        ex.setExecutionFee(0);
        ex.setTradingFeeBps(0);
        ex.setBorrowFeePerHour(0);

        address user = makeAddr("user");
        tok.mint(user, 10_000e18);
        tok.mint(address(ex), 1_000_000e18);

        vm.prank(user); tok.approve(address(ex), type(uint256).max);
        vm.prank(user); ex.depositMargin(10_000e18);
        vm.prank(user); uint256 pid = ex.openPosition(BTC, true, 1_000e18, 1);
        vm.prank(user); ex.closePosition(pid);
        vm.prank(user); ex.withdrawMargin(10_000e18);

        assertEq(tok.balanceOf(user), 10_000e18);
    }
}
