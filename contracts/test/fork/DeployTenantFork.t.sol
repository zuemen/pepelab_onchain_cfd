// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../src/PerpetualExchange.sol";
import "../../src/FeeRouter.sol";
import "../../src/InsuranceVault.sol";
import "../../src/TraderStake.sol";
import "../TenantFixture.sol";

/// @notice ADR-008 — `DeployTenant` against live Base Sepolia state: a tenant
///         that shares the settlement token and (for the one-off seed) the
///         price source with the live platform, and nothing else. Nothing is
///         broadcast; the script runs in-process.
///
///         The live addresses below belong in this TEST (it asserts the live
///         platform is left untouched); `DeployTenant` itself has none.
///
///         Limited value, on purpose stated: since `DeployTenant` carries no
///         platform address at all, "the live platform did not notice" holds
///         by construction. What this test adds over DeployTenant.t.sol is the
///         real settlement token and price source, and the live chain's state
///         (nonces, code at the shared addresses). It does not run in CI (it
///         skips without a Base Sepolia fork); the per-tenant check CI does
///         run against chain is VerifyTenant (docs/TENANT_DEPLOYMENT.md).
///
///         Skipped unless the suite itself runs on a Base Sepolia fork:
///           forge test --match-path test/fork/DeployTenantFork.t.sol \
///             --fork-url https://sepolia.base.org -vv
contract DeployTenantForkTest is TenantFixture {
    address constant LIVE_OWNER    = 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585;
    address constant LIVE_KEEPER   = 0x540aECD37E7A7885824e7b7e996eBddfb842ef17;
    address constant USDC          = 0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035;
    address constant LIVE_ORACLE   = 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3;
    address constant LIVE_EXCHANGE = 0x827eA0c62a32e995927101259042F8A27D99124D;
    address constant LIVE_INS      = 0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812;
    address constant LIVE_FEE_R    = 0x00f6cf0113399a7A451c7f85fe094a28092d3e0c;
    address constant LIVE_TSTAKE   = 0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe;
    address constant LIVE_VAULT    = 0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a;
    address constant LIVE_G_ORACLE = 0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842;

    address deployer = makeAddr("tenant-deployer");
    address trader   = makeAddr("tenant-trader");
    bytes32 constant BTC = keccak256("sBTC");

    struct LiveSnapshot {
        address insExchange;
        address frExchange;
        address frCopyTracker;
        address tsCopyTracker;
        address exOwner;

        bool    exPaused;
        uint256 exUsdc;
        uint256 insUsdc;
        uint256 nextPositionId;
        uint256 btcPrice;
        bytes32 exCodeHash;
    }

    function setUp() public {
        if (block.chainid != 84532) vm.skip(true, "needs --fork-url https://sepolia.base.org");
        // Keeper heartbeat, as the runbook tells the operator to do first: the
        // seed must be under an hour old, and the live MockOracle may not be.
        string[11] memory syms = _allSyms();
        for (uint256 i; i < 11; i++) {
            bytes32 id = keccak256(bytes(syms[i]));
            (uint256 p, ) = IOracle(LIVE_ORACLE).getPrice(id);
            vm.prank(LIVE_KEEPER);
            (bool ok, ) = LIVE_ORACLE.call(abi.encodeWithSignature("updatePrice(bytes32,uint256)", id, p));
            require(ok, "keeper heartbeat failed");
        }
    }

    function _snapshot() internal view returns (LiveSnapshot memory s) {
        PerpetualExchange ex = PerpetualExchange(LIVE_EXCHANGE);
        s.insExchange    = InsuranceVault(LIVE_INS).exchange();
        s.frExchange     = FeeRouter(LIVE_FEE_R).exchange();
        s.frCopyTracker  = FeeRouter(LIVE_FEE_R).copyTracker();
        s.tsCopyTracker  = TraderStake(LIVE_TSTAKE).copyTracker();
        s.exOwner        = ex.owner();
        s.exPaused       = _livePaused();
        s.exUsdc         = IERC20(USDC).balanceOf(LIVE_EXCHANGE);
        s.insUsdc        = IERC20(USDC).balanceOf(LIVE_INS);
        s.nextPositionId = ex.nextPositionId();
        (s.btcPrice, )   = IOracle(LIVE_ORACLE).getPrice(BTC);
        s.exCodeHash     = LIVE_EXCHANGE.codehash;
    }

    /// @dev The exchange live today predates the guardian build and may have no
    ///      `paused()`; "not paused" is then the only possible state.
    function _livePaused() internal view returns (bool) {
        (bool ok, bytes memory ret) = LIVE_EXCHANGE.staticcall(abi.encodeWithSignature("paused()"));
        return ok && ret.length == 32 && abi.decode(ret, (bool));
    }

    function _assertLiveUntouched(LiveSnapshot memory a) internal view {
        LiveSnapshot memory b = _snapshot();
        assertEq(b.insExchange, a.insExchange, "live InsuranceVault.exchange moved");
        assertEq(b.frExchange, a.frExchange, "live FeeRouter.exchange moved");
        assertEq(b.frCopyTracker, a.frCopyTracker, "live FeeRouter.copyTracker moved");
        assertEq(b.tsCopyTracker, a.tsCopyTracker, "live TraderStake.copyTracker moved");
        assertEq(b.exOwner, a.exOwner, "live exchange owner moved");
        assertEq(b.exPaused, a.exPaused, "live exchange pause state moved");
        assertEq(b.exUsdc, a.exUsdc, "live exchange USDC moved");
        assertEq(b.insUsdc, a.insUsdc, "live insurance USDC moved");
        assertEq(b.nextPositionId, a.nextPositionId, "live exchange got a position");
        assertEq(b.btcPrice, a.btcPrice, "live oracle price moved");
        assertEq(b.exCodeHash, a.exCodeHash, "live exchange code changed");
    }

    function test_fork_tenantDeploysBesideLivePlatform_andSharesOnlyTokenAndSeed() public {
        LiveSnapshot memory before = _snapshot();

        Spec memory s = _spec("fork-bank", USDC, LIVE_ORACLE);
        DeployTenant script = _deployTenant(s, deployer);   // runs _verifyTenant at the end
        TenantBase.TenantDeployed memory d = script.lastDeployed();
        PerpetualExchange ex = PerpetualExchange(d.exchange);

        // 1. The live platform did not notice.
        _assertLiveUntouched(before);

        // 2. No tenant contract is a live contract.
        address[10] memory live = [LIVE_ORACLE, LIVE_EXCHANGE, LIVE_INS, LIVE_FEE_R, LIVE_TSTAKE, LIVE_VAULT,
            LIVE_G_ORACLE, before.frCopyTracker, LIVE_OWNER, LIVE_KEEPER];
        address[12] memory mine = [d.oracle, d.esgRegistry, d.kyc, d.insuranceVault, d.feeRouter, d.traderStake,
            d.exchange, d.strategyRegistry, d.copyTracker, d.sessionManager, d.assetVault, d.assetVaultImpl];
        for (uint256 i; i < mine.length; i++) {
            for (uint256 j; j < live.length; j++) assertTrue(mine[i] != live[j], "tenant reuses a live address");
        }
        assertEq(address(ex.usdc()), USDC, "shared: settlement token");
        assertTrue(address(ex.oracle()) != LIVE_ORACLE && address(ex.oracle()) != LIVE_G_ORACLE, "own oracle");
        assertTrue(address(ex.insuranceVault()) != LIVE_INS, "own insurance");
        assertTrue(address(ex.feeRouter()) != LIVE_FEE_R, "own fee router");
        assertEq(FeeRouter(d.feeRouter).platformTreasury(), s.treasury);

        // 3. Seeded from the live price, then independent of it.
        (uint256 seeded, ) = IOracle(d.oracle).getPrice(BTC);
        assertEq(seeded, before.btcPrice, "seed = the shared source's price");

        // 4. The live owner and keeper are nobody on the tenant.
        vm.prank(LIVE_OWNER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, LIVE_OWNER));
        ex.setMaxProfitBps(BTC, 60_000);
        vm.prank(LIVE_KEEPER);
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, LIVE_KEEPER, keccak256("KEEPER_ROLE")));
        GuardedOracle(d.oracle).updatePrice(BTC, seeded);
        vm.prank(LIVE_OWNER);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotGuardianOrOwner.selector, LIVE_OWNER));
        ex.pause();

        // 5. The tenant trades on its own book, with real MockUSDC — once the
        //    grace period that follows the deploy's own pause/unpause is over.
        vm.warp(block.timestamp + 30 minutes + 1);
        deal(USDC, trader, 2_000e18);
        vm.deal(trader, 1 ether);
        vm.startPrank(trader);
        IERC20(USDC).approve(d.exchange, type(uint256).max);
        ex.depositMargin(1_500e18);
        ex.openPosition{value: 1e14}(BTC, true, 500e18, 1);
        // 500 + 600 > 1,000 per side.
        vm.expectPartialRevert(PerpetualExchange.OpenInterestCapExceeded.selector);
        ex.openPosition{value: 1e14}(BTC, true, 600e18, 1);
        vm.stopPrank();
        assertEq(ex.nextPositionId(), 1);
        assertEq(IERC20(USDC).balanceOf(d.exchange) > 0, true, "margin sits in the tenant's exchange");

        // 6. A tenant incident stays in the tenant.
        vm.prank(s.guardian); ex.pause();
        assertTrue(ex.paused());
        vm.prank(s.guardian);
        GuardedOracle(d.oracle).setPaused(true);
        _assertLiveUntouched(before);
        (uint256 liveNow, ) = IOracle(LIVE_ORACLE).getPrice(BTC);
        assertEq(liveNow, before.btcPrice, "live oracle still quotes while the tenant's is paused");
    }

    /// @dev The same source seeds two tenants; they still share nothing.
    function test_fork_twoTenantsOnTheSameSharedLayer() public {
        LiveSnapshot memory before = _snapshot();
        Spec memory a = _spec("fork-bank-a", USDC, LIVE_ORACLE);
        Spec memory b = _spec("fork-bank-b", USDC, LIVE_ORACLE);
        b.deployVault = false;
        b.assets = "\"sBTC\",\"sETH\",\"sGOLD\"";
        TenantBase.TenantDeployed memory da = _deployTenant(a, deployer).lastDeployed();
        TenantBase.TenantDeployed memory db = _deployTenant(b, makeAddr("tenant-deployer-b")).lastDeployed();

        assertTrue(da.exchange != db.exchange && da.oracle != db.oracle && da.insuranceVault != db.insuranceVault
            && da.feeRouter != db.feeRouter && da.kyc != db.kyc && da.esgRegistry != db.esgRegistry);
        vm.prank(a.guardian); PerpetualExchange(da.exchange).pause();
        assertFalse(PerpetualExchange(db.exchange).paused());
        _assertLiveUntouched(before);
    }
}
