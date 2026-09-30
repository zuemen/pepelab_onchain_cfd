// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/v2/GuardedOracle.sol";

contract WindowRefSource {
    mapping(bytes32 => uint256) public px;
    function set(bytes32 id, uint256 p) external { px[id] = p; }
    function getPrice(bytes32 id) external view returns (uint256, uint256) { return (px[id], block.timestamp); }
}

/// @notice GuardedOracle rate limit: cumulative move per time window.
contract GuardedOracleRateLimitTest is Test {
    GuardedOracle oracle;
    WindowRefSource ref;
    address admin  = address(this);
    address keeper = makeAddr("keeper");
    bytes32 constant ID = keccak256("sBTC");

    function setUp() public {
        vm.warp(1_700_000_000);
        oracle = new GuardedOracle(admin);
        ref = new WindowRefSource();
        oracle.grantRole(oracle.KEEPER_ROLE(), keeper);
        oracle.addAsset(ID, 100_000e8);
    }

    function _post(uint256 p) internal {
        vm.prank(keeper);
        oracle.updatePrice(ID, p);
    }

    function test_offByDefault_chainedStepsStillCompound() public {
        _post(110_000e8);
        _post(121_000e8);
        _post(133_100e8);   // +33% in one block: what the limit exists to stop
        (uint256 p, ) = oracle.getPrice(ID);
        assertEq(p, 133_100e8);
    }

    function test_chainedStepsBeyondTheWindowCapAreRejected() public {
        oracle.setWindowLimit(1 hours, 2_000);   // 20% per hour
        _post(110_000e8);                        // +10% from anchor 100k
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedOracle.WindowDeviationTooLarge.selector, ID, 121_000e8, 100_000e8
        ));
        oracle.updatePrice(ID, 121_000e8);       // +21% from the anchor
        _post(120_000e8);                        // exactly +20%: allowed
        (uint256 anchor, uint256 start) = oracle.windowOf(ID);
        assertEq(anchor, 100_000e8);
        assertEq(start, block.timestamp);
    }

    function test_downwardWalkIsBoundedToo() public {
        oracle.setWindowLimit(1 hours, 2_000);
        _post(90_000e8);                         // −10%
        _post(81_000e8);                         // −10% step, −19% from anchor
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(
            GuardedOracle.WindowDeviationTooLarge.selector, ID, 72_900e8, 100_000e8
        ));
        oracle.updatePrice(ID, 72_900e8);        // legal −10% step, but −27.1% in the window
    }

    function test_newWindowReanchorsAtCurrentPrice() public {
        oracle.setWindowLimit(1 hours, 2_000);
        _post(110_000e8);
        _post(120_000e8);
        vm.warp(block.timestamp + 1 hours);
        _post(132_000e8);                        // +10% from the new anchor 120k
        (uint256 anchor, ) = oracle.windowOf(ID);
        assertEq(anchor, 120_000e8);
        vm.prank(keeper);
        vm.expectRevert();
        oracle.updatePrice(ID, 145_000e8);       // legal +9.8% step, +20.8% from 120k
    }

    function test_referenceConfirmedMoveBypassesAndReanchors() public {
        oracle.setWindowLimit(1 hours, 2_000);
        oracle.setReferenceSource(address(ref));
        ref.set(ID, 70_000e8);                   // the market really gapped −30%
        _post(70_000e8);                         // confirmed → lands in one call
        (uint256 anchor, ) = oracle.windowOf(ID);
        assertEq(anchor, 70_000e8, "window re-anchored at the confirmed price");
        ref.set(ID, 0);                          // reference goes dark
        _post(75_000e8);                         // +7% from the new anchor, fine
    }

    function test_setterBoundsAndAccess() public {
        vm.expectRevert(GuardedOracle.InvalidParam.selector);
        oracle.setWindowLimit(1 hours, 5_001);
        vm.expectRevert(GuardedOracle.InvalidParam.selector);
        oracle.setWindowLimit(1 minutes, 2_000);
        vm.expectRevert(GuardedOracle.InvalidParam.selector);
        oracle.setWindowLimit(8 days, 2_000);

        vm.prank(keeper);
        vm.expectRevert();
        oracle.setWindowLimit(1 hours, 2_000);

        oracle.setWindowLimit(6 hours, 3_000);
        assertEq(oracle.windowDuration(), 6 hours);
        assertEq(oracle.maxWindowDeviationBps(), 3_000);
        oracle.setWindowLimit(6 hours, 0);       // off
        assertEq(oracle.windowDuration(), 0);
        assertEq(oracle.maxWindowDeviationBps(), 0);
    }
}
