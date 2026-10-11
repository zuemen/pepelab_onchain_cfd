// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../src/CarbonRetirement.sol";
import "../src/MockCarbonCredit.sol";
import "../src/MockUSDC.sol";

/// @dev 6-decimal settlement token, like the official USDC the x402 router uses.
contract CarbonUSDC6 is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Issue #105: `MockCarbonCredit` + `CarbonRetirement` — buy and
///         permanently burn (simulated) credits, emit `CarbonRetired`, and carry
///         the "this is simulated" disclosure on-chain.
contract CarbonRetirementTest is Test {
    MockUSDC         usdc;
    MockCarbonCredit credit;
    CarbonRetirement retirement;

    address issuer   = address(this);
    address seller   = makeAddr("seller");
    address stranger = makeAddr("stranger");

    uint256 constant PRICE     = 10e18;           // 10 USDC (18-dec) per tonne — simulated
    uint256 constant INVENTORY = 1_000_000e18;    // 1,000,000 labelled tonnes

    event CarbonRetired(uint256 amount, uint256 tonnesCO2e, uint256 timestamp);
    event CreditsIssued(address indexed to, uint256 tonnes);

    function setUp() public {
        usdc       = new MockUSDC();
        credit     = new MockCarbonCredit(issuer);
        retirement = new CarbonRetirement(address(usdc), address(credit), seller, PRICE);

        credit.issue(seller, INVENTORY);
        vm.prank(seller);
        credit.approve(address(retirement), type(uint256).max);
    }

    function _fund(uint256 amount) internal {
        usdc.mint(address(retirement), amount);
    }

    // ── Honesty: the simulation is disclosed on-chain ────────────────────────

    function test_disclosure_creditIsMarkedSimulated() public view {
        assertTrue(credit.SIMULATED());
        assertEq(credit.name(), "Mock Carbon Credit (SIMULATED, not a real offset)");
        assertEq(credit.symbol(), "mtCO2e");
        assertEq(credit.decimals(), 18);
    }

    function test_disclosure_retirementIsMarkedSimulated() public view {
        assertTrue(retirement.SIMULATED());
        string memory d = retirement.DISCLOSURE();
        assertGt(bytes(d).length, 0);
        // Starts with the word a reader must not miss.
        bytes memory prefix = bytes("SIMULATED");
        for (uint256 i = 0; i < prefix.length; i++) {
            assertEq(bytes(d)[i], prefix[i]);
        }
    }

    // ── MockCarbonCredit ─────────────────────────────────────────────────────

    function test_issue_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        credit.issue(stranger, 1e18);
    }

    function test_issue_rejectsZero() public {
        vm.expectRevert(MockCarbonCredit.ZeroAmount.selector);
        credit.issue(seller, 0);
        vm.expectRevert(MockCarbonCredit.ZeroAddress.selector);
        credit.issue(address(0), 1e18);
    }

    function test_issue_tracksTotalsAndEmits() public {
        vm.expectEmit(true, false, false, true, address(credit));
        emit CreditsIssued(stranger, 5e18);
        credit.issue(stranger, 5e18);
        assertEq(credit.totalIssued(), INVENTORY + 5e18);
        assertEq(credit.totalSupply(), INVENTORY + 5e18);
    }

    function test_burn_countedInTotalBurned() public {
        vm.prank(seller);
        credit.burn(3e18);
        assertEq(credit.totalBurned(), 3e18);
        assertEq(credit.totalSupply(), credit.totalIssued() - credit.totalBurned());
    }

    // ── Constructor ──────────────────────────────────────────────────────────

    function test_constructor_rejectsZeroInputs() public {
        vm.expectRevert(CarbonRetirement.ZeroAddress.selector);
        new CarbonRetirement(address(0), address(credit), seller, PRICE);
        vm.expectRevert(CarbonRetirement.ZeroAddress.selector);
        new CarbonRetirement(address(usdc), address(0), seller, PRICE);
        vm.expectRevert(CarbonRetirement.ZeroAddress.selector);
        new CarbonRetirement(address(usdc), address(credit), address(0), PRICE);
        vm.expectRevert(CarbonRetirement.ZeroPrice.selector);
        new CarbonRetirement(address(usdc), address(credit), seller, 0);
    }

    function test_constructor_storesImmutables() public view {
        assertEq(address(retirement.usdc()), address(usdc));
        assertEq(address(retirement.credit()), address(credit));
        assertEq(retirement.seller(), seller);
        assertEq(retirement.pricePerTonne(), PRICE);
        assertEq(retirement.TONNE(), 1e18);
    }

    // ── retire: happy path ───────────────────────────────────────────────────

    function test_retire_buysAndPermanentlyBurns() public {
        _fund(1_000e18);
        vm.warp(1_800_000_000);

        uint256 supplyBefore = credit.totalSupply();
        uint256 sellerUsdcBefore = usdc.balanceOf(seller);

        vm.expectEmit(false, false, false, true, address(retirement));
        emit CarbonRetired(250e18, 25e18, 1_800_000_000);
        vm.prank(stranger);   // permissionless
        uint256 tonnes = retirement.retire(250e18);

        assertEq(tonnes, 25e18);                                     // 250 / 10 per tonne
        // Burned, not moved: supply shrank and nobody holds the bought tonnes.
        assertEq(credit.totalSupply(), supplyBefore - 25e18);
        assertEq(credit.totalBurned(), 25e18);
        assertEq(credit.balanceOf(address(retirement)), 0);
        assertEq(credit.balanceOf(seller), INVENTORY - 25e18);
        // Paid: the budget went to the seller, all of it, nowhere else.
        assertEq(usdc.balanceOf(seller), sellerUsdcBefore + 250e18);
        assertEq(retirement.budget(), 750e18);
        // Recorded.
        assertEq(retirement.totalRetiredTonnes(), 25e18);
        assertEq(retirement.totalSpent(), 250e18);
        assertEq(retirement.retirementCount(), 1);
        CarbonRetirement.Retirement memory r = retirement.getRetirement(0);
        assertEq(r.amount, 250e18);
        assertEq(r.tonnesCO2e, 25e18);
        assertEq(r.timestamp, 1_800_000_000);
        assertEq(r.retiredBy, stranger);
    }

    function test_retire_wholeBudget() public {
        _fund(1_000e18);
        retirement.retire(retirement.budget());
        assertEq(retirement.budget(), 0);
        assertEq(retirement.totalRetiredTonnes(), 100e18);
    }

    function test_retire_fractionalTonnesRoundDownToSeller() public {
        _fund(15);                       // 15 wei of USDC at 10e18 per tonne
        uint256 tonnes = retirement.retire(15);
        assertEq(tonnes, 1);             // floor(15 * 1e18 / 10e18) = 1 credit unit
        assertEq(usdc.balanceOf(seller), 15); // the whole amount leaves the budget
    }

    function test_retire_sixDecimalSettlementToken() public {
        CarbonUSDC6 usdc6 = new CarbonUSDC6();
        CarbonRetirement r6 = new CarbonRetirement(address(usdc6), address(credit), seller, 10e6); // 10 USDC / t
        vm.prank(seller);
        credit.approve(address(r6), type(uint256).max);
        usdc6.mint(address(r6), 25e6);

        uint256 tonnes = r6.retire(25e6);
        assertEq(tonnes, 2.5e18);        // 2.5 labelled tonnes
        assertEq(usdc6.balanceOf(seller), 25e6);
    }

    // ── retire: reverts ──────────────────────────────────────────────────────

    function test_retire_revertsOnZero() public {
        _fund(100e18);
        vm.expectRevert(CarbonRetirement.ZeroAmount.selector);
        retirement.retire(0);
    }

    function test_retire_revertsOverBudget() public {
        _fund(100e18);
        vm.expectRevert(abi.encodeWithSelector(CarbonRetirement.InsufficientBudget.selector, 101e18, 100e18));
        retirement.retire(101e18);
    }

    function test_retire_revertsWhenAmountBuysNothing() public {
        _fund(9);                        // 9 wei < 10 wei per credit unit
        vm.expectRevert(abi.encodeWithSelector(CarbonRetirement.AmountTooSmall.selector, 9));
        retirement.retire(9);
    }

    function test_retire_revertsWhenSellerOutOfInventory() public {
        CarbonRetirement r = new CarbonRetirement(address(usdc), address(credit), stranger, PRICE);
        vm.prank(stranger);
        credit.approve(address(r), type(uint256).max);   // approved, but holds nothing
        usdc.mint(address(r), 100e18);
        vm.expectRevert();
        r.retire(100e18);
        assertEq(r.retirementCount(), 0);
        assertEq(r.budget(), 100e18);    // budget untouched on failure
    }

    function test_retire_revertsWithoutSellerApproval() public {
        vm.prank(seller);
        credit.approve(address(retirement), 0);
        _fund(100e18);
        vm.expectRevert();
        retirement.retire(100e18);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    function test_availableTonnes_isBalanceCappedByAllowance() public {
        assertEq(retirement.availableTonnes(), INVENTORY);
        vm.prank(seller);
        credit.approve(address(retirement), 7e18);
        assertEq(retirement.availableTonnes(), 7e18);
    }

    function test_quoteTonnes_matchesRetire() public {
        _fund(123e18);
        uint256 q = retirement.quoteTonnes(123e18);
        assertEq(retirement.retire(123e18), q);
    }

    function test_getRecentRetirements_newestFirstWithPaging() public {
        _fund(60e18);
        retirement.retire(10e18);
        retirement.retire(20e18);
        retirement.retire(30e18);

        CarbonRetirement.Retirement[] memory p = retirement.getRecentRetirements(0, 2);
        assertEq(p.length, 2);
        assertEq(p[0].amount, 30e18);
        assertEq(p[1].amount, 20e18);

        p = retirement.getRecentRetirements(2, 5);
        assertEq(p.length, 1);
        assertEq(p[0].amount, 10e18);

        p = retirement.getRecentRetirements(3, 5);
        assertEq(p.length, 0);
    }

    // ── Fuzz ─────────────────────────────────────────────────────────────────

    /// @dev For any budget, price and spend: tonnes follow the fixed price, the
    ///      spend goes entirely to the seller, and every bought tonne is burned.
    function testFuzz_retire_conservesValueAndBurnsEverything(
        uint256 price,
        uint256 fundAmount,
        uint256 spend
    ) public {
        price = bound(price, 1, 1_000_000e18);
        // Smallest spend that still buys one credit unit, so every run retires something.
        uint256 minSpend = (price + 1e18 - 1) / 1e18;
        fundAmount = bound(fundAmount, minSpend, 1e30);
        spend      = bound(spend, minSpend, fundAmount);
        uint256 expectedTonnes = spend * 1e18 / price;
        assertGt(expectedTonnes, 0);

        MockCarbonCredit c = new MockCarbonCredit(address(this));
        CarbonRetirement r = new CarbonRetirement(address(usdc), address(c), seller, price);
        c.issue(seller, expectedTonnes);
        vm.prank(seller);
        c.approve(address(r), type(uint256).max);
        usdc.mint(address(r), fundAmount);
        uint256 sellerBefore = usdc.balanceOf(seller);

        uint256 tonnes = r.retire(spend);

        assertEq(tonnes, expectedTonnes);
        assertEq(c.totalSupply(), 0);                     // everything issued was burned
        assertEq(c.totalBurned(), tonnes);
        assertEq(c.balanceOf(address(r)), 0);
        assertEq(usdc.balanceOf(seller) - sellerBefore, spend);
        assertEq(r.budget(), fundAmount - spend);
        assertEq(r.totalSpent(), spend);
        assertEq(r.totalRetiredTonnes(), tonnes);
    }
}
