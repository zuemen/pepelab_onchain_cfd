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

    function testCompositeScore_average() public {
        // (75 + 65 + 72) / 3 = 212 / 3 = 70 (floor)
        esg.setESG(SETH, 75, 65, 72, "AA");
        assertEq(esg.compositeScore(SETH), 70);

        // (82 + 78 + 85) / 3 = 245 / 3 = 81 (floor)
        esg.setESG(keccak256("sBOND"), 82, 78, 85, "AAA");
        assertEq(esg.compositeScore(keccak256("sBOND")), 81);
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
