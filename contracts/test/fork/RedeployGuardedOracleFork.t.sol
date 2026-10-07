// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/v2/GuardedOracle.sol";
import "../../script/RedeployGuardedOracle.s.sol";
import "../utils/KeylessAddr.sol";

/// @notice Fork simulation of `RedeployGuardedOracle` against the live Base
///         Sepolia vault: the new oracle carries the rate limit AND the bounded
///         guardian halts, the vault is re-pointed with its liability
///         unchanged, and on the new instance a guardian freeze lapses by
///         itself while an admin freeze does not. Nothing is broadcast; the
///         script runs in-process.
///
///         The script gets its parameters through `setParams`, not
///         `vm.setEnv`: env is process-wide, and CutoverGovernanceFork sets
///         GUARDIAN / EXCHANGE_NEW for its own scripts. This test neither
///         reads nor writes any environment variable, so the fork suites pass
///         together, in parallel (default) or with `-j 1`.
///
///           forge test --match-path test/fork/RedeployGuardedOracleFork.t.sol --fork-url https://sepolia.base.org -vv
contract RedeployGuardedOracleForkTest is Test {
    address constant OWNER  = 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585;
    address constant KEEPER = 0x540aECD37E7A7885824e7b7e996eBddfb842ef17;
    address constant VAULT  = 0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a;

    address guardian = KeylessAddr.addr("oracleGuardian");   // no known key: see test/utils/KeylessAddr.sol

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

    function _params(address old, uint256 maxAge) internal view returns (RedeployGuardedOracle.Params memory) {
        return RedeployGuardedOracle.Params({
            guardian: guardian,
            keeper: KEEPER,
            windowSeconds: 1 hours,
            windowDeviationBps: 2_500,
            maxPriceAge: maxAge,
            vault: VAULT,
            oldOracle: old,
            exchangeNew: address(0),
            keeperHeartbeat: 900,
            keeperScheduleSlack: 3 hours
        });
    }

    /// @dev ORACLE_MAX_PRICE_AGE may not switch the staleness check off, and
    ///      no copied price may already be older than it: otherwise an asset
    ///      would be stale -- every read reverting -- the moment the vault is
    ///      re-pointed.
    function test_fork_maxPriceAgeBounds() public {
        GuardedOracle old = GuardedOracle(IVaultOracleRepoint(VAULT).oracle());
        _heartbeat(old);

        RedeployGuardedOracle s = new RedeployGuardedOracle();
        s.setBroadcasterOverride(OWNER);
        s.setParams(_params(address(old), 0));
        vm.expectRevert(bytes("ORACLE_MAX_PRICE_AGE must be 3600..2592000 (0 would switch the staleness check off)"));
        s.run();

        // Must cover the keeper's heartbeat plus cron slack: a 6h heartbeat
        // (the keeper's maximum) does not fit a 6h oracle.
        RedeployGuardedOracle.Params memory p = _params(address(old), 21_600);
        p.keeperHeartbeat = 21_600;
        s.setParams(p);
        vm.expectRevert(bytes("ORACLE_MAX_PRICE_AGE must be >= KEEPER_HEARTBEAT + KEEPER_SCHEDULE_SLACK - prices would go stale between keeper runs"));
        s.run();

        // Prices 2h old: fine for the 6h default, refused for a 1h oracle
        // (heartbeat 0 = not given, so only the copy check applies).
        p = _params(address(old), 1 hours);
        p.keeperHeartbeat = 0;
        vm.warp(vm.getBlockTimestamp() + 2 hours);
        s.setParams(p);
        vm.expectRevert(bytes("sBTC price is stale by min(vault maxPriceAge, 6h, ORACLE_MAX_PRICE_AGE) - refusing to re-stamp it as fresh"));
        s.run();
    }

    function test_fork_redeployCarriesBoundedGuardianHalts() public {
        GuardedOracle old = GuardedOracle(IVaultOracleRepoint(VAULT).oracle());
        _heartbeat(old);

        RedeployGuardedOracle s = new RedeployGuardedOracle();
        s.setBroadcasterOverride(OWNER);
        s.setParams(RedeployGuardedOracle.Params({
            guardian: guardian,
            keeper: KEEPER,
            windowSeconds: 1 hours,
            windowDeviationBps: 2_500,
            maxPriceAge: 21_600,
            vault: VAULT,
            oldOracle: address(old),
            exchangeNew: address(0),
            keeperHeartbeat: 900,
            keeperScheduleSlack: 3 hours
        }));
        GuardedOracle n = GuardedOracle(s.run());

        assertEq(IVaultOracleRepoint(VAULT).oracle(), address(n));
        assertEq(n.GUARDIAN_HALT_DURATION(), 72 hours);
        assertEq(n.GUARDIAN_HALT_COOLDOWN(), 24 hours);
        assertTrue(n.hasRole(n.GUARDIAN_ROLE(), guardian));
        assertFalse(n.hasRole(n.GUARDIAN_ROLE(), OWNER));
        assertFalse(n.hasRole(0x00, guardian), "the guardian must not be the admin, or its halts never lapse");
        assertFalse(n.paused());
        assertEq(n.maxPriceAge(), 21_600, "6h, not the old oracle's 30 days");

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

        // The guardian cannot chain another freeze on this asset for 24h. (It
        // could still open a pause now; that is the 144h worst case, after
        // which the asset gets a clean day -- KNOWN_LIMITATIONS #27.)
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.GuardianCooldown.selector, t0 + 96 hours));
        n.setAssetFrozen(ETH, true);

        // A takeover with nothing running does nothing (a queued takeover
        // after a false alarm must not become a new indefinite freeze)...
        vm.prank(OWNER);
        vm.expectRevert(GuardedOracle.NothingToTakeOver.selector);
        n.takeOverAssetFreeze(BTC);
        // ...and the admin's freeze has no expiry; the guardian cannot lift it.
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
