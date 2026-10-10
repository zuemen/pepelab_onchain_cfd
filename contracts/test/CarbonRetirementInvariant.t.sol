// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/FeeRouter.sol";
import "../src/InsuranceVault.sol";
import "../src/MockUSDC.sol";
import "../src/MockCarbonCredit.sol";
import "../src/CarbonRetirement.sol";
import "../src/PlatformFeeSplitter.sol";

/// @dev Drives the fee → splitter → retirement pipeline through random
///      sequences of fee inflows (copy fee, performance fee, x402 external
///      revenue), splits, retirements, credit issuance, direct donations to the
///      retirement budget and seller-side burns.
///
///      Same shape as InsuranceVaultInvariant: every call is wrapped in
///      try/catch, reverts the handler did not predict are counted in
///      `unexpectedReverts` (checked by an invariant) instead of being swallowed.
contract CarbonPipelineHandler is Test {
    MockUSDC            public usdc;
    InsuranceVault      public vault;
    FeeRouter           public router;
    MockCarbonCredit    public credit;
    CarbonRetirement    public retirement;
    PlatformFeeSplitter public splitter;
    address public seller;
    address public trader;
    address public caller;   // authorized copyTracker + exchange
    address public payer;    // x402 settlement EOA
    address public owner;    // owns MockUSDC and MockCarbonCredit

    // Ghost accounting.
    uint256 public ghostPlatform;     // Σ platform share credited by the router
    uint256 public ghostVault;        // Σ vault share
    uint256 public ghostTrader;       // Σ trader share
    uint256 public ghostDonations;    // USDC sent straight to the retirement budget
    uint256 public ghostOtherBurns;   // credits burned outside CarbonRetirement
    uint256 public distributeCalls;

    uint256 public unexpectedReverts;
    string  public lastUnexpectedAction;
    bytes   public lastUnexpectedError;

    constructor(
        MockUSDC u, InsuranceVault v, FeeRouter r, MockCarbonCredit c,
        CarbonRetirement ret, PlatformFeeSplitter s,
        address _seller, address _trader, address _caller, address _payer, address _owner
    ) {
        usdc = u; vault = v; router = r; credit = c; retirement = ret; splitter = s;
        seller = _seller; trader = _trader; caller = _caller; payer = _payer; owner = _owner;
        vm.prank(caller);
        usdc.approve(address(router), type(uint256).max);
        vm.prank(payer);
        usdc.approve(address(router), type(uint256).max);
    }

    function _unexpected(string memory action, bytes memory err) internal {
        unexpectedReverts++;
        lastUnexpectedAction = action;
        lastUnexpectedError = err;
    }

    function _mint(address to, uint256 amount) internal {
        vm.prank(owner);
        usdc.mint(to, amount);
    }

    function _book(uint256 fee) internal {
        uint256 p = fee * router.PLATFORM_SHARE_BPS() / 10_000;
        uint256 v = fee * router.VAULT_SHARE_BPS() / 10_000;
        ghostPlatform += p;
        ghostVault    += v;
        ghostTrader   += fee - p - v;
    }

    // ── Fee inflows ──────────────────────────────────────────────────────────

    function copyFee(uint256 fee) external {
        fee = bound(fee, 0, 1_000_000e18);
        _mint(caller, fee);
        vm.prank(caller);
        try router.distributeCopyFee(trader, fee) { _book(fee); }
        catch (bytes memory err) { _unexpected("copyFee", err); }
    }

    function performanceFee(uint256 fee) external {
        fee = bound(fee, 0, 1_000_000e18);
        _mint(caller, fee);
        vm.prank(caller);
        try router.receivePerformanceFee(trader, fee) { _book(fee); }
        catch (bytes memory err) { _unexpected("performanceFee", err); }
    }

    function externalRevenue(uint256 fee) external {
        fee = bound(fee, 1, 1_000_000e18);
        _mint(payer, fee);
        vm.prank(payer);
        try router.routeExternalRevenue(trader, fee) { _book(fee); }
        catch (bytes memory err) { _unexpected("externalRevenue", err); }
    }

    // ── Split ────────────────────────────────────────────────────────────────

    function distribute(uint256 callerSeed) external {
        bool expectEmpty = splitter.pending() == 0;
        vm.prank(address(uint160(bound(callerSeed, 1, type(uint160).max))));
        try splitter.distribute() {
            if (expectEmpty) _unexpected("distribute succeeded with nothing pending", "");
            distributeCalls++;
        } catch (bytes memory err) {
            bool isEmpty = bytes4(err) == PlatformFeeSplitter.NothingToDistribute.selector;
            if (!(expectEmpty && isEmpty)) _unexpected("distribute", err);
        }
    }

    // ── Retire ───────────────────────────────────────────────────────────────

    function retire(uint256 fractionBps, uint256 callerSeed) external {
        uint256 budget = retirement.budget();
        uint256 amount = budget * bound(fractionBps, 0, 10_000) / 10_000;
        uint256 tonnes = amount * 1e18 / retirement.pricePerTonne();
        bool expectRevert = amount == 0 || tonnes == 0 || tonnes > retirement.availableTonnes();

        vm.prank(address(uint160(bound(callerSeed, 1, type(uint160).max))));
        try retirement.retire(amount) returns (uint256 burned) {
            if (expectRevert) _unexpected("retire succeeded unexpectedly", "");
            if (burned != tonnes) _unexpected("retire tonnes mismatch", "");
        } catch (bytes memory err) {
            if (!expectRevert) _unexpected("retire", err);
        }
    }

    // ── Supply side and noise ────────────────────────────────────────────────

    function issueCredits(uint256 tonnes) external {
        tonnes = bound(tonnes, 1, 1_000_000e18);
        vm.prank(owner);
        try credit.issue(seller, tonnes) {}
        catch (bytes memory err) { _unexpected("issueCredits", err); }
    }

    function donateToRetirement(uint256 amount) external {
        amount = bound(amount, 0, 100_000e18);
        _mint(address(this), amount);
        usdc.transfer(address(retirement), amount);
        ghostDonations += amount;
    }

    function sellerBurns(uint256 amount) external {
        amount = bound(amount, 0, credit.balanceOf(seller));
        vm.prank(seller);
        try credit.burn(amount) { ghostOtherBurns += amount; }
        catch (bytes memory err) { _unexpected("sellerBurns", err); }
    }
}

