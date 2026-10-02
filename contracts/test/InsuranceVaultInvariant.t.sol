// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/InsuranceVault.sol";
import "../src/MockUSDC.sol";

/// @dev Drives the InsuranceVault through random sequences of LP deposits and
///      withdrawals, protocol inflows, bailouts, owner recapitalisation, plain
///      token transfers to the vault and share transfers between LPs.
contract InsuranceVaultHandler is Test {
    InsuranceVault public vault;
    MockUSDC       public usdc;
    address        public feeRtr;
    address        public exch;
    address        public owner;

    address[4] public actors;

    // Ghost accounting of tracked assets.
    uint256 public ghostIn;   // deposits + inflows + recapitalisations
    uint256 public ghostOut;  // withdrawals + bailouts
    uint256 public ghostGifts; // plain transfers (not tracked by the vault)

    uint256 public calls;

    constructor(InsuranceVault v, MockUSDC u, address fr, address ex, address own) {
        vault = v; usdc = u; feeRtr = fr; exch = ex; owner = own;
        actors = [makeAddr("lp1"), makeAddr("lp2"), makeAddr("lp3"), makeAddr("lp4")];
        for (uint256 i = 0; i < actors.length; i++) {
            vm.prank(actors[i]);
            usdc.approve(address(vault), type(uint256).max);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _mint(address to, uint256 amount) internal {
        vm.prank(usdc.owner());
        usdc.mint(to, amount);
    }

    function deposit(uint256 seed, uint256 amount) external {
        calls++;
        address who = _actor(seed);
        amount = bound(amount, 1, 1e30);
        uint256 supply = vault.totalSupply();
        if (supply != 0 && vault.totalAssets() == 0) return;     // VaultInsolvent
        if (vault.previewDeposit(amount) == 0) return;           // ZeroShares
        _mint(who, amount);
        uint256 valueBefore = vault.previewWithdraw(vault.balanceOf(actors[(seed + 1) % actors.length]));
        vm.prank(who);
        uint256 shares = vault.deposit(amount);
        // The new shares are never worth more than what was paid for them,
        // and another holder's value never drops because of a deposit.
        assertLe(vault.previewWithdraw(shares), amount, "deposit minted value from nothing");
        if (actors[(seed + 1) % actors.length] != who) {
            assertGe(
                vault.previewWithdraw(vault.balanceOf(actors[(seed + 1) % actors.length])),
                valueBefore,
                "deposit diluted another holder"
            );
        }
        ghostIn += amount;
    }

    function withdraw(uint256 seed, uint256 fracBps) external {
        calls++;
        address who = _actor(seed);
        uint256 bal = vault.balanceOf(who);
        if (bal == 0) return;
        uint256 shares = bal * bound(fracBps, 1, 10_000) / 10_000;
        if (shares == 0) shares = 1;
        vm.prank(who);
        uint256 out = vault.withdraw(shares);
        ghostOut += out;
    }

    function protocolInflow(uint256 amount) external {
        calls++;
        amount = bound(amount, 0, 1e30);
        _mint(feeRtr, amount);
        vm.startPrank(feeRtr);
        usdc.approve(address(vault), amount);
        vault.depositFromProtocol(amount);
        vm.stopPrank();
        ghostIn += amount;
    }

    function bailout(uint256 bps) external {
        calls++;
        uint256 amount = vault.totalAssets() * bound(bps, 0, 10_000) / 10_000;
        vm.prank(exch);
        vault.bailout(amount, makeAddr("trader"));
        ghostOut += amount;
    }

    function recapitalize(uint256 amount) external {
        calls++;
        amount = bound(amount, 1, 1e30);
        _mint(owner, amount);
        vm.startPrank(owner);
        usdc.approve(address(vault), amount);
        vault.recapitalize(amount);
        vm.stopPrank();
        ghostIn += amount;
    }

    function plainTransfer(uint256 seed, uint256 amount) external {
        calls++;
        amount = bound(amount, 1, 1e30);
        address who = _actor(seed);
        _mint(who, amount);
        vm.prank(who);
        usdc.transfer(address(vault), amount);
        ghostGifts += amount;
    }

    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 fracBps) external {
        calls++;
        address from = _actor(fromSeed);
        address to   = _actor(toSeed);
        uint256 amt = vault.balanceOf(from) * bound(fracBps, 0, 10_000) / 10_000;
        vm.prank(from);
        vault.transfer(to, amt);
    }

    function actorCount() external view returns (uint256) { return actors.length; }
}

/// @notice P1-05 invariants for the virtual-share InsuranceVault.
contract InsuranceVaultInvariantTest is Test {
    InsuranceVault        vault;
    MockUSDC              usdc;
    InsuranceVaultHandler handler;

    function setUp() public {
        usdc  = new MockUSDC();
        vault = new InsuranceVault(address(usdc));
        address fr = makeAddr("feeRouter");
        address ex = makeAddr("exchange");
        vault.setFeeRouter(fr);
        vault.setExchange(ex);

        // The handler pranks as this contract, which owns both the vault
        // (recapitalize is onlyOwner) and MockUSDC (mint is onlyOwner).
        handler = new InsuranceVaultHandler(vault, usdc, fr, ex, address(this));
        targetContract(address(handler));
    }

    /// @dev Total value of all shares never exceeds the vault's assets.
    function invariant_sharesNeverWorthMoreThanAssets() public view {
        assertLe(vault.previewWithdraw(vault.totalSupply()), vault.totalAssets());
    }

    /// @dev Same, summed holder by holder (each rounded down on its own).
    function invariant_sumOfHolderValuesWithinAssets() public view {
        uint256 sum;
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            sum += vault.previewWithdraw(vault.balanceOf(handler.actors(i)));
        }
        assertLe(sum, vault.totalAssets());
    }

    /// @dev Tracked assets are always backed by real tokens.
    function invariant_trackedAssetsBacked() public view {
        assertGe(usdc.balanceOf(address(vault)), vault.totalAssets());
    }

    /// @dev Tracked assets are exactly what came in through the tracked entry
    ///      points minus what went out; plain transfers never count.
    function invariant_trackedAssetsAccounting() public view {
        assertEq(vault.totalAssets(), handler.ghostIn() - handler.ghostOut());
        assertEq(usdc.balanceOf(address(vault)), vault.totalAssets() + handler.ghostGifts());
    }

    /// @dev Display price is consistent with redemption: redeeming one whole
    ///      pIV never pays more than the displayed price (solvent states).
    function invariant_displayPriceNotBelowRedemption() public view {
        uint256 supply = vault.totalSupply();
        if (supply == 0) return;
        uint256 one = 10 ** vault.decimals();
        // Only meaningful while at least one whole share's worth is priced
        // above dust (assets * V >= supply).
        if (vault.totalAssets() * 1e6 < supply) return;
        assertLe(vault.previewWithdraw(one), vault.getSharePrice() + 1);
    }
}
