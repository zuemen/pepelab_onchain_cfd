// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/PerpetualExchange.sol";
import "../src/CopyTracker.sol";
import "../src/StrategyRegistry.sol";
import "../src/AgentSessionManager.sol";
import "../src/TraderStake.sol";
import "../src/FeeRouter.sol";
import "../src/CarbonTiers.sol";

interface ISettableExchange {
    function setExchange(address) external;
}

interface IEsgRegistryV2Schema {
    function medianCarbonTier(bytes32 assetId)
        external view returns (CarbonTiers.Tier tier, uint256 count, uint256 dispersion, bool isRated);
}

/// @notice #129 phase C — the carbon-pricing chain redeploy, forced by #128:
///         `ESGRegistryV2`'s record now carries `tier` + `basis` (ADR-006), so
///         the registry redeploys (plain contract), and `PerpetualExchange`
///         holds its address `immutable`, so the exchange redeploys, and
///         `CopyTracker` / `StrategyRegistry` / `AgentSessionManager` all hold
///         the exchange `immutable`, so they redeploy too. Identical chain to
///         #102 — this is its second run, not a new procedure.
///
///         Adapted from `Redeploy102Exchange.s.sol`. Differences for #129:
///           - the "old" addresses are #102's outputs (the chain currently
///             live on Base Sepolia), not the pre-#102 ones;
///           - the old exchange is ALREADY carbon-priced, so its `getPosition`
///             returns the current `Position` struct — the survey uses the
///             real type directly, no 13-field mirror;
///           - the new exchange reads `medianCarbonTier` (not
///             `medianCarbonIntensity`) from the registry — bytecode-level, so
///             this redeploy is the only way that lands on chain.
///
///         Run — dry run first, ALWAYS:
///           ESG_REGISTRY_V2=0x… DRY_RUN=true \
///           forge script script/Redeploy129Exchange.s.sol:Redeploy129Exchange \
///             --rpc-url "$BASE_SEPOLIA_RPC_URL" -vvv
///
///           # only when the dry run reports 0 open positions on the old exchange:
///           ESG_REGISTRY_V2=0x… \
///           forge script script/Redeploy129Exchange.s.sol:Redeploy129Exchange \
///             --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --slow -vvv
contract Redeploy129Exchange is Script {
    // ── Base Sepolia (84532) pieces that stay where they are ────────────────
    address constant USDC       = 0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035;
    address constant ORACLE     = 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3; // exchange stays on MockOracle
    address constant FEE_ROUTER = 0x00f6cf0113399a7A451c7f85fe094a28092d3e0c;
    address constant INS_VAULT  = 0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812;
    address constant KYC        = 0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d;
    address constant TRADER_STK = 0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe;

    // ── #102's outputs — the chain currently live, being replaced ───────────
    address constant OLD_EXCHANGE = 0xfAEf549C687C37064cEaB5728989a839B08955cf;
    // Defunct AgentSessionManager with no per-session asset allow-list.
    // Never authorised on the new exchange; also revoked on the old one here.
    address constant OLD_SESSION_MANAGER = 0x5Ebcc64C712C5a26119789dCbD0753981dc518E8;

    // Read off the live exchange 0xfAEf… (2026-09-09) — the replacement must
    // match in everything but the registry read path. Re-confirm with
    // `cast call 0xfAEf… "maxPriceAge()(uint256)"` etc. right before running.
    uint256 constant MAX_PRICE_AGE = 21_600;   // 6h
    uint256 constant EXECUTION_FEE = 1e14;     // 0.0001 ETH
    bool    constant ADL_ENABLED   = true;

    // Every regulated: true asset in frontend/src/lib/pepefi/assetMeta.ts.
    function _kycAssets() internal pure returns (bytes32[8] memory k) {
        k[0] = keccak256("sAAPL");
        k[1] = keccak256("sTSLA");
        k[2] = keccak256("sNVDA");
        k[3] = keccak256("sMSFT");
        k[4] = keccak256("sGOOGL");
        k[5] = keccak256("sICLN");
        k[6] = keccak256("sESGU");
        k[7] = keccak256("sBOND");
    }

    // Demo session mirrored from #102's.
    uint256 constant SESSION_MAX_PER_TRADE = 1_000e18;
    uint256 constant SESSION_BUDGET        = 3_000e18;
    uint256 constant SESSION_MAX_LEVERAGE  = 5;
    uint256 constant SESSION_EXPIRY        = 1_816_650_312; // 2027-07

    uint256 constant MAX_SCAN = 4_000;

    function run() external {
        bool dryRun = vm.envOr("DRY_RUN", false);
        address esgRegistryV2 = vm.envAddress("ESG_REGISTRY_V2");

        _assertRegistrySchemaAndSeed(esgRegistryV2);

        (uint256 openCount, uint256 openMargin) = _survey();

        if (dryRun) {
            console.log("");
            console.log("DRY RUN - nothing was sent.");
            if (openCount > 0) {
                console.log("!!! %s position(s) still OPEN on the old exchange.", openCount);
                console.log("!!! Close/liquidate them before broadcasting - repointing");
                console.log("!!! InsuranceVault now would strand them in a venue whose");
                console.log("!!! bailout path reverts NotAuthorized.");
            } else {
                console.log("0 open positions on the old exchange - safe to migrate.");
            }
            console.log("ESG_REGISTRY_V2 :", esgRegistryV2);
            require(esgRegistryV2.code.length > 0, "ESG_REGISTRY_V2 has no code on this chain");
            openMargin;
            return;
        }

        require(esgRegistryV2.code.length > 0, "ESG_REGISTRY_V2 has no code on this chain");
        if (openCount > 0) {
            console.log("!!! PROCEEDING WITH %s OPEN POSITION(S) - a deliberate, logged choice.", openCount);
        }

        vm.startBroadcast();
        address deployer = msg.sender;

        // ── 1. The carbon-pricing exchange (now reads medianCarbonTier) ─────
        PerpetualExchange exchange = new PerpetualExchange(USDC, ORACLE, esgRegistryV2);

        exchange.setMaxPriceAge(MAX_PRICE_AGE);
        exchange.setExecutionFee(EXECUTION_FEE);
        exchange.setAdlEnabled(ADL_ENABLED);
        exchange.setKycRegistry(KYC);
        exchange.setFeeRouter(FEE_ROUTER);
        exchange.setInsuranceVault(INS_VAULT);

        bytes32[8] memory kyc = _kycAssets();
        for (uint256 i = 0; i < 8; i++) {
            exchange.setRwaAsset(kyc[i], true);
        }

        // ── 2. Fresh StrategyRegistry (#97) ────────────────────────────────
        StrategyRegistry registry = new StrategyRegistry(TRADER_STK);

        // ── 3. CopyTracker (exchange/registry/etc. are immutable) ──────────
        CopyTracker copyTracker = new CopyTracker(
            USDC, address(exchange), address(registry), FEE_ROUTER, TRADER_STK
        );
        exchange.setCopyTracker(address(copyTracker));
        TraderStake(TRADER_STK).setCopyTracker(address(copyTracker));
        FeeRouter(FEE_ROUTER).setCopyTracker(address(copyTracker));

        // ── 4. AgentSessionManager (exchange is immutable) ─────────────────
        AgentSessionManager sessionManager = new AgentSessionManager(address(exchange));
        exchange.setAgentAuthorized(address(sessionManager), true);
        exchange.setAgentAuthorized(OLD_SESSION_MANAGER, false);

        bytes32[] memory allowed = new bytes32[](2);
        allowed[0] = keccak256("sBTC");
        allowed[1] = keccak256("sETH");
        uint256 sessionId = sessionManager.createSessionWithAssets(
            deployer, SESSION_MAX_PER_TRADE, SESSION_BUDGET, SESSION_MAX_LEVERAGE, SESSION_EXPIRY, allowed
        );

        // ── 5. Repoint the two peripherals — LAST (irreversible) ───────────
        ISettableExchange(INS_VAULT).setExchange(address(exchange));
        ISettableExchange(FEE_ROUTER).setExchange(address(exchange));

        // ── 6. Revoke the defunct session manager on the OLD exchange ──────
        PerpetualExchange(OLD_EXCHANGE).setAgentAuthorized(OLD_SESSION_MANAGER, false);

        vm.stopBroadcast();

        // ── 7. Read the wiring back ───────────────────────────────────────
        require(address(exchange.esgRegistry()) == esgRegistryV2, "esgRegistry not wired");
        require(exchange.copyTracker() == address(copyTracker), "exchange.copyTracker");
        require(TraderStake(TRADER_STK).copyTracker() == address(copyTracker), "traderStake.copyTracker");
        require(FeeRouter(FEE_ROUTER).copyTracker() == address(copyTracker), "feeRouter.copyTracker");
        require(exchange.authorizedAgents(address(sessionManager)), "sessionManager not authorised");
        require(!exchange.authorizedAgents(OLD_SESSION_MANAGER), "old session manager still authorised (new)");
        require(!PerpetualExchange(OLD_EXCHANGE).authorizedAgents(OLD_SESSION_MANAGER), "old session manager still authorised (old)");

        console.log("=== #129 carbon-chain redeploy ===");
        console.log("PerpetualExchange_NEW    :", address(exchange));
        console.log("StrategyRegistry_NEW     :", address(registry));
        console.log("CopyTracker_NEW          :", address(copyTracker));
        console.log("AgentSessionManager_NEW  :", address(sessionManager));
        console.log("demo sessionId           :", sessionId);
        console.log("FUNDING_INTERVAL         :", exchange.FUNDING_INTERVAL());
        console.log("");
        console.log("Carbon params the new exchange will apply (from medianCarbonTier):");
        console.log("  sMSFT  maxLev :", exchange.maxLeverageForAsset(keccak256("sMSFT")), "(want 1)");
        console.log("  sMSFT  feeBps :", exchange.tradingFeeBpsForAsset(keccak256("sMSFT")), "(want 100)");
        console.log("  sNVDA  maxLev :", exchange.maxLeverageForAsset(keccak256("sNVDA")), "(want 5)");
        console.log("  sNVDA  feeBps :", exchange.tradingFeeBpsForAsset(keccak256("sNVDA")), "(want 10)");
        console.log("");
        console.log("Set for the next phase:");
        console.log("  export EXCHANGE_NEW=", address(exchange));
        console.log("");
        console.log("Old exchange", OLD_EXCHANGE, "is now degraded (InsuranceVault repointed).");
        console.log("Next: phase D (reward distributor), phase E (wire vault), addresses.ts + ABIs + agent/.env.");
    }

    /// @dev Fail BEFORE broadcasting if `ESG_REGISTRY_V2` is the wrong contract
    ///      (the old #102 registry with no `medianCarbonTier`) or is deployed
    ///      but not yet seeded (phase B not run / not landed). Without this the
    ///      deploy + all wiring succeeds and only the closing sanity log
    ///      reverts — leaving a half-cut-over chain.
    function _assertRegistrySchemaAndSeed(address registry) internal view {
        require(registry.code.length > 0, "ESG_REGISTRY_V2 has no code on this chain");
        try IEsgRegistryV2Schema(registry).medianCarbonTier(keccak256("sMSFT")) returns (
            CarbonTiers.Tier tier, uint256, uint256, bool isRated
        ) {
            require(isRated, "ESG_REGISTRY_V2 has the #128 schema but is NOT seeded - run phase B (Deploy102CarbonRegistry) first");
            require(tier == CarbonTiers.Tier.High, "ESG_REGISTRY_V2: sMSFT median tier != High - re-attestation is wrong");
            console.log("registry schema + seed check: OK (sMSFT median tier = High)");
        } catch {
            revert("ESG_REGISTRY_V2 has no medianCarbonTier - it is the pre-#128 registry, not the new one");
        }
    }

    function _survey() internal view returns (uint256 openCount, uint256 openMargin) {
        uint256 next = PerpetualExchange(OLD_EXCHANGE).nextPositionId();
        uint256 limit = next > MAX_SCAN ? MAX_SCAN : next;

        console.log("=== old exchange survey ===");
        console.log("address        :", OLD_EXCHANGE);
        console.log("nextPositionId :", next);

        for (uint256 i = 0; i < limit; i++) {
            PerpetualExchange.Position memory p = PerpetualExchange(OLD_EXCHANGE).getPosition(i);
            if (!p.isOpen) continue;
            openCount++;
            openMargin += p.margin;
            console.log("  OPEN id", i, "owner", p.owner);
        }
        console.log("open positions :", openCount);
        console.log("margin at risk :", openMargin / 1e18);
    }
}
