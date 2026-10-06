// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../script/DeployVCKycRegistry.s.sol";
import "../src/PerpetualExchange.sol";
import "../src/MockUSDC.sol";
import "../src/MockOracle.sol";

contract DeployVCKycRegistryTest is Test {
    DeployVCKycRegistry script;
    PerpetualExchange exchange;
    address issuer = makeAddr("issuer");
    address finalOwner = makeAddr("finalOwner");

    bytes32 constant QI = keccak256("QUALIFIED_INVESTOR");
    bytes32 constant BASIC = keccak256("KYC_BASIC");
    address constant LEAKED = 0xE80A81360608C1342e66743F70a00f75d792Eb93;

    function setUp() public {
        script = new DeployVCKycRegistry();
        exchange = new PerpetualExchange(address(new MockUSDC()), address(new MockOracle()), address(0));
    }

    function _cfg(bool wire) internal view returns (DeployVCKycRegistry.Config memory c) {
        c.broadcaster = address(script);
        c.owner = address(script);
        c.issuer = issuer;
        c.issuerTypes = new bytes32[](2);
        c.issuerTypes[0] = QI;
        c.issuerTypes[1] = BASIC;
        c.requiredType = QI;
        c.wireExchange = wire;
        c.exchange = address(exchange);
        c.rwaAssets = new string[](2);
        c.rwaAssets[0] = "sAAPL";
        c.rwaAssets[1] = "sTSLA";
    }

    function test_deploy_wiresExchange_whenBroadcasterIsOwner() public {
        exchange.transferOwnership(address(script));
        VCKycRegistry r = script.deploy(_cfg(true));
        assertEq(address(exchange.kyc()), address(r));
        assertTrue(exchange.rwaAsset(keccak256("sAAPL")));
        assertTrue(exchange.rwaAsset(keccak256("sTSLA")));
        assertTrue(r.trustedIssuer(issuer, QI));
        assertTrue(r.trustedIssuer(issuer, BASIC));
        assertEq(r.requiredType(), QI);
        assertEq(r.owner(), address(script));
    }

    function test_deploy_skipsWiring_whenNotOwner() public {
        // exchange owner 是這個測試合約，不是 broadcaster（script）
        VCKycRegistry r = script.deploy(_cfg(true));
        assertEq(address(exchange.kyc()), address(0));
        assertFalse(exchange.rwaAsset(keccak256("sAAPL")));
        assertTrue(r.trustedIssuer(issuer, QI));
    }

    function test_deploy_noWire_byDefault() public {
        exchange.transferOwnership(address(script));
        script.deploy(_cfg(false));
        assertEq(address(exchange.kyc()), address(0));
    }

    function test_deploy_ownershipTransfer_isTwoStep() public {
        DeployVCKycRegistry.Config memory c = _cfg(false);
        c.owner = finalOwner;
        VCKycRegistry r = script.deploy(c);
        assertEq(r.owner(), address(script));
        assertEq(r.pendingOwner(), finalOwner);
        vm.prank(finalOwner);
        r.acceptOwnership();
        assertEq(r.owner(), finalOwner);
    }

    function test_validate_rejectsCompromised() public {
        DeployVCKycRegistry.Config memory c = _cfg(false);
        c.issuer = LEAKED;
        vm.expectRevert(abi.encodeWithSelector(DeployVCKycRegistry.CompromisedAddress.selector, "issuer", LEAKED));
        script.validate(c);
        c = _cfg(false);
        c.broadcaster = LEAKED;
        vm.expectRevert(abi.encodeWithSelector(DeployVCKycRegistry.CompromisedAddress.selector, "broadcaster", LEAKED));
        script.validate(c);
        c = _cfg(false);
        c.owner = LEAKED;
        vm.expectRevert(abi.encodeWithSelector(DeployVCKycRegistry.CompromisedAddress.selector, "owner", LEAKED));
        script.validate(c);
    }

    function test_validate_requiresIssuerAndExchange() public {
        DeployVCKycRegistry.Config memory c = _cfg(false);
        c.issuer = address(0);
        vm.expectRevert(DeployVCKycRegistry.MissingIssuer.selector);
        script.validate(c);
        c = _cfg(true);
        c.exchange = address(0);
        vm.expectRevert(DeployVCKycRegistry.MissingExchange.selector);
        script.validate(c);
    }

    function test_checkChain() public {
        script.checkChain(31337, 0);
        script.checkChain(1337, 1337);
        vm.expectRevert(abi.encodeWithSelector(DeployVCKycRegistry.ChainNotConfirmed.selector, uint256(84532)));
        script.checkChain(84532, 0);
    }

    function test_typeId() public {
        assertEq(script.typeId("QUALIFIED_INVESTOR"), QI);
        assertEq(script.typeId("KYC_BASIC"), BASIC);
        vm.expectRevert(abi.encodeWithSelector(DeployVCKycRegistry.UnknownCredentialType.selector, "qi"));
        script.typeId("qi");
    }
}
