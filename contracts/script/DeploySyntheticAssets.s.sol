// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/AssetVault.sol";
import "../src/SyntheticAsset.sol";

/// @notice Deploys the tokenized-asset layer: one AssetVault plus an ERC-20 for
///         each of the 11 synthetic assets, registered with the vault.
///
///         Reuses the ALREADY DEPLOYED MockUSDC and MockOracle — passed in via
///         env so nothing existing is redeployed:
///
///           MOCKUSDC_ADDR=0x…  MOCKORACLE_ADDR=0x…  forge script …
///
///         assetId is keccak256(symbol), matching ASSET_IDS in the frontend's
///         addresses.ts and the ids already registered on the live oracle.
///
///         After broadcasting, seed the vault with fundVault() or redemptions
///         will revert once prices rise above the USDC users paid in.
contract DeploySyntheticAssets is Script {
    function _defs()
        internal
        pure
        returns (string[11] memory syms, string[11] memory names)
    {
        syms = [
            "sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND",
            "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"
        ];
        names = [
            "Synthetic Bitcoin",
            "Synthetic Ether",
            "Synthetic Apple",
            "Synthetic Tesla",
            "Synthetic Gold",
            "Synthetic Bond",
            "Synthetic Nvidia",
            "Synthetic Microsoft",
            "Synthetic Alphabet",
            "Synthetic Clean Energy ETF",
            "Synthetic ESG ETF"
        ];
    }

    function run() external {
        address usdc   = vm.envAddress("MOCKUSDC_ADDR");
        address oracle = vm.envAddress("MOCKORACLE_ADDR");

        vm.startBroadcast();

        AssetVault vault = new AssetVault(usdc, oracle);
        console.log("AssetVault deployed:", address(vault));

        (string[11] memory syms, string[11] memory names) = _defs();
        for (uint256 i = 0; i < 11; i++) {
            bytes32 aid = keccak256(bytes(syms[i]));
            SyntheticAsset token = new SyntheticAsset(names[i], syms[i], aid, address(vault));
            vault.registerAsset(aid, address(token));
            console.log(syms[i], address(token));
        }

        vm.stopBroadcast();

        console.log("---");
        console.log("Paste the vault into addresses.ts AssetVault and the 11 tokens into SYNTH_TOKENS.");
        console.log("Then approve + fundVault() so users can redeem.");
    }
}
