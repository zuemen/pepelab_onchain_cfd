// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/InsuranceVault.sol";

/// @notice N1 (ADR G5): trading-fee → InsuranceVault routing. LP deposits earn a
///         slice of every trade's fee, lifting the pIV share price — reusing the
///         existing ERC20-share vault, no parallel system.
contract MarketMakerVaultTest is Test {
    PerpetualExchange exchange;
    MockUSDC          usdc;
    MockOracle        oracle;
    InsuranceVault    vault;

    address lp     = makeAddr("lp");
    address trader = makeAddr("trader");

    bytes32 constant BTC = keccak256("BTC");
    uint256 constant BTC_PRICE = 100_000e8;

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle));
        vault    = new InsuranceVault(address(usdc));

        oracle.addAsset(BTC, BTC_PRICE);

        // Wire vault ↔ exchange so depositFromProtocol authorizes the exchange.
        vault.setExchange(address(exchange));
        exchange.setInsuranceVault(address(vault));

        exchange.setExecutionFee(0);
        exchange.setBorrowFeePerHour(0);
        exchange.setTradingFeeBps(10); // 0.1%

        usdc.mint(lp,     1_000_000e18);
        usdc.mint(trader, 1_000_000e18);
        usdc.mint(address(exchange), 1_000_000e18); // reserves
        vm.prank(lp);     usdc.approve(address(vault),    type(uint256).max);
        vm.prank(trader); usdc.approve(address(exchange), type(uint256).max);
        vm.prank(trader); exchange.depositMargin(500_000e18);
    }

    function _lpDeposit(uint256 amt) internal returns (uint256 shares) {
        vm.prank(lp);
        return vault.deposit(amt);
    }

    // ── default off: no routing, share price flat ───────────────────────────────

    function test_defaultShareZero_noRouting() public {
        assertEq(exchange.vaultFeeShareBps(), 0);
        _lpDeposit(1_000e18);
        uint256 priceBefore = vault.getSharePrice();

        vm.prank(trader);
        uint256 pid = exchange.openPosition(BTC, true, 1_000e18, 2);
        vm.prank(trader); exchange.closePosition(pid);

        assertEq(vault.getSharePrice(), priceBefore); // unchanged
        assertEq(exchange.cumulativeVaultFees(), 0);
    }

    // ── enabled: fee lifts share price; LP withdraws principal + yield ───────────

    function test_feeRoutedToVault_liftsSharePrice() public {
        exchange.setVaultFeeShareBps(5_000); // 50% of trading fee → vault
        uint256 shares = _lpDeposit(1_000e18);
        assertEq(vault.getSharePrice(), 1e18); // 1:1 first deposit

        // notional = 1000 * 2 = 2000; fee = 2000 * 0.1% = 2; 50% → 1 to vault.
        vm.prank(trader);
        uint256 pid = exchange.openPosition(BTC, true, 1_000e18, 2);
        assertEq(exchange.cumulativeVaultFees(), 1e18);          // open fee cut
        assertEq(vault.totalAssets(), 1_001e18);

        vm.prank(trader); exchange.closePosition(pid);
        assertEq(exchange.cumulativeVaultFees(), 2e18);          // + close fee cut
        assertEq(vault.totalAssets(), 1_002e18);
        assertGt(vault.getSharePrice(), 1e18);                   // LP yield

        // LP withdraws everything → principal + routed yield.
        vm.prank(lp);
        uint256 out = vault.withdraw(shares);
        assertEq(out, 1_002e18);
    }

    // ── bailout regression: routing does not break the existing vault floor ─────

    function test_bailoutStillWorks_withRoutingEnabled() public {
        exchange.setVaultFeeShareBps(5_000);
        _lpDeposit(10_000e18); // fund the vault so bailout can pay

        // Underwater long: price crashes, loss exceeds margin → bailout floor.
        vm.prank(trader);
        uint256 pid = exchange.openPosition(BTC, true, 1_000e18, 5);
        oracle.updatePrice(BTC, 70_000e8); // -30% → wiped

        uint256 ownerBefore = exchange.freeMargin(trader);
        vm.prank(trader);
        exchange.closePosition(pid);
        // closeAmount floored to 0, but bailout pays BAILOUT_FLOOR_BPS of margin.
        // freeMargin should not have grown by the (negative) close; bailout goes
        // to the trader's USDC via vault — assert vault paid out (totalAssets dropped
        // below the deposited 10_000 + routed fees).
        assertLt(vault.totalAssets(), 10_000e18 + exchange.cumulativeVaultFees());
        // sanity: no revert, position closed
        assertFalse(exchange.getPosition(pid).isOpen);
        ownerBefore; // silence unused
    }
}
