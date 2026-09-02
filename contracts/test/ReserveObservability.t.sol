// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/v2/AssetVaultV2_2.sol";
import "../src/v2/AssetVaultV2_3.sol";
import "../src/v2/SyntheticAssetV2.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @notice The vault already proves its reserve on-chain — reserve(),
///         outstandingValue(), reserveRatioBps() and ratioIsStale() are all
///         public, and anyone can recompute them. Three things were missing,
///         and these tests pin all three:
///
///           1. NO HISTORY. The ratio was a spot read with no event, so it could
///              not be replayed. observeReserve() emits ReserveObserved.
///           2. NOTHING HAPPENED ON A BREACH. Liability is marked to market, so
///              a doubling price halves the ratio with NO ONE TRANSACTING. The
///              mint() check only fires when someone happens to mint — nobody
///              already inside got an event, an alert, or any protection.
///           3. STALENESS HAD NO READER. ratioIsStale() existed and nothing
///              consumed it.
///
///         The invariant that must survive all of it: REDEMPTION IS NEVER GATED
///         ON THE RATIO. Blocking the exit during stress is the bank run itself,
///         not a defence against it (docs/RISK_MODEL.md).
contract ReserveObservabilityTest is Test {
    MockUSDC   usdc;
    MockOracle oracle;

    AssetVaultV2_3   vault;   // the proxy, upgraded in place from V2.2
    SyntheticAssetV2 aapl;

    address admin  = address(this);
    address alice  = makeAddr("alice");
    address random = makeAddr("random");   // holds no role

    bytes32 constant AAPL = keccak256("sAAPL");

    // Numbers the tests assert against, derived once here:
    //   fund 5,000 + alice pays 10,000 → balance 15,000, fee 30 → reserve 14,970
    //   tokenOut  = (10,000 - 30) * 1e8 / 200e8  = 49.85 sAAPL
    //   liability = 49.85 * 200                  = 9,970
    //   ratio     = 14,970 * 10,000 / 9,970      = 15,015 bps
    uint256 constant SEED_FUND   = 5_000e18;
    uint256 constant ALICE_SPEND = 10_000e18;
    uint256 constant EXP_TOKENS  = 49.85e18;
    uint256 constant EXP_FEE     = 30e18;
    uint256 constant EXP_RESERVE = 14_970e18;
    uint256 constant EXP_LIAB    = 9_970e18;
    uint256 constant EXP_RATIO   = 15_015;

    event ReserveObserved(
        uint256 reserve,
        uint256 liability,
        uint256 ratioBps,
        uint256 unpriced,
        uint256 timestamp
    );
    event ReserveBreached(uint256 ratioBps, uint256 minRatioBps, uint256 unpriced);
    event ReserveRestored(uint256 ratioBps, uint256 minRatioBps);
    event MintingHaltCleared(address indexed operator, uint256 ratioBps, uint256 unpriced);

    function setUp() public {
        // Start well past the epoch so a later warp can age a price out.
        vm.warp(1_700_000_000);

        usdc   = new MockUSDC();
        oracle = new MockOracle();
        oracle.addAsset(AAPL, 200e8);

        // Deployed as V2.2 and upgraded in place, because that is the actual
        // change being shipped: same proxy address, no new contract to trust.
        AssetVaultV2_2 impl = new AssetVaultV2_2();
        address proxy = address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2_2.initialize, (address(usdc), address(oracle), admin))
        ));
        AssetVaultV2_2(proxy).upgradeToAndCall(address(new AssetVaultV2_3()), "");
        vault = AssetVaultV2_3(proxy);

        aapl = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AAPL, admin);
        aapl.grantRole(aapl.MINTER_ROLE(), address(vault));
        vault.registerAsset(AAPL, address(aapl));
        vault.setAssetCap(AAPL, 1_000e18);

        usdc.mint(admin, 1_000_000e18);
        usdc.mint(alice, 1_000_000e18);
        usdc.approve(address(vault), type(uint256).max);
        vault.fundVault(SEED_FUND);

        vm.prank(alice);
        usdc.approve(address(vault), type(uint256).max);
    }

    function _aliceMints() internal {
        vm.prank(alice);
        vault.mint(AAPL, ALICE_SPEND);
    }

    /// @dev Re-posts a price so updatedAt becomes now.
    function _repost(uint256 price8) internal {
        oracle.updatePrice(AAPL, price8);
    }

    // ── 1. history ───────────────────────────────────────────────────────────

    /// @dev Every field is asserted against an independently computed number,
    ///      not against the view it mirrors — a bug that corrupted both the view
    ///      and the event would otherwise pass.
    function test_observeEmitsExactFields() public {
        _aliceMints();

        assertEq(aapl.balanceOf(alice), EXP_TOKENS, "tokenOut");
        assertEq(vault.accruedFees(),   EXP_FEE,    "fee");

        vm.expectEmit(false, false, false, true, address(vault));
        emit ReserveObserved(EXP_RESERVE, EXP_LIAB, EXP_RATIO, 0, block.timestamp);
        vault.observeReserve();
    }

    /// @dev Permissionless on purpose. The keeper must be able to call it
    ///      without holding a new key, and an observation asserts nothing a
    ///      reader could not compute themselves — it only timestamps it.
    function test_observeIsPermissionless() public {
        _aliceMints();
        vm.prank(random);
        (uint256 r, uint256 l, uint256 ratio, uint256 unpriced, bool halted) = vault.observeReserve();
        assertEq(r, EXP_RESERVE);
        assertEq(l, EXP_LIAB);
        assertEq(ratio, EXP_RATIO);
        assertEq(unpriced, 0);
        assertFalse(halted);
    }

    /// @dev A paused vault is exactly when the number matters most.
    function test_observeWorksWhilePaused() public {
        _aliceMints();
        vault.pause();
        vm.expectEmit(false, false, false, true, address(vault));
        emit ReserveObserved(EXP_RESERVE, EXP_LIAB, EXP_RATIO, 0, block.timestamp);
        vault.observeReserve();
    }

    /// @dev Returned values and the emitted event are the same numbers the
    ///      public views report, so a dashboard reading either one agrees.
    function test_observationMatchesViews() public {
        _aliceMints();
        (uint256 r, uint256 l, uint256 ratio, uint256 unpriced, ) = vault.observeReserve();
        assertEq(r, vault.reserve());
        assertEq(l, vault.outstandingValue());
        assertEq(ratio, vault.reserveRatioBps());
        assertEq(unpriced, 0);
        assertFalse(vault.ratioIsStale());
    }

    // ── 2. a breach now does something ───────────────────────────────────────

    /// @dev The scenario the old code had no answer for: nobody transacts, the
    ///      market moves, and the book is under-reserved. Liability doubles,
    ///      reserve does not.
    function test_breachWithNoUserActionHaltsMintingAndEmits() public {
        _aliceMints();
        _repost(400e8);                       // 14,970 / 19,940 = 7,507 bps

        vm.expectEmit(false, false, false, true, address(vault));
        emit ReserveBreached(7_507, 11_000, 0);
        vault.observeReserve();

        assertTrue(vault.mintingHalted(), "minting halted");

        vm.prank(alice);
        vm.expectRevert(AssetVaultV2_3.MintingHalted.selector);
        vault.mint(AAPL, 100e18);
    }

    /// @dev The keeper calls this on a schedule; a breach that stays a breach
    ///      must not re-emit every tick, or the alert is unreadable.
    function test_breachEmitsOncePerCrossing() public {
        _aliceMints();
        _repost(400e8);
        vault.observeReserve();

        vm.recordLogs();
        vault.observeReserve();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(
                logs[i].topics[0] != ReserveBreached.selector,
                "ReserveBreached re-emitted while already halted"
            );
        }
        assertTrue(vault.mintingHalted());
    }

    /// @dev Recovery is by observation, not by a privileged unpause: anyone can
    ///      re-open minting once the numbers say it is safe, and nobody can
    ///      re-open it while they do not.
    function test_recoveryRestoresMinting() public {
        _aliceMints();
        _repost(400e8);
        vault.observeReserve();
        assertTrue(vault.mintingHalted());

        vault.fundVault(20_000e18);           // 34,970 / 19,940 = 17,537 bps

        vm.expectEmit(false, false, false, true, address(vault));
        emit ReserveRestored(17_537, 11_000);
        vm.prank(random);
        vault.observeReserve();

        assertFalse(vault.mintingHalted());
        vm.prank(alice);
        vault.mint(AAPL, 100e18);             // no revert
    }

    /// @dev The halt is sticky on purpose. A ratio that recovers on its own does
    ///      not silently re-open minting — someone has to observe it, which is
    ///      what puts the recovery in the log too.
    function test_haltIsStickyUntilObserved() public {
        _aliceMints();
        _repost(400e8);
        vault.observeReserve();

        vault.fundVault(20_000e18);           // healthy again, but unobserved
        assertGt(vault.reserveRatioBps(), vault.minReserveRatioBps());

        vm.prank(alice);
        vm.expectRevert(AssetVaultV2_3.MintingHalted.selector);
        vault.mint(AAPL, 100e18);
    }

    /// @dev The event fields are the values `clearMintingHalt()` actually saw
    ///      at the moment it cleared — reusing the exact scenario/numbers from
    ///      `test_staleObservationReportsUnpriced` so this can assert them
    ///      precisely instead of just checking the halted flag flipped.
    function test_clearMintingHaltEmitsCurrentSnapshot() public {
        _aliceMints();
        _repost(400e8);
        vault.observeReserve();
        assertTrue(vault.mintingHalted());

        vm.warp(block.timestamp + 2 hours);   // sAAPL now stale too: ratio reads "infinite"
        vault.observeReserve();
        assertTrue(vault.mintingHalted(), "a stale observation must not clear it automatically");

        vm.expectEmit(true, false, false, true, address(vault));
        emit MintingHaltCleared(admin, type(uint256).max, 1);
        vault.clearMintingHalt();

        assertFalse(vault.mintingHalted());
    }

    /// @dev The actual escape-hatch scenario: a low-cap asset's feed goes dark
    ///      permanently while a popular asset breaches and then genuinely
    ///      recovers. Without `clearMintingHalt()`, `observeReserve()`'s
    ///      `unpriced == 0` restore condition can never be satisfied again —
    ///      the dead feed holds every OTHER asset's minting hostage forever.
    function test_clearMintingHaltUnblocksHealthyAssetWhenAnotherIsPermanentlyStale() public {
        bytes32 dead = keccak256("sDEAD");
        oracle.addAsset(dead, 10e8);
        SyntheticAssetV2 deadToken = new SyntheticAssetV2("Dead Asset", "sDEAD", dead, admin);
        deadToken.grantRole(deadToken.MINTER_ROLE(), address(vault));
        vault.registerAsset(dead, address(deadToken));
        vault.setAssetCap(dead, 1_000e18);

        vm.prank(alice);
        vault.mint(dead, 100e18);              // dust outstanding — its feed goes dark next

        _aliceMints();
        _repost(400e8);                        // sAAPL breaches
        vault.observeReserve();
        assertTrue(vault.mintingHalted());

        vault.fundVault(20_000e18);            // reserve genuinely recovers

        vm.warp(block.timestamp + 2 hours);    // both feeds age out
        _repost(400e8);                        // re-post sAAPL only — sDEAD's stays dark forever

        // sAAPL alone is healthy and fresh, but sDEAD's staleness still taints
        // the vault-wide observation, so the automatic restore can't fire.
        vault.observeReserve();
        assertTrue(vault.mintingHalted(), "sDEAD's dead feed blocks the automatic restore");

        vault.clearMintingHalt();
        assertFalse(vault.mintingHalted());

        vm.prank(alice);
        vault.mint(AAPL, 100e18);              // sAAPL's own price is fresh — succeeds
    }

    function test_clearMintingHaltIsRiskRoleOnly() public {
        vm.prank(random);
        vm.expectRevert();
        vault.clearMintingHalt();
    }

    /// @dev setRiskParams's own fee caps exist "so a compromised risk key
    ///      cannot confiscate deposits" — minReserveRatioBps needs the same
    ///      floor, or that same key can zero out the entire breach mechanism
    ///      (ratioBps is unsigned and never negative, so a 0 floor makes
    ///      `ratioBps < minBps` impossible to ever satisfy).
    function test_setRiskParamsRejectsRatioFloorBelow100Pct() public {
        vm.expectRevert(AssetVaultV2_3.InvalidParam.selector);
        vault.setRiskParams(30, 30, 9_999, 1 hours);

        // The boundary itself (exactly 100%) is accepted.
        vault.setRiskParams(30, 30, 10_000, 1 hours);
        assertEq(vault.minReserveRatioBps(), 10_000);
    }

    // ── 3. staleness has a reader ────────────────────────────────────────────

    /// @dev A stale price makes the liability UNDER-counted, so the ratio reads
    ///      optimistic. The observation says so in `unpriced` rather than
    ///      publishing a flattering number with no caveat.
    function test_staleObservationReportsUnpriced() public {
        _aliceMints();
        vm.warp(block.timestamp + 2 hours);   // past maxPriceAge (1h)

        (uint256 r, uint256 l, uint256 ratio, uint256 unpriced, ) = vault.observeReserve();
        assertEq(unpriced, 1, "one asset could not be priced");
        assertEq(l, 0, "an unpriced asset drops out of the liability");
        assertEq(ratio, type(uint256).max, "which is exactly why it looks perfect");
        assertEq(r, EXP_RESERVE);
        assertTrue(vault.ratioIsStale());
    }

    /// @dev The asymmetry that matters: an optimistic ratio can BREACH (the real
    ///      one is lower still) but can never RESTORE.
    function test_staleRatioNeverClearsAHalt() public {
        _aliceMints();
        _repost(400e8);
        vault.observeReserve();
        assertTrue(vault.mintingHalted());

        vm.warp(block.timestamp + 2 hours);   // ratio now reads "infinite"
        assertEq(vault.reserveRatioBps(), type(uint256).max);

        vm.recordLogs();
        vault.observeReserve();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(
                logs[i].topics[0] != ReserveRestored.selector,
                "a stale ratio must not re-open minting"
            );
        }
        assertTrue(vault.mintingHalted(), "still halted");
    }

    /// @dev One call for a dashboard: the number plus whether the number can be
    ///      trusted, read atomically so the two cannot disagree.
    function test_reserveStatusPairsTheNumberWithItsTrustworthiness() public {
        _aliceMints();

        (
            uint256 r, uint256 l, uint256 ratio, uint256 unpriced, bool stale, bool halted
        ) = vault.reserveStatus();
        assertEq(r, EXP_RESERVE);
        assertEq(l, EXP_LIAB);
        assertEq(ratio, EXP_RATIO);
        assertEq(unpriced, 0);
        assertFalse(stale);
        assertFalse(halted);

        vm.warp(block.timestamp + 2 hours);
        (, , , unpriced, stale, ) = vault.reserveStatus();
        assertEq(unpriced, 1);
        assertTrue(stale, "the stale flag is what the UI shows instead of a number");
    }

    // ── the invariant: exits stay open ───────────────────────────────────────

    /// @dev At a 3% reserve ratio, with minting halted, the exit still works.
    function test_redeemIsNeverGatedOnTheRatio() public {
        _aliceMints();
        _repost(10_000e8);                    // 14,970 / 498,500 = 300 bps

        vault.observeReserve();
        assertTrue(vault.mintingHalted());
        assertEq(vault.reserveRatioBps(), 300);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 out = vault.redeem(AAPL, 1e18);           // 10,000 gross - 30 fee

        assertEq(out, 9_970e18);
        assertEq(usdc.balanceOf(alice), before + 9_970e18);
        assertEq(aapl.balanceOf(alice), EXP_TOKENS - 1e18);
    }

    /// @dev Same invariant one notch less extreme, and with the halt latched:
    ///      being under-reserved changes nothing about the exit.
    function test_redeemWorksWhileHaltedAndUnderReserved() public {
        _aliceMints();
        _repost(400e8);
        vault.observeReserve();
        assertTrue(vault.mintingHalted());

        vm.prank(alice);
        uint256 out = vault.redeem(AAPL, 10e18);
        assertEq(out, 3_988e18);                          // 4,000 gross - 12 fee
    }

    // ── the upgrade itself ───────────────────────────────────────────────────

    /// @dev Same address, same balances, same accounting. The whole point of
    ///      doing this as a UUPS upgrade rather than a redeploy.
    function test_upgradeInPlacePreservesState() public {
        MockUSDC   usdc2   = new MockUSDC();
        MockOracle oracle2 = new MockOracle();
        oracle2.addAsset(AAPL, 200e8);

        AssetVaultV2_2 v22 = AssetVaultV2_2(address(new ERC1967Proxy(
            address(new AssetVaultV2_2()),
            abi.encodeCall(AssetVaultV2_2.initialize, (address(usdc2), address(oracle2), admin))
        )));
        SyntheticAssetV2 tok = new SyntheticAssetV2("Synthetic Apple", "sAAPL", AAPL, admin);
        tok.grantRole(tok.MINTER_ROLE(), address(v22));
        v22.registerAsset(AAPL, address(tok));
        v22.setAssetCap(AAPL, 1_000e18);

        usdc2.mint(admin, 1_000_000e18);
        usdc2.mint(alice, 1_000_000e18);
        usdc2.approve(address(v22), type(uint256).max);
        v22.fundVault(SEED_FUND);
        vm.startPrank(alice);
        usdc2.approve(address(v22), type(uint256).max);
        v22.mint(AAPL, ALICE_SPEND);
        vm.stopPrank();

        assertEq(v22.version(), "2.2.0");
        uint256 feesBefore = v22.accruedFees();
        uint256 expBefore  = v22.exposureOf(AAPL);
        uint256 capBefore  = v22.assetCap(AAPL);

        address proxyAddr = address(v22);
        v22.upgradeToAndCall(address(new AssetVaultV2_3()), "");
        AssetVaultV2_3 v23 = AssetVaultV2_3(proxyAddr);

        assertEq(address(v23), proxyAddr, "same address");
        assertEq(v23.version(), "2.3.0");
        assertEq(v23.accruedFees(), feesBefore);
        assertEq(v23.exposureOf(AAPL), expBefore);
        assertEq(v23.assetCap(AAPL), capBefore);
        assertEq(v23.usdc(), address(usdc2));
        assertEq(v23.oracle(), address(oracle2));
        assertEq(v23.minReserveRatioBps(), 11_000);
        assertEq(v23.assetToken(AAPL), address(tok));
        assertEq(v23.reserve(), EXP_RESERVE);
        assertFalse(v23.mintingHalted(), "the new slot starts clear");

        // and the new machinery works on the migrated state
        (uint256 r, uint256 l, uint256 ratio, , ) = v23.observeReserve();
        assertEq(r, EXP_RESERVE);
        assertEq(l, EXP_LIAB);
        assertEq(ratio, EXP_RATIO);
    }

    /// @dev Only the upgrade admin may swap the implementation — the new
    ///      observation surface adds no new privileged path.
    function test_upgradeStillAdminOnly() public {
        AssetVaultV2_3 next = new AssetVaultV2_3();
        vm.prank(random);
        vm.expectRevert();
        vault.upgradeToAndCall(address(next), "");
    }
}
