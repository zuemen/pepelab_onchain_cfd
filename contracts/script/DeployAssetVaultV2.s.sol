// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/v2/AssetVaultV2.sol";
import "../src/v2/SyntheticAssetV2.sol";

/// @notice Deploys the V2 tokenized-asset layer alongside V1. V1 stays deployed
///         and untouched.
///
///           MOCKUSDC_ADDR=0x… MOCKORACLE_ADDR=0x… forge script … --broadcast
///
///         Caps default to 0 (asset closed) so nothing can be minted until the
///         operator's risk committee sets real limits. This is deliberate — an
///         open cap on deploy would be a risk decision made by a script.
contract DeployAssetVaultV2 is Script {
    function _defs()
        internal pure
        returns (string[11] memory syms, string[11] memory names)
    {
        syms = [
            "sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND",
            "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"
        ];
        names = [
            "Synthetic Bitcoin", "Synthetic Ether", "Synthetic Apple",
            "Synthetic Tesla", "Synthetic Gold", "Synthetic Bond",
            "Synthetic Nvidia", "Synthetic Microsoft", "Synthetic Alphabet",
            "Synthetic Clean Energy ETF", "Synthetic ESG ETF"
        ];
    }

    function run() external {
        address usdc   = vm.envAddress("MOCKUSDC_ADDR");
        address oracle = vm.envAddress("MOCKORACLE_ADDR");
        address admin  = msg.sender;

        vm.startBroadcast();

        AssetVaultV2 impl = new AssetVaultV2();
        console.log("AssetVaultV2 implementation:", address(impl));

        ERC1967Proxy proxy = new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (usdc, oracle, admin))
        );
        AssetVaultV2 vault = AssetVaultV2(address(proxy));
        console.log("AssetVaultV2 proxy (use this):", address(vault));

        (string[11] memory syms, string[11] memory names) = _defs();
        bytes32 minterRole = keccak256("MINTER_ROLE");

        for (uint256 i = 0; i < 11; i++) {
            bytes32 aid = keccak256(bytes(syms[i]));
            SyntheticAssetV2 token = new SyntheticAssetV2(names[i], syms[i], aid, admin);
            token.grantRole(minterRole, address(vault));
            vault.registerAsset(aid, address(token));
            console.log(syms[i], address(token));
        }

        vm.stopBroadcast();

        console.log("---");
        console.log("Caps are 0 - every asset is closed to new mints.");
        console.log("Risk committee must call setAssetCap() before use.");
        console.log("Then approve + fundVault() to seed payout collateral.");
    }
}
