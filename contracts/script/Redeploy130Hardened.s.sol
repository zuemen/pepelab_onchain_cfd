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
import "./Verify130.s.sol";

interface ISettableExchange130 {
    function setExchange(address) external;
    function exchange() external view returns (address);
    function owner() external view returns (address);
}

interface IEsgRegistryV2Tier130 {
    function medianCarbonTier(bytes32 assetId)
        external view returns (CarbonTiers.Tier tier, uint256 count, uint256 dispersion, bool isRated);
}

/// @notice #130 — cut Base Sepolia over to the PR #191 hardened
///         `PerpetualExchange`. Third run of the #102 / #129 chain redeploy:
///         the exchange is not upgradeable and `CopyTracker`,
///         `StrategyRegistry`, `AgentSessionManager` hold it `immutable`, so
///         all four are redeployed.
///
///         ORDER — everything before step 9 only touches contracts deployed by
///         this run, so aborting there leaves the live #129 chain intact.
///         Step 9 (re-point InsuranceVault / FeeRouter) is the irreversible
///         point; step 10 (shared CopyTracker pointers, retiring the old
///         session manager) follows it.
///
///         Every step is IDEMPOTENT (it checks state and writes only what is
///         missing) and the run is RESUMABLE: after an interruption pass the
///         contracts the broken run already deployed as
///         RESUME_EXCHANGE / RESUME_STRATEGY_REGISTRY / RESUME_COPY_TRACKER /
///         RESUME_SESSION_MANAGER (/ RESUME_TRADER_STAKE) and the script picks
///         up where it stopped on the SAME exchange. Without RESUME_EXCHANGE
///         the preflight insists on a fully untouched #129 chain, so it
///         refuses a run that died at or after step 9. A run that died at
///         steps 1-8 left the shared pointers untouched: re-running it
///         WITHOUT RESUME_* passes the preflight and deploys a fresh set,
///         orphaning the first (no funds at risk, only gas and confusion) —
///         always resume instead.
///
///         Fork simulation (no key, nothing sent):
///           GUARDIAN=0x… forge script script/Redeploy130Hardened.s.sol:Redeploy130Hardened \
///             --fork-url https://sepolia.base.org --sender 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585 -vv
///         Broadcast (the user only) — docs/DEPLOY_130_CUTOVER.md §5.
contract Redeploy130Hardened is Cutover130Base {
    uint256 internal constant MAX_SCAN = 4_000;

    uint256 internal constant SESSION_MAX_PER_TRADE = 1_000e18;
    uint256 internal constant SESSION_BUDGET        = 3_000e18;
    uint256 internal constant SESSION_MAX_LEVERAGE  = 5;
    uint256 internal constant SESSION_EXPIRY        = 1_816_650_312; // 2027-07

    // OI-cap sizing defaults (whole USDC). See docs/DEPLOY_130_CUTOVER.md §3.
    uint256 internal constant OI_CAP_MULTIPLIER_DEFAULT = 10;
    uint256 internal constant OI_CAP_FLOOR_USDC         = 1_000;
    uint256 internal constant OI_CAP_CEILING_USDC       = 50_000;
    uint256 internal constant OI_CAP_RWA_BPS_DEFAULT    = 5_000;

    struct Config {
        address guardian;
        address marketOperator;
        address oracle;
        string  oracleKind;
        uint256 maxProfitBps;
        uint256 oiCapNonRwa;   // 18-dec, whole USDC
        uint256 oiCapRwa;      // 18-dec, whole USDC
        bool    allowOpenPositions;
        bool    createDemoSession;
        address demoSessionAgent;
        bool    deployNewTraderStake;
        address traderStake;
    }

    // ── test hooks (a script is never deployed on chain) ────────────────────
    address public broadcasterOverride;
    function setBroadcasterOverride(address a) external { broadcasterOverride = a; }
    /// @dev Stop after step N (1..10) to simulate an interrupted broadcast.
    uint256 public haltAfterStep;
    function setHaltAfterStep(uint256 n) external { haltAfterStep = n; }
    /// @dev Resume addresses without process-wide env (parallel tests).
    Deployed130 internal _resumeOverride;
    bool internal _hasResumeOverride;
    function setResumeOverride(Deployed130 calldata r) external { _resumeOverride = r; _hasResumeOverride = true; }

    Deployed130 public lastDeployed;

    function run() external {
        address deployer = broadcasterOverride != address(0) ? broadcasterOverride : msg.sender;
        Config memory c = _loadConfig(deployer);
        Deployed130 memory r = _loadResume(c);
        _preflight(deployer, c, r);
        if (vm.envOr("PREFLIGHT_ONLY", false)) {
            console.log("PREFLIGHT_ONLY=true - stopping before any transaction.");
            return;
        }
        (Deployed130 memory d, bool complete) = _execute(deployer, c, r);
        lastDeployed = d;
        _printAddresses(d, c);
        if (!complete) {
            console.log("!!! HALTED after step", haltAfterStep, "(simulated interruption) - resume with RESUME_*.");
            return;
        }

        _verify130(d, Expect130({
            owner:          deployer,
            guardian:       c.guardian,
            marketOperator: c.marketOperator,
            oracle:         c.oracle,
            maxProfitBps:   c.maxProfitBps,
            oiCapNonRwa:    c.oiCapNonRwa,
            oiCapRwa:       c.oiCapRwa
        }));
        console.log("");
        console.log("Next: Verify130 against the real chain, then runbook sec.7.");
    }

    // ── config ──────────────────────────────────────────────────────────────

    function _loadConfig(address deployer) internal view returns (Config memory c) {
        c.guardian = vm.envOr("GUARDIAN", address(0));
        require(c.guardian != address(0), "GUARDIAN env is required (hot key that may pause, never unpause)");
        c.marketOperator = vm.envOr("MARKET_OPERATOR", KEEPER);
        require(c.marketOperator != address(0), "MARKET_OPERATOR must not be 0");
        // Role separation: a guardian that is also the keeper / operator key is
        // one compromise away from both moving prices and freezing markets.
        require(c.guardian != c.marketOperator, "GUARDIAN must differ from MARKET_OPERATOR");
        require(c.guardian != KEEPER, "GUARDIAN must differ from the keeper key");
        // Owner == guardian makes the brake no separate key. Allowed only for a
        // deliberate single-key rehearsal (anvil / throwaway fork).
        require(c.guardian != deployer || vm.envOr("ALLOW_GUARDIAN_IS_OWNER", false),
            "GUARDIAN must differ from the owner key (ALLOW_GUARDIAN_IS_OWNER=true only for single-key rehearsals)");

        c.oracleKind = vm.envOr("ORACLE_KIND", string("mock"));
        bytes32 k = keccak256(bytes(c.oracleKind));
        if (k == keccak256("mock")) c.oracle = MOCK_ORACLE;
        else if (k == keccak256("guarded")) c.oracle = GUARDED_ORACLE;
        else revert("ORACLE_KIND must be 'mock' or 'guarded'");

        c.maxProfitBps = vm.envOr("MAX_PROFIT_BPS", DEFAULT_MAX_PROFIT_BPS);
        require(c.maxProfitBps >= 10_000 && c.maxProfitBps <= 250_000,
            "MAX_PROFIT_BPS must be in [10000, 250000] (0 = off is not allowed here)");

        (c.oiCapNonRwa, c.oiCapRwa) = _oiCaps();

        c.allowOpenPositions   = vm.envOr("ALLOW_OPEN_POSITIONS", false);
        c.createDemoSession    = vm.envOr("CREATE_DEMO_SESSION", false);
        c.demoSessionAgent     = vm.envOr("DEMO_SESSION_AGENT", address(0));
        if (c.createDemoSession) {
            require(c.demoSessionAgent != address(0), "CREATE_DEMO_SESSION=true needs DEMO_SESSION_AGENT");
            require(c.demoSessionAgent != deployer, "DEMO_SESSION_AGENT must not be the owner key");
        }
        c.deployNewTraderStake = vm.envOr("DEPLOY_NEW_TRADER_STAKE", false);
        c.traderStake          = vm.envOr("TRADER_STAKE", TRADER_STK);
    }

    /// @dev Per-side OI cap, same for long and short, whole USDC.
    ///        non-RWA = OI_CAP_NON_RWA_USDC, else
    ///                  clamp(InsuranceVault.totalAssets × OI_CAP_MULTIPLIER, 1,000, 50,000)
    ///        RWA     = OI_CAP_RWA_USDC, else non-RWA × OI_CAP_RWA_BPS / 10,000
    function _oiCaps() internal view returns (uint256 nonRwa, uint256 rwa) {
        uint256 overrideNon = vm.envOr("OI_CAP_NON_RWA_USDC", uint256(0));
        if (overrideNon != 0) {
            nonRwa = overrideNon * 1e18;
        } else {
            uint256 ins = IInsuranceVaultPerp(INS_VAULT).totalAssets();
            nonRwa = ins * vm.envOr("OI_CAP_MULTIPLIER", OI_CAP_MULTIPLIER_DEFAULT);
            if (nonRwa < OI_CAP_FLOOR_USDC * 1e18) nonRwa = OI_CAP_FLOOR_USDC * 1e18;
            if (nonRwa > OI_CAP_CEILING_USDC * 1e18) nonRwa = OI_CAP_CEILING_USDC * 1e18;
        }
        uint256 overrideRwa = vm.envOr("OI_CAP_RWA_USDC", uint256(0));
        rwa = overrideRwa != 0
            ? overrideRwa * 1e18
            : nonRwa * vm.envOr("OI_CAP_RWA_BPS", OI_CAP_RWA_BPS_DEFAULT) / 10_000;
        // Whole USDC both ways, so the value Verify130 is told (in USDC) matches exactly.
        nonRwa = nonRwa / 1e18 * 1e18;
        rwa    = rwa / 1e18 * 1e18;
        require(nonRwa > 0 && rwa > 0, "OI caps must be non-zero (0 = unlimited)");
    }

    function _loadResume(Config memory c) internal view returns (Deployed130 memory r) {
        if (_hasResumeOverride) return _resumeOverride;
        r.exchange         = vm.envOr("RESUME_EXCHANGE", address(0));
        r.strategyRegistry = vm.envOr("RESUME_STRATEGY_REGISTRY", address(0));
        r.copyTracker      = vm.envOr("RESUME_COPY_TRACKER", address(0));
        r.sessionManager   = vm.envOr("RESUME_SESSION_MANAGER", address(0));
        r.traderStake      = vm.envOr("RESUME_TRADER_STAKE", address(0));
        c;
    }

    // ── preflight (read-only) ─────────────────────────────────────────────

    function _preflight(address deployer, Config memory c, Deployed130 memory r) internal view {
        console.log("=== #130 preflight ===");
        console.log("broadcaster      :", deployer);
        bool resume = r.exchange != address(0);

        // 1. Where the shared pointers are. Fresh run: all five must still be
        //    the #129 values. Resume: each may be the #129 value OR the resumed
        //    one — anything else is a third chain and is refused.
        address stake = _stakeSource(c, r);   // same rule as step 5
        address insEx = ISettableExchange130(INS_VAULT).exchange();
        address frEx  = ISettableExchange130(FEE_ROUTER).exchange();
        address frCt  = FeeRouter(FEE_ROUTER).copyTracker();
        address tsCt  = stake == address(0) ? address(0) : TraderStake(stake).copyTracker();
        bool oldSmAuth = PerpetualExchange(OLD_EXCHANGE).authorizedAgents(OLD_SESSION_MANAGER);
        if (!resume) {
            string memory partialMsg = " - partial cutover detected; re-run with RESUME_* (runbook sec.9), never from scratch";
            require(insEx == OLD_EXCHANGE, string.concat("InsuranceVault.exchange != old exchange", partialMsg));
            require(frEx == OLD_EXCHANGE, string.concat("FeeRouter.exchange != old exchange", partialMsg));
            require(frCt == OLD_COPY_TRACKER, string.concat("FeeRouter.copyTracker != old CopyTracker", partialMsg));
            if (stake != address(0)) {
                require(tsCt == OLD_COPY_TRACKER, string.concat("TraderStake.copyTracker != old CopyTracker", partialMsg));
            }
            require(oldSmAuth, string.concat("old SessionManager already revoked on the old exchange", partialMsg));
            console.log("ok   untouched #129 chain (5 pointers)");
        } else {
            require(r.exchange != OLD_EXCHANGE, "RESUME_EXCHANGE is the OLD exchange - pass the new one from the broken run");
            require(r.exchange.code.length > 0, "RESUME_EXCHANGE has no code");
            require(PerpetualExchange(r.exchange).owner() == deployer, "RESUME_EXCHANGE not owned by broadcaster");
            require(insEx == OLD_EXCHANGE || insEx == r.exchange, "InsuranceVault.exchange is neither old nor RESUME_EXCHANGE");
            require(frEx == OLD_EXCHANGE || frEx == r.exchange, "FeeRouter.exchange is neither old nor RESUME_EXCHANGE");
            require(frCt == OLD_COPY_TRACKER || (r.copyTracker != address(0) && frCt == r.copyTracker),
                "FeeRouter.copyTracker is neither old nor RESUME_COPY_TRACKER");
            if (stake != address(0)) {
                // A freshly deployed stake (RESUME_TRADER_STAKE) starts at 0.
                require(tsCt == OLD_COPY_TRACKER || tsCt == address(0)
                    || (r.copyTracker != address(0) && tsCt == r.copyTracker),
                    "TraderStake.copyTracker is neither old, unset nor RESUME_COPY_TRACKER");
            }
            console.log("RESUME from exchange:", r.exchange);
        }

        // 2. Ownership of everything the broadcast writes to.
        require(ISettableExchange130(INS_VAULT).owner() == deployer, "broadcaster is not InsuranceVault.owner");
        require(ISettableExchange130(FEE_ROUTER).owner() == deployer, "broadcaster is not FeeRouter.owner");
        require(PerpetualExchange(OLD_EXCHANGE).owner() == deployer, "broadcaster is not old exchange owner");
        if (stake != address(0)) {
            require(stake.code.length > 0, "TraderStake has no code");
            require(TraderStake(stake).owner() == deployer, "broadcaster is not TraderStake.owner");
        }
        console.log("ok   ownership");

        // 3. Carbon registry the exchange will read (immutable on the exchange).
        try IEsgRegistryV2Tier130(ESG_V2).medianCarbonTier(keccak256("sMSFT")) returns (
            CarbonTiers.Tier, uint256, uint256, bool isRated
        ) {
            require(isRated, "ESGRegistryV2: sMSFT not rated - registry not seeded");
        } catch {
            revert("ESGRegistryV2 has no medianCarbonTier - wrong registry");
        }
        console.log("ok   ESGRegistryV2 schema + seed");

        // 4. Oracle quotes all 11 assets fresh.
        string[11] memory syms = _syms();
        for (uint256 i = 0; i < N_ASSETS; i++) {
            try IOracle(c.oracle).getPrice(keccak256(bytes(syms[i]))) returns (uint256 p, uint256 at) {
                require(p > 0, string.concat("oracle: zero price for ", syms[i]));
                require(block.timestamp <= at + MAX_PRICE_AGE,
                    string.concat("oracle: stale price for ", syms[i], " - dispatch the keeper first"));
            } catch {
                revert(string.concat("oracle refused to quote ", syms[i], " (GuardedOracle stale/frozen?)"));
            }
        }
        console.log("ok   oracle quotes all 11 assets:", c.oracleKind, c.oracle);

        console.log("guardian         :", c.guardian);
        console.log("marketOperator   :", c.marketOperator);
        console.log("InsuranceVault totalAssets (USDC):", IInsuranceVaultPerp(INS_VAULT).totalAssets() / 1e18);
        console.log("OI cap / side, crypto+gold (USDC) :", c.oiCapNonRwa / 1e18);
        console.log("OI cap / side, RWA (USDC)         :", c.oiCapRwa / 1e18);
        console.log("maxProfitBps (all assets)        :", c.maxProfitBps);

        // 5. Old exchange: open positions (hard gate) and parked margin.
        (uint256 openCount, uint256 openMargin) = _survey();
        console.log("old exchange USDC balance (margin users must withdraw + re-deposit):", IERC20(USDC).balanceOf(OLD_EXCHANGE) / 1e18);
        console.log("old exchange ETH (execution fees):", OLD_EXCHANGE.balance);
        if (openCount > 0) {
            console.log("!!! %s OPEN position(s), %s USDC margin, on the old exchange.", openCount, openMargin / 1e18);
            require(c.allowOpenPositions,
                "old exchange has open positions - close/liquidate them first (runbook sec.5.1), or ALLOW_OPEN_POSITIONS=true (read sec.5.1 first)");
            console.log("!!! ALLOW_OPEN_POSITIONS=true: after the re-point these can no longer be liquidated;");
            console.log("!!! run old.setInsuranceVault(0) + old.setFeeRouter(0) (runbook sec.5.1).");
        } else {
            console.log("ok   0 open positions on the old exchange");
        }
    }

    /// @dev The ONE rule for which TraderStake this run uses, shared by the
    ///      preflight and steps 5 / 10: a resumed stake, else the retained one,
    ///      else 0 = "deploy a new one in step 5".
    function _stakeSource(Config memory c, Deployed130 memory r) internal pure returns (address) {
        if (r.traderStake != address(0)) return r.traderStake;
        if (c.deployNewTraderStake) return address(0);
        return c.traderStake;
    }

    function _survey() internal view returns (uint256 openCount, uint256 openMargin) {
        uint256 next = PerpetualExchange(OLD_EXCHANGE).nextPositionId();
        require(next <= MAX_SCAN, "more positions than MAX_SCAN - survey incomplete; raise MAX_SCAN");
        console.log("old exchange nextPositionId:", next);
        for (uint256 i = 0; i < next; i++) {
            PerpetualExchange.Position memory p = PerpetualExchange(OLD_EXCHANGE).getPosition(i);
            if (!p.isOpen) continue;
            openCount++;
            openMargin += p.margin;
            console.log("  OPEN id", i, "owner", p.owner);
        }
    }

    // ── the broadcast (idempotent, resumable) ─────────────────────────────

    function _halt(uint256 step) internal returns (bool) {
        if (haltAfterStep != 0 && step >= haltAfterStep) {
            vm.stopBroadcast();
            return true;
        }
        return false;
    }

    function _execute(address deployer, Config memory c, Deployed130 memory r)
        internal returns (Deployed130 memory d, bool complete)
    {
        PerpetualExchange old = PerpetualExchange(OLD_EXCHANGE);
        uint256 oldTradingFee = old.TRADING_FEE_BPS();
        uint256 oldBorrowFee  = old.BORROW_FEE_BPS_PER_HOUR();
        uint256 oldLiqPenalty = old.liquidationPenaltyBps();
        uint256 oldPremiumCap = old.markPremiumCapBps();
        uint256 oldVaultShare = old.vaultFeeShareBps();

        vm.startBroadcast(deployer);

        // ── 1. Exchange ────────────────────────────────────────────────────
        PerpetualExchange ex;
        if (r.exchange != address(0)) {
            ex = PerpetualExchange(r.exchange);
            require(address(ex.usdc()) == USDC && address(ex.oracle()) == c.oracle && address(ex.esgRegistry()) == ESG_V2,
                "RESUME_EXCHANGE immutables differ from this config (ORACLE_KIND?)");
        } else {
            ex = new PerpetualExchange(USDC, c.oracle, ESG_V2);
        }
        d.exchange = address(ex);
        if (_halt(1)) return (d, false);

        // ── 2. Global params (write only what differs) ─────────────────────
        if (ex.maxPriceAge() != MAX_PRICE_AGE) ex.setMaxPriceAge(MAX_PRICE_AGE);
        if (ex.executionFee() != EXECUTION_FEE) ex.setExecutionFee(EXECUTION_FEE);
        if (ex.adlEnabled() != ADL_ENABLED) ex.setAdlEnabled(ADL_ENABLED);
        if (address(ex.kyc()) != KYC) ex.setKycRegistry(KYC);
        if (address(ex.feeRouter()) != FEE_ROUTER) ex.setFeeRouter(FEE_ROUTER);
        if (address(ex.insuranceVault()) != INS_VAULT) ex.setInsuranceVault(INS_VAULT);
        if (ex.TRADING_FEE_BPS() != oldTradingFee) ex.setTradingFeeBps(oldTradingFee);
        if (ex.BORROW_FEE_BPS_PER_HOUR() != oldBorrowFee) ex.setBorrowFeePerHour(oldBorrowFee);
        if (ex.liquidationPenaltyBps() != oldLiqPenalty) ex.setLiquidationPenaltyBps(oldLiqPenalty);
        if (ex.markPremiumCapBps() != oldPremiumCap) ex.setMarkPremiumCapBps(oldPremiumCap);
        if (ex.vaultFeeShareBps() != oldVaultShare) ex.setVaultFeeShareBps(oldVaultShare);
        if (_halt(2)) return (d, false);

        // ── 3. Per-asset RWA flag + forced risk caps; emergency roles ──────
        string[11] memory syms = _syms();
        for (uint256 i = 0; i < N_ASSETS; i++) {
            bytes32 id = keccak256(bytes(syms[i]));
            bool rwa = _isRwa(syms[i]);
            if (ex.rwaAsset(id) != rwa) ex.setRwaAsset(id, rwa);
            uint256 cap = rwa ? c.oiCapRwa : c.oiCapNonRwa;
            if (ex.maxLongOI(id) != cap || ex.maxShortOI(id) != cap) ex.setMaxOpenInterest(id, cap, cap);
            if (ex.maxProfitBps(id) != c.maxProfitBps) ex.setMaxProfitBps(id, c.maxProfitBps);
        }
        if (ex.guardian() != c.guardian) ex.setGuardian(c.guardian);
        if (ex.marketOperator() != c.marketOperator) ex.setMarketOperator(c.marketOperator);
        if (_halt(3)) return (d, false);

        // ── 4. Probe: the #191 build (CopyTracker scoring needs closeReasonOf)
        vm.stopBroadcast();
        try ex.closeReasonOf(0) returns (PerpetualExchange.CloseReason) {
        } catch {
            revert("new exchange has no closeReasonOf - not the #191 build; refusing to wire CopyTracker");
        }
        vm.startBroadcast(deployer);

        // ── 5. TraderStake (retained by default — it holds live stakes) ────
        d.traderStake = _stakeSource(c, r);
        if (d.traderStake == address(0)) d.traderStake = address(new TraderStake(USDC));
        if (_halt(5)) return (d, false);

        // ── 6. StrategyRegistry + CopyTracker (new contracts only) ─────────
        if (r.strategyRegistry != address(0)) {
            d.strategyRegistry = r.strategyRegistry;
            require(address(StrategyRegistry(d.strategyRegistry).stakeContract()) == d.traderStake, "RESUME_STRATEGY_REGISTRY: wrong stake");
        } else {
            d.strategyRegistry = address(new StrategyRegistry(d.traderStake));
        }
        if (r.copyTracker != address(0)) {
            d.copyTracker = r.copyTracker;
            require(address(CopyTracker(d.copyTracker).exchange()) == d.exchange
                && address(CopyTracker(d.copyTracker).registry()) == d.strategyRegistry,
                "RESUME_COPY_TRACKER: wired to a different exchange/registry");
        } else {
            d.copyTracker = address(new CopyTracker(USDC, d.exchange, d.strategyRegistry, FEE_ROUTER, d.traderStake));
        }
        if (ex.copyTracker() != d.copyTracker) ex.setCopyTracker(d.copyTracker);
        if (_halt(6)) return (d, false);

        // ── 7. AgentSessionManager (new contract only) ─────────────────────
        if (r.sessionManager != address(0)) {
            d.sessionManager = r.sessionManager;
            require(address(AgentSessionManager(d.sessionManager).exchange()) == d.exchange, "RESUME_SESSION_MANAGER: wrong exchange");
        } else {
            d.sessionManager = address(new AgentSessionManager(d.exchange));
        }
        if (!ex.authorizedAgents(d.sessionManager)) ex.setAgentAuthorized(d.sessionManager, true);
        if (_halt(7)) return (d, false);

        // ── 8. Optional demo session (never to the owner key) ──────────────
        if (c.createDemoSession && AgentSessionManager(d.sessionManager).nextSessionId() == 0) {
            bytes32[] memory allowed = new bytes32[](2);
            allowed[0] = keccak256("sBTC");
            allowed[1] = keccak256("sETH");
            AgentSessionManager(d.sessionManager).createSessionWithAssets(
                c.demoSessionAgent, SESSION_MAX_PER_TRADE, SESSION_BUDGET, SESSION_MAX_LEVERAGE, SESSION_EXPIRY, allowed
            );
        }
        if (_halt(8)) return (d, false);

        // ── 9. IRREVERSIBLE: re-point the two peripherals ──────────────────
        if (ISettableExchange130(INS_VAULT).exchange() != d.exchange) ISettableExchange130(INS_VAULT).setExchange(d.exchange);
        if (_halt(9)) return (d, false);   // (a "half re-point" for the resume test)
        if (ISettableExchange130(FEE_ROUTER).exchange() != d.exchange) ISettableExchange130(FEE_ROUTER).setExchange(d.exchange);

        // ── 10. After the point of no return: shared pointers + retire old SM
        if (FeeRouter(FEE_ROUTER).copyTracker() != d.copyTracker) FeeRouter(FEE_ROUTER).setCopyTracker(d.copyTracker);
        if (TraderStake(d.traderStake).copyTracker() != d.copyTracker) TraderStake(d.traderStake).setCopyTracker(d.copyTracker);
        if (old.authorizedAgents(OLD_SESSION_MANAGER)) old.setAgentAuthorized(OLD_SESSION_MANAGER, false);

        vm.stopBroadcast();
        complete = true;
    }

    function _printAddresses(Deployed130 memory d, Config memory c) internal pure {
        console.log("");
        console.log("=== #130 hardened-exchange cutover ===");
        console.log("EXCHANGE_NEW          =", d.exchange);
        console.log("COPYTRACKER_NEW       =", d.copyTracker);
        console.log("STRATEGY_REGISTRY_NEW =", d.strategyRegistry);
        console.log("SESSION_MANAGER_NEW   =", d.sessionManager);
        console.log("TRADER_STAKE          =", d.traderStake);
        console.log("oracle                =", c.oracleKind, c.oracle);
        console.log("OI_CAP_NON_RWA_USDC   =", c.oiCapNonRwa / 1e18);
        console.log("OI_CAP_RWA_USDC       =", c.oiCapRwa / 1e18);
    }
}
