// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";
import "../src/ESGRegistryV2.sol";
import "../src/PerpetualExchange.sol";
import "../script/AttestTenantCarbon.s.sol";
import "./TenantFixture.sol";

/// @notice `AttestTenantCarbon` writes the shared carbon list into a tenant's
///         own ESGRegistryV2: attest only, refuses a wrong chain, a key without
///         ATTESTOR_ROLE and the leaked deployer, and the tenant still verifies
///         (an attestor is an appointment, reported).
contract AttestTenantCarbonTest is TenantFixture {
    MockUSDC   usdc;
    MockOracle source;
    TenantVerifyHarness verifier;
    AttestTenantCarbon attestScript;

    address deployer = makeAddr("tenant-deployer");
    address attestor = makeAddr("carbon-attestor");

    function setUp() public {
        vm.chainId(84532);
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        source = new MockOracle();
        string[11] memory syms = _allSyms();
        for (uint256 i; i < 11; i++) source.addAsset(keccak256(bytes(syms[i])), (i + 1) * 100e8);
        verifier = new TenantVerifyHarness();
        attestScript = new AttestTenantCarbon();
    }

    function _tenant() internal returns (Spec memory s, string memory record, TenantBase.TenantDeployed memory d) {
        s = _spec("carbon-t", address(usdc), address(source));
        DeployTenant script = _deployTenant(s, deployer);
        record = script.lastRecordJson();
        d = script.lastDeployed();
    }

    function test_attestsEveryAsset_tiersMatchTheSharedList_tenantStillVerifies() public {
        (Spec memory s, string memory record, TenantBase.TenantDeployed memory d) = _tenant();
        ESGRegistryV2 esg = ESGRegistryV2(d.esgRegistry);
        PerpetualExchange ex = PerpetualExchange(d.exchange);
        assertEq(ex.maxLeverageForAsset(keccak256("sNVDA")), 1, "Unrated before any attestation");

        vm.startPrank(s.admin);
        esg.grantRole(esg.ATTESTOR_ROLE(), attestor);
        vm.stopPrank();
        vm.recordLogs();
        uint256 n = attestScript.attestAs(attestor, d.esgRegistry, 84532, new string[](0), "");
        assertEq(n, 11);

        CarbonAttestations.A[11] memory list = CarbonAttestations.assets();
        for (uint256 i; i < 11; i++) {
            (CarbonTiers.Tier t, , , bool ok) = esg.medianCarbonTier(keccak256(bytes(list[i].symbol)));
            assertTrue(ok, list[i].symbol);
            assertEq(uint256(t), uint256(list[i].tier), list[i].symbol);
        }
        assertGt(ex.maxLeverageForAsset(keccak256("sNVDA")), 1, "a Low tier lifts the 1x Unrated cap");
        verifier.verify(_json(s), s.id, record, s.admin);
    }

    function test_attestsOnlyTheNamedAssets() public {
        (Spec memory s, , TenantBase.TenantDeployed memory d) = _tenant();
        ESGRegistryV2 esg = ESGRegistryV2(d.esgRegistry);
        vm.startPrank(s.admin);
        esg.grantRole(esg.ATTESTOR_ROLE(), attestor);
        vm.stopPrank();
        string[] memory only = new string[](2);
        (only[0], only[1]) = ("sGOLD", "sAAPL");
        assertEq(attestScript.attestAs(attestor, d.esgRegistry, 84532, only, ""), 2);
        assertTrue(esg.hasAttested(keccak256("sGOLD"), attestor));
        assertFalse(esg.hasAttested(keccak256("sBTC"), attestor));

        only = new string[](1);
        only[0] = "sDOGE";
        vm.expectRevert(abi.encodeWithSelector(AttestTenantCarbon.UnknownAsset.selector, "sDOGE"));
        attestScript.attestAs(attestor, d.esgRegistry, 84532, only, "");
    }

    /// @dev With the deployment record (TENANT_RECORD / TENANT), ESG_REGISTRY
    ///      must be the record's own registry on this chain.
    function test_recordCrossCheck_refusesAnotherRegistryOrChain() public {
        (Spec memory s, string memory record, TenantBase.TenantDeployed memory d) = _tenant();
        ESGRegistryV2 esg = ESGRegistryV2(d.esgRegistry);
        vm.startPrank(s.admin);
        esg.grantRole(esg.ATTESTOR_ROLE(), attestor);
        vm.stopPrank();
        string[] memory one = new string[](1);
        one[0] = "sGOLD";
        uint256 snap = vm.snapshotState();

        assertEq(attestScript.attestAs(attestor, d.esgRegistry, 84532, one, record), 1, "matching record");

        // A registry that is not the recorded one: nothing is written.
        vm.revertToState(snap);
        ESGRegistryV2 other = new ESGRegistryV2(s.admin);
        vm.expectRevert(abi.encodeWithSelector(AttestTenantCarbon.RecordMismatch.selector, d.esgRegistry, address(other)));
        attestScript.attestAs(attestor, address(other), 84532, one, record);
        assertFalse(esg.hasAttested(keccak256("sGOLD"), attestor));

        // A record from another chain.
        string memory foreign = vm.replace(record, "\"chainId\":84532", "\"chainId\":8453");
        vm.expectRevert(abi.encodeWithSelector(AttestTenantCarbon.RecordChainMismatch.selector, 8453, 84532));
        attestScript.attestAs(attestor, d.esgRegistry, 84532, one, foreign);
    }

    function test_refuses_wrongChainNonAttestorLeakedKeyOrNoRegistry() public {
        (Spec memory s, , TenantBase.TenantDeployed memory d) = _tenant();
        ESGRegistryV2 esg = ESGRegistryV2(d.esgRegistry);
        string[] memory all = new string[](0);

        vm.expectRevert(abi.encodeWithSelector(AttestTenantCarbon.NotAnAttestor.selector, attestor));
        attestScript.attestAs(attestor, d.esgRegistry, 84532, all, "");

        vm.startPrank(s.admin);
        esg.grantRole(esg.ATTESTOR_ROLE(), attestor);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(AttestTenantCarbon.ChainNotConfirmed.selector, 84532, 0));
        attestScript.attestAs(attestor, d.esgRegistry, 0, all, "");
        vm.expectRevert(abi.encodeWithSelector(AttestTenantCarbon.ChainNotConfirmed.selector, 84532, 8453));
        attestScript.attestAs(attestor, d.esgRegistry, 8453, all, "");

        address leaked = 0xE80A81360608C1342e66743F70a00f75d792Eb93;
        vm.expectRevert(abi.encodeWithSelector(AttestTenantCarbon.CompromisedAddress.selector, leaked));
        attestScript.attestAs(leaked, d.esgRegistry, 84532, all, "");

        address eoa = makeAddr("not-a-registry");
        vm.expectRevert(abi.encodeWithSelector(AttestTenantCarbon.NoRegistry.selector, eoa));
        attestScript.attestAs(attestor, eoa, 84532, all, "");
    }
}
