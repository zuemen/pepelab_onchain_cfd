// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @dev Drives the exchange through trading AND operations: opens, closes,
///      liquidations and price moves on two assets, time advancing (so
///      funding and borrow fees accrue), deposits and withdrawals, global
///      pause / unpause (guardian and owner), per-asset mode changes and
///      mid-run cap changes.
///
///      Reverts are never swallowed wholesale. Before every call the handler
///      predicts the outcome from public state; a predicted revert is asserted
///      with its exact reason (`vm.expectRevert`), and a call predicted to
///      succeed that reverts anyway is recorded (`unexpectedReverts`, and for
///      closes `livenessFailures`) and fails the run through an invariant.
contract ExchangeCapsHandler is Test {
    PerpetualExchange public exchange;
    MockUSDC          public usdc;
    MockOracle        public oracle;
    address           public admin;     // exchange owner
    address           public guardian;
    address           public liquidator;

    bytes32[2] public assets;
    address[3] public actors;

    uint256[] public allIds;
    uint256[] public openIds;

    // ── ghosts (tracked independently of the exchange's own counters) ──────
    mapping(bytes32 => uint256) public ghostLongOI;
    mapping(bytes32 => uint256) public ghostShortOI;
    mapping(bytes32 => uint256) public ghostLongSize;
    mapping(bytes32 => uint256) public ghostShortSize;
    mapping(bytes32 => uint256) public ghostOpenCount;
    /// Σ profitCapOf over settled positions.
    uint256 public ghostSettledCaps;
    /// Σ funding RECEIVED (−FundingRealized when negative) by settled positions.
    uint256 public ghostFundingReceived;
    /// Opens after which the side's OI at the index exceeded its cap.
    uint256 public ghostOpensAboveCap;
    /// Positions whose frozen cap != margin × maxProfitBps at their open.
    uint256 public ghostCapMismatches;
    /// Calls predicted to succeed that reverted.
    uint256 public unexpectedReverts;
    bytes   public lastUnexpectedReason;
    /// Closes of an open position on a non-Halted asset, fresh non-zero
    /// price, exchange not paused, that did not go through.
    uint256 public livenessFailures;

    // coverage counters
    uint256 public opens;
    uint256 public closes;
    uint256 public liquidations;
    uint256 public expectedReverts;
    uint256 public rejectedByOICap;
    uint256 public pauses;
    uint256 public takeovers;
    uint256 public lapsedUnpauseAttempts;
    uint256 public lapsesClosed;
    uint256 public modeChanges;
    uint256 public capChanges;
    uint256 public warps;
    uint256 public settledAtCap;

    constructor(PerpetualExchange e, MockUSDC u, MockOracle o, address _admin, address _guardian, bytes32 a0, bytes32 a1) {
        exchange = e; usdc = u; oracle = o; admin = _admin; guardian = _guardian;
        assets = [a0, a1];
        actors = [makeAddr("a1"), makeAddr("a2"), makeAddr("a3")];
        liquidator = makeAddr("liquidator");
    }

    function actorCount() external view returns (uint256) { return actors.length; }
    function openCount() external view returns (uint256) { return openIds.length; }
    function allCount() external view returns (uint256) { return allIds.length; }

    // ── prediction helpers (mirror the exchange's public state) ────────────

    function _resumedAt() internal view returns (uint256) {
        uint256 pa = exchange.pausedAt();
        if (pa != 0 && !exchange.paused()) return exchange.pauseExpiresAt();
        return exchange.lastResumedAt();
    }

    /// Exact GracePeriodActive revert for `asset`, or empty if none applies.
    function _graceError(bytes32 asset) internal view returns (bytes memory) {
        uint256 g = exchange.LIQUIDATION_GRACE_PERIOD();
        uint256 r = _resumedAt();
        if (r != 0 && vm.getBlockTimestamp() < r + g) {
            return abi.encodeWithSelector(PerpetualExchange.GracePeriodActive.selector, bytes32(0), r + g);
        }
        uint256 lifted = exchange.haltLiftedAt(asset);
        if (lifted != 0 && vm.getBlockTimestamp() < lifted + g) {
            return abi.encodeWithSelector(PerpetualExchange.GracePeriodActive.selector, asset, lifted + g);
        }
        return "";
    }

    function _globalGraceError() internal view returns (bytes memory) {
        uint256 g = exchange.LIQUIDATION_GRACE_PERIOD();
        uint256 r = _resumedAt();
        if (r != 0 && vm.getBlockTimestamp() < r + g) {
            return abi.encodeWithSelector(PerpetualExchange.GracePeriodActive.selector, bytes32(0), r + g);
        }
        return "";
    }

    function _expectRevert(bytes memory reason) internal {
        vm.expectRevert(reason);
        ++expectedReverts;
    }

    function _unexpected(bytes memory reason) internal {
        ++unexpectedReverts;
        lastUnexpectedReason = reason;
    }

    // ── trading actions ────────────────────────────────────────────────────

    /// Two entry points to the same action weight the run toward building a
    /// book (the fuzzer picks selectors uniformly).
    function open(uint256 actorSeed, uint256 assetSeed, bool isLong, uint256 margin, uint256 leverage) external {
        _open(actorSeed, assetSeed, isLong, margin, leverage);
    }

    function openMore(uint256 actorSeed, uint256 assetSeed, bool isLong, uint256 margin, uint256 leverage) external {
        _open(actorSeed, assetSeed, isLong, margin, leverage);
    }

    function _open(uint256 actorSeed, uint256 assetSeed, bool isLong, uint256 margin, uint256 leverage) internal {
        address who   = actors[actorSeed % actors.length];
        bytes32 asset = assets[assetSeed % assets.length];
        margin   = bound(margin, 10e18, 5_000e18);
        leverage = bound(leverage, 1, 5);
        if (exchange.freeMargin(who) < margin * 2) return; // margin + fee, generously

        // Revert order of openPosition / _openPosition.
        bytes memory expected;
        PerpetualExchange.AssetMode mode = exchange.assetMode(asset);
        uint256 size = margin * leverage * 1e18 / exchange.getMarkPrice(asset);
        uint256 resulting;
        uint256 cap = isLong ? exchange.maxLongOI(asset) : exchange.maxShortOI(asset);
        {
            (uint256 raw,) = oracle.getPrice(asset);
            resulting = ((isLong ? ghostLongSize[asset] : ghostShortSize[asset]) + size) * (raw * 1e10) / 1e18;
        }
        if (exchange.paused()) {
            expected = abi.encodeWithSelector(PerpetualExchange.EnforcedPause.selector);
        } else if (mode != PerpetualExchange.AssetMode.Active) {
            expected = abi.encodeWithSelector(PerpetualExchange.AssetNotActive.selector, asset, mode);
        } else if (_graceError(asset).length != 0) {
            expected = _graceError(asset);
        } else if (cap != 0 && resulting > cap) {
            expected = abi.encodeWithSelector(
                PerpetualExchange.OpenInterestCapExceeded.selector, asset, isLong, resulting, cap
            );
            ++rejectedByOICap;
        }

        if (expected.length != 0) {
            _expectRevert(expected);
            vm.prank(who);
            exchange.openPosition(asset, isLong, margin, leverage);
            return;
        }
        uint256 bpsAtOpen = exchange.maxProfitBps(asset);
        vm.prank(who);
        try exchange.openPosition(asset, isLong, margin, leverage) returns (uint256 id) {
            allIds.push(id);
            openIds.push(id);
            ++opens;
            ++ghostOpenCount[asset];
            if (isLong) { ghostLongOI[asset] += margin * leverage; ghostLongSize[asset] += size; }
            else        { ghostShortOI[asset] += margin * leverage; ghostShortSize[asset] += size; }
            (uint256 lv, uint256 sv) = exchange.openInterestValue(asset);
            if (cap != 0 && (isLong ? lv : sv) > cap) ++ghostOpensAboveCap;
            if (exchange.profitCapOf(id) != margin * bpsAtOpen / 10_000) ++ghostCapMismatches;
        } catch (bytes memory reason) {
            _unexpected(reason);
        }
    }

    /// Liveness: an open position whose asset is not Halted, with a fresh
    /// non-zero price, while the exchange is not paused, can ALWAYS be closed
    /// by its owner — underwater or not, in grace or not, ReduceOnly or not.
    function close(uint256 idxSeed, uint256 gate) external {
        if (gate % 3 != 0 || openIds.length == 0) return; // let positions live a while
        uint256 id = openIds[idxSeed % openIds.length];
        PerpetualExchange.Position memory p = exchange.getPosition(id);

        bytes memory expected;
        if (exchange.paused()) {
            expected = abi.encodeWithSelector(PerpetualExchange.EnforcedPause.selector);
        } else if (exchange.assetMode(p.asset) == PerpetualExchange.AssetMode.Halted) {
            expected = abi.encodeWithSelector(PerpetualExchange.AssetHalted.selector, p.asset);
        }
        if (expected.length != 0) {
            _expectRevert(expected);
            vm.prank(p.owner);
            exchange.closePosition(id);
            return;
        }
        vm.recordLogs();
        vm.prank(p.owner);
        try exchange.closePosition(id) {
            ++closes;
        } catch (bytes memory reason) {
            ++livenessFailures;
            _unexpected(reason);
        }
        _sync();
    }

    function liquidate(uint256 idxSeed) external {
        if (openIds.length == 0) return;
        uint256 id = openIds[idxSeed % openIds.length];
        bytes32 asset = exchange.getPosition(id).asset;

        bytes memory expected;
        if (exchange.paused()) {
            expected = abi.encodeWithSelector(PerpetualExchange.EnforcedPause.selector);
        } else if (exchange.assetMode(asset) == PerpetualExchange.AssetMode.Halted) {
            expected = abi.encodeWithSelector(PerpetualExchange.AssetHalted.selector, asset);
        } else {
            expected = _graceError(asset);
        }
        if (expected.length != 0) {
            _expectRevert(expected);
            vm.prank(liquidator);
            exchange.liquidatePosition(id);
            return;
        }
        vm.recordLogs();
        // Health depends on funding settled inside the call, so both outcomes
        // are legitimate here — but ONLY these two.
        bytes32 healthy = keccak256(abi.encodeWithSelector(PerpetualExchange.PositionIsHealthy.selector));
        vm.prank(liquidator);
        try exchange.liquidatePosition(id) {
            ++liquidations;
        } catch (bytes memory reason) {
            if (keccak256(reason) != healthy) _unexpected(reason);
        }
        _sync();
    }

    /// Moves every newly-closed id (the target, and any ADL victims) out of the
    /// open list, and books the funding each settlement received.
    function _sync() internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = PerpetualExchange.FundingRealized.selector;
        for (uint256 j; j < logs.length; ++j) {
            if (logs[j].emitter != address(exchange) || logs[j].topics[0] != topic) continue;
            int256 amount = abi.decode(logs[j].data, (int256));
            if (amount < 0) ghostFundingReceived += SafeCast.toUint256(-amount);
        }

        uint256 i;
        while (i < openIds.length) {
            uint256 id = openIds[i];
            PerpetualExchange.Position memory p = exchange.getPosition(id);
            if (p.isOpen) { ++i; continue; }
            uint256 cap = exchange.profitCapOf(id);
            ghostSettledCaps += cap;
            if (p.realizedPnL == SafeCast.toInt256(cap)) ++settledAtCap;
            uint256 psize = p.margin * p.leverage * 1e18 / p.entryPrice;
            if (p.isLong) { ghostLongOI[p.asset] -= p.margin * p.leverage; ghostLongSize[p.asset] -= psize; }
            else          { ghostShortOI[p.asset] -= p.margin * p.leverage; ghostShortSize[p.asset] -= psize; }
            --ghostOpenCount[p.asset];
            openIds[i] = openIds[openIds.length - 1];
            openIds.pop();
        }
    }

    // ── market / time actions ──────────────────────────────────────────────

    /// Moves one index by up to ±25%, kept inside a sane band per asset.
    function movePrice(uint256 assetSeed, uint256 bpsSeed, bool up) external {
        bytes32 asset = assets[assetSeed % assets.length];
        (uint256 p,) = oracle.getPrice(asset);
        uint256 bps  = bound(bpsSeed, 1, 2_500);
        uint256 next = up ? p + p * bps / 10_000 : p - p * bps / 10_000;
        uint256 lo = asset == assets[0] ? 20_000e8 : 800e8;
        uint256 hi = asset == assets[0] ? 400_000e8 : 16_000e8;
        if (next < lo) next = lo;
        if (next > hi) next = hi;
        vm.prank(admin);
        oracle.updatePrice(asset, next);
    }

    /// Advances time by up to 12h (so funding intervals and borrow hours
    /// elapse, and guardian pauses can lapse), then refreshes both feeds at
    /// their current price so they never go stale.
    /// Advances time by up to 12h; one call in ten jumps 80h so a guardian
    /// pause (72h) can lapse inside a single step.
    function warp(uint256 secs) external {
        secs = secs % 10 == 0 ? 80 hours : bound(secs, 1 minutes, 12 hours);
        vm.warp(vm.getBlockTimestamp() + secs);
        for (uint256 i; i < assets.length; ++i) {
            (uint256 p,) = oracle.getPrice(assets[i]);
            vm.prank(admin);
            oracle.updatePrice(assets[i], p);
        }
        ++warps;
    }

    // ── margin actions ─────────────────────────────────────────────────────

    /// Deposits are allowed at all times, including while paused.
    function deposit(uint256 actorSeed, uint256 amount) external {
        address who = actors[actorSeed % actors.length];
        amount = bound(amount, 1e18, 20_000e18);
        vm.prank(admin);
        usdc.mint(who, amount);
        vm.prank(who);
        try exchange.depositMargin(amount) {} catch (bytes memory reason) { _unexpected(reason); }
    }

    function withdraw(uint256 actorSeed, uint256 amount) external {
        address who = actors[actorSeed % actors.length];
        uint256 free = exchange.freeMargin(who);
        if (free == 0) return;
        amount = bound(amount, 1, free);

        bytes memory expected;
        if (exchange.paused()) {
            expected = abi.encodeWithSelector(PerpetualExchange.EnforcedPause.selector);
        } else {
            expected = _globalGraceError();
        }
        if (expected.length != 0) {
            _expectRevert(expected);
            vm.prank(who);
            exchange.withdrawMargin(amount);
            return;
        }
        vm.prank(who);
        try exchange.withdrawMargin(amount) {} catch (bytes memory reason) { _unexpected(reason); }
    }

    // ── operations actions ─────────────────────────────────────────────────

    /// Rare on purpose (1 in 8 calls acts): a pause stops most other actions,
    /// and the run should spend most of its time trading.
    /// Covers: guardian or owner starting a pause, the guardian refused while
    /// a pause runs or during its 24h cooldown, and the owner taking over a
    /// running guardian pause.
    function pause(uint256 seed, bool byGuardian) external {
        // Starting a pause is rare (1 in 8) so the run mostly trades; calls
        // made while a pause runs always go through, to reach the takeover
        // and refusal paths.
        if (seed % 8 != 0 && !exchange.paused()) return;
        bytes memory expected;
        bool takeover;
        if (exchange.paused()) {
            if (!byGuardian && exchange.pauseExpiresAt() != 0) takeover = true;
            else expected = abi.encodeWithSelector(PerpetualExchange.EnforcedPause.selector);
        } else if (byGuardian) {
            // pause() first closes a lapsed guardian window, which starts the
            // cooldown from that window's expiry.
            uint256 allowedAt = exchange.pausedAt() != 0
                ? exchange.pauseExpiresAt() + exchange.GUARDIAN_PAUSE_COOLDOWN()
                : exchange.guardianPauseAllowedAt();
            if (vm.getBlockTimestamp() < allowedAt) {
                expected = abi.encodeWithSelector(PerpetualExchange.GuardianPauseCooldown.selector, allowedAt);
            }
        }
        if (expected.length != 0) {
            _expectRevert(expected);
            vm.prank(byGuardian ? guardian : admin);
            exchange.pause();
            return;
        }
        vm.prank(byGuardian ? guardian : admin);
        try exchange.pause() {
            if (takeover) ++takeovers; else ++pauses;
        } catch (bytes memory reason) { _unexpected(reason); }
    }

    /// Covers the owner unpausing a running pause, and calling unpause on a
    /// guardian pause that already lapsed (or none) — which must revert.
    function unpause() external {
        if (!exchange.paused()) {
            if (exchange.pausedAt() != 0) ++lapsedUnpauseAttempts;
            _expectRevert(abi.encodeWithSelector(PerpetualExchange.ExpectedPause.selector));
            vm.prank(admin);
            exchange.unpause();
            return;
        }
        vm.prank(admin);
        try exchange.unpause() {} catch (bytes memory reason) { _unexpected(reason); }
    }

    /// Anyone may record a lapsed guardian pause.
    function closeLapsedPause() external {
        if (exchange.pausedAt() == 0 || exchange.paused()) {
            _expectRevert(abi.encodeWithSelector(PerpetualExchange.NoLapsedPause.selector));
            exchange.closeLapsedPause();
            return;
        }
        try exchange.closeLapsedPause() { ++lapsesClosed; } catch (bytes memory reason) { _unexpected(reason); }
    }

    function setMode(uint256 assetSeed, uint256 modeSeed) external {
        if (modeSeed % 3 != 0) return; // rarer than trading
        modeSeed /= 3;
        bytes32 asset = assets[assetSeed % assets.length];
        PerpetualExchange.AssetMode mode = PerpetualExchange.AssetMode.Active;
        uint256 m = modeSeed % 6; // Active 4 in 6, so markets mostly trade
        if (m == 1) mode = PerpetualExchange.AssetMode.ReduceOnly;
        if (m == 2) mode = PerpetualExchange.AssetMode.Halted;
        vm.prank(admin);
        try exchange.setAssetMode(asset, mode) { ++modeChanges; } catch (bytes memory reason) { _unexpected(reason); }
    }

    /// Mid-run cap changes, including below the current open interest.
    function setCaps(uint256 assetSeed, uint256 longCap, uint256 shortCap, uint256 profitBps) external {
        if (profitBps % 3 != 0) return; // rarer than trading
        bytes32 asset = assets[assetSeed % assets.length];
        longCap   = bound(longCap, 20_000e18, 150_000e18);
        shortCap  = bound(shortCap, 20_000e18, 150_000e18);
        profitBps = bound(profitBps, exchange.MIN_PROFIT_CAP_BPS(), exchange.MAX_PROFIT_CAP_BPS());
        vm.startPrank(admin);
        exchange.setMaxOpenInterest(asset, longCap, shortCap);
        exchange.setMaxProfitBps(asset, profitBps);
        vm.stopPrank();
        ++capChanges;
    }
}

