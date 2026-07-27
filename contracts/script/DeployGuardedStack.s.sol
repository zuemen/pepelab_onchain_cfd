// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/v2/GuardedOracle.sol";
import "../src/v2/AssetVaultV2.sol";
import "../src/v2/SyntheticAssetV2.sol";

interface IExistingOracle {
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt);
}

/// @notice Deploys the hardened stack and wires it together in one broadcast:
///
///           GuardedOracle  (multi-keeper, deviation-capped, freezable)
///           AssetVaultV2   (UUPS proxy) -> pointed at GuardedOracle
///           11x SyntheticAssetV2        -> vault holds MINTER_ROLE
///
///         Nothing existing is touched. V1's AssetVault, the 11 V1 tokens, and
///         MockOracle all keep running — this deploys alongside so the two can
///         be compared.
///
///           MOCKUSDC_ADDR=0x… MOCKORACLE_ADDR=0x… forge script … --broadcast
///
///         Seeding: prices are copied from the existing MockOracle so the new
///         oracle starts in sync with the live one. Starting from a hardcoded
///         guess would make the first keeper post look like a huge move and trip
///         the deviation cap.
contract DeployGuardedStack is Script {
    uint256 constant ASSET_COUNT = 11;

    function _defs()
        internal pure
        returns (string[ASSET_COUNT] memory syms, string[ASSET_COUNT] memory names)
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
        address usdc      = vm.envAddress("MOCKUSDC_ADDR");
        address oldOracle = vm.envAddress("MOCKORACLE_ADDR");
        address admin     = msg.sender;

        (string[ASSET_COUNT] memory syms, string[ASSET_COUNT] memory names) = _defs();

        // Read live prices BEFORE broadcasting — these are view calls.
        uint256[ASSET_COUNT] memory seeded;
        for (uint256 i = 0; i < ASSET_COUNT; i++) {
            bytes32 aid = keccak256(bytes(syms[i]));
            try IExistingOracle(oldOracle).getPrice(aid) returns (uint256 p, uint256) {
                seeded[i] = p;
            } catch {
                seeded[i] = 0;
            }
        }

        vm.startBroadcast();

        // 1. Hardened oracle, seeded in sync with the live one.
        GuardedOracle guarded = new GuardedOracle(admin);
        console.log("GuardedOracle:", address(guarded));
        for (uint256 i = 0; i < ASSET_COUNT; i++) {
            if (seeded[i] > 0) guarded.addAsset(keccak256(bytes(syms[i])), seeded[i]);
        }
        // The deployer runs the keeper for now. Production: separate hot key,
        // and move DEFAULT_ADMIN_ROLE to a multisig behind a timelock.
        guarded.grantRole(guarded.KEEPER_ROLE(), admin);

        // 2. Upgradeable vault, initialized on the OLD oracle then migrated, so
        //    setOracle is exercised on-chain rather than merely existing.
        AssetVaultV2 impl = new AssetVaultV2();
        console.log("AssetVaultV2 impl:", address(impl));

        AssetVaultV2 vault = AssetVaultV2(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(AssetVaultV2.initialize, (usdc, oldOracle, admin))
        )));
        console.log("AssetVaultV2 proxy:", address(vault));

        vault.setOracle(address(guarded));

        // 3. Tokens, each granting the vault mint/burn rights.
        bytes32 minterRole = keccak256("MINTER_ROLE");
        for (uint256 i = 0; i < ASSET_COUNT; i++) {
            bytes32 aid = keccak256(bytes(syms[i]));
            SyntheticAssetV2 t = new SyntheticAssetV2(names[i], syms[i], aid, admin);
            t.grantRole(minterRole, address(vault));
            vault.registerAsset(aid, address(t));
            console.log(syms[i], address(t));
        }

        vm.stopBroadcast();

        console.log("---");
        console.log("Caps are 0 - every asset closed until the risk owner sets limits.");
        console.log("Then approve + fundVault() to seed payout collateral.");
    }
}
