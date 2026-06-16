// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/InsuranceVault.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @notice Regression tests for the 2026-06 security hardening pass:
///         1. ReentrancyGuard + CEI ordering in PerpetualExchange
///         2. MockUSDC.setSwapRouter access control
///         3. Stale-oracle protection on state-changing paths
///         4. Automatic funding settlement on open/close/liquidate
///         5. Liquidator reward incentive
contract SecurityFixesTest is Test {
    PerpetualExchange exchange;
    InsuranceVault    vault;
    MockUSDC          usdc;
    MockOracle        oracle;

    address alice      = makeAddr("alice");
    address liquidator = makeAddr("liquidator");
    address attacker   = makeAddr("attacker");

    bytes32 constant BTC = keccak256("BTC");
    uint256 constant BTC_PRICE = 100_000e8;

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle));
        vault    = new InsuranceVault(address(usdc));

        vault.setExchange(address(exchange));
        exchange.setInsuranceVault(address(vault));

        oracle.addAsset(BTC, BTC_PRICE);

        usdc.mint(alice, 1_000_000e18);
        usdc.mint(address(exchange), 10_000_000e18); // payout reserve

        vm.prank(alice);
        usdc.approve(address(exchange), type(uint256).max);

        exchange.setExecutionFee(0);
    }

    // ── 2. MockUSDC access control ────────────────────────────────────────────

    function test_setSwapRouter_revertsForNonOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        usdc.setSwapRouter(attacker);
    }

    function test_setSwapRouter_ownerSucceedsOnce() public {
        usdc.setSwapRouter(address(0xBEEF));
        assertEq(usdc.swapRouter(), address(0xBEEF));
        vm.expectRevert(bytes("Already set"));
        usdc.setSwapRouter(address(0xCAFE));
    }

    // ── 3. Stale-oracle protection ────────────────────────────────────────────

    function test_openPosition_revertsOnStalePrice() public {
        vm.prank(alice);
        exchange.depositMargin(1_000e18);

        vm.warp(block.timestamp + exchange.maxPriceAge() + 1);

        vm.prank(alice);
        vm.expectRevert(); // StalePrice
        exchange.openPosition(BTC, true, 100e18, 1);
    }

    function test_closePosition_revertsOnStalePrice() public {
        vm.prank(alice);
        exchange.depositMargin(1_000e18);
        vm.prank(alice);
        uint256 pid = exchange.openPosition(BTC, true, 100e18, 1);

        vm.warp(block.timestamp + exchange.maxPriceAge() + 1);

        vm.prank(alice);
        vm.expectRevert(); // StalePrice
        exchange.closePosition(pid);
    }

    function test_closePosition_succeedsAfterOracleRefresh() public {
        vm.prank(alice);
        exchange.depositMargin(1_000e18);
        vm.prank(alice);
        uint256 pid = exchange.openPosition(BTC, true, 100e18, 1);

        vm.warp(block.timestamp + exchange.maxPriceAge() + 1);
        oracle.updatePrice(BTC, BTC_PRICE); // keeper refreshes

        vm.prank(alice);
        exchange.closePosition(pid); // should not revert
        assertFalse(exchange.getPosition(pid).isOpen);
    }

    function test_setMaxPriceAge_onlyOwner() public {
        vm.prank(attacker);
        vm.expectRevert();
        exchange.setMaxPriceAge(1 hours);

        exchange.setMaxPriceAge(1 hours);
        assertEq(exchange.maxPriceAge(), 1 hours);
    }

    // ── 4. Automatic funding settlement ───────────────────────────────────────

    /// Funding now accrues on close even if nobody ever calls settleFunding().
    function test_funding_autoSettledOnClose() public {
        uint256 INTERVAL = exchange.FUNDING_INTERVAL();

        vm.prank(alice);
        exchange.depositMargin(1_000e18);
        vm.prank(alice);
        uint256 pid = exchange.openPosition(BTC, true, 100e18, 5); // long-only → max funding

        // 3 intervals pass; NOBODY calls settleFunding
        vm.warp(block.timestamp + 3 * INTERVAL);
        oracle.updatePrice(BTC, BTC_PRICE); // keep price fresh & unchanged (pnl = 0)

        uint256 fmBefore = exchange.freeMargin(alice);
        vm.prank(alice);
        exchange.closePosition(pid);

        // notional 500e18, rate 75 bps/interval × 3 intervals
        // funding = 500e18 * 3*75e14 / 1e18 = 11.25e18
        // tradingFee = 0.5e18
        // borrowFee = borrowed(400e18) * 1bps/h * (3 * 8h) / 10000  (8h interval)
        uint256 borrowFee = (100e18 * (5 - 1)) * exchange.BORROW_FEE_BPS_PER_HOUR() * (3 * INTERVAL / 3600) / 10_000;
        uint256 expected = 100e18 - 0.5e18 - 11.25e18 - borrowFee;
        assertEq(exchange.freeMargin(alice) - fmBefore, expected);
    }

    /// Multi-interval accrual: one settleFunding call after N intervals charges N× rate.
    function test_settleFunding_accruesMultipleIntervals() public {
        uint256 INTERVAL = exchange.FUNDING_INTERVAL();

        vm.prank(alice);
        exchange.depositMargin(1_000e18);
        vm.prank(alice);
        exchange.openPosition(BTC, true, 100e18, 1);

        vm.warp(block.timestamp + 4 * INTERVAL);
        exchange.settleFunding(BTC);

        // 4 intervals × 75 bps
        assertEq(exchange.cumulativeFundingIndex(BTC), int256(4 * 75) * int256(1e14));
    }

    /// A position opened AFTER funding accrued must not pay for the past.
    function test_newPosition_notChargedForPastFunding() public {
        uint256 INTERVAL = exchange.FUNDING_INTERVAL();

        vm.prank(alice);
        exchange.depositMargin(2_000e18);
        vm.prank(alice);
        exchange.openPosition(BTC, true, 100e18, 1); // creates long-only OI

        vm.warp(block.timestamp + 5 * INTERVAL);
        oracle.updatePrice(BTC, BTC_PRICE);

        // Opening pokes funding first, locking the entry index AFTER accrual
        vm.prank(alice);
        uint256 pid2 = exchange.openPosition(BTC, true, 100e18, 1);

        assertEq(exchange.pendingFunding(pid2), 0);
    }

    // ── 5. Liquidator reward ──────────────────────────────────────────────────

    function test_liquidation_paysRewardToCaller() public {
        // 1× long, notional 1_000e18, maintenance margin 50e18
        vm.prank(alice);
        exchange.depositMargin(1_100e18); // margin + 0.1% trading fee
        vm.prank(alice);
        uint256 pid = exchange.openPosition(BTC, true, 1_000e18, 1);

        oracle.updatePrice(BTC, 5_000e8); // 95% drop → closeAmount ≈ 50e18 - fees

        uint256 vaultBefore = vault.totalAssets();
        uint256 liqBefore   = usdc.balanceOf(liquidator);

        vm.prank(liquidator);
        exchange.liquidatePosition(pid);

        uint256 reward = usdc.balanceOf(liquidator) - liqBefore;
        assertGt(reward, 0, "liquidator must be paid");
        assertGt(vault.totalAssets(), vaultBefore, "vault still receives remainder");

        // reward = 5% of remaining collateral; remainder = 95%
        uint256 toVault = vault.totalAssets() - vaultBefore;
        assertEq(reward * 95 / 5, toVault); // 5/95 split holds exactly
    }

    function test_liquidation_revertsOnStalePrice() public {
        vm.prank(alice);
        exchange.depositMargin(1_100e18); // margin + 0.1% trading fee
        vm.prank(alice);
        uint256 pid = exchange.openPosition(BTC, true, 1_000e18, 1);

        vm.warp(block.timestamp + exchange.maxPriceAge() + 1);

        vm.prank(liquidator);
        vm.expectRevert(); // StalePrice — never liquidate on stale data
        exchange.liquidatePosition(pid);
    }

    // ── 1. Reentrancy ─────────────────────────────────────────────────────────

    function test_withdrawMargin_reentrancyBlocked() public {
        ReentrantToken evil = new ReentrantToken();
        PerpetualExchange ex2 = new PerpetualExchange(address(evil), address(oracle));
        evil.setTarget(address(ex2));

        evil.mint(address(this), 100e18);
        evil.approve(address(ex2), type(uint256).max);
        ex2.depositMargin(100e18);

        evil.arm();
        // The malicious token re-enters withdrawMargin during transfer;
        // ReentrancyGuard must revert the whole call.
        vm.expectRevert();
        ex2.withdrawMargin(50e18);
    }
}

/// Minimal malicious ERC20 that re-enters the exchange on transfer.
contract ReentrantToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address target;
    bool armed;

    function setTarget(address t) external { target = t; }
    function arm() external { armed = true; }
    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address s, uint256 amt) external returns (bool) {
        allowance[msg.sender][s] = amt; return true;
    }
    function transferFrom(address f, address t, uint256 amt) external returns (bool) {
        balanceOf[f] -= amt; balanceOf[t] += amt; return true;
    }
    function transfer(address t, uint256 amt) external returns (bool) {
        if (armed) {
            armed = false;
            PerpetualExchange(payable(target)).withdrawMargin(1); // re-enter
        }
        balanceOf[msg.sender] -= amt; balanceOf[t] += amt; return true;
    }
}
