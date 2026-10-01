// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/v2/GuardedOracle.sol";
import "../../script/RedeployGuardedOracle.s.sol";

/// @notice Fork simulation of `RedeployGuardedOracle` against the live Base
///         Sepolia vault: the new oracle carries the rate limit AND the bounded
///         guardian halts, the vault is re-pointed with its liability
///         unchanged, and on the new instance a guardian freeze lapses by
///         itself while an admin freeze does not. Nothing is broadcast; the
///         script runs in-process.
///
///           forge test --match-path test/fork/RedeployGuardedOracleFork.t.sol --fork-url https://sepolia.base.org -vv
contract RedeployGuardedOracleForkTest is Test {
    address constant OWNER  = 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585;
    address constant KEEPER = 0x540aECD37E7A7885824e7b7e996eBddfb842ef17;
    address constant VAULT  = 0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a;

    address guardian = makeAddr("oracleGuardian");

    bytes32 constant ETH = keccak256("sETH");
    bytes32 constant BTC = keccak256("sBTC");

    function setUp() public {
        if (block.chainid != 84532) vm.skip(true, "needs --fork-url https://sepolia.base.org");
    }

    function _syms() internal pure returns (string[11] memory s) {
        s = ["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"];
    }

    /// @dev Keeper heartbeat (same price, new timestamp), as the runbook tells
    ///      the operator to do before the migration: the script refuses to
    ///      re-stamp a quote older than min(vault.maxPriceAge, 6h).
    function _heartbeat(GuardedOracle o) internal {
        string[11] memory syms = _syms();
        for (uint256 i; i < 11; i++) {
            bytes32 id = keccak256(bytes(syms[i]));
            (uint256 p, , , ) = o.peek(id);
            vm.prank(KEEPER);
            o.updatePrice(id, p);
        }
    }

    function test_fork_redeployCarriesBoundedGuardianHalts() public {
        GuardedOracle old = GuardedOracle(IVaultOracleRepoint(VAULT).oracle());
        _heartbeat(old);

        vm.setEnv("GUARDIAN", vm.toString(guardian));
        vm.setEnv("OLD_GUARDED_ORACLE", vm.toString(address(old)));
        RedeployGuardedOracle s = new RedeployGuardedOracle();
        s.setBroadcasterOverride(OWNER);
        GuardedOracle n = GuardedOracle(s.run());

        assertEq(IVaultOracleRepoint(VAULT).oracle(), address(n));
        assertEq(n.GUARDIAN_HALT_DURATION(), 72 hours);
        assertEq(n.GUARDIAN_HALT_COOLDOWN(), 24 hours);
        assertTrue(n.hasRole(n.GUARDIAN_ROLE(), guardian));
        assertFalse(n.hasRole(n.GUARDIAN_ROLE(), OWNER));
        assertFalse(n.hasRole(0x00, guardian), "the guardian must not be the admin, or its halts never lapse");
        assertFalse(n.paused());

        // vm.getBlockTimestamp(), not block.timestamp: with via_ir the optimizer
        // re-reads TIMESTAMP at each use, so a cached `block.timestamp` would
        // follow every later vm.warp.
        uint256 t0 = vm.getBlockTimestamp();
        (uint256 pEth, ) = n.getPrice(ETH);

        // Guardian freeze: fail-closed for 72h…
        vm.prank(guardian);
        n.setAssetFrozen(ETH, true);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.AssetIsFrozen.selector, ETH));
        n.getPrice(ETH);
        vm.warp(t0 + 72 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.AssetIsFrozen.selector, ETH));
        n.getPrice(ETH);

        // …then it lapses with no guardian or admin transaction. The keeper's
        // ordinary post is all that is needed for a fresh quote.
        vm.warp(t0 + 72 hours);
        (, , , bool frozen) = n.peek(ETH);
        assertFalse(frozen);
        vm.prank(KEEPER);
        n.updatePrice(ETH, pEth);
        (uint256 p, ) = n.getPrice(ETH);
        assertEq(p, pEth);

        // The guardian cannot chain another freeze, nor reach for the pause to
        // keep the asset stale after it.
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.GuardianCooldown.selector, t0 + 96 hours));
        n.setAssetFrozen(ETH, true);

        // The admin's freeze has no expiry and the guardian cannot lift it.
        vm.prank(OWNER);
        n.setAssetFrozen(BTC, true);
        vm.warp(t0 + 400 days);
        (, , , frozen) = n.peek(BTC);
        assertTrue(frozen);
        vm.prank(guardian);
        vm.expectRevert(GuardedOracle.NotGuardianHalt.selector);
        n.setAssetFrozen(BTC, false);
    }
}
