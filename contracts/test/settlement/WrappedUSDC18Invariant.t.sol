// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/settlement/WrappedUSDC18.sol";
import "./MockFiatUSDC6.sol";

/// @dev Random wraps, unwraps (arbitrary 18-dec amounts), 18-dec transfers
///      between holders, direct USDC donations, and USDC pause toggles.
contract WrappedUSDC18Handler is Test {
    MockFiatUSDC6 public usdc;
    WrappedUSDC18 public w;
    address[] public actors;

    uint256 public ghostDeposited; // USDC that entered through depositFor
    uint256 public ghostDonated;   // USDC sent straight to the wrapper
    uint256 public ghostPaid;      // USDC paid out by withdrawTo
    uint256 public ghostOverpay;   // times a single unwrap paid > amount / SCALE

    constructor(MockFiatUSDC6 u, WrappedUSDC18 w_) {
        usdc = u;
        w = w_;
        for (uint256 i; i < 4; ++i) {
            address a = address(uint160(0xA11CE + i));
            actors.push(a);
            usdc.mint(a, 1e15); // 1e9 USDC each
            vm.prank(a);
            usdc.approve(address(w), type(uint256).max);
        }
    }

    function _actor(uint256 s) internal view returns (address) { return actors[s % actors.length]; }

    function wrap(uint256 s, uint256 amt) external {
        if (usdc.paused()) return;
        address a = _actor(s);
        amt = bound(amt, 1, usdc.balanceOf(a) == 0 ? 1 : usdc.balanceOf(a));
        if (usdc.balanceOf(a) == 0) return;
        vm.prank(a);
        w.depositFor(a, amt);
        ghostDeposited += amt;
    }

    function unwrap(uint256 s, uint256 amt) external {
        if (usdc.paused()) return;
        address a = _actor(s);
        uint256 bal = w.balanceOf(a);
        if (bal < w.SCALE()) return;
        amt = bound(amt, w.SCALE(), bal);
        vm.prank(a);
        uint256 paid = w.withdrawTo(a, amt);
        if (paid > amt / w.SCALE()) ghostOverpay++;
        ghostPaid += paid;
    }

    function move(uint256 s1, uint256 s2, uint256 amt) external {
        address from = _actor(s1);
        uint256 bal = w.balanceOf(from);
        if (bal == 0) return;
        amt = bound(amt, 1, bal); // arbitrary 18-dec units, like a PnL credit
        vm.prank(from);
        w.transfer(_actor(s2), amt);
    }

    function donate(uint256 amt) external {
        if (usdc.paused()) return;
        amt = bound(amt, 1, 1e12);
        usdc.mint(address(this), amt);
        usdc.transfer(address(w), amt);
        ghostDonated += amt;
    }

    function togglePause(bool p) external {
        if (p) usdc.pause(); else usdc.unpause();
    }

    function actorCount() external view returns (uint256) { return actors.length; }
}

/// @notice ADR-011 invariants for WrappedUSDC18.
contract WrappedUSDC18InvariantTest is Test {
    MockFiatUSDC6 usdc;
    WrappedUSDC18 w;
    WrappedUSDC18Handler h;

    function setUp() public {
        usdc = new MockFiatUSDC6();
        w = new WrappedUSDC18(address(usdc), "Wrapped USDC", "USDC");
        h = new WrappedUSDC18Handler(usdc, w);
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

    /// I3: no single unwrap ever paid more than amount / SCALE.
    function invariant_I3_neverOverpays() public view {
        assertEq(h.ghostOverpay(), 0);
    }

    /// Conservation: USDC held == deposited + donated − paid, and supply is
    /// exactly (deposited − paid) × SCALE (donations back nothing).
    function invariant_conservation() public view {
        assertEq(usdc.balanceOf(address(w)), h.ghostDeposited() + h.ghostDonated() - h.ghostPaid());
        assertEq(w.totalSupply(), (h.ghostDeposited() - h.ghostPaid()) * w.SCALE());
    }

    /// Dust bound: what is stuck below one unit across all holders is
    /// < (holders) units, i.e. the claim on USDC lost to rounding is bounded.
    function invariant_dustBound() public view {
        uint256 dust;
        for (uint256 i; i < h.actorCount(); ++i) dust += w.balanceOf(h.actors(i)) % w.SCALE();
        assertLt(dust, h.actorCount() * w.SCALE());
    }
}
