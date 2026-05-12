// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MockOracle.sol";

contract MockOracleTest is Test {
    MockOracle oracle;
    address owner = address(this);
    address stranger = makeAddr("stranger");

    bytes32 constant BTC  = keccak256("BTC");
    bytes32 constant ETH  = keccak256("ETH");
    uint256 constant BTC_INIT = 60_000e8; // $60,000 with 8 decimals

    function setUp() public {
        oracle = new MockOracle();
    }

    // ── addAsset ────────────────────────────────────────────────────────────

    function test_addAsset_storesPrice() public {
        oracle.addAsset(BTC, BTC_INIT);
        (uint256 price,) = oracle.getPrice(BTC);
        assertEq(price, BTC_INIT);
    }

    function test_addAsset_revertsForDuplicate() public {
        oracle.addAsset(BTC, BTC_INIT);
        vm.expectRevert(abi.encodeWithSelector(MockOracle.AssetAlreadyExists.selector, BTC));
        oracle.addAsset(BTC, BTC_INIT);
    }

    function test_addAsset_revertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert();
        oracle.addAsset(BTC, BTC_INIT);
    }

    // ── updatePrice ─────────────────────────────────────────────────────────

    function test_updatePrice_success() public {
        oracle.addAsset(BTC, BTC_INIT);
        // +200% — should succeed now that limits are removed
        uint256 newPrice = BTC_INIT * 300 / 100;
        oracle.updatePrice(BTC, newPrice);
        (uint256 price,) = oracle.getPrice(BTC);
        assertEq(price, newPrice);
    }


    function test_updatePrice_emitsPriceUpdatedEvent() public {
        oracle.addAsset(ETH, 3_000e8);
        uint256 newPrice = 3_500e8; // +16.7%
        vm.expectEmit(true, false, false, true);
        emit MockOracle.PriceUpdated(ETH, 3_000e8, newPrice, block.timestamp);
        oracle.updatePrice(ETH, newPrice);
    }

    function test_updatePrice_revertsForNonOwner() public {
        oracle.addAsset(BTC, BTC_INIT);
        vm.prank(stranger);
        vm.expectRevert();
        oracle.updatePrice(BTC, BTC_INIT + 1);
    }

    function test_updatePrice_revertsForUnknownAsset() public {
        vm.expectRevert(abi.encodeWithSelector(MockOracle.AssetNotFound.selector, BTC));
        oracle.updatePrice(BTC, BTC_INIT);
    }

    // ── isStale ─────────────────────────────────────────────────────────────

    function test_isStale_freshPrice() public {
        oracle.addAsset(BTC, BTC_INIT);
        assertFalse(oracle.isStale(BTC));
    }

    function test_isStale_afterStalePeriod() public {
        oracle.addAsset(BTC, BTC_INIT);
        vm.warp(block.timestamp + 86401); // just over 24 h
        assertTrue(oracle.isStale(BTC));
    }

    function test_isStale_resetAfterUpdate() public {
        oracle.addAsset(BTC, BTC_INIT);
        vm.warp(block.timestamp + 86401);
        assertTrue(oracle.isStale(BTC));

        // update resets the clock
        oracle.updatePrice(BTC, BTC_INIT * 110 / 100); // +10%
        assertFalse(oracle.isStale(BTC));
    }
}
