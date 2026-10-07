// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../src/v2/AssetVaultV2_5.sol";
import "../../src/v2/GuardedOracle.sol";
import "../../script/UpgradeVaultToV2_5.s.sol";
import "../utils/KeylessAddr.sol";

/// @notice Fork simulation: upgrade the live Base Sepolia vault proxy to V2.5
///         (maxPriceAge 30d -> 6h in the same run) and prove mint / redeem
///         keep working as long as the keeper posts on its heartbeat — and
///         stop minting (not redeeming) when it does not.
///
///           forge test --match-path test/fork/VaultV2_5Fork.t.sol --fork-url https://sepolia.base.org -vv
contract VaultV2_5ForkTest is Test {
    address constant OWNER  = 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585;
    address constant KEEPER = 0x540aECD37E7A7885824e7b7e996eBddfb842ef17;
    address constant VAULT  = 0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a;
    address constant USDC   = 0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035;

    address user = KeylessAddr.addr("vaultUser");   // no known key: see test/utils/KeylessAddr.sol

    function setUp() public {
        if (block.chainid != 84532) vm.skip(true, "needs --fork-url https://sepolia.base.org");
    }

    function _heartbeat(AssetVaultV2_5 v) internal {
        GuardedOracle o = GuardedOracle(v.oracle());
        bytes32[] memory ids = v.registeredAssets();
        for (uint256 i; i < ids.length; i++) {
            (uint256 p, , , ) = o.peek(ids[i]);
            vm.prank(KEEPER);
            o.updatePrice(ids[i], p);   // same price, new timestamp
        }
    }

    function test_fork_upgradeThenMintRedeemOnKeeperHeartbeat() public {
        UpgradeVaultToV2_5 s = new UpgradeVaultToV2_5();
        s.setBroadcasterOverride(OWNER);
        s.run();
        AssetVaultV2_5 v = AssetVaultV2_5(VAULT);
        assertEq(v.version(), "2.5.0");
        assertEq(v.maxPriceAge(), 21_600);

        bytes32 eth = keccak256("sETH");
        IERC20 sEth = IERC20(v.assetToken(eth));
        deal(USDC, user, 1_000e18);
        vm.startPrank(user);
        IERC20(USDC).approve(VAULT, type(uint256).max);
        uint256 out = v.mint(eth, 100e18);
        assertGt(out, 0);
        v.redeem(eth, out / 2);
        vm.stopPrank();

        // Keeper heartbeat every 5h keeps it open.
        vm.warp(block.timestamp + 5 hours);
        _heartbeat(v);
        v.observeReserve();
        vm.prank(user); v.mint(eth, 100e18);

        // Keeper silent for > 6h: minting stops, redeeming does not... until
        // the quote itself is too old to price the redeem either.
        vm.warp(block.timestamp + 6 hours + 1);
        vm.prank(user);
        vm.expectRevert();
        v.mint(eth, 100e18);

        // Heartbeat resumes -> both work again.
        _heartbeat(v);
        vm.startPrank(user);
        v.mint(eth, 100e18);
        v.redeem(eth, sEth.balanceOf(user));
        vm.stopPrank();
        assertEq(sEth.balanceOf(user), 0);
    }
}
