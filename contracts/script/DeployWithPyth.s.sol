// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/MockUSDC.sol";
import "../src/MockSwapRouter.sol";
import "../src/FeeRouter.sol";
import "../src/InsuranceVault.sol";
import "../src/PerpetualExchange.sol";
import "../src/StrategyRegistry.sol";
import "../src/CopyTracker.sol";
import "../src/TraderStake.sol";
import "../src/AgentSessionManager.sol";
import "../src/KYCRegistry.sol";
import "../src/ChainlinkOracleAdapter.sol";
import "../src/PythOracleAdapter.sol";
import "../src/AggregatorOracleAdapter.sol";

/// @notice Track 2A — "RWA real pricing" deployment. Identical wiring to
///         Deploy.s.sol, except `PerpetualExchange` points at a REAL aggregator
///         oracle (Pyth + Chainlink) instead of MockOracle. Because
///         `PerpetualExchange.oracle` is immutable, switching to real feeds
///         means deploying a fresh exchange — this script does that while
///         leaving the existing MockOracle deployment untouched for tests.
///
/// @dev    ## PA-6 — this script used to build a one-legged aggregator
///
///         `ChainlinkOracleAdapter` was deployed and handed to the aggregator,
///         and then `setFeed` was never called. Every Chainlink read therefore
///         reverted `FeedNotSet`, the aggregator degraded to Pyth on every
///         single asset, and `maxDeviationBps` — the entire point of running two
///         sources — never executed once. The deployment was documented as a
///         dual-source RWA oracle and was, in fact, a Pyth passthrough with an
///         unreachable second leg.
///
///         Two things fix that, and both are here:
///
///         1. **Chainlink feeds are configured.** Base Sepolia aggregator
///            addresses come from env (`CHAINLINK_FEED_*`), because they are
///            chain-specific and hardcoding them is how the last set went stale.
///            Feed addresses are printed so they can be checked against
///            docs.chain.link before the operator broadcasts.
///
///         2. **Single-source degradation is now a decision, not an accident.**
///            `AggregatorOracleAdapter.allowSingleSource` defaults to FALSE, so
///            an asset with only one working feed fails closed at read time —
///            `openPosition`, `closePosition` and `liquidatePosition` on that
///            asset all revert `SingleSourceNotAllowed`. That is a live market
///            that cannot be exited. This script therefore refuses to deploy a
///            configuration that would do that silently: if any listed asset has
///            fewer than two sources, it reverts with the list, unless the
///            operator explicitly sets `ORACLE_ALLOW_SINGLE_SOURCE=true` — in
///            which case the degradation is turned on, logged in capitals, and
///            owned.
///
///         Pyth is a PULL oracle: a keeper must push fresh prices
///         (`updatePriceFeeds`) or reads go stale and trades revert by design.
///         Both adapters now fail closed on staleness with a 1h default
///         threshold; override with `ORACLE_STALE_THRESHOLD` (seconds, 5m–24h).
///
///         Dry-run first (no state is written, the guards still run):
///           forge script script/DeployWithPyth.s.sol:DeployWithPyth \
///             --rpc-url $BASE_SEPOLIA_RPC_URL -vvv
///         Then broadcast manually:
///           forge script script/DeployWithPyth.s.sol:DeployWithPyth \
///             --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --account <deployer>
///
///         Env:
///           PYTH_CONTRACT              Pyth on this chain (default Base Sepolia)
///           PYTH_ID_AAPL/TSLA/GOLD     Pyth price ids for the RWA legs
///           CHAINLINK_FEED_BTC/ETH/AAPL/TSLA/GOLD
///                                      Chainlink AggregatorV3 addresses
///           ORACLE_ALLOW_SINGLE_SOURCE "true" to accept single-feed assets
///           ORACLE_STALE_THRESHOLD     seconds, applied to both adapters
///           ORACLE_MAX_CONF_BPS        Pyth confidence ceiling, bps
contract DeployWithPyth is Script {
    uint256 constant N = 5;

    bytes32 constant SBTC  = keccak256("sBTC");
    bytes32 constant SETH  = keccak256("sETH");
    bytes32 constant SAAPL = keccak256("sAAPL");  // RWA: equity
    bytes32 constant STSLA = keccak256("sTSLA");  // RWA: equity
    bytes32 constant SGOLD = keccak256("sGOLD");  // RWA: commodity

    // Well-known, chain-independent Pyth price ids.
    bytes32 constant PYTH_BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 constant PYTH_ETH = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;

    error SingleSourceAssetsPresent(uint256 count);

    function run() external {
        address deployer = msg.sender;

        // Pyth contract on Base Sepolia (override with env PYTH_CONTRACT).
        address pythContract = vm.envOr("PYTH_CONTRACT", address(0xA2aa501b19aff244D90cc15a4Cf739D2725B5729));

        string[N] memory syms = ["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD"];
        bytes32[N] memory ids = [SBTC, SETH, SAAPL, STSLA, SGOLD];

        // Pyth ids: BTC/ETH are universal constants; the RWA legs must be
        // supplied, because a wrong equity feed id is worse than none.
        bytes32[N] memory pythIds = [
            PYTH_BTC,
            PYTH_ETH,
            vm.envOr("PYTH_ID_AAPL", bytes32(0)),
            vm.envOr("PYTH_ID_TSLA", bytes32(0)),
            vm.envOr("PYTH_ID_GOLD", bytes32(0))
        ];

        // Chainlink aggregators for this chain. No defaults on purpose: a stale
        // hardcoded address reads as "configured" while returning nothing.
        address[N] memory clFeeds = [
            vm.envOr("CHAINLINK_FEED_BTC",  address(0)),
            vm.envOr("CHAINLINK_FEED_ETH",  address(0)),
            vm.envOr("CHAINLINK_FEED_AAPL", address(0)),
            vm.envOr("CHAINLINK_FEED_TSLA", address(0)),
            vm.envOr("CHAINLINK_FEED_GOLD", address(0))
        ];

        bool allowSingle = vm.envOr("ORACLE_ALLOW_SINGLE_SOURCE", false);
        uint256 staleThreshold = vm.envOr("ORACLE_STALE_THRESHOLD", uint256(0));
        uint256 maxConfBps     = vm.envOr("ORACLE_MAX_CONF_BPS", uint256(0));

        // ── Source matrix, printed BEFORE anything is deployed ────────────────
        uint256 dual;
        uint256 single;
        uint256 dead;
        console.log("=== oracle source matrix (asset: chainlink / pyth) ===");
        for (uint256 i = 0; i < N; i++) {
            bool hasCl   = clFeeds[i] != address(0);
            bool hasPyth = pythIds[i] != bytes32(0);
            if (hasCl && hasPyth)      { dual++;   console.log("  DUAL   ", syms[i], clFeeds[i]); }
            else if (hasCl)            { single++; console.log("  CL ONLY", syms[i], clFeeds[i]); }
            else if (hasPyth)          { single++; console.log("  PYTH ONLY (no CHAINLINK_FEED_*)", syms[i]); }
            else                       { dead++;   console.log("  NO SOURCE AT ALL", syms[i]); }
        }
        console.log("dual-source:", dual, " single-source:", single);
        console.log("unpriced   :", dead);

        // ── The fail-closed decision, made explicitly ─────────────────────────
        if (single > 0 || dead > 0) {
            console.log("");
            console.log("!!! NOT every asset has two live sources.");
            console.log("!!! allowSingleSource defaults to FALSE, so a single-source asset");
            console.log("!!! reverts SingleSourceNotAllowed on EVERY read - including");
            console.log("!!! closePosition and liquidatePosition. Traders would be locked in.");
            if (!allowSingle) {
                console.log("!!! Refusing to deploy. Either set the missing CHAINLINK_FEED_* /");
                console.log("!!! PYTH_ID_* env vars, or accept the degradation explicitly with");
                console.log("!!! ORACLE_ALLOW_SINGLE_SOURCE=true.");
                revert SingleSourceAssetsPresent(single + dead);
            }
            console.log("!!! ORACLE_ALLOW_SINGLE_SOURCE=true -> degradation will be ENABLED.");
            console.log("!!! The cross-source check is NOT running for those assets.");
            console.log("!!! Assets with NO source stay unreadable regardless of this flag.");
        }

        vm.startBroadcast();

        // 1. Real aggregator oracle (Chainlink + Pyth), both legs configured.
        ChainlinkOracleAdapter clOracle   = new ChainlinkOracleAdapter();
        PythOracleAdapter      pythOracle = new PythOracleAdapter(pythContract);

        for (uint256 i = 0; i < N; i++) {
            if (pythIds[i] != bytes32(0)) pythOracle.setPriceId(ids[i], pythIds[i]);
            // PA-6: the call that was missing entirely.
            if (clFeeds[i] != address(0)) clOracle.setFeed(ids[i], clFeeds[i]);
        }

        if (staleThreshold != 0) {
            clOracle.setStaleThreshold(staleThreshold);
            pythOracle.setStaleThreshold(staleThreshold);
        }
        if (maxConfBps != 0) pythOracle.setMaxConfBps(maxConfBps);

        AggregatorOracleAdapter aggOracle =
            new AggregatorOracleAdapter(address(clOracle), address(pythOracle));

        // Only ever turned on deliberately, and only after the warning above.
        if (allowSingle) aggOracle.setAllowSingleSource(true);

        // 2. Margin/collateral currency + swap router (unchanged).
        MockUSDC usdc = new MockUSDC();
        MockSwapRouter swapRouter = new MockSwapRouter(address(usdc));
        usdc.setSwapRouter(address(swapRouter));

        // 3. Core stack — exchange points at the REAL aggregator oracle.
        TraderStake traderStake = new TraderStake(address(usdc));
        InsuranceVault vault = new InsuranceVault(address(usdc));
        FeeRouter feeRouter = new FeeRouter(address(usdc), deployer, address(vault));
        PerpetualExchange exchange = new PerpetualExchange(address(usdc), address(aggOracle), address(0));
        StrategyRegistry registry = new StrategyRegistry(address(traderStake));
        CopyTracker ct = new CopyTracker(
            address(usdc), address(exchange), address(registry), address(feeRouter), address(traderStake)
        );

        // 4. Wire (same as Deploy.s.sol).
        vault.setFeeRouter(address(feeRouter));
        vault.setExchange(address(exchange));
        traderStake.setCopyTracker(address(ct));
        exchange.setCopyTracker(address(ct));
        exchange.setFeeRouter(address(feeRouter));
        exchange.setInsuranceVault(address(vault));
        feeRouter.setCopyTracker(address(ct));
        feeRouter.setExchange(address(exchange));

        // 5. Agent session layer.
        AgentSessionManager sessionManager = new AgentSessionManager(address(exchange));
        exchange.setAgentAuthorized(address(sessionManager), true);

        // 6. KYC + RWA compliance gating — RWA (equity/commodity) require KYC.
        //    NOTE (M8): `submitKYC` no longer self-verifies. After deployment the
        //    owner must `approveKYC(user)` — or appoint a hot compliance key with
        //    `setVerifier(operator, true)` — or every RWA market is unopenable.
        KYCRegistry kyc = new KYCRegistry();
        exchange.setKycRegistry(address(kyc));
        exchange.setRwaAsset(SAAPL, true);
        exchange.setRwaAsset(STSLA, true);
        exchange.setRwaAsset(SGOLD, true);

        vm.stopBroadcast();

        console.log("");
        console.log("=== DeployWithPyth (REAL oracle) ===");
        console.log("AggregatorOracle :", address(aggOracle));
        console.log("PythAdapter      :", address(pythOracle));
        console.log("ChainlinkAdapter :", address(clOracle));
        console.log("MockUSDC         :", address(usdc));
        console.log("MockSwapRouter   :", address(swapRouter));
        console.log("TraderStake      :", address(traderStake));
        console.log("InsuranceVault   :", address(vault));
        console.log("FeeRouter        :", address(feeRouter));
        console.log("PerpetualExchange:", address(exchange));
        console.log("StrategyRegistry :", address(registry));
        console.log("CopyTracker      :", address(ct));
        console.log("AgentSessionMgr  :", address(sessionManager));
        console.log("KYCRegistry      :", address(kyc));
        console.log("");
        console.log("allowSingleSource:", aggOracle.allowSingleSource());
        console.log("maxDeviationBps  :", aggOracle.maxDeviationBps(), "(degraded above this)");
        console.log("haltDeviationBps :", aggOracle.haltDeviationBps(), "(fails closed above this)");
        console.log("chainlink stale  :", clOracle.staleThreshold());
        console.log("pyth stale       :", pythOracle.staleThreshold());
        console.log("pyth maxConfBps  :", pythOracle.maxConfBps());
        console.log("");
        console.log("NEXT: Pyth is pull-based - run the keeper's updatePriceFeeds before");
        console.log("      the first trade, or every read is stale and every open reverts.");
        console.log("NEXT: approveKYC / setVerifier on the KYCRegistry, or sAAPL, sTSLA and");
        console.log("      sGOLD are closed to everyone.");
    }
}
