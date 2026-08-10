// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/ESGRegistry.sol";

contract ESGRegistryTest is Test {
    ESGRegistry esg;

    address owner   = address(this);
    address nonOwner = makeAddr("nonOwner");

    bytes32 constant SBTC  = keccak256("sBTC");
    bytes32 constant SETH  = keccak256("sETH");
    bytes32 constant SAAPL = keccak256("sAAPL");
    bytes32 constant STSLA = keccak256("sTSLA");

    function setUp() public {
        esg = new ESGRegistry();
    }

    // ── testSetESG_byOwner ───────────────────────────────────────────────────

    function testSetESG_byOwner() public {
        vm.expectEmit(true, false, false, true);
        emit ESGRegistry.ESGUpdated(SBTC, 22, 50, 40, "CCC");

        esg.setESG(SBTC, 22, 50, 40, "CCC");

        assertTrue(esg.isRated(SBTC));
    }

    // ── testSetESG_byNonOwner_revert ─────────────────────────────────────────

    function testSetESG_byNonOwner_revert() public {
        vm.prank(nonOwner);
        vm.expectRevert();
        esg.setESG(SBTC, 22, 50, 40, "CCC");
    }

    // ── testGetESG_returnsCorrectData ────────────────────────────────────────

    function testGetESG_returnsCorrectData() public {
        esg.setESG(SETH, 75, 65, 72, "AA");

        (uint8 e, uint8 s, uint8 g, string memory rating) = esg.getESG(SETH);
        assertEq(e, 75);
        assertEq(s, 65);
        assertEq(g, 72);
        assertEq(rating, "AA");
    }

    // ── testCompositeScore_average ───────────────────────────────────────────

    /// @dev Low (rounding boundary): compositeScore now rounds to nearest
    ///      instead of flooring. Every consumer compares it with `>=` against a
    ///      threshold, so flooring silently raised the bar by up to 0.67 points
    ///      in a way that depended on the sum's remainder.
    function testCompositeScore_roundsToNearest() public {
        // (75 + 65 + 72) = 212 → 70.67 → 71
        esg.setESG(SETH, 75, 65, 72, "AA");
        assertEq(esg.compositeScore(SETH), 71);

        // (82 + 78 + 85) = 245 → 81.67 → 82
        esg.setESG(keccak256("sBOND"), 82, 78, 85, "AAA");
        assertEq(esg.compositeScore(keccak256("sBOND")), 82);

        // Exact multiples are unaffected.
        esg.setESG(keccak256("sEXACT"), 70, 70, 70, "A");
        assertEq(esg.compositeScore(keccak256("sEXACT")), 70);

        // …and .33 still rounds down.
        esg.setESG(keccak256("sDOWN"), 70, 70, 69, "A");
        assertEq(esg.compositeScore(keccak256("sDOWN")), 70);   // 209 → 69.67 → 70
        esg.setESG(keccak256("sDOWN2"), 70, 69, 69, "A");
        assertEq(esg.compositeScore(keccak256("sDOWN2")), 69);  // 208 → 69.33 → 69
    }

    function testCompositeScore_cannotExceed100() public {
        esg.setESG(keccak256("sMAX"), 100, 100, 100, "AAA");
        assertEq(esg.compositeScore(keccak256("sMAX")), 100);
    }

    // ── testGetUnratedAsset_revert ───────────────────────────────────────────

    function testGetUnratedAsset_revert() public {
        vm.expectRevert(abi.encodeWithSelector(ESGRegistry.AssetNotRated.selector, SBTC));
        esg.getESG(SBTC);
    }

    // ── testGetAllRatedAssets ────────────────────────────────────────────────

    function testGetAllRatedAssets() public {
        esg.setESG(SBTC,  22, 50, 40, "CCC");
        esg.setESG(SETH,  75, 65, 72, "AA");
        esg.setESG(SAAPL, 72, 76, 80, "AA");

        bytes32[] memory assets = esg.getAllRatedAssets();
        assertEq(assets.length, 3);
        assertEq(assets[0], SBTC);
        assertEq(assets[1], SETH);
        assertEq(assets[2], SAAPL);
    }

    // ── additional: update existing asset replaces data ──────────────────────

    function testSetESG_update_doesNotDuplicate() public {
        esg.setESG(SBTC, 22, 50, 40, "CCC");
        esg.setESG(SBTC, 30, 55, 45, "BB");

        bytes32[] memory assets = esg.getAllRatedAssets();
        assertEq(assets.length, 1, "should not push duplicate");

        (uint8 e,,,) = esg.getESG(SBTC);
        assertEq(e, 30, "environmental should be updated");
    }

    // ── additional: ScoreOutOfRange ──────────────────────────────────────────

    function testSetESG_scoreOutOfRange_revert() public {
        vm.expectRevert(ESGRegistry.ScoreOutOfRange.selector);
        esg.setESG(SBTC, 101, 50, 40, "CCC");
    }
}
