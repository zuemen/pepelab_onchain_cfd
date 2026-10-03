// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/PerpetualExchange.sol";
import "../../src/MockOracle.sol";
import "../../src/settlement/WrappedUSDC18.sol";
import "../../src/settlement/SettlementDepositRouter.sol";
import "./MockFiatUSDC6.sol";

/// @dev Drives the wrapper through every edge the ADR relies on and checks
///      each call's outcome against an independent model of when it must
///      succeed or revert (blacklist, pause, transfer fee, sub-unit and
///      over-balance unwraps, third-party recipients, router deposits).
///      Every mismatch between model and contract is counted; the invariant
///      test requires zero. Calls are wrapped in try/catch so reverting edges
///      are actually exercised (not filtered out by `bound`).
contract WrappedUSDC18Handler is Test {
    MockFiatUSDC6 public usdc;
    WrappedUSDC18 public w;
    SettlementDepositRouter public router;
    PerpetualExchange public exchange;
    uint256 public constant SCALE = 1e12;

    address[] public actors;     // hold wrapper units
    address[] public recipients; // third parties that only ever receive USDC

    uint256 public ghostDeposited;   // USDC that entered via a successful wrap / route
    uint256 public ghostDonated;     // USDC sent straight to the wrapper
    uint256 public ghostPaid;        // USDC that left the wrapper via unwraps
    uint256 public ghostMismatch;    // model said succeed but reverted, or vice versa
    uint256 public ghostI3Violation; // an unwrap paid/burned outside floor(amount)
    uint256 public revertsHit;       // reverting edges actually exercised
    uint256 public routed;           // successful router deposits

    constructor(MockFiatUSDC6 u, WrappedUSDC18 w_, SettlementDepositRouter r, PerpetualExchange ex) {
        usdc = u;
        w = w_;
        router = r;
        exchange = ex;
        for (uint256 i; i < 4; ++i) {
            address a = address(uint160(0xA11CE + i));
            actors.push(a);
            recipients.push(address(uint160(0xBEEF00 + i)));
            usdc.mint(a, 1e15); // 1e9 USDC each
            vm.startPrank(a);
            usdc.approve(address(w), type(uint256).max);
            usdc.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _actor(uint256 s) internal view returns (address) { return actors[s % actors.length]; }
    function _bl(address a) internal view returns (bool) { return usdc.isBlacklisted(a); }
    function _check(bool expectedOk, bool ok) internal {
        if (expectedOk != ok) ghostMismatch++;
        if (!ok) revertsHit++;
    }

    // ── wrapper entry points ─────────────────────────────────────────────

    function wrap(uint256 s, uint256 amt) external {
        address a = _actor(s);
        amt = bound(amt, 0, usdc.balanceOf(a));
        // a fee that rounds to 0 on this amount still delivers 1:1
        bool expectOk = amt > 0 && !usdc.paused() && !_bl(a) && amt * usdc.feeBps() / 10_000 == 0;
        uint256 supplyBefore = w.totalSupply();
        vm.prank(a);
        try w.depositFor(a, amt) returns (uint256 minted) {
            _check(expectOk, true);
            ghostDeposited += amt;
            if (minted != amt * SCALE || w.totalSupply() - supplyBefore != minted) ghostMismatch++;
        } catch {
            _check(expectOk, false);
        }
    }

    /// `amt` deliberately ranges below one unit and above the balance.
    function unwrap(uint256 s, uint256 rs, uint256 amt, bool thirdParty) external {
        address a = _actor(s);
        address to = thirdParty ? recipients[rs % recipients.length] : _actor(rs);
        uint256 bal = w.balanceOf(a);
        amt = bound(amt, 0, bal + 2 * SCALE);
        uint256 burnable = amt - (amt % SCALE);
        bool expectOk = burnable > 0 && burnable <= bal && !usdc.paused() && !_bl(a) && !_bl(to);

        uint256 wUsdcBefore = usdc.balanceOf(address(w));
        vm.prank(a);
        try w.withdrawTo(to, amt) returns (uint256 paid) {
            _check(expectOk, true);
            uint256 left = wUsdcBefore - usdc.balanceOf(address(w)); // observed, not recomputed
            uint256 burned = bal - w.balanceOf(a);
            if (left != paid || left * SCALE != burned || burned > amt || amt - burned >= SCALE) ghostI3Violation++;
            ghostPaid += left;
        } catch {
            _check(expectOk, false);
        }
    }

    /// Arbitrary 18-dec movement between holders (like a PnL credit).
    function move(uint256 s1, uint256 s2, uint256 amt) external {
        address from = _actor(s1);
        address to = _actor(s2);
        uint256 bal = w.balanceOf(from);
        amt = bound(amt, 0, bal + 1);
        bool expectOk = amt <= bal && !_bl(from) && !_bl(to);
        vm.prank(from);
        try w.transfer(to, amt) {
            _check(expectOk, true);
        } catch {
            _check(expectOk, false);
        }
    }

    /// One-tx deposit through the router into the (unmodified) exchange.
    function route(uint256 s, uint256 amt) external {
        address a = _actor(s);
        amt = bound(amt, 0, usdc.balanceOf(a));
        // a fee that rounds to 0 on this amount still delivers 1:1
        bool expectOk = amt > 0 && !usdc.paused() && !_bl(a) && amt * usdc.feeBps() / 10_000 == 0;
        uint256 marginBefore = exchange.freeMargin(a);
        vm.prank(a);
        try router.depositMargin(a, amt) returns (uint256 margin) {
            _check(expectOk, true);
            ghostDeposited += amt;
            routed++;
            if (margin != amt * SCALE || exchange.freeMargin(a) - marginBefore != margin) ghostMismatch++;
            if (usdc.balanceOf(address(router)) != 0 || w.balanceOf(address(router)) != 0) ghostMismatch++;
        } catch {
            _check(expectOk, false);
        }
    }

    // ── environment ──────────────────────────────────────────────────────

    function donate(uint256 amt) external {
        if (usdc.paused() || usdc.feeBps() != 0) return;
        amt = bound(amt, 1, 1e12);
        usdc.mint(address(this), amt);
        usdc.transfer(address(w), amt);
        ghostDonated += amt;
    }

    function togglePause(bool p) external {
        if (p) usdc.pause(); else usdc.unpause();
    }

    function toggleBlacklist(uint256 s, bool b) external {
        address a = _actor(s);
        if (b) usdc.blacklist(a); else usdc.unBlacklist(a);
    }

    function toggleFee(bool on) external {
        usdc.setFeeBps(on ? 100 : 0);
    }

    function actorCount() external view returns (uint256) { return actors.length; }
}

/// @notice ADR-011 invariants for WrappedUSDC18 (plain FiatToken-like underlying).
/// @dev Each handler call is heavy (real exchange + router); 64 x 500 keeps the
///      campaign at 32k calls so the CI test job stays well inside its timeout.
/// forge-config: default.invariant.runs = 64
contract WrappedUSDC18InvariantTest is Test {
    MockFiatUSDC6 usdc;
    WrappedUSDC18 w;
    SettlementDepositRouter router;
    PerpetualExchange exchange;
    WrappedUSDC18Handler h;

    function setUp() public {
        usdc = new MockFiatUSDC6();
        w = new WrappedUSDC18(address(usdc), "Wrapped USDC", "wUSDC");
        MockOracle oracle = new MockOracle();
        exchange = new PerpetualExchange(address(w), address(oracle), address(0));
        router = new SettlementDepositRouter(address(w), address(exchange));
        exchange.setAgentAuthorized(address(router), true);
        h = new WrappedUSDC18Handler(usdc, w, router, exchange);
        targetContract(address(h));
    }

    /// I1: wrapped supply × 1e-12 ≤ USDC actually held.
    function invariant_I1_supplyBackedByUsdc() public view {
        assertLe(w.totalSupply(), usdc.balanceOf(address(w)) * w.SCALE());
    }

    /// I2: supply is always whole USDC units (dust lives only in balances).
    function invariant_I2_supplyIsWholeUnits() public view {
        assertEq(w.totalSupply() % w.SCALE(), 0);
    }

    /// I3, observed: every successful unwrap moved exactly floor(amount)
    /// out of the wrapper and burned exactly that many units.
    function invariant_I3_unwrapPaysObservedFloor() public view {
        assertEq(h.ghostI3Violation(), 0);
    }

    /// Every call succeeded or reverted exactly when the model said it should
    /// (blacklist parity, pause, fee fail-closed, sub-unit / over-balance).
    function invariant_behaviourMatchesModel() public view {
        assertEq(h.ghostMismatch(), 0);
    }

    /// No value is created: supply plus everything paid out equals exactly
    /// everything deposited (so dust + paid can never exceed deposits).
    function invariant_noValueCreated() public view {
        assertEq(w.totalSupply() + h.ghostPaid() * w.SCALE(), h.ghostDeposited() * w.SCALE());
    }

    /// USDC held == deposited + donated − paid (donations back nothing).
    function invariant_usdcConservation() public view {
        assertEq(usdc.balanceOf(address(w)), h.ghostDeposited() + h.ghostDonated() - h.ghostPaid());
    }

    /// Every wrapper unit sits with a known holder (actors or the exchange):
    /// nothing was minted to or stranded at an unexpected address.
    function invariant_holdersSumToSupply() public view {
        uint256 sum = w.balanceOf(address(exchange));
        for (uint256 i; i < h.actorCount(); ++i) sum += w.balanceOf(h.actors(i));
        assertEq(sum, w.totalSupply());
    }

    /// Prints how often the reverting edges were exercised (sanity, not an assertion).
    function afterInvariant() public view {
        console.log("reverting edges hit:", h.revertsHit(), " router deposits:", h.routed());
    }
}

/// @dev M-1: a hooked underlying whose send hook re-enters `depositFor`.
contract HookedReentrantActor is ISendHook {
    WrappedUSDC18 public w;
    HookedUSDC6 public u;
    uint256 public inner;
    bool entered;
    constructor(WrappedUSDC18 w_, HookedUSDC6 u_) { w = w_; u = u_; u_.approve(address(w_), type(uint256).max); }
    function attack(uint256 outer_, uint256 inner_) external returns (uint256) {
        inner = inner_;
        entered = false;
        return w.depositFor(address(this), outer_);
    }
    function unwrapAll() external returns (uint256) {
        return w.withdrawTo(address(this), w.maxUnwrappable(address(this)));
    }
    function tokensToSend(address, address, uint256) external {
        if (msg.sender != address(u) || entered) return;
        entered = true;
        w.depositFor(address(this), inner);
    }
}

contract HookedWrapperHandler is Test {
    HookedUSDC6 public u;
    WrappedUSDC18 public w;
    HookedReentrantActor public attacker;
    address public honest = address(0xB0B);
    uint256 public ghostDeposited;
    uint256 public ghostPaid;

    constructor(HookedUSDC6 u_, WrappedUSDC18 w_) {
        u = u_;
        w = w_;
        attacker = new HookedReentrantActor(w, u);
        u.register(address(attacker));
        u.mint(address(attacker), 1e15);
        u.mint(honest, 1e15);
        vm.prank(honest);
        u.approve(address(w), type(uint256).max);
    }

    function attack(uint256 outer, uint256 inner, bool bubble) external {
        u.setBubble(bubble);
        uint256 bal = u.balanceOf(address(attacker));
        if (bal < 2) return;
        outer = bound(outer, 1, bal / 2);
        inner = bound(inner, 1, bal / 2);
        try attacker.attack(outer, inner) returns (uint256 minted) {
            ghostDeposited += minted / 1e12;
        } catch {}
        u.setBubble(false);
    }

    function honestWrap(uint256 amt) external {
        amt = bound(amt, 1, 1e12);
        vm.prank(honest);
        w.depositFor(honest, amt);
        ghostDeposited += amt;
    }

    function attackerCashOut() external {
        if (w.maxUnwrappable(address(attacker)) == 0) return;
        uint256 before = u.balanceOf(address(w));
        attacker.unwrapAll();
        ghostPaid += before - u.balanceOf(address(w));
    }
}

/// @notice ADR-011 M-1: under a re-entering hooked underlying, I1 and
///         exact conservation still hold (no double mint, honest holder
///         always fully redeemable).
/// forge-config: default.invariant.runs = 64
contract WrappedUSDC18HookedInvariantTest is Test {
    HookedUSDC6 u;
    WrappedUSDC18 w;
    HookedWrapperHandler h;

    function setUp() public {
        u = new HookedUSDC6();
        w = new WrappedUSDC18(address(u), "W", "W");
        h = new HookedWrapperHandler(u, w);
        targetContract(address(h));
    }

    function invariant_hooked_I1() public view {
        assertLe(w.totalSupply(), u.balanceOf(address(w)) * w.SCALE());
    }

    function invariant_hooked_noDoubleMint() public view {
        assertEq(w.totalSupply() + h.ghostPaid() * w.SCALE(), h.ghostDeposited() * w.SCALE());
        // no donations in this campaign, so backing is exact
        assertEq(u.balanceOf(address(w)) * w.SCALE(), w.totalSupply());
    }

    function invariant_hooked_honestFullyRedeemable() public view {
        assertGe(u.balanceOf(address(w)) * w.SCALE(), w.balanceOf(h.honest()));
    }
}
