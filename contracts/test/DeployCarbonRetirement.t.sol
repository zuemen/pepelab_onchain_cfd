// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../script/DeployCarbonRetirement.s.sol";
import "../src/MockUSDC.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract DeployCarbonUSDC6 is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
}

/// @notice Issue #105: the (undeployed) deploy script wires the stack so the
///         FeeRouter's platform payee is the splitter, and the pipeline works
///         end to end straight after deployment.
contract DeployCarbonRetirementTest is Test {
    DeployCarbonRetirement script;
    MockUSDC usdc;
    address treasury = makeAddr("treasury");
    address payer    = makeAddr("payer");
    address trader   = makeAddr("trader");
    address LEAKED   = 0xE80A81360608C1342e66743F70a00f75d792Eb93;

    function setUp() public {
        script = new DeployCarbonRetirement();
        usdc = new MockUSDC();
    }

    function _cfg() internal view returns (DeployCarbonRetirement.Config memory c) {
        c.broadcaster    = address(script);
        c.usdc           = address(usdc);
        c.treasury       = treasury;
        c.seller         = address(script);
        c.creditOwner    = address(script);
        c.carbonShareBps = 2500;
        c.pricePerTonne  = 0;
        c.initialTonnes  = 100_000;
        c.deployRouter   = true;
    }

    function test_deploy_wiresSplitterAsPlatformPayee() public {
        DeployCarbonRetirement.Deployment memory d = script.deploy(_cfg());

        assertEq(d.router.platformTreasury(), address(d.splitter));
        assertEq(address(d.splitter.feeRouter()), address(d.router));
        assertEq(d.vault.feeRouter(), address(d.router));
        assertEq(d.splitter.carbonRetirement(), address(d.retirement));
        assertEq(d.splitter.treasury(), treasury);
        assertEq(d.splitter.carbonShareBps(), 2500);
        // Router itself is the stock FeeRouter: 70/20/10.
        assertEq(d.router.PLATFORM_SHARE_BPS(), 2000);
        assertEq(d.router.VAULT_SHARE_BPS(), 1000);
        // Simulated credit stock at the seller, approved for retirement.
        assertTrue(d.credit.SIMULATED());
        assertEq(d.credit.balanceOf(address(script)), 100_000e18);
        assertEq(d.retirement.availableTonnes(), 100_000e18);
        assertEq(d.retirement.pricePerTonne(), 10e18);   // 10 × 10^18 default
    }

    function test_deploy_pipelineWorksEndToEnd() public {
        DeployCarbonRetirement.Deployment memory d = script.deploy(_cfg());

        usdc.mint(payer, 1_000e18);
        vm.startPrank(payer);
        usdc.approve(address(d.router), 1_000e18);
        d.router.routeExternalRevenue(trader, 1_000e18);   // platform 200 → carbon 50
        vm.stopPrank();

        d.splitter.distribute();
        assertEq(usdc.balanceOf(treasury), 150e18);
        assertEq(d.retirement.retire(d.retirement.budget()), 5e18);   // 50 / 10 per tonne
        assertEq(d.credit.totalBurned(), 5e18);
    }

    function test_deploy_sixDecimalTokenDerivesPrice() public {
        DeployCarbonUSDC6 usdc6 = new DeployCarbonUSDC6();
        DeployCarbonRetirement.Config memory c = _cfg();
        c.usdc = address(usdc6);
        DeployCarbonRetirement.Deployment memory d = script.deploy(c);
        assertEq(d.retirement.pricePerTonne(), 10e6);
    }

    function test_deploy_withoutRouter_leavesSplitterUnbound() public {
        DeployCarbonRetirement.Config memory c = _cfg();
        c.deployRouter = false;
        DeployCarbonRetirement.Deployment memory d = script.deploy(c);
        assertEq(address(d.router), address(0));
        assertEq(address(d.splitter.feeRouter()), address(0));
        assertEq(d.splitter.deployer(), address(script));   // can still bind later
    }

    function test_deploy_externalSellerIsNotApprovedAndOwnershipMoves() public {
        DeployCarbonRetirement.Config memory c = _cfg();
        address seller = makeAddr("seller");
        address owner  = makeAddr("creditOwner");
        c.seller = seller;
        c.creditOwner = owner;
        c.pricePerTonne = 12e18;
        DeployCarbonRetirement.Deployment memory d = script.deploy(c);
        assertEq(d.credit.balanceOf(seller), 100_000e18);
        assertEq(d.retirement.availableTonnes(), 0);       // seller has to approve itself
        assertEq(d.credit.owner(), owner);
        assertEq(d.retirement.pricePerTonne(), 12e18);
    }

    function test_validate_rejectsMissingUsdcAndLeakedAddresses() public {
        DeployCarbonRetirement.Config memory c = _cfg();
        c.usdc = address(0);
        vm.expectRevert(DeployCarbonRetirement.MissingUsdc.selector);
        script.validate(c);

        c = _cfg();
        c.treasury = LEAKED;
        vm.expectRevert(abi.encodeWithSelector(DeployCarbonRetirement.CompromisedAddress.selector, "treasury", LEAKED));
        script.validate(c);

        c = _cfg();
        c.seller = LEAKED;
        vm.expectRevert(abi.encodeWithSelector(DeployCarbonRetirement.CompromisedAddress.selector, "seller", LEAKED));
        script.validate(c);
    }

    function test_checkChain_requiresExplicitConfirmationOffAnvil() public {
        script.checkChain(31337, 0);
        script.checkChain(84532, 84532);
        vm.expectRevert(abi.encodeWithSelector(DeployCarbonRetirement.ChainNotConfirmed.selector, 84532));
        script.checkChain(84532, 0);
    }
}
