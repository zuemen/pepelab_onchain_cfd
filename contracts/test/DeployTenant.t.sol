// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/KYCRegistry.sol";
import "../src/PerpetualExchange.sol";
import "../src/InsuranceVault.sol";
import "../src/FeeRouter.sol";
import "../script/Verify130.s.sol";
import "./TenantFixture.sol";

contract SixDecimalToken is ERC20 {
    constructor() ERC20("Six", "SIX") {}
    function decimals() public pure override returns (uint8) { return 6; }
}

/// @dev Reads the live platform's own RWA classification (`Cutover130Base`),
///      so the tenant copy can be pinned to it.
contract Rwa130Harness is Cutover130Base {
    function isRwa(string calldata sym) external pure returns (bool) { return _isRwa(sym); }
}

/// @notice ADR-008 — `DeployTenant` / `VerifyTenant` against mocks on the local
///         chain. No fork, no file written: the config is built in memory
///         (`TenantFixture`), the settlement token is a fresh `MockUSDC` and
///         the shared price source a fresh `MockOracle`.
contract DeployTenantTest is TenantFixture {
    MockUSDC   usdc;
    MockOracle source;
    TenantVerifyHarness verifier;

    address deployer = makeAddr("tenant-deployer");
    address trader   = makeAddr("trader");

    bytes32 constant BTC  = keccak256("sBTC");
    bytes32 constant AAPL = keccak256("sAAPL");

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        source = new MockOracle();
        string[11] memory syms = _allSyms();
        for (uint256 i; i < 11; i++) source.addAsset(keccak256(bytes(syms[i])), (i + 1) * 100e8);
        verifier = new TenantVerifyHarness();
    }

    function _tenant(string memory id) internal returns (Spec memory s, DeployTenant script, TenantBase.TenantDeployed memory d) {
        s = _spec(id, address(usdc), address(source));
        script = _deployTenant(s, deployer);
        d = script.lastDeployed();
    }

    // ── happy path ──────────────────────────────────────────────────────────

    function test_deploysFullTenant_ownedByAdmin_deployerKeepsNothing() public {
        (Spec memory s, DeployTenant script, TenantBase.TenantDeployed memory d) = _tenant("bank-a");
        PerpetualExchange ex = PerpetualExchange(d.exchange);

        // Ownable: all six handed to the tenant admin.
        address[6] memory owned = [d.exchange, d.copyTracker, d.insuranceVault, d.feeRouter, d.traderStake, d.kyc];
        for (uint256 i; i < owned.length; i++) assertEq(Ownable(owned[i]).owner(), s.admin, "owner is the tenant admin");

        // AccessControl: admin holds DEFAULT_ADMIN, the deployer holds nothing.
        address[3] memory ac = [d.oracle, d.esgRegistry, d.assetVault];
        for (uint256 i; i < ac.length; i++) {
            assertTrue(IAccessControl(ac[i]).hasRole(0x00, s.admin), "admin role");
            assertFalse(IAccessControl(ac[i]).hasRole(0x00, deployer), "deployer admin dropped");
        }
        assertFalse(IAccessControl(d.oracle).hasRole(keccak256("GUARDIAN_ROLE"), deployer), "constructor guardian dropped");
        assertTrue(IAccessControl(d.oracle).hasRole(keccak256("KEEPER_ROLE"), s.keeper));
        assertTrue(IAccessControl(d.oracle).hasRole(keccak256("GUARDIAN_ROLE"), s.guardian));
        assertTrue(IAccessControl(d.assetVault).hasRole(keccak256("RISK_ROLE"), s.risk));
        assertTrue(IAccessControl(d.assetVault).hasRole(keccak256("PAUSER_ROLE"), s.guardian));
        assertFalse(IAccessControl(d.assetVault).hasRole(keccak256("RISK_ROLE"), deployer));
        assertFalse(IAccessControl(d.assetVault).hasRole(keccak256("PAUSER_ROLE"), deployer));

        // The tenant's own oracle, seeded from — but not equal to — the source.
        assertTrue(d.oracle != address(source), "own oracle");
        assertEq(address(ex.oracle()), d.oracle);
        (uint256 p, uint256 at) = IOracle(d.oracle).getPrice(BTC);
        assertEq(p, 100e8, "seeded from the source");
        assertEq(at, block.timestamp);

        // The tenant's own money path.
        assertEq(FeeRouter(d.feeRouter).platformTreasury(), s.treasury, "treasury is the tenant's");
        assertEq(InsuranceVault(d.insuranceVault).exchange(), d.exchange);
        assertEq(address(ex.insuranceVault()), d.insuranceVault);

        // Caps written as whole USDC, RWA flag from the asset not the tenant.
        assertEq(ex.maxLongOI(BTC), 1_000e18);
        assertEq(ex.maxShortOI(BTC), 1_000e18);
        assertEq(ex.maxLongOI(AAPL), 500e18);
        assertEq(ex.maxProfitBps(BTC), 50_000);
        assertFalse(ex.rwaAsset(BTC));
        assertTrue(ex.rwaAsset(AAPL));
        assertEq(ex.guardian(), s.guardian);
        assertEq(ex.marketOperator(), s.marketOperator);
        assertEq(address(ex.kyc()), d.kyc);

        assertEq(d.tokens.length, 11, "one token per registered asset");
        assertEq(AssetVaultV2_5(d.assetVault).maxPriceAge(), 21_600, "vault quote-age limit = 6h");
        assertEq(AssetVaultV2_5(d.assetVault).redeemFeeBps(), 30, "redeem fee left at the contract default");
        assertEq(AssetVaultV2_5(d.assetVault).minReserveRatioBps(), 11_000, "reserve floor left at the contract default");

        // The record the run produced verifies on its own, from strings alone.
        string memory record = script.lastRecordJson();
        assertEq(vm.parseJsonString(record, ".mode"), "test");
        assertEq(vm.parseJsonString(record, ".tenantId"), "bank-a");
        assertEq(vm.parseJsonUint(record, ".chainId"), 84532);
        assertEq(vm.parseJsonAddress(record, ".contracts.PerpetualExchange"), d.exchange);
        assertEq(vm.parseJsonAddress(record, ".tokens.sBTC"), d.tokens[0]);
        assertEq(vm.parseJsonAddress(record, ".owner"), s.admin);
        verifier.verify(_json(s), s.id, record, s.admin);
    }

    function test_tenantTrades_capsAndKycGateHold() public {
        (Spec memory s, , TenantBase.TenantDeployed memory d) = _tenant("bank-a");
        PerpetualExchange ex = PerpetualExchange(d.exchange);

        usdc.mint(trader, 5_000e18);
        vm.deal(trader, 1 ether);
        vm.startPrank(trader);
        usdc.approve(d.exchange, type(uint256).max);
        ex.depositMargin(3_000e18);
        // Empty ESGRegistryV2 → every asset Unrated → 1x, the most conservative row.
        ex.openPosition{value: 1e14}(BTC, true, 600e18, 1);
        vm.expectRevert();   // OpenInterestCapExceeded: 600 + 600 > 1,000
        ex.openPosition{value: 1e14}(BTC, true, 600e18, 1);
        vm.expectRevert();   // InvalidLeverage: unrated assets are 1x only
        ex.openPosition{value: 1e14}(BTC, false, 100e18, 2);
        // RWA market: closed until the tenant's own KYC registry verifies the trader.
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotKycVerified.selector, trader));
        ex.openPosition{value: 1e14}(AAPL, true, 100e18, 1);
        KYCRegistry(d.kyc).submitKYC("Trader", "TW");
        vm.stopPrank();

        vm.prank(deployer);
        vm.expectRevert();   // the deployer is nobody on the tenant's KYC registry
        KYCRegistry(d.kyc).approveKYC(trader);
        vm.prank(s.admin);
        KYCRegistry(d.kyc).approveKYC(trader);

        vm.prank(trader);
        ex.openPosition{value: 1e14}(AAPL, true, 100e18, 1);
        assertEq(ex.profitCapOf(0), ex.getPosition(0).margin * 5, "profit cap frozen at 5x margin");
    }

    /// @dev The keeper reads `getPrice` before every post and refuses to write
    ///      when that read reverts. With the oracle's own staleness check on,
    ///      one outage longer than the limit would lock the keeper out for good.
    function test_staleTenantOracle_stillReadable_soTheKeeperCanRecover() public {
        (Spec memory s, , TenantBase.TenantDeployed memory d) = _tenant("bank-a");
        assertEq(GuardedOracle(d.oracle).maxPriceAge(), 0, "oracle-level staleness check is off");
        assertEq(GuardedOracle(d.oracle).maxDeviationBps(), 1_000);

        vm.warp(block.timestamp + 3 days);   // a long keeper outage
        (uint256 p, uint256 at) = IOracle(d.oracle).getPrice(BTC);   // must not revert
        assertEq(p, 100e8);
        assertLt(at, block.timestamp - 6 hours);

        // The exchange still refuses the stale quote on its own...
        usdc.mint(trader, 1_000e18);
        vm.deal(trader, 1 ether);
        vm.startPrank(trader);
        usdc.approve(d.exchange, type(uint256).max);
        PerpetualExchange(d.exchange).depositMargin(500e18);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.StalePrice.selector, BTC, at));
        PerpetualExchange(d.exchange).openPosition{value: 1e14}(BTC, true, 100e18, 1);
        vm.stopPrank();

        // ...and the keeper's next post ends the outage.
        vm.prank(s.keeper);
        GuardedOracle(d.oracle).updatePrice(BTC, 105e8);
        vm.prank(trader);
        PerpetualExchange(d.exchange).openPosition{value: 1e14}(BTC, true, 100e18, 1);
    }

    function test_mockOracleKind_withoutVault() public {
        Spec memory s = _spec("bank-m", address(usdc), address(source));
        s.oracleKind = "mock";
        s.deployVault = false;
        s.assets = "\"sBTC\",\"sETH\",\"sGOLD\"";
        DeployTenant script = _deployTenant(s, deployer);
        TenantBase.TenantDeployed memory d = script.lastDeployed();

        assertEq(Ownable(d.oracle).owner(), s.keeper, "MockOracle owner = the price writer");
        assertEq(d.assetVault, address(0));
        assertEq(d.tokens.length, 0);
        assertEq(PerpetualExchange(d.exchange).maxLongOI(AAPL), 0, "unregistered asset untouched");
        verifier.verify(_json(s), s.id, script.lastRecordJson(), s.admin);
    }

    // ── isolation ───────────────────────────────────────────────────────────

    function test_twoTenants_shareNoContractAndNoIncident() public {
        (Spec memory a, , TenantBase.TenantDeployed memory da) = _tenant("bank-a");
        (Spec memory b, , TenantBase.TenantDeployed memory db) = _tenant("bank-b");

        address[12] memory A = [da.oracle, da.esgRegistry, da.kyc, da.insuranceVault, da.feeRouter, da.traderStake,
            da.exchange, da.strategyRegistry, da.copyTracker, da.sessionManager, da.assetVault, da.assetVaultImpl];
        address[12] memory B = [db.oracle, db.esgRegistry, db.kyc, db.insuranceVault, db.feeRouter, db.traderStake,
            db.exchange, db.strategyRegistry, db.copyTracker, db.sessionManager, db.assetVault, db.assetVaultImpl];
        for (uint256 i; i < 12; i++) for (uint256 j; j < 12; j++) assertTrue(A[i] != B[j], "tenants share a contract");
        for (uint256 i; i < 11; i++) for (uint256 j; j < 11; j++) assertTrue(da.tokens[i] != db.tokens[j], "tenants share a token");

        PerpetualExchange exA = PerpetualExchange(da.exchange);
        PerpetualExchange exB = PerpetualExchange(db.exchange);

        // Incident isolation: A's guardian stops A, and only A.
        vm.prank(a.guardian); exA.pause();
        assertTrue(exA.paused());
        assertFalse(exB.paused(), "B keeps trading while A is paused");
        vm.prank(a.guardian);
        vm.expectRevert(abi.encodeWithSelector(PerpetualExchange.NotGuardianOrOwner.selector, a.guardian));
        exB.pause();
        // Freezing an asset on A's oracle leaves B's quote alone.
        vm.prank(a.guardian);
        GuardedOracle(da.oracle).setAssetFrozen(BTC, true);
        vm.expectRevert(abi.encodeWithSelector(GuardedOracle.AssetIsFrozen.selector, BTC));
        IOracle(da.oracle).getPrice(BTC);
        (uint256 pb, ) = IOracle(db.oracle).getPrice(BTC);
        assertEq(pb, 100e8);

        // Authority isolation: A's admin and keeper are nobody on B.
        vm.prank(a.admin);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, a.admin));
        exB.setMaxProfitBps(BTC, 60_000);
        vm.prank(a.keeper);
        vm.expectRevert();
        GuardedOracle(db.oracle).updatePrice(BTC, 101e8);
        vm.prank(b.keeper);
        GuardedOracle(db.oracle).updatePrice(BTC, 101e8);

        // Funds isolation: A's insurance vault only answers to A's exchange,
        // and each router pays its own treasury.
        assertEq(InsuranceVault(da.insuranceVault).exchange(), da.exchange);
        assertEq(InsuranceVault(db.insuranceVault).exchange(), db.exchange);
        assertTrue(FeeRouter(da.feeRouter).platformTreasury() != FeeRouter(db.feeRouter).platformTreasury());
        assertEq(FeeRouter(db.feeRouter).platformTreasury(), b.treasury);
    }

    // ── verification catches drift ──────────────────────────────────────────

    function test_verify_refusesAnotherTenantsExchange() public {
        (Spec memory a, DeployTenant sa, ) = _tenant("bank-a");
        (, , TenantBase.TenantDeployed memory db) = _tenant("bank-b");
        // A's record with B's exchange pasted in: the wiring no longer closes.
        string memory tampered = _replaceExchange(sa.lastRecordJson(), db.exchange);
        assertEq(vm.parseJsonAddress(tampered, ".contracts.PerpetualExchange"), db.exchange, "the swap took");
        vm.expectRevert(bytes("verify tenant mismatch: exchange.owner"));
        verifier.verify(_json(a), a.id, tampered, a.admin);
    }

    function test_verify_catchesChangedGuardianAndLeftoverDeployerRole() public {
        (Spec memory s, DeployTenant script, TenantBase.TenantDeployed memory d) = _tenant("bank-a");
        string memory record = script.lastRecordJson();
        uint256 snap = vm.snapshotState();

        vm.prank(s.admin);
        PerpetualExchange(d.exchange).setGuardian(makeAddr("someone-else"));
        vm.expectRevert(bytes("verify tenant mismatch: exchange.guardian"));
        verifier.verify(_json(s), s.id, record, s.admin);

        vm.revertToState(snap);
        vm.prank(s.admin);
        IAccessControl(d.oracle).grantRole(keccak256("KEEPER_ROLE"), deployer);
        vm.expectRevert(bytes("verify tenant failed: deployer has no role on the oracle"));
        verifier.verify(_json(s), s.id, record, s.admin);

        vm.revertToState(snap);
        vm.expectRevert(bytes("verify tenant mismatch: exchange.owner"));
        verifier.verify(_json(s), s.id, record, makeAddr("a-timelock-that-does-not-own-it"));
    }

    function test_verify_refusesRecordForAnotherChainOrTreasury() public {
        (Spec memory s, DeployTenant script, ) = _tenant("bank-a");
        string memory record = script.lastRecordJson();
        string memory cfg = _json(s);

        vm.chainId(8453);
        vm.expectRevert(bytes("deployment record: chainId != this chain"));
        verifier.verify(cfg, s.id, record, s.admin);
        vm.chainId(84532);

        s.treasury = makeAddr("a-different-treasury");
        vm.expectRevert(bytes("deployment record: treasury differs from the tenant config"));
        verifier.verify(_json(s), s.id, record, s.admin);
    }

    /// @dev Rebuilds the record with a different exchange address.
    function _replaceExchange(string memory record, address newExchange) internal pure returns (string memory) {
        string memory old = vm.toString(vm.parseJsonAddress(record, ".contracts.PerpetualExchange"));
        return vm.replace(record, old, vm.toString(newExchange));
    }

    // ── preflight refusals ──────────────────────────────────────────────────

    function _expectRefused(Spec memory s, address broadcaster, bytes memory reason) internal {
        DeployTenant script = new DeployTenant();
        script.setBroadcasterOverride(broadcaster);
        script.setAllowEoaAdmin(true);
        string memory json = _json(s);
        if (reason.length == 0) vm.expectRevert();
        else vm.expectRevert(reason);
        script.runWithConfig(json, s.id);
    }

    function _valid() internal returns (Spec memory) {
        return _spec("bank-a", address(usdc), address(source));
    }

    function test_refuses_roleOverlaps() public {
        Spec memory s = _valid();
        s.guardian = s.keeper;
        _expectRefused(s, deployer, bytes("roles: admin / keeper / guardian / risk must be four different addresses"));

        s = _valid();
        s.risk = s.admin;
        _expectRefused(s, deployer, bytes("roles: admin / keeper / guardian / risk must be four different addresses"));

        s = _valid();
        s.marketOperator = s.guardian;
        _expectRefused(s, deployer, bytes("roles: guardian must differ from marketOperator"));

        s = _valid();
        s.treasury = s.keeper;
        _expectRefused(s, deployer, bytes("roles: the keeper hot key must not be the treasury"));

        s = _valid();
        s.treasury = s.guardian;
        _expectRefused(s, deployer, bytes("roles: the guardian hot key must not be the treasury"));

        s = _valid();
        s.guardian = address(0);
        _expectRefused(s, deployer, bytes("roles: none may be the zero address"));
    }

    function test_refuses_deployerHoldingAnyRole() public {
        Spec memory s = _valid();
        bytes memory why = bytes("roles: the deployer key must hold no tenant role (it ends the run with no privileges)");
        _expectRefused(s, s.admin, why);
        _expectRefused(s, s.keeper, why);
        _expectRefused(s, s.guardian, why);
        _expectRefused(s, s.risk, why);
        _expectRefused(s, s.treasury, why);
        s.marketOperator = makeAddr("separate-operator");
        _expectRefused(s, s.marketOperator, why);
    }

    function test_refuses_unlimitedOrOutOfRangeCaps() public {
        Spec memory s = _valid();
        s.oiCapNonRwaUsdc = 0;
        _expectRefused(s, deployer, bytes("params: OI caps must be non-zero (0 = unlimited)"));
        s = _valid();
        s.oiCapRwaUsdc = 0;
        _expectRefused(s, deployer, bytes("params: OI caps must be non-zero (0 = unlimited)"));
        s = _valid();
        s.maxProfitBps = 0;
        _expectRefused(s, deployer, bytes("params: maxProfitBps must be in [10000, 250000] (0 = off is not allowed)"));
        s = _valid();
        s.maxProfitBps = 250_001;
        _expectRefused(s, deployer, bytes("params: maxProfitBps must be in [10000, 250000] (0 = off is not allowed)"));
    }

    function test_refuses_badAssetsAndOracleKind() public {
        Spec memory s = _valid();
        s.assets = "\"sBTC\",\"sDOGE\"";
        _expectRefused(s, deployer, bytes("assets.registered: unknown asset sDOGE"));
        s = _valid();
        s.assets = "\"sBTC\",\"sETH\",\"sBTC\"";
        _expectRefused(s, deployer, bytes("assets.registered: duplicate symbol"));
        s = _valid();
        s.assets = "";
        _expectRefused(s, deployer, bytes("assets.registered: 1 to 11 assets"));
        s = _valid();
        s.oracleKind = "chainlink";
        _expectRefused(s, deployer, bytes("tenant config: params.oracleKind must be 'guarded' or 'mock'"));
        s = _valid();
        s.oracleKind = "mock";   // deployVault still true
        _expectRefused(s, deployer, bytes("params: deployVault requires oracleKind 'guarded'"));
    }

    function test_refuses_statusChainAndIdMismatch() public {
        Spec memory s = _valid();
        s.status = "template";
        _expectRefused(s, deployer, bytes("tenant config: status must be 'ready' (template = placeholders left, deployed = already done)"));
        s = _valid();
        s.status = "deployed";
        _expectRefused(s, deployer, bytes("tenant config: status must be 'ready' (template = placeholders left, deployed = already done)"));
        s = _valid();
        s.chainId = 8453;
        _expectRefused(s, deployer, bytes("tenant config: network.chainId != the chain this run is connected to"));

        // The file says bank-b, the operator asked for bank-a.
        s = _valid();
        DeployTenant script = new DeployTenant();
        script.setBroadcasterOverride(deployer);
        string memory json = _json(s);
        vm.expectRevert(bytes("tenant config: tenantId != TENANT"));
        script.runWithConfig(json, "bank-b");
    }

    function test_refuses_mockOracleOnBaseMainnet() public {
        vm.chainId(8453);
        Spec memory s = _valid();
        s.oracleKind = "mock";
        s.deployVault = false;
        _expectRefused(s, deployer, bytes("params.oracleKind 'mock' is not allowed on Base mainnet"));
    }

    function test_refuses_eoaAdminUnlessAllowed() public {
        Spec memory s = _valid();
        DeployTenant script = new DeployTenant();
        script.setBroadcasterOverride(deployer);
        string memory json = _json(s);
        vm.expectRevert(bytes("roles.admin has no code - it must be a multisig (ALLOW_EOA_ADMIN=true only for rehearsals)"));
        script.runWithConfig(json, s.id);

        // An admin with code (stand-in for a multisig) needs no override.
        vm.etch(s.admin, hex"00");
        script.runWithConfig(json, s.id);
        assertEq(PerpetualExchange(script.lastDeployed().exchange).owner(), s.admin);
    }

    function test_refuses_wrongSettlementToken() public {
        Spec memory s = _valid();
        s.usdc = address(new SixDecimalToken());
        _expectRefused(s, deployer, bytes("shared.settlementToken must have 18 decimals (PerpetualExchange requirement)"));
        s = _valid();
        s.usdc = makeAddr("no-code-token");
        _expectRefused(s, deployer, bytes("shared.settlementToken has no code on this chain"));
    }

    function test_refuses_staleOrMissingSeedPrice() public {
        Spec memory s = _valid();
        vm.warp(block.timestamp + 1 hours + 1);
        _expectRefused(s, deployer,
            bytes("price source: sBTC is older than 1h - refresh the source first (a stale seed would look fresh on the new oracle)"));

        MockOracle sparse = new MockOracle();
        sparse.addAsset(BTC, 100e8);
        s = _spec("bank-a", address(usdc), address(sparse));
        _expectRefused(s, deployer, bytes("price source refused to quote sETH"));

        s = _valid();
        s.priceSource = makeAddr("no-code-source");
        _expectRefused(s, deployer, bytes("shared.priceSource has no code on this chain"));
    }

    function test_refuses_idsThatAreNotFileNames() public {
        vm.expectRevert(bytes("TENANT: only [a-z0-9] and single hyphens (it is a file name)"));
        verifier.requireSlug("../secrets");
        vm.expectRevert(bytes("TENANT: only [a-z0-9] and single hyphens (it is a file name)"));
        verifier.requireSlug("Bank-A");
        vm.expectRevert(bytes("TENANT: only [a-z0-9] and single hyphens (it is a file name)"));
        verifier.requireSlug("bank--a");
        vm.expectRevert(bytes("TENANT: only [a-z0-9] and single hyphens (it is a file name)"));
        verifier.requireSlug("_template");
        vm.expectRevert(bytes("TENANT: empty or longer than 64 chars"));
        verifier.requireSlug("");
        vm.expectRevert(bytes("TENANT: 'default' is the live platform, not a tenant deployment"));
        verifier.requireSlug("default");
        verifier.requireSlug("bank-a-2");
    }

    // ── the checked-in configs and the filesystem boundary ──────────────────

    /// @dev `run()` reads deploy/tenants/<id>.json. The committed demo tenant
    ///      is a template (placeholder addresses): readable, never deployable.
    function test_run_readsTenantDir_andRefusesTheCommittedTemplate() public {
        string memory raw = vm.readFile("../deploy/tenants/demo-bank.json");
        assertEq(vm.parseJsonString(raw, ".tenantId"), "demo-bank", "fs_permissions lets the script read deploy/tenants");
        assertEq(vm.parseJsonString(raw, ".status"), "template");

        DeployTenant script = new DeployTenant();
        script.setBroadcasterOverride(deployer);
        vm.expectRevert();   // "<DEMO_BANK_ADMIN_MULTISIG>" is not an address
        script.runWithConfig(raw, "demo-bank");
    }

    function test_fsPermissions_stopAtTheTenantDir() public {
        // try/catch, not expectRevert: a refused cheatcode fails at the test's own depth.
        try vm.readFile("../deploy-base-sepolia.sh") returns (string memory) {
            fail("read outside deploy/tenants was allowed");
        } catch {}
        try vm.readFile("../frontend/src/contracts/addresses.ts") returns (string memory) {
            fail("read outside deploy/tenants was allowed");
        } catch {}
        try vm.writeFile("../deploy/tenants/should-not-exist.json", "{}") {
            fail("write into deploy/tenants was allowed");
        } catch {}
        assertFalse(vm.exists("../deploy/tenants/should-not-exist.json"));
    }

    function test_rwaClassification_matchesTheLivePlatform() public {
        Rwa130Harness live = new Rwa130Harness();
        string[11] memory syms = _allSyms();
        uint256 rwaCount;
        for (uint256 i; i < 11; i++) {
            assertEq(verifier.isRwa(syms[i]), live.isRwa(syms[i]), syms[i]);
            if (verifier.isRwa(syms[i])) rwaCount++;
            assertGt(bytes(verifier.tokenName(syms[i])).length, 0);
        }
        assertEq(rwaCount, 8);
    }
}
