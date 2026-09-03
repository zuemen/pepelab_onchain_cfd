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

interface ISettableExchange {
    function setExchange(address) external;
}

/// @dev The live old exchange (deployed 2026-06-14) predates #96, so its
///      `getPosition` returns the ORIGINAL 13-field Position tuple. Decoding
///      that into the current `PerpetualExchange.Position` (which #96 grew
///      with `carbonTier` etc.) reverts — 13 fields of data cannot fill the
///      wider struct. The survey below reads the old exchange through this
///      13-field mirror instead. `setAgentAuthorized` / `authorizedAgents` /
///      `nextPositionId` are unchanged, so those still go through the real
///      `PerpetualExchange` type.
interface IOldExchange {
    struct OldPosition {
        uint256 id;
        address owner;
        bytes32 asset;
        bool    isLong;
        uint256 entryPrice;
        uint256 margin;
        uint256 leverage;
        uint256 openedAt;
        uint256 closedAt;
        int256  realizedPnL;
        bool    isOpen;
        address copiedFrom;
        int256  entryFundingIndex;
    }
    function getPosition(uint256) external view returns (OldPosition memory);
}

/// @notice #102 step 2 — redeploy the four-contract chain onto the
///         carbon-pricing PerpetualExchange (#96), and rewire everything that
///         holds the old exchange address as `immutable`.
///
///         Adapted from `RedeployExchange.s.sol` (the funding-cadence fix).
///         Differences for #102:
///           - constructor's 3rd arg is the real `ESGRegistryV2` (env
///             `ESG_REGISTRY_V2`), not `address(0)` — that is what turns
///             carbon pricing on;
///           - a fresh `StrategyRegistry` is deployed too (the #97 diversification
///             constraints, and because the old one's published strategies
///             cannot migrate anyway);
///           - all 8 KYC-gated assets get `setRwaAsset(true)`, not just 2;
///           - the survey/dry-run gate and the InsuranceVault/FeeRouter
///             repoint-last ordering are kept verbatim — they are the reason
///             this is safe.
///
///         Run — dry run first, ALWAYS:
///           DRY_RUN=true forge script script/Redeploy102Exchange.s.sol:Redeploy102Exchange \
///             --rpc-url "$BASE_SEPOLIA_RPC_URL" -vvv
///
///           # only when the dry run reports 0 open positions on the old exchange:
///           forge script script/Redeploy102Exchange.s.sol:Redeploy102Exchange \
///             --rpc-url "$BASE_SEPOLIA_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast -vvv
contract Redeploy102Exchange is Script {
    // ── Base Sepolia (84532) pieces that stay where they are ────────────────
    address constant USDC         = 0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035;
    address constant ORACLE       = 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3;
    address constant FEE_ROUTER   = 0x00f6cf0113399a7A451c7f85fe094a28092d3e0c;
    address constant INS_VAULT    = 0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812;
    address constant KYC          = 0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d;
    address constant TRADER_STK   = 0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe;
    address constant OLD_EXCHANGE = 0xEf75ECA6514cE96B18382E921aC6190a0cF8c072;
    // Defunct AgentSessionManager with no per-session asset allow-list — a
    // path around the asset gate. Never authorised on the new exchange; also
    // revoked on the old one here (defence in depth). See KNOWN_LIMITATIONS §10.
    address constant OLD_SESSION_MANAGER = 0x5Ebcc64C712C5a26119789dCbD0753981dc518E8;

    // Read off the live exchange 2026-08-06 — the replacement must match in
    // everything except carbon pricing.
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

    // Demo session mirrored from session #0 on the current manager.
    uint256 constant SESSION_MAX_PER_TRADE = 1_000e18;
    uint256 constant SESSION_BUDGET        = 3_000e18;
    uint256 constant SESSION_MAX_LEVERAGE  = 5;
    uint256 constant SESSION_EXPIRY        = 1_816_650_312; // 2027-07

    uint256 constant MAX_SCAN = 2_000;

    function run() external {
        bool dryRun = vm.envOr("DRY_RUN", false);
        address esgRegistryV2 = vm.envAddress("ESG_REGISTRY_V2");

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
            openMargin;
            return;
        }

        if (openCount > 0) {
            console.log("!!! PROCEEDING WITH %s OPEN POSITION(S) - a deliberate, logged choice.", openCount);
        }

        vm.startBroadcast();
        address deployer = msg.sender;

        // ── 1. The carbon-pricing exchange ──────────────────────────────────
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

        // ── 2. Fresh StrategyRegistry (#97) ─────────────────────────────────
        StrategyRegistry registry = new StrategyRegistry(TRADER_STK);

        // ── 3. CopyTracker (its exchange/registry/etc. are immutable) ───────
        CopyTracker copyTracker = new CopyTracker(
            USDC, address(exchange), address(registry), FEE_ROUTER, TRADER_STK
        );
        exchange.setCopyTracker(address(copyTracker));
        TraderStake(TRADER_STK).setCopyTracker(address(copyTracker));
        FeeRouter(FEE_ROUTER).setCopyTracker(address(copyTracker));

        // ── 4. AgentSessionManager (its exchange is immutable) ──────────────
        AgentSessionManager sessionManager = new AgentSessionManager(address(exchange));
        exchange.setAgentAuthorized(address(sessionManager), true);
        // The defunct one is simply never added. Explicit false is harmless
        // and makes the intent auditable in the trace.
        exchange.setAgentAuthorized(OLD_SESSION_MANAGER, false);

        bytes32[] memory allowed = new bytes32[](2);
        allowed[0] = keccak256("sBTC");
        allowed[1] = keccak256("sETH");
        uint256 sessionId = sessionManager.createSessionWithAssets(
            deployer,
            SESSION_MAX_PER_TRADE,
            SESSION_BUDGET,
            SESSION_MAX_LEVERAGE,
            SESSION_EXPIRY,
            allowed
        );

        // ── 5. Repoint the two peripherals with a setter — LAST ─────────────
        //      Irreversible for the old venue from here.
        ISettableExchange(INS_VAULT).setExchange(address(exchange));
        ISettableExchange(FEE_ROUTER).setExchange(address(exchange));

        // ── 6. Revoke the defunct session manager on the OLD exchange ───────
        PerpetualExchange(OLD_EXCHANGE).setAgentAuthorized(OLD_SESSION_MANAGER, false);

        vm.stopBroadcast();

        // ── 7. Read the wiring back ─────────────────────────────────────────
        require(address(exchange.esgRegistry()) == esgRegistryV2, "esgRegistry not wired");
        require(exchange.copyTracker() == address(copyTracker), "exchange.copyTracker");
        require(TraderStake(TRADER_STK).copyTracker() == address(copyTracker), "traderStake.copyTracker");
        require(FeeRouter(FEE_ROUTER).copyTracker() == address(copyTracker), "feeRouter.copyTracker");
        require(exchange.authorizedAgents(address(sessionManager)), "sessionManager not authorised");
        require(!exchange.authorizedAgents(OLD_SESSION_MANAGER), "old session manager still authorised (new)");
        require(!PerpetualExchange(OLD_EXCHANGE).authorizedAgents(OLD_SESSION_MANAGER), "old session manager still authorised (old)");

        console.log("=== #102 four-contract redeploy ===");
        console.log("PerpetualExchange_NEW    :", address(exchange));
        console.log("StrategyRegistry_NEW     :", address(registry));
        console.log("CopyTracker_NEW          :", address(copyTracker));
        console.log("AgentSessionManager_NEW  :", address(sessionManager));
        console.log("demo sessionId           :", sessionId);
        console.log("FUNDING_INTERVAL         :", exchange.FUNDING_INTERVAL());
        console.log("");
        console.log("Carbon params the new exchange will apply:");
        console.log("  sMSFT  maxLev :", exchange.maxLeverageForAsset(keccak256("sMSFT")));
        console.log("  sMSFT  feeBps :", exchange.tradingFeeBpsForAsset(keccak256("sMSFT")));
        console.log("  sNVDA  maxLev :", exchange.maxLeverageForAsset(keccak256("sNVDA")));
        console.log("");
        console.log("Old exchange", OLD_EXCHANGE, "is now degraded: InsuranceVault points");
        console.log("at the new address, so on the old venue any close needing a bailout");
        console.log("reverts NotAuthorized. Update addresses.ts + ABIs + agent/.env next.");
    }

    function _survey() internal view returns (uint256 openCount, uint256 openMargin) {
        uint256 next = PerpetualExchange(OLD_EXCHANGE).nextPositionId();
        uint256 limit = next > MAX_SCAN ? MAX_SCAN : next;

        console.log("=== old exchange survey ===");
        console.log("address        :", OLD_EXCHANGE);
        console.log("nextPositionId :", next);

        for (uint256 i = 0; i < limit; i++) {
            IOldExchange.OldPosition memory p = IOldExchange(OLD_EXCHANGE).getPosition(i);
            if (!p.isOpen) continue;
            openCount++;
            openMargin += p.margin;
            console.log("  OPEN id", i, "owner", p.owner);
        }
        console.log("open positions :", openCount);
        console.log("margin at risk :", openMargin / 1e18);
    }
}
