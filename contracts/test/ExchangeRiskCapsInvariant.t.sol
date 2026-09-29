// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

/// @dev Drives the exchange with random opens, closes, liquidations and price
///      moves on one asset. Inputs are bounded to the plausible range so the
///      fuzzer spends its budget on real states. Time never advances, so no
///      funding accrues (see the invariant contract's NatSpec for why).
contract ExchangeCapsHandler is Test {
    PerpetualExchange public exchange;
    MockUSDC          public usdc;
    MockOracle        public oracle;
    bytes32           public asset;

    address[3] public actors;
    address    public liquidator;

    /// every position id this handler ever opened, and the still-open subset
    uint256[] public allIds;
    uint256[] public openIds;

    /// Σ profitCapOf(id) over every position that has been settled (closed,
    /// liquidated or auto-deleveraged) — the ghost the drain bound uses.
    uint256 public ghostSettledCaps;

    /// Independent bookkeeping of the open book, maintained from what the
    /// handler observes (notional at open, removal when a position is seen
    /// closed) — never read from the exchange's own OI counters.
    uint256 public ghostLongOI;
    uint256 public ghostShortOI;
    uint256 public ghostLongSize;
    uint256 public ghostShortSize;
    /// Successful opens after which the side's OI, valued at the index,
    /// exceeded its cap (must stay 0).
    uint256 public ghostOpensAboveCap;
    uint256 public ghostOpenCaps;
    /// Positions whose frozen cap did not equal margin × maxProfitBps at open.
    uint256 public ghostCapMismatches;
    uint256 public immutable profitBps;
    uint256 internal _lastTarget;

    // call counters, to show the run actually exercised each path
    uint256 public opens;
    uint256 public opensRejectedByOICap;
    uint256 public opensFailedOther;
    uint256 public closes;
    uint256 public liquidations;
    uint256 public priceMoves;
    uint256 public settledAtCap;   // settlements where the cap actually bound
    uint256 public settledByAdl;   // positions closed as ADL counterparties

    constructor(PerpetualExchange e, MockUSDC u, MockOracle o, bytes32 a, uint256 bps) {
        exchange = e; usdc = u; oracle = o; asset = a; profitBps = bps;
        actors = [makeAddr("a1"), makeAddr("a2"), makeAddr("a3")];
        liquidator = makeAddr("liquidator");
    }

    function actorCount() external view returns (uint256) { return actors.length; }
    function openCount() external view returns (uint256) { return openIds.length; }
    function allCount() external view returns (uint256) { return allIds.length; }

    // ── actions ──────────────────────────────────────────────────────────────

    function open(uint256 actorSeed, bool isLong, uint256 margin, uint256 leverage) external {
        address who = actors[actorSeed % actors.length];
        margin   = bound(margin, 10e18, 5_000e18);
        leverage = bound(leverage, 1, 5);
        if (exchange.freeMargin(who) < margin * 2) return; // margin + fee, generously

        // Predict the OI cap independently and require the exact revert.
        // OI is capped on size × current index price; the new position's size
        // is booked at the mark the book shows before it opens.
        uint256 notional  = margin * leverage;
        uint256 size      = notional * 1e18 / exchange.getMarkPrice(asset);
        (uint256 raw,)    = oracle.getPrice(asset);
        uint256 index     = raw * 1e10;
        uint256 cap       = isLong ? exchange.maxLongOI(asset) : exchange.maxShortOI(asset);
        uint256 resulting = ((isLong ? ghostLongSize : ghostShortSize) + size) * index / 1e18;
        if (cap != 0 && resulting > cap) {
            vm.prank(who);
            vm.expectRevert(abi.encodeWithSelector(
                PerpetualExchange.OpenInterestCapExceeded.selector, asset, isLong, resulting, cap
            ));
            exchange.openPosition(asset, isLong, margin, leverage);
            ++opensRejectedByOICap;
            return;
        }

        vm.prank(who);
        try exchange.openPosition(asset, isLong, margin, leverage) returns (uint256 id) {
            allIds.push(id);
            openIds.push(id);
            ++opens;
            if (isLong) { ghostLongOI += notional; ghostLongSize += size; }
            else        { ghostShortOI += notional; ghostShortSize += size; }
            (uint256 lv, uint256 sv) = exchange.openInterestValue(asset);
            if (cap != 0 && (isLong ? lv : sv) > cap) ++ghostOpensAboveCap;
            uint256 profitCap = exchange.profitCapOf(id);
            ghostOpenCaps += profitCap;
            if (profitCap != margin * profitBps / 10_000) ++ghostCapMismatches;
        } catch {
            ++opensFailedOther;
        }
    }

    function close(uint256 idxSeed) external {
        if (openIds.length == 0) return;
        uint256 id = openIds[idxSeed % openIds.length];
        _lastTarget = id;
        address owner = exchange.getPosition(id).owner;
        vm.prank(owner);
        try exchange.closePosition(id) { ++closes; } catch {}
        _sync();
    }

    function liquidate(uint256 idxSeed) external {
        if (openIds.length == 0) return;
        uint256 id = openIds[idxSeed % openIds.length];
        _lastTarget = id;
        vm.prank(liquidator);
        try exchange.liquidatePosition(id) { ++liquidations; } catch {}
        _sync();
    }

    /// Moves the index by up to ±25%, kept inside [20,000, 400,000].
    function movePrice(uint256 bpsSeed, bool up) external {
        (uint256 p,) = oracle.getPrice(asset);
        uint256 bps = bound(bpsSeed, 1, 2_500);
        uint256 next = up ? p + p * bps / 10_000 : p - p * bps / 10_000;
        if (next < 20_000e8)  next = 20_000e8;
        if (next > 400_000e8) next = 400_000e8;
        oracle.updatePrice(asset, next);
        ++priceMoves;
    }

    /// Moves every newly-closed id (close, liquidation, and any ADL victims it
    /// triggered) out of the open list and adds its cap to the ghost.
    function _sync() internal {
        uint256 i;
        while (i < openIds.length) {
            uint256 id = openIds[i];
            PerpetualExchange.Position memory p = exchange.getPosition(id);
            if (p.isOpen) { ++i; continue; }
            uint256 cap = exchange.profitCapOf(id);
            ghostSettledCaps += cap;
            if (p.realizedPnL == SafeCast.toInt256(cap)) ++settledAtCap;
            if (id != _lastTarget) ++settledByAdl;
            ghostOpenCaps    -= cap;
            uint256 psize = p.margin * p.leverage * 1e18 / p.entryPrice;
            if (p.isLong) { ghostLongOI -= p.margin * p.leverage; ghostLongSize -= psize; }
            else          { ghostShortOI -= p.margin * p.leverage; ghostShortSize -= psize; }
            openIds[i] = openIds[openIds.length - 1];
            openIds.pop();
        }
    }
}

