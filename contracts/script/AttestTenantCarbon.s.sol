// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/ESGRegistryV2.sol";
import "../src/CarbonTiers.sol";
import "./CarbonAttestations.sol";

/// @notice Writes the team's carbon attestations (`CarbonAttestations`, the
///         same list the platform's `Deploy102CarbonRegistry` writes) into a
///         tenant's own `ESGRegistryV2`. Attest only: it deploys nothing and
///         grants nothing.
///
///         A tenant's ESGRegistryV2 starts empty — every asset `Unrated`, 1x
///         and the most conservative fee row (docs/TENANT_DEPLOYMENT.md sec.5)
///         — until the tenant admin grants `ATTESTOR_ROLE` and an attestor
///         writes tiers. The broadcaster must already hold that role (the
///         admin grants it; this script cannot). Say who the attestor is: when
///         it is the tenant's own key, the tiers are the operator's own
///         statement, not an independent agency's.
///
///         Dry run first (no key, nothing sent), then broadcast from the
///         attestor's keystore:
///           ESG_REGISTRY=0x… ATTEST_CHAIN_ID=84532 \
///           forge script script/AttestTenantCarbon.s.sol:AttestTenantCarbon \
///             --rpc-url "$BASE_SEPOLIA_RPC_URL" --sender <attestor address>
///           … --account <attestor keystore> --sender <attestor address> --broadcast --slow
///
///         Env:
///           ESG_REGISTRY      required — the tenant's ESGRegistryV2 (deployment record contracts.ESGRegistryV2)
///           ATTEST_CHAIN_ID   required — must equal the connected chain (no accidental public-chain run)
///           ATTEST_ASSETS     optional — comma-separated symbols; default all eleven
///           TENANT_RECORD     optional — a deployment record (`cache/tenants/<id>.deployed.json`
///                             or `../deploy/tenants/<id>.deployed.json`; foundry.toml's
///                             fs_permissions allow reading only those two directories)
///           TENANT            optional — shorthand for `../deploy/tenants/<TENANT>.deployed.json`
///                             (TENANT_RECORD wins when both are set)
///         With a record, its `contracts.ESGRegistryV2` and `chainId` must match
///         ESG_REGISTRY and this chain, or nothing is sent: a mistyped address
///         cannot attest into another tenant's (or the platform's) registry.
contract AttestTenantCarbon is Script {
    /// Mirrors agent/shared/src/payoutSafety.ts COMPROMISED_ADDRESSES.
    address internal constant LEAKED_DEPLOYER = 0xE80A81360608C1342e66743F70a00f75d792Eb93;

    error CompromisedAddress(address who);
    error ChainNotConfirmed(uint256 chainId, uint256 confirmed);
    error NoRegistry(address registry);
    error NotAnAttestor(address who);
    error UnknownAsset(string symbol);
    error RecordMismatch(address recorded, address registry);
    error RecordChainMismatch(uint256 recorded, uint256 chainId);
    error BadTenantId(string id);

    function run() external {
        address registry = vm.envAddress("ESG_REGISTRY");
        uint256 confirmed = vm.envOr("ATTEST_CHAIN_ID", uint256(0));
        string[] memory only = vm.envOr("ATTEST_ASSETS", ",", new string[](0));
        attestAs(msg.sender, registry, confirmed, only, _recordJson());
    }

    /// @dev "" when neither TENANT_RECORD nor TENANT is set.
    function _recordJson() internal view returns (string memory) {
        string memory path = vm.envOr("TENANT_RECORD", string(""));
        if (bytes(path).length == 0) {
            string memory id = vm.envOr("TENANT", string(""));
            if (bytes(id).length == 0) return "";
            _requireSlug(id);
            path = string.concat("../deploy/tenants/", id, ".deployed.json");
        }
        return vm.readFile(path);
    }

    /// @dev Lower-case letters, digits and single hyphens: TENANT is a file name.
    function _requireSlug(string memory id) internal pure {
        bytes memory b = bytes(id);
        if (b.length == 0 || b.length > 64) revert BadTenantId(id);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 ch = b[i];
            bool alnum = (ch >= 0x30 && ch <= 0x39) || (ch >= 0x61 && ch <= 0x7a);
            bool hyphen = ch == 0x2d && i != 0 && i != b.length - 1 && b[i - 1] != 0x2d;
            if (!alnum && !hyphen) revert BadTenantId(id);
        }
    }

    /// @dev Split from `run` so a test can name the broadcaster. `recordJson`
    ///      "" skips the record cross-check.
    function attestAs(address attestor, address registry, uint256 confirmedChainId, string[] memory only, string memory recordJson)
        public returns (uint256 written)
    {
        if (attestor == LEAKED_DEPLOYER) revert CompromisedAddress(attestor);
        if (confirmedChainId != block.chainid) revert ChainNotConfirmed(block.chainid, confirmedChainId);
        if (bytes(recordJson).length > 0) {
            uint256 recordedChain = vm.parseJsonUint(recordJson, ".chainId");
            if (recordedChain != block.chainid) revert RecordChainMismatch(recordedChain, block.chainid);
            address recorded = vm.parseJsonAddress(recordJson, ".contracts.ESGRegistryV2");
            if (recorded != registry) revert RecordMismatch(recorded, registry);
            console.log("ok   ESG_REGISTRY == the deployment record's contracts.ESGRegistryV2");
        }
        if (registry.code.length == 0) revert NoRegistry(registry);
        ESGRegistryV2 esg = ESGRegistryV2(registry);
        if (!esg.hasRole(esg.ATTESTOR_ROLE(), attestor)) revert NotAnAttestor(attestor);

        CarbonAttestations.A[11] memory list = CarbonAttestations.assets();
        bool[] memory pick = _pick(list, only);

        vm.startBroadcast(attestor);
        for (uint256 i = 0; i < list.length; i++) {
            if (!pick[i]) continue;
            CarbonAttestations.attest(esg, list[i]);
            written++;
        }
        vm.stopBroadcast();

        // Read back what this attestor wrote: the tier the exchange prices on
        // is the median over attestors, so check this attestor's own entry.
        for (uint256 i = 0; i < list.length; i++) {
            if (!pick[i]) continue;
            ESGRegistryV2.Attestation memory a = esg.getAttestation(keccak256(bytes(list[i].symbol)), attestor);
            require(a.exists && a.tier == list[i].tier && a.basis == list[i].basis,
                string.concat("attestation did not land for ", list[i].symbol));
            console.log(string.concat("ok   ", list[i].symbol, " tier"), uint256(a.tier));
        }
        console.log("attestor          :", attestor);
        console.log("ESGRegistryV2     :", registry);
        console.log("attestations      :", written);
    }

    function _pick(CarbonAttestations.A[11] memory list, string[] memory only) internal pure returns (bool[] memory pick) {
        pick = new bool[](list.length);
        if (only.length == 0) {
            for (uint256 i = 0; i < list.length; i++) pick[i] = true;
            return pick;
        }
        for (uint256 j = 0; j < only.length; j++) {
            bool found;
            for (uint256 i = 0; i < list.length; i++) {
                if (keccak256(bytes(list[i].symbol)) == keccak256(bytes(only[j]))) (pick[i], found) = (true, true);
            }
            if (!found) revert UnknownAsset(only[j]);
        }
    }
}
