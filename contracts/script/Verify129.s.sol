// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/PerpetualExchange.sol";
import "../src/CopyTracker.sol";
import "../src/TraderStake.sol";
import "../src/FeeRouter.sol";
import "../src/v2/AssetVaultV2_4.sol";
import "../src/v2/GuardedOracle.sol";
import "../src/CarbonTiers.sol";
import "../src/ESGRegistryV2.sol";

interface IEsgRegistryV2Verify {
    function medianCarbonTier(bytes32 assetId)
        external view returns (CarbonTiers.Tier tier, uint256 count, uint256 dispersion, bool isRated);
    function getAttestors(bytes32 assetId) external view returns (address[] memory);
    function getAttestation(bytes32 assetId, address attestor)
        external view returns (ESGRegistryV2.Attestation memory);
}

interface IBadgeVerify {
    function MINTER_ROLE() external view returns (bytes32);
    function hasRole(bytes32 role, address account) external view returns (bool);
}

interface IRewardVerify {
    function exchange() external view returns (address);
    function esgRegistry() external view returns (address);
    function badge() external view returns (address);
}

interface IInsVerify {
    function exchange() external view returns (address);
}


/// @notice #129 verification — read-only. The scripted form of the DEPLOY_129
///         runbook's "every dependency address confirmed to be from this
///         round, not the last" loop (spec: 重接線後的相依確認). Reverts on
///         the first mismatch with the field name.
///
///         Pass every address from the phase outputs:
///           GUARDED_ORACLE_129, VAULT_PROXY_129, ESG_REGISTRY_V2,
///           SUSTAINABILITY_BADGE, EXCHANGE_NEW, COPYTRACKER_NEW,
///           STRATEGY_REGISTRY_NEW, SESSION_MANAGER_NEW, REWARD_DISTRIBUTOR_NEW
///         plus the retained ones (defaulted to the known Base Sepolia values,
///         override if they ever move):
///           FEE_ROUTER, INS_VAULT, TRADER_STK, MOCKORACLE_ADDR
///
///           forge script script/Verify129.s.sol:Verify129 --rpc-url "$BASE_SEPOLIA_RPC_URL" -vvv
contract Verify129 is Script {
    address constant OLD_SESSION_MANAGER = 0x5Ebcc64C712C5a26119789dCbD0753981dc518E8;

    // Retained Base Sepolia infra — same values as Redeploy102/129Exchange.
    address constant FEE_ROUTER = 0x00f6cf0113399a7A451c7f85fe094a28092d3e0c;
    address constant INS_VAULT  = 0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812;
    address constant TRADER_STK = 0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe;
    address constant MOCKORACLE = 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3;

    string[11] SYMS = ["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"];

    function _eq(string memory field, address got, address want) internal pure {
        if (got != want) {
            console.log("MISMATCH", field);
            console.log("  got  :", got);
            console.log("  want :", want);
            revert(string.concat("dependency mismatch: ", field));
        }
        console.log("ok  ", field);
    }

    function run() external view {
        address guardedOracle = vm.envAddress("GUARDED_ORACLE_129");
        address vaultAddr     = vm.envAddress("VAULT_PROXY_129");
        address esgRegistry   = vm.envAddress("ESG_REGISTRY_V2");
        address badge         = vm.envAddress("SUSTAINABILITY_BADGE");
        address exchangeAddr  = vm.envAddress("EXCHANGE_NEW");
        address copyTracker   = vm.envAddress("COPYTRACKER_NEW");
        address strategyReg   = vm.envAddress("STRATEGY_REGISTRY_NEW");
        address sessionMgr    = vm.envAddress("SESSION_MANAGER_NEW");
        address reward        = vm.envAddress("REWARD_DISTRIBUTOR_NEW");

        // Retained infra — hard constants, like Redeploy102Exchange's. If any of
        // these ever moves, this file is wrong on purpose (a stale env default
        // would instead let a moved contract pass silently).
        address feeRouter  = FEE_ROUTER;
        address insVault   = INS_VAULT;
        address traderStk  = TRADER_STK;
        address mockOracle = MOCKORACLE;

        // ── hardened vault ────────────────────────────────────────────────
        console.log("--- AssetVaultV2_4 ---");
        AssetVaultV2_4 vault = AssetVaultV2_4(vaultAddr);
        require(
            keccak256(bytes(vault.version())) == keccak256(bytes("2.4.0")),
            "vault version != 2.4.0"
        );
        console.log("ok   vault version 2.4.0");
        _eq("vault.oracle -> GuardedOracle", vault.oracle(), guardedOracle);
        _eq("vault.esgRegistry -> ESGRegistryV2", vault.esgRegistry(), esgRegistry);

        uint256 feeMsft = vault.mintFeeBpsForAsset(keccak256("sMSFT"));
        uint256 feeNvda = vault.mintFeeBpsForAsset(keccak256("sNVDA"));
        (uint256 highFee, ,) = CarbonTiers.paramsFor(CarbonTiers.Tier.High);
        (uint256 lowFee, ,)  = CarbonTiers.paramsFor(CarbonTiers.Tier.Low);
        require(feeMsft == highFee, "vault mint fee sMSFT != High tier fee");
        require(feeNvda == lowFee,  "vault mint fee sNVDA != Low tier fee");
        require(feeMsft > feeNvda,  "vault: high-carbon buy not dearer than low-carbon");
        console.log("ok   vault mint fee sMSFT(High) =", feeMsft);
        console.log("ok   vault mint fee sNVDA(Low)  =", feeNvda);

        // ── GuardedOracle ────────────────────────────────────────────────
        console.log("--- GuardedOracle ---");
        for (uint256 i = 0; i < 11; i++) {
            (uint256 p,) = GuardedOracle(guardedOracle).getPrice(keccak256(bytes(SYMS[i])));
            require(p > 0, string.concat("GuardedOracle has no price for ", SYMS[i]));
        }
        console.log("ok   all 11 assets priced on GuardedOracle");

        // ── ESGRegistryV2: 11 assets attested with a tier + a source hash ─
        console.log("--- ESGRegistryV2 ---");
        for (uint256 i = 0; i < 11; i++) {
            bytes32 aid = keccak256(bytes(SYMS[i]));
            (, , , bool isRated) = IEsgRegistryV2Verify(esgRegistry).medianCarbonTier(aid);
            require(isRated, string.concat("ESGRegistryV2: ", SYMS[i], " has no fresh attestation -> would price Unrated"));
            // Story 10: the source-URL + retrieval-date hash is on chain, so a
            // user can verify the number. `attest` reverts on sourceHash == 0,
            // so this is really a check that the record decoded as expected.
            address[] memory attestors = IEsgRegistryV2Verify(esgRegistry).getAttestors(aid);
            require(attestors.length > 0, string.concat("ESGRegistryV2: no attestors for ", SYMS[i]));
            ESGRegistryV2.Attestation memory a =
                IEsgRegistryV2Verify(esgRegistry).getAttestation(aid, attestors[0]);
            require(a.sourceHash != bytes32(0), string.concat("ESGRegistryV2: ", SYMS[i], " attestation has no source hash"));
        }
        (CarbonTiers.Tier tMsft, , ,) = IEsgRegistryV2Verify(esgRegistry).medianCarbonTier(keccak256("sMSFT"));
        (CarbonTiers.Tier tNvda, , ,) = IEsgRegistryV2Verify(esgRegistry).medianCarbonTier(keccak256("sNVDA"));
        require(tMsft == CarbonTiers.Tier.High, "sMSFT median tier != High");
        require(tNvda == CarbonTiers.Tier.Low,  "sNVDA median tier != Low");
        console.log("ok   11 assets attested; sMSFT=High, sNVDA=Low");

        // ── PerpetualExchange ───────────────────────────────────────────
        console.log("--- PerpetualExchange ---");
        PerpetualExchange exchange = PerpetualExchange(exchangeAddr);
        _eq("exchange.esgRegistry -> ESGRegistryV2", address(exchange.esgRegistry()), esgRegistry);
        _eq("exchange.copyTracker -> CopyTracker_NEW", exchange.copyTracker(), copyTracker);
        require(exchange.authorizedAgents(sessionMgr), "exchange: new session manager not authorised");
        require(!exchange.authorizedAgents(OLD_SESSION_MANAGER), "exchange: defunct session manager still authorised");
        console.log("ok   exchange agent authorisation (new only)");
        require(exchange.tradingFeeBpsForAsset(keccak256("sMSFT")) == highFee, "exchange sMSFT fee != High");
        require(exchange.maxLeverageForAsset(keccak256("sMSFT")) == 1, "exchange sMSFT maxLev != 1");
        require(exchange.tradingFeeBpsForAsset(keccak256("sNVDA")) == lowFee, "exchange sNVDA fee != Low");
        console.log("ok   exchange carbon params (sMSFT 1x/High, sNVDA Low)");

        // ── CopyTracker upstreams ───────────────────────────────────────
        console.log("--- CopyTracker ---");
        _eq("copyTracker.exchange -> Exchange_NEW", address(CopyTracker(copyTracker).exchange()), exchangeAddr);
        _eq("copyTracker.registry -> StrategyRegistry_NEW", address(CopyTracker(copyTracker).registry()), strategyReg);

        // ── FeeRouter / InsuranceVault / TraderStake ────────────────────
        console.log("--- peripherals ---");
        _eq("feeRouter.exchange -> Exchange_NEW", FeeRouter(feeRouter).exchange(), exchangeAddr);
        _eq("feeRouter.copyTracker -> CopyTracker_NEW", FeeRouter(feeRouter).copyTracker(), copyTracker);
        _eq("insVault.exchange -> Exchange_NEW", IInsVerify(insVault).exchange(), exchangeAddr);
        _eq("traderStake.copyTracker -> CopyTracker_NEW", TraderStake(traderStk).copyTracker(), copyTracker);

        // ── EsgRewardDistributor / SustainabilityBadge ──────────────────
        console.log("--- EsgRewardDistributor ---");
        _eq("reward.exchange -> Exchange_NEW", IRewardVerify(reward).exchange(), exchangeAddr);
        _eq("reward.esgRegistry -> ESGRegistryV2", IRewardVerify(reward).esgRegistry(), esgRegistry);
        _eq("reward.badge -> SustainabilityBadge", IRewardVerify(reward).badge(), badge);
        require(
            IBadgeVerify(badge).hasRole(IBadgeVerify(badge).MINTER_ROLE(), reward),
            "badge: reward distributor lacks MINTER_ROLE"
        );
        console.log("ok   badge MINTER_ROLE -> reward distributor");

        // ── retained pieces unchanged ──────────────────────────────────
        console.log("--- retained ---");
        require(mockOracle.code.length > 0, "MockOracle missing");
        console.log("ok   MockOracle still present (exchange oracle, immutable)");

        console.log("");
        console.log("=== #129 wiring verified. Screen acceptance (runbook) is still required. ===");
    }
}
