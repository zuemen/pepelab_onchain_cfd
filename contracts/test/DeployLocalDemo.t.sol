// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../script/DeployLocalDemo.s.sol";

contract DeployLocalDemoTest is Test {
    DeployLocalDemo internal script;
    DeployLocalDemo.Deployed internal d;
    address internal deployer = makeAddr("deployer");
    address internal trader = makeAddr("trader");

    string[11] internal SYMBOLS =
        ["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"];

    function setUp() public {
        script = new DeployLocalDemo();
        d = script.deploy(deployer);
    }

    function _id(string memory symbol) internal pure returns (bytes32) {
        return keccak256(bytes(symbol));
    }

    function _exchange() internal view returns (PerpetualExchange) {
        return PerpetualExchange(payable(d.exchange));
    }

    function _fund(address who, bool verified) internal {
        vm.deal(who, 1 ether);
        vm.prank(deployer);
        MockUSDC(d.usdc).mint(who, 10_000e18);
        if (verified) {
            address[] memory list = new address[](1);
            list[0] = who;
            vm.prank(deployer);
            KYCRegistry(d.kyc).batchVerify(list);
        }
        vm.startPrank(who);
        MockUSDC(d.usdc).approve(d.exchange, 10_000e18);
        _exchange().depositMargin(10_000e18);
        vm.stopPrank();
    }

    function test_everyAssetHasAPrice() public view {
        for (uint256 i = 0; i < SYMBOLS.length; i++) {
            (uint256 price,) = MockOracle(d.oracle).getPrice(_id(SYMBOLS[i]));
            assertGt(price, 0, SYMBOLS[i]);
        }
    }

    function test_carbonTierSetsTheLeverageCeilingAndTheFee() public view {
        PerpetualExchange ex = _exchange();
        // Low
        assertEq(ex.maxLeverageForAsset(_id("sETH")), 5);
        assertEq(ex.tradingFeeBpsForAsset(_id("sETH")), 10);
        // Mid
        assertEq(ex.maxLeverageForAsset(_id("sESGU")), 2);
        assertEq(ex.tradingFeeBpsForAsset(_id("sESGU")), 40);
        // High
        assertEq(ex.maxLeverageForAsset(_id("sBTC")), 1);
        assertEq(ex.tradingFeeBpsForAsset(_id("sBTC")), 100);
    }

    function test_attestationsOutliveATwoYearReplay() public {
        vm.warp(block.timestamp + 800 days);
        assertEq(_exchange().maxLeverageForAsset(_id("sETH")), 5);
    }

    function test_aVerifiedTraderCanOpenOnEveryAsset() public {
        _fund(trader, true);
        uint256 fee = _exchange().executionFee();
        vm.startPrank(trader);
        for (uint256 i = 0; i < SYMBOLS.length; i++) {
            _exchange().openPosition{value: fee}(_id(SYMBOLS[i]), true, 20e18, 1);
        }
        vm.stopPrank();
        assertEq(_exchange().getUserPositions(trader).length, 11);
    }

    function test_regulatedMarketsNeedKycAndCryptoDoesNot() public {
        _fund(trader, false);
        uint256 fee = _exchange().executionFee();
        vm.startPrank(trader);
        _exchange().openPosition{value: fee}(_id("sBTC"), true, 20e18, 1);
        _exchange().openPosition{value: fee}(_id("sGOLD"), true, 20e18, 1);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, trader));
        _exchange().openPosition{value: fee}(_id("sAAPL"), true, 20e18, 1);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, trader));
        _exchange().openPosition{value: fee}(_id("sBOND"), true, 20e18, 1);
        vm.stopPrank();
    }

    function test_theCopyStackIsWiredAndTheInsuranceVaultIsFunded() public view {
        assertEq(TraderStake(d.traderStake).copyTracker(), d.copyTracker);
        assertEq(address(CopyTracker(payable(d.copyTracker)).exchange()), d.exchange);
        assertEq(address(CopyTracker(payable(d.copyTracker)).registry()), d.strategyRegistry);
        assertTrue(_exchange().authorizedAgents(d.copyTracker));
        assertEq(InsuranceVault(payable(d.insuranceVault)).totalAssets(), 500_000e18);
        assertEq(_exchange().maxPriceAge(), 7 days);
    }

    function test_refusesToRunOffTheLocalChain() public {
        vm.chainId(84532);
        DeployLocalDemo other = new DeployLocalDemo();
        vm.expectRevert(abi.encodeWithSelector(DeployLocalDemo.NotLocalChain.selector, uint256(84532)));
        other.deploy(deployer);
    }
}
