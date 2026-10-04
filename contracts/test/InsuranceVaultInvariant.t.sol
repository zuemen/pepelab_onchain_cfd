// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/InsuranceVault.sol";
import "../src/MockUSDC.sol";

/// @dev Drives the InsuranceVault through random sequences of LP deposits and
///      withdrawals, protocol inflows, bailouts, owner recapitalisation, plain
///      token transfers to the vault and share transfers between LPs.
///
///      Every vault call is wrapped in try/catch. A revert the handler did not
///      predict is counted in `unexpectedReverts` (and checked by an
///      invariant) instead of being swallowed by the fuzzer, and per-call
///      properties are recorded as violation counters rather than asserted
///      here (an assertion inside a handler only reverts the call, which
///      `fail_on_revert = false` would hide). The one revert that IS expected
///      is a deposit whose share count overflows after bailouts crushed the
///      share price to dust (docs/INSURANCE_VAULT_SHARES.md §2, L-4); it is
///      counted separately in `expectedOverflows`.
contract InsuranceVaultHandler is Test {
    InsuranceVault public vault;
    MockUSDC       public usdc;
    address        public feeRtr;
    address        public exch;
    address        public owner;

    address[4] public actors;

    // Ghost accounting of tracked assets.
    uint256 public ghostIn;    // deposits + inflows + recapitalisations
    uint256 public ghostOut;   // withdrawals + bailouts
    uint256 public ghostGifts; // plain transfers (not tracked by the vault)

    uint256 public calls;

    // Revert bookkeeping.
    uint256 public unexpectedReverts;
    string  public lastUnexpectedAction;
    bytes   public lastUnexpectedError;
    uint256 public expectedOverflows;

    // Per-call property violations.
    uint256 public mintedValueFromNothing; // previewWithdraw(new shares) > amount paid
    uint256 public dilutedOtherHolder;     // another holder's value fell on a deposit
    uint256 public previewMismatch;        // deposit/withdraw result != its preview

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

    function _unexpected(string memory action, bytes memory err) internal {
        unexpectedReverts++;
        lastUnexpectedAction = action;
        lastUnexpectedError = err;
    }

    /// @dev Panic(0x11): arithmetic overflow, as raised by Math.mulDiv and by
    ///      checked addition in ERC20._update.
    function _isOverflowPanic(bytes memory err) internal pure returns (bool) {
        if (err.length != 36 || bytes4(err) != bytes4(0x4e487b71)) return false;
        uint256 code;
        assembly { code := mload(add(err, 36)) }
        return code == 0x11;
    }

    /// @dev The share price is "crushed" when one whole asset unit buys more
    ///      than 10^6 share units, i.e. totalAssets * 1e6 < totalSupply: only
    ///      reachable through bailouts that leave dust behind.
    function _priceCrushed() internal view returns (bool) {
        return vault.totalAssets() * 1e6 < vault.totalSupply();
    }

    function deposit(uint256 seed, uint256 amount) external {
        calls++;
        address who = _actor(seed);
        amount = bound(amount, 1, 1e30);
        uint256 supply = vault.totalSupply();
        if (supply != 0 && vault.totalAssets() == 0) return;     // VaultInsolvent (H-4), by design

        uint256 preview;
        try vault.previewDeposit(amount) returns (uint256 s) {
            preview = s;
        } catch (bytes memory err) {
            if (_isOverflowPanic(err) && _priceCrushed()) { expectedOverflows++; return; }
            _unexpected("previewDeposit", err);
            return;
        }
        if (preview == 0) return;                                 // ZeroShares, by design
        if (preview > type(uint256).max - supply) {               // totalSupply would overflow
            if (_priceCrushed()) expectedOverflows++;
            else _unexpected("deposit: supply overflow outside crushed price", "");
            return;
        }

        _mint(who, amount);
        address other = actors[(seed % actors.length + 1) % actors.length];
        uint256 otherBefore = vault.previewWithdraw(vault.balanceOf(other));
        vm.prank(who);
        try vault.deposit(amount) returns (uint256 shares) {
            if (shares != preview) previewMismatch++;
            if (vault.previewWithdraw(shares) > amount) mintedValueFromNothing++;
            if (other != who && vault.previewWithdraw(vault.balanceOf(other)) < otherBefore) dilutedOtherHolder++;
            ghostIn += amount;
        } catch (bytes memory err) {
            _unexpected("deposit", err);
        }
    }

    function withdraw(uint256 seed, uint256 fracBps) external {
        calls++;
        address who = _actor(seed);
        uint256 bal = vault.balanceOf(who);
        if (bal == 0) return;
        uint256 shares = Math.mulDiv(bal, bound(fracBps, 1, 10_000), 10_000);
        if (shares == 0) shares = 1;
        uint256 preview = vault.previewWithdraw(shares);
        vm.prank(who);
        try vault.withdraw(shares) returns (uint256 out) {
            if (out != preview) previewMismatch++;
            ghostOut += out;
        } catch (bytes memory err) {
            _unexpected("withdraw", err);
        }
    }

    function protocolInflow(uint256 amount) external {
        calls++;
        amount = bound(amount, 0, 1e30);
        _mint(feeRtr, amount);
        vm.startPrank(feeRtr);
        usdc.approve(address(vault), amount);
        try vault.depositFromProtocol(amount) {
            ghostIn += amount;
        } catch (bytes memory err) {
            _unexpected("depositFromProtocol", err);
        }
        vm.stopPrank();
    }

    function bailout(uint256 bps) external {
        calls++;
        uint256 amount = vault.totalAssets() * bound(bps, 0, 10_000) / 10_000;
        vm.prank(exch);
        try vault.bailout(amount, makeAddr("trader")) {
            ghostOut += amount;
        } catch (bytes memory err) {
            _unexpected("bailout", err);
        }
    }

    function recapitalize(uint256 amount) external {
        calls++;
        amount = bound(amount, 1, 1e30);
        _mint(owner, amount);
        vm.startPrank(owner);
        usdc.approve(address(vault), amount);
        try vault.recapitalize(amount) {
            ghostIn += amount;
        } catch (bytes memory err) {
            _unexpected("recapitalize", err);
        }
        vm.stopPrank();
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
        uint256 amt = Math.mulDiv(vault.balanceOf(from), bound(fracBps, 0, 10_000), 10_000);
        vm.prank(from);
        try vault.transfer(to, amt) returns (bool) {
        } catch (bytes memory err) {
            _unexpected("transfer", err);
        }
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
        bytes4[] memory sel = new bytes4[](7);
        sel[0] = InsuranceVaultHandler.deposit.selector;
        sel[1] = InsuranceVaultHandler.withdraw.selector;
        sel[2] = InsuranceVaultHandler.protocolInflow.selector;
        sel[3] = InsuranceVaultHandler.bailout.selector;
        sel[4] = InsuranceVaultHandler.recapitalize.selector;
        sel[5] = InsuranceVaultHandler.plainTransfer.selector;
        sel[6] = InsuranceVaultHandler.transferShares.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// @dev Total value of all shares never exceeds the vault's assets.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_sharesNeverWorthMoreThanAssets() public view {
        assertLe(vault.previewWithdraw(vault.totalSupply()), vault.totalAssets());
    }

    /// @dev Same, summed holder by holder (each rounded down on its own).
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_sumOfHolderValuesWithinAssets() public view {
        uint256 sum;
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            sum += vault.previewWithdraw(vault.balanceOf(handler.actors(i)));
        }
        assertLe(sum, vault.totalAssets());
    }

    /// @dev No vault call reverted except where the handler predicted it
    ///      (VaultInsolvent, ZeroShares and the crushed-price overflow are
    ///      filtered before calling; everything else must succeed).
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_noUnexpectedReverts() public view {
        assertEq(handler.unexpectedReverts(), 0, handler.lastUnexpectedAction());
    }

    /// @dev Per-call properties recorded by the handler: new shares are never
    ///      worth more than what was paid, a deposit never lowers another
    ///      holder's value, and each call matches its preview.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_perCallPropertiesHeld() public view {
        assertEq(handler.mintedValueFromNothing(), 0, "deposit minted value from nothing");
        assertEq(handler.dilutedOtherHolder(), 0, "deposit diluted another holder");
        assertEq(handler.previewMismatch(), 0, "call result differs from its preview");
    }

    /// @dev Tracked assets are always backed by real tokens.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_trackedAssetsBacked() public view {
        assertGe(usdc.balanceOf(address(vault)), vault.totalAssets());
    }

    /// @dev Tracked assets are exactly what came in through the tracked entry
    ///      points minus what went out; plain transfers never count.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_trackedAssetsAccounting() public view {
        assertEq(vault.totalAssets(), handler.ghostIn() - handler.ghostOut());
        assertEq(usdc.balanceOf(address(vault)), vault.totalAssets() + handler.ghostGifts());
    }

    /// @dev Display price is consistent with redemption: redeeming one whole
    ///      pIV never pays more than the displayed price (solvent states).
    /// forge-config: default.invariant.fail-on-revert = true
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
