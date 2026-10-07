// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../script/DeployPepeIncentives.s.sol";
import "../script/DeployAMM.s.sol";
import "../src/MockOracle.sol";
import "../src/PepeToken.sol";

/// @notice DeployPepeIncentives and DeployAMM used to read PRIVATE_KEY in-script,
///         so they could not run from a Foundry keystore (`--account`), unlike
///         every other cutover script (docs/OWNER_ACTIONS.md step 5). They now
///         broadcast as `msg.sender`. These tests run them the way a keystore
///         broadcast does — as an address, with no key anywhere — and pin who
///         ends up owning what.
contract DeployPepeScriptsTest is Test {
    address deployer = makeAddr("deployer");
    address stranger = makeAddr("stranger");

    /// @dev One test, not two: vm.setEnv is process-wide and forge runs tests in
    ///      parallel, so a second test setting PERPETUAL_EXCHANGE would race this one.
    function test_incentives_deployerIsTheBroadcaster_andAddressesMustHaveCode() public {
        address pepe = address(new PepeToken());
        address exchange = address(new MockUSDC());      // any contract: the constructor only stores it
        address copyTracker = address(new MockUSDC());
        vm.setEnv("PEPE_TOKEN", vm.toString(pepe));
        vm.setEnv("COPY_TRACKER", vm.toString(copyTracker));
        vm.setEnv("ESG_REGISTRY", vm.toString(address(0)));   // the live deployment wires none

        DeployPepeIncentives s = new DeployPepeIncentives();
        s.setBroadcasterOverride(deployer);

        vm.setEnv("PERPETUAL_EXCHANGE", vm.toString(makeAddr("eoa")));   // a typo'd address
        vm.expectRevert(bytes("PERPETUAL_EXCHANGE has no code"));
        s.run();

        vm.setEnv("PERPETUAL_EXCHANGE", vm.toString(exchange));
        PepeIncentives inc = s.run();
        assertEq(inc.owner(), deployer, "owner is the broadcasting account, not a key from env");
        assertEq(address(inc.exchange()), exchange);
        assertEq(address(inc.copyTracker()), copyTracker);
    }

    function _ammEnv() internal returns (MockUSDC usdc, MockOracle oracle) {
        // startPrank/stopPrank, not a one-shot prank: under forge 1.8.0 (CI) a
        // bare `vm.prank` before `new MockUSDC()` also made `deployer` the owner
        // of the MockOracle created on the next line. Both owners are asserted.
        vm.startPrank(deployer);
        usdc = new MockUSDC();
        vm.stopPrank();
        oracle = new MockOracle();
        assertEq(usdc.owner(), deployer);
        assertEq(oracle.owner(), address(this));
        oracle.addAsset(keccak256("sETH"), 2_300e8);
        vm.setEnv("MOCK_USDC", vm.toString(address(usdc)));
        vm.setEnv("MOCK_ORACLE", vm.toString(address(oracle)));
        vm.setEnv("SEED_ETH", "1000000000000000000");
        vm.setEnv("SEED_USDC", "2300000000000000000000");
    }

    /// @dev One test for the same reason as above (process-wide env).
    function test_amm_seedsFromTheBroadcaster_andOnlyTheUsdcOwnerCanSeed() public {
        (MockUSDC usdc, MockOracle oracle) = _ammEnv();
        vm.deal(stranger, 2 ether);
        vm.deal(deployer, 2 ether);

        DeployAMM s = new DeployAMM();
        s.setBroadcasterOverride(stranger);
        vm.expectRevert(bytes("the broadcaster is not the MockUSDC owner - mint() became onlyOwner in PA-3"));
        s.run();

        s.setBroadcasterOverride(deployer);
        PepeAMM amm = s.run();
        assertEq(amm.owner(), deployer);
        assertEq(amm.ethReserve(), 1 ether);
        assertEq(amm.usdcReserve(), 2_300e18);
        assertEq(usdc.balanceOf(deployer), 0, "the minted seed went into the pool");
        assertGt(amm.sharesOf(deployer), 0, "LP shares belong to the broadcaster");

        // SEED_USDC=0 (or unset) seeds at the oracle price instead of a fixed
        // 2300 that went stale: the pool must open exactly at the oracle.
        oracle.updatePrice(keccak256("sETH"), 2_697.57e8);
        vm.setEnv("SEED_USDC", "0");
        PepeAMM atOracle = s.run();
        assertEq(atOracle.usdcReserve(), 2_697.57e18, "seed = SEED_ETH x oracle price");
        assertEq(atOracle.getPrice(), 2_697.57e18, "opens at the oracle");
    }
}