/// @notice Issue #105 invariants for the carbon-retirement pipeline.
contract CarbonRetirementInvariantTest is Test {
    MockUSDC              usdc;
    InsuranceVault        vault;
    FeeRouter             router;
    MockCarbonCredit      credit;
    CarbonRetirement      retirement;
    PlatformFeeSplitter   splitter;
    CarbonPipelineHandler handler;

    address treasury = makeAddr("treasury");
    address seller   = makeAddr("seller");
    address trader   = makeAddr("trader");
    address caller   = makeAddr("caller");
    address payer    = makeAddr("payer");

    uint256 constant CARBON_BPS = 2500;
    uint256 constant PRICE      = 12.5e18;   // deliberately not a round divisor of fees

    function setUp() public {
        usdc       = new MockUSDC();
        vault      = new InsuranceVault(address(usdc));
        credit     = new MockCarbonCredit(address(this));
        retirement = new CarbonRetirement(address(usdc), address(credit), seller, PRICE);
        splitter   = new PlatformFeeSplitter(address(usdc), treasury, address(retirement), CARBON_BPS);
        router     = new FeeRouter(address(usdc), address(splitter), address(vault));
        splitter.bindFeeRouter(address(router));
        vault.setFeeRouter(address(router));
        router.setCopyTracker(caller);
        router.setExchange(caller);

        credit.issue(seller, 10_000e18);
        vm.prank(seller);
        credit.approve(address(retirement), type(uint256).max);

        handler = new CarbonPipelineHandler(
            usdc, vault, router, credit, retirement, splitter,
            seller, trader, caller, payer, address(this)
        );
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](8);
        sel[0] = CarbonPipelineHandler.copyFee.selector;
        sel[1] = CarbonPipelineHandler.performanceFee.selector;
        sel[2] = CarbonPipelineHandler.externalRevenue.selector;
        sel[3] = CarbonPipelineHandler.distribute.selector;
        sel[4] = CarbonPipelineHandler.retire.selector;
        sel[5] = CarbonPipelineHandler.issueCredits.selector;
        sel[6] = CarbonPipelineHandler.donateToRetirement.selector;
        sel[7] = CarbonPipelineHandler.sellerBurns.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    /// @dev Bought credits never linger: buy and burn are one transaction.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_retirementNeverHoldsCredits() public view {
        assertEq(credit.balanceOf(address(retirement)), 0);
    }

    /// @dev A retired tonne is gone from supply, not parked somewhere.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_burnedCreditsLeaveSupply() public view {
        assertEq(credit.totalSupply(), credit.totalIssued() - credit.totalBurned());
        assertEq(credit.totalBurned(), retirement.totalRetiredTonnes() + handler.ghostOtherBurns());
    }

    /// @dev The router's 70 / 20 / 10 is untouched by the splitter.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_routerSplitUnchanged() public view {
        assertEq(router.traderEarnings(trader), handler.ghostTrader());
        assertEq(vault.totalAssets(), handler.ghostVault());
    }

    /// @dev Every unit of platform share is either still accrued in the router,
    ///      waiting in the splitter, or paid out to exactly one of its two sinks.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_platformShareConserved() public view {
        assertEq(
            handler.ghostPlatform(),
            router.platformEarnings()
                + usdc.balanceOf(address(splitter))
                + splitter.totalToCarbon()
                + splitter.totalToTreasury()
        );
        assertEq(usdc.balanceOf(treasury), splitter.totalToTreasury());
    }

    /// @dev The carbon slice is carbonShareBps of what was split, short only by
    ///      per-call round-down (< 1 unit per distribute).
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_carbonSliceMatchesShare() public view {
        uint256 split = splitter.totalToCarbon() + splitter.totalToTreasury();
        uint256 exact = split * CARBON_BPS;               // scaled by 1e4
        uint256 got   = splitter.totalToCarbon() * 10_000;
        assertLe(got, exact);
        assertLe(exact - got, handler.distributeCalls() * 10_000);
    }

    /// @dev The retirement budget only ever leaves to the seller, as purchases.
    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_retirementBudgetConserved() public view {
        assertEq(
            splitter.totalToCarbon() + handler.ghostDonations(),
            retirement.totalSpent() + usdc.balanceOf(address(retirement))
        );
        assertEq(usdc.balanceOf(seller), retirement.totalSpent());
        assertLe(retirement.totalRetiredTonnes(), retirement.totalSpent() * 1e18 / PRICE);
    }

    /// forge-config: default.invariant.fail-on-revert = true
    function invariant_noUnexpectedReverts() public view {
        assertEq(handler.unexpectedReverts(), 0, handler.lastUnexpectedAction());
    }
}