/// @notice P1 invariants for the open-interest and profit caps.
///
/// Configuration (set explicitly in setUp — an unconfigured cap would make
/// the first two invariants vacuous): maxLongOI = 60,000, maxShortOI = 40,000
/// (18-dec notional), maxProfitBps = 20,000 (200% of margin), mark premium
/// cap 50 bps, ADL on, trading fee 0.1%, no InsuranceVault / FeeRouter.
///
/// Runs and depth follow the project defaults — `foundry.toml` sets no
/// `[invariant]` section, so Foundry's defaults apply.
contract ExchangeRiskCapsInvariantTest is Test {
    PerpetualExchange    exchange;
    MockUSDC             usdc;
    MockOracle           oracle;
    ExchangeCapsHandler  handler;

    bytes32 constant BTC = keccak256("BTC");
    uint256 constant MAX_LONG_OI   = 60_000e18;
    uint256 constant MAX_SHORT_OI  = 40_000e18;
    uint256 constant PROFIT_BPS    = 20_000;
    uint256 constant RESERVE       = 5_000_000e18;
    uint256 constant PER_ACTOR     = 200_000e18;

    function setUp() public {
        usdc     = new MockUSDC();
        oracle   = new MockOracle();
        exchange = new PerpetualExchange(address(usdc), address(oracle), address(0));
        oracle.addAsset(BTC, 100_000e8);

        exchange.setExecutionFee(0);
        exchange.setMaxOpenInterest(BTC, MAX_LONG_OI, MAX_SHORT_OI);
        exchange.setMaxProfitBps(BTC, PROFIT_BPS);
        exchange.setMarkPremiumCapBps(50);
        exchange.setAdlEnabled(true);

        handler = new ExchangeCapsHandler(exchange, usdc, oracle, BTC, PROFIT_BPS);
        // MockOracle.updatePrice is owner-gated; hand the oracle to the handler.
        oracle.transferOwnership(address(handler));

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
    // The cap is on size × current index price and is enforced at open: a
    // later price move may lift a side above it (that refuses new exposure,
    // it does not force anyone out), so the property is checked right after
    // every successful open rather than as a standing state predicate.

    function invariant_opensNeverLeaveSideAboveCap() public view {
        assertEq(handler.ghostOpensAboveCap(), 0);
    }

    // ── 2. OI accounting equals the sum of open positions ───────────────────

    /// The exchange's OI counters must equal the notional of the positions
    /// that are actually open, as tracked independently by the handler (a
    /// position the exchange closed through ADL is picked up by the handler's
    /// scan of its open list after every close / liquidation).
    function invariant_openInterestEqualsSumOfOpenPositions() public view {
        assertEq(exchange.globalLongNotional(BTC), handler.ghostLongOI(), "long OI != sum of open longs");
        assertEq(exchange.globalShortNotional(BTC), handler.ghostShortOI(), "short OI != sum of open shorts");
        assertEq(exchange.openPositionCountFor(BTC), handler.openCount(), "ADL index != open positions");
        assertEq(exchange.longOpenSize(BTC), handler.ghostLongSize(), "long size != sum of open longs");
        assertEq(exchange.shortOpenSize(BTC), handler.ghostShortSize(), "short size != sum of open shorts");
    }

    // ── 3. Solvency: the pool can lose at most the settled positions' caps ──
    //
    // Let B = exchange USDC balance, C = Σ freeMargin (every claim withdrawable
    // right now), R = the reserve seeded in setUp. Initially B − C = R.
    //
    // Every flow in this configuration changes S = B − C as follows:
    //   deposit / withdraw          ΔS = 0 (B and C move together)
    //   open                        ΔS = +(margin + tradingFee) ≥ 0
    //   close                       ΔS = −payout,  payout = max(0, margin + pnl − fees)
    //   liquidation                 ΔS = −(refund + liquidatorReward) ≥ −max(0, closeAmount)
    //   ADL of a counterparty       ΔS = −payout,  payout ≤ margin + pnl − haircut
    //   price move                  ΔS = 0
    // and in every settlement pnl ≤ profitCapOf(id) (the cap under test). So a
    // position's lifetime contribution is ≥ (margin + fee) − (margin + cap) ≥
    // −cap, and an open position contributes ≥ 0. Summing:
    //
    //       B − C  ≥  R − Σ_{settled positions} profitCapOf(id)
    //
    // WHAT THIS PROVES: no settlement path — voluntary close, liquidation
    // (reward, penalty, refund), ADL, the mark premium, fees — ever pays a
    // position more than margin + its profit cap, and nothing else moves value
    // out of the pool. Equivalently: each position can drain at most its cap.
    //
    // WHAT IT DOES NOT PROVE:
    //   • that B ≥ C at all times — a long enough run of capped winners can
    //     still exhaust any finite reserve; that is market risk, sized by the
    //     operator using the OI caps (at a given price level the open book's
    //     worst case is about (maxLongOI + maxShortOI) × maxProfitBps / price
    //     move; after a fall, more entry notional fits under the same cap);
    //   • anything about funding: time is frozen, so no funding accrues. A
    //     funding RECEIVER is paid margin + pnl + receipt, which can exceed
    //     margin + cap; including funding needs an extra receipt term;
    //   • InsuranceVault bailouts / penalties and FeeRouter performance fees
    //     (not wired here; they move value across the pool boundary).
    function invariant_poolDrainBoundedBySettledProfitCaps() public view {
        uint256 b = usdc.balanceOf(address(exchange));
        uint256 c;
        for (uint256 i; i < handler.actorCount(); ++i) {
            c += exchange.freeMargin(handler.actors(i));
        }
        // B − C ≥ R − G, rearranged so every term stays unsigned: B + G ≥ C + R.
        assertGe(b + handler.ghostSettledCaps(), c + RESERVE);
    }

    /// Every position in the run was opened with cap = margin × maxProfitBps
    /// (otherwise the drain bound above would be vacuous for it).
    function invariant_everyPositionIsCapped() public view {
        assertEq(handler.ghostCapMismatches(), 0);
    }

    /// Full cross-check of the incremental ghosts against the exchange's own
    /// position records, run once per run rather than after every call.
    function afterInvariant() external view {
        uint256 longSum;
        uint256 shortSum;
        uint256 n = handler.allCount();
        for (uint256 i; i < n; ++i) {
            PerpetualExchange.Position memory p = exchange.getPosition(handler.allIds(i));
            if (!p.isOpen) continue;
            if (p.isLong) longSum += p.margin * p.leverage;
            else          shortSum += p.margin * p.leverage;
        }
        assertEq(exchange.globalLongNotional(BTC), longSum);
        assertEq(exchange.globalShortNotional(BTC), shortSum);
        // Coverage evidence in -vv output; not an assertion.
        console.log("opens", handler.opens(), "rejectedByOICap", handler.opensRejectedByOICap());
        console.log("opensFailedOther", handler.opensFailedOther());
        console.log("closes", handler.closes(), "liquidations", handler.liquidations());
        console.log("priceMoves", handler.priceMoves(), "settledAtCap", handler.settledAtCap());
        console.log("settledByAdl", handler.settledByAdl());
    }
}