/// @notice P1 invariants for OI caps, profit caps and the emergency controls,
///         under trading AND operations (time, pause, modes, cap changes,
///         deposits / withdrawals) on two assets.
///
/// Configuration (set explicitly in setUp — an unconfigured cap would make the
/// cap invariants vacuous): both assets start with long/short OI caps and a
/// 20,000 bps profit cap; the handler moves them mid-run (profit cap always
/// within [MIN, MAX], never 0). Mark premium 50 bps, ADL on, trading fee
/// 0.1%, borrow 0.01%/h, no InsuranceVault / FeeRouter, portfolio margin off.
///
/// Runs and depth follow the project defaults — `foundry.toml` sets no
/// `[invariant]` section, so Foundry's defaults apply. `fail-on-revert` is
/// on for this suite: the handler never reverts on its own (unexpected
/// failures are caught and counted), so a handler revert can only mean a
/// predicted revert did not happen or had a different reason — which must
/// fail the run rather than be discarded.
/// forge-config: default.invariant.fail-on-revert = true
contract ExchangeRiskCapsInvariantTest is Test {
    PerpetualExchange    exchange;
    MockUSDC             usdc;
    MockOracle           oracle;
    ExchangeCapsHandler  handler;

    bytes32 constant BTC = keccak256("BTC");
    bytes32 constant ETH = keccak256("ETH");
    uint256 constant RESERVE   = 5_000_000e18;
    uint256 constant PER_ACTOR = 200_000e18;

    address guardian = makeAddr("guardian");

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        oracle.addAsset(BTC, 100_000e8);
        oracle.addAsset(ETH, 4_000e8);

        exchange.setExecutionFee(0);
        exchange.setMaxOpenInterest(BTC, 80_000e18, 60_000e18);
        exchange.setMaxOpenInterest(ETH, 60_000e18, 80_000e18);
        exchange.setMaxProfitBps(BTC, 20_000);
        exchange.setMaxProfitBps(ETH, 20_000);
        exchange.setMarkPremiumCapBps(50);
        exchange.setAdlEnabled(true);
        exchange.setGuardian(guardian);

        handler = new ExchangeCapsHandler(exchange, usdc, oracle, address(this), guardian, BTC, ETH);

        usdc.mint(address(exchange), RESERVE);
        for (uint256 i; i < handler.actorCount(); ++i) {
            address a = handler.actors(i);
            usdc.mint(a, PER_ACTOR);
            vm.startPrank(a);
            usdc.approve(address(exchange), type(uint256).max);
            exchange.depositMargin(PER_ACTOR);
            vm.stopPrank();
        }

        targetContract(address(handler));
    }

    // ── 1. No open ever leaves its side above the cap ───────────────────────
    //
    // The cap is on size × current index price and is enforced at open; a
    // later price move or a lowered cap may leave a side above it (that
    // refuses new exposure, it forces nobody out), so the property is checked
    // right after every successful open.
    function invariant_opensNeverLeaveSideAboveCap() public view {
        assertEq(handler.ghostOpensAboveCap(), 0);
    }

    // ── 2. OI accounting equals the sum of open positions ───────────────────
    function invariant_openInterestEqualsSumOfOpenPositions() public view {
        bytes32[2] memory a = [BTC, ETH];
        for (uint256 i; i < 2; ++i) {
            assertEq(exchange.globalLongNotional(a[i]), handler.ghostLongOI(a[i]), "long notional");
            assertEq(exchange.globalShortNotional(a[i]), handler.ghostShortOI(a[i]), "short notional");
            assertEq(exchange.longOpenSize(a[i]), handler.ghostLongSize(a[i]), "long size");
            assertEq(exchange.shortOpenSize(a[i]), handler.ghostShortSize(a[i]), "short size");
            assertEq(exchange.openPositionCountFor(a[i]), handler.ghostOpenCount(a[i]), "ADL index");
        }
    }

    // ── 3. Solvency: the pool loses at most caps + funding received ─────────
    //
    // B = exchange USDC, C = Σ freeMargin, R = seeded reserve; initially
    // B − C = R. Every flow changes S = B − C as follows:
    //   deposit / withdraw          ΔS = 0
    //   open                        ΔS = +(margin + tradingFee) ≥ 0
    //   close                       ΔS = −payout,  payout = max(0, margin + pnl − fees − funding)
    //   liquidation                 ΔS = −(refund + reward) ≥ −max(0, closeAmount)
    //   ADL of a counterparty       ΔS = −payout,  payout ≤ margin + pnl − haircut − funding
    //   price, time, pause, modes, cap changes   ΔS = 0
    // with pnl ≤ profitCapOf(id) in every settlement and −funding ≤ the
    // funding the position RECEIVED (FundingRealized < 0). Hence a position's
    // lifetime contribution is ≥ −(cap + fundingReceived), and
    //
    //     B − C  ≥  R − Σ_settled profitCapOf − Σ_settled fundingReceived
    //
    // WHAT THIS PROVES: no settlement path (close, liquidation reward /
    // penalty / refund, ADL, mark premium, fees, borrow and funding under
    // pause / Halt / grace) pays a position more than margin + cap + the
    // funding it was owed; nothing else moves value out of the pool.
    // WHAT IT DOES NOT PROVE: B ≥ C at all times (capped winners can still
    // exhaust any finite reserve — market risk sized by the OI caps), that
    // funding receipts are fully backed by payers (a payer can go bankrupt),
    // or anything about InsuranceVault / FeeRouter flows (not wired here).
    function invariant_poolDrainBoundedBySettledCapsAndFunding() public view {
        uint256 b = usdc.balanceOf(address(exchange));
        uint256 c;
        for (uint256 i; i < handler.actorCount(); ++i) {
            c += exchange.freeMargin(handler.actors(i));
        }
        // B − C ≥ R − G − F, kept unsigned: B + G + F ≥ C + R.
        assertGe(b + handler.ghostSettledCaps() + handler.ghostFundingReceived(), c + RESERVE);
    }

    // ── 4. Every position is capped at margin × the bps in force at open ────
    function invariant_everyPositionIsCapped() public view {
        assertEq(handler.ghostCapMismatches(), 0);
    }

    // ── 5. Liveness: closable when it should be ─────────────────────────────
    //
    // An open position on a non-Halted asset, with a fresh non-zero price,
    // while not paused, can always be closed by its owner — whether it is
    // underwater, in a grace period, ReduceOnly, or above a lowered cap.
    function invariant_closeAlwaysPossibleWhenMarketOpen() public view {
        assertEq(handler.livenessFailures(), 0);
    }

    /// No call predicted to succeed reverted, and every predicted revert
    /// carried its exact reason (enforced by vm.expectRevert in the handler).
    function invariant_noUnexpectedReverts() public view {
        assertEq(handler.unexpectedReverts(), 0, string(handler.lastUnexpectedReason()));
    }

    /// Cross-check of the incremental ghosts against the exchange's own
    /// position records, once per run; plus coverage evidence in -vv output.
    function afterInvariant() external view {
        uint256 n = handler.allCount();
        uint256 openN;
        for (uint256 i; i < n; ++i) {
            if (exchange.getPosition(handler.allIds(i)).isOpen) ++openN;
        }
        assertEq(openN, handler.openCount());
        console.log("opens", handler.opens(), "closes", handler.closes());
        console.log("liquidations", handler.liquidations(), "expectedReverts", handler.expectedReverts());
        console.log("pauses", handler.pauses(), "modeChanges", handler.modeChanges());
        console.log("capChanges", handler.capChanges(), "warps", handler.warps());
        console.log("rejectedByOICap", handler.rejectedByOICap());
        console.log("takeovers", handler.takeovers(), "lapsesClosed", handler.lapsesClosed());
        console.log("lapsedUnpauseAttempts", handler.lapsedUnpauseAttempts());
        console.log("settledAtCap", handler.settledAtCap(), "fundingReceived", handler.ghostFundingReceived());
    }
}
