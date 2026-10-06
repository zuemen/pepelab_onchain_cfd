// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/VCKycRegistry.sol";

interface IOwnedExchange {
    function owner() external view returns (address);
    function setKycRegistry(address _kyc) external;
    function setRwaAsset(bytes32 asset, bool isRwa) external;
    function kyc() external view returns (address);
    function rwaAsset(bytes32 asset) external view returns (bool);
}

/// @title  DeployVCKycRegistry — 部署 VC 准入的 KYC 登錄（docs/SSI_RWA_ACCESS.md）
/// @notice 1. 部署 VCKycRegistry（requiredType 預設 QUALIFIED_INVESTOR）
///         2. 設定受信任發證者（VC_KYC_ISSUER，類型由 VC_KYC_ISSUER_TYPES 指定）
///         3. 可選：VC_KYC_WIRE_EXCHANGE=true 且 **broadcaster 是 exchange owner** 時，
///            以既有 setter `setKycRegistry` 把 exchange 換到新登錄、`setRwaAsset` 標記 RWA 資產。
///            broadcaster 不是 owner 時只印出 owner 要送的兩筆呼叫，不嘗試送出。
///         4. VC_KYC_OWNER 與 broadcaster 不同時發起 Ownable2Step 轉移（新 owner 要 acceptOwnership）。
///
///         安全：broadcaster、owner、發證者若是已知外洩地址（agent/shared/src/payoutSafety.ts 的
///         COMPROMISED_ADDRESSES）一律拒絕。只允許本機鏈（anvil 31337）與 VC_KYC_CHAIN_ID 明確指定的鏈，
///         避免誤打到公開鏈。
///
///         用法（keystore，不在指令列放私鑰）：
///           cd contracts
///           VC_KYC_ISSUER=0x… VC_KYC_CHAIN_ID=<chainId> \
///           forge script script/DeployVCKycRegistry.s.sol:DeployVCKycRegistry \
///             --rpc-url <rpc> --account <keystore 名稱> --sender <地址> --broadcast
///         Base Sepolia（keystore pepelab-rwa-deployer；先 dry-run，不加 --broadcast）：
///           VC_KYC_ISSUER=0x… VC_KYC_CHAIN_ID=84532 \
///           forge script script/DeployVCKycRegistry.s.sol:DeployVCKycRegistry \
///             --rpc-url https://sepolia.base.org --account pepelab-rwa-deployer \
///             --sender 0xF52D1a91B93bFF40C7D36Cb7f898833c16a049eE [--broadcast]
///           這把新 keystore 不是現行 exchange 的 owner，所以即使設了 VC_KYC_WIRE_EXCHANGE=true
///           也只會印出 owner（timelock）要送的 setKycRegistry／setRwaAsset，不會嘗試送出。
///         本機 anvil（PoC）：scripts/poc/rwa-ssi-demo.sh；Besu：besu/scripts/deploy-vc-kyc.sh。
///
///         環境變數：
///           BROADCASTER            覆寫 broadcaster（預設 msg.sender，即 --sender／--account 的地址）；
///                                  必須是實際簽交易的金鑰，同樣要通過外洩地址檢查
///           VC_KYC_ISSUER          受信任發證者（必填）
///           VC_KYC_ISSUER_TYPES    逗號分隔：QUALIFIED_INVESTOR,KYC_BASIC（預設兩者）
///           VC_KYC_REQUIRED_TYPE   QUALIFIED_INVESTOR（預設）或 KYC_BASIC
///           VC_KYC_OWNER           最終 owner（預設 broadcaster）
///           VC_KYC_CHAIN_ID        非 31337 時必須等於目前 chainId（明確確認目標鏈）
///           VC_KYC_WIRE_EXCHANGE   true 才接線 exchange（預設 false）
///           EXCHANGE               PerpetualExchange 位址（接線時必填）
///           VC_KYC_RWA_ASSETS      逗號分隔資產代號，預設 sAAPL,sTSLA
contract DeployVCKycRegistry is Script {
    /// Mirrors agent/shared/src/payoutSafety.ts COMPROMISED_ADDRESSES.
    address internal constant LEAKED_DEPLOYER = 0xE80A81360608C1342e66743F70a00f75d792Eb93;
    uint256 internal constant ANVIL_CHAIN_ID = 31337;

    struct Config {
        address broadcaster;
        address owner;
        address issuer;
        bytes32[] issuerTypes;
        bytes32 requiredType;
        bool wireExchange;
        address exchange;
        string[] rwaAssets;
    }

    error CompromisedAddress(string role, address who);
    error ChainNotConfirmed(uint256 chainId);
    error MissingIssuer();
    error UnknownCredentialType(string name);
    error MissingExchange();

    function run() external returns (VCKycRegistry registry) {
        Config memory c = loadConfig(msg.sender);
        checkChain(block.chainid, vm.envOr("VC_KYC_CHAIN_ID", uint256(0)));
        validate(c);

        vm.startBroadcast(c.broadcaster);
        registry = deploy(c);
        vm.stopBroadcast();

        report(c, registry);
    }

    // ── 設定 ───────────────────────────────────────────────────────────────────

    function loadConfig(address broadcaster) public view returns (Config memory c) {
        c.broadcaster = vm.envOr("BROADCASTER", broadcaster);
        c.owner = vm.envOr("VC_KYC_OWNER", c.broadcaster);
        c.issuer = vm.envOr("VC_KYC_ISSUER", address(0));
        string[] memory defTypes = new string[](2);
        defTypes[0] = "QUALIFIED_INVESTOR";
        defTypes[1] = "KYC_BASIC";
        string[] memory typeNames = vm.envOr("VC_KYC_ISSUER_TYPES", ",", defTypes);
        c.issuerTypes = new bytes32[](typeNames.length);
        for (uint256 i; i < typeNames.length; ++i) c.issuerTypes[i] = typeId(typeNames[i]);
        c.requiredType = typeId(vm.envOr("VC_KYC_REQUIRED_TYPE", string("QUALIFIED_INVESTOR")));
        c.wireExchange = vm.envOr("VC_KYC_WIRE_EXCHANGE", false);
        c.exchange = vm.envOr("EXCHANGE", address(0));
        string[] memory defAssets = new string[](2);
        defAssets[0] = "sAAPL";
        defAssets[1] = "sTSLA";
        c.rwaAssets = vm.envOr("VC_KYC_RWA_ASSETS", ",", defAssets);
    }

    function typeId(string memory name) public pure returns (bytes32) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256("QUALIFIED_INVESTOR") || h == keccak256("KYC_BASIC")) return h;
        revert UnknownCredentialType(name);
    }

    function checkChain(uint256 chainId, uint256 confirmed) public pure {
        if (chainId == ANVIL_CHAIN_ID) return;
        if (confirmed != chainId) revert ChainNotConfirmed(chainId);
    }

    function isCompromised(address a) public pure returns (bool) {
        return a == LEAKED_DEPLOYER;
    }

    function validate(Config memory c) public pure {
        if (c.issuer == address(0)) revert MissingIssuer();
        if (isCompromised(c.broadcaster)) revert CompromisedAddress("broadcaster", c.broadcaster);
        if (isCompromised(c.owner)) revert CompromisedAddress("owner", c.owner);
        if (isCompromised(c.issuer)) revert CompromisedAddress("issuer", c.issuer);
        if (c.wireExchange && c.exchange == address(0)) revert MissingExchange();
    }

    // ── 部署（不含 broadcast，測試可直接呼叫）─────────────────────────────────────

    /// @dev 呼叫者（broadcast 時是 broadcaster；測試時是本合約）必須等於 c.broadcaster，
    ///      registry 的初始 owner 是它，之後才能 setIssuer。
    function deploy(Config memory c) public returns (VCKycRegistry registry) {
        registry = new VCKycRegistry(c.broadcaster, c.requiredType);
        for (uint256 i; i < c.issuerTypes.length; ++i) {
            registry.setIssuer(c.issuer, c.issuerTypes[i], true);
        }

        if (c.wireExchange) {
            IOwnedExchange ex = IOwnedExchange(c.exchange);
            if (ex.owner() == c.broadcaster) {
                ex.setKycRegistry(address(registry));
                for (uint256 i; i < c.rwaAssets.length; ++i) {
                    ex.setRwaAsset(keccak256(bytes(c.rwaAssets[i])), true);
                }
            }
        }

        if (c.owner != c.broadcaster) registry.transferOwnership(c.owner);
    }

    function report(Config memory c, VCKycRegistry registry) internal view {
        console.log("=== VCKycRegistry ===");
        console.log("registry      :", address(registry));
        console.log("issuer        :", c.issuer);
        console.log("requiredType  :", c.requiredType == keccak256("QUALIFIED_INVESTOR") ? "QUALIFIED_INVESTOR" : "KYC_BASIC");
        if (c.owner != c.broadcaster) {
            console.log("ownership     : pending -> ", c.owner, "(acceptOwnership required)");
        }
        if (!c.wireExchange) {
            console.log("exchange      : not wired (VC_KYC_WIRE_EXCHANGE unset)");
            return;
        }
        IOwnedExchange ex = IOwnedExchange(c.exchange);
        if (ex.owner() == c.broadcaster) {
            console.log("exchange      : wired", c.exchange);
        } else {
            console.log("exchange      : SKIPPED, broadcaster is not the exchange owner", ex.owner());
            console.log("  owner must call setKycRegistry(address) with:", address(registry));
            for (uint256 i; i < c.rwaAssets.length; ++i) {
                console.log("  owner must call setRwaAsset(bytes32,bool) for:", c.rwaAssets[i]);
            }
        }
    }
}
