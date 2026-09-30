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
///         `PerpetualExchange` (guardian pause, asset modes, OI caps, profit
///         cap, `closeReasonOf`). Third run of the #102 / #129 chain redeploy:
///         the exchange is not upgradeable, and `CopyTracker`,
///         `StrategyRegistry` and `AgentSessionManager` hold it `immutable`,
///         so all four are redeployed; `InsuranceVault` / `FeeRouter` are
///         re-pointed LAST (irreversible for the old venue's bail-out path).
///
///         Differences from #129:
///           - risk parameters are forced, never left at the 0 (= off)
///             default: per-asset OI caps, `maxProfitBps`, guardian, market
///             operator. `GUARDIAN` is REQUIRED — the script reverts without it;
///           - the old exchange's open positions are a HARD gate (revert unless
///             `ALLOW_OPEN_POSITIONS=true`), not only a log line;
///           - ownership / "still the #129 chain" preflight on every contract the
///             broadcast writes to, so a re-run after a partial cutover reverts
///             instead of minting a second exchange;
///           - `closeReasonOf` is probed on the new exchange BEFORE the
///             CopyTracker is built on it;
///           - the full `Verify130` assertion set runs at the end, so a fork
///             simulation exercises every post-deploy check.
///
///         Fork simulation (no key, nothing sent):
///           GUARDIAN=0x… forge script script/Redeploy130Hardened.s.sol:Redeploy130Hardened \
///             --fork-url https://sepolia.base.org --sender 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585 -vv
///
///         Broadcast (the user, never automation) — see docs/DEPLOY_130_CUTOVER.md.
contract Redeploy130Hardened is Cutover130Base {
    uint256 internal constant MAX_SCAN = 4_000;

    // Demo session mirrored from #102 / #129.
    uint256 internal constant SESSION_MAX_PER_TRADE = 1_000e18;
    uint256 internal constant SESSION_BUDGET        = 3_000e18;
    uint256 internal constant SESSION_MAX_LEVERAGE  = 5;
    uint256 internal constant SESSION_EXPIRY        = 1_816_650_312; // 2027-07

    // OI-cap sizing defaults (whole USDC). See docs/DEPLOY_130_CUTOVER.md §3.
    uint256 internal constant OI_CAP_MULTIPLIER_DEFAULT = 10;       // × InsuranceVault.totalAssets
    uint256 internal constant OI_CAP_FLOOR_USDC         = 1_000;
    uint256 internal constant OI_CAP_CEILING_USDC       = 50_000;
    uint256 internal constant OI_CAP_RWA_BPS_DEFAULT    = 5_000;    // RWA side = 50% of the crypto cap

    struct Config {
        address guardian;
        address marketOperator;
        address oracle;
        string  oracleKind;
        uint256 maxProfitBps;
        uint256 oiCapNonRwa;   // 18-dec
        uint256 oiCapRwa;      // 18-dec
        bool    allowOpenPositions;
        bool    createDemoSession;
        address demoSessionAgent;
        bool    deployNewTraderStake;
        address traderStake;
    }

    /// @dev Test hook only (see test/fork/Cutover130Fork.t.sol): lets a test
    ///      pick the broadcaster without a prank (pranks and broadcasts do not
    ///      mix). Never set by `run()`; a script is never deployed on chain.
    address public broadcasterOverride;
    function setBroadcasterOverride(address a) external { broadcasterOverride = a; }

    Deployed130 public lastDeployed;

    function run() external {
        address deployer = broadcasterOverride != address(0) ? broadcasterOverride : msg.sender;
        Config memory c = _loadConfig();
        _preflight(deployer, c);
        if (vm.envOr("PREFLIGHT_ONLY", false)) {
            console.log("PREFLIGHT_ONLY=true - stopping before any transaction.");
            return;
        }
        Deployed130 memory d = _execute(deployer, c);
        lastDeployed = d;

        _verify130(d, Expect130({
            owner:          deployer,
            guardian:       c.guardian,
            marketOperator: c.marketOperator,
            oracle:         c.oracle,
            maxProfitBps:   c.maxProfitBps,
            oiCapNonRwa:    c.oiCapNonRwa,
            oiCapRwa:       c.oiCapRwa
        }));
        _printNext(d, c);
    }

    // ── config ──────────────────────────────────────────────────────────────

    function _loadConfig() internal view returns (Config memory c) {
        c.guardian = vm.envOr("GUARDIAN", address(0));
        require(c.guardian != address(0), "GUARDIAN env is required (hot key that may pause, never unpause)");

        c.marketOperator = vm.envOr("MARKET_OPERATOR", KEEPER);
        require(c.marketOperator != address(0), "MARKET_OPERATOR must not be 0");

        c.oracleKind = vm.envOr("ORACLE_KIND", string("mock"));
        bytes32 k = keccak256(bytes(c.oracleKind));
        if (k == keccak256("mock")) c.oracle = MOCK_ORACLE;
        else if (k == keccak256("guarded")) c.oracle = GUARDED_ORACLE;
        else revert("ORACLE_KIND must be 'mock' or 'guarded'");

        c.maxProfitBps = vm.envOr("MAX_PROFIT_BPS", DEFAULT_MAX_PROFIT_BPS);
        require(c.maxProfitBps >= 10_000 && c.maxProfitBps <= 250_000, "MAX_PROFIT_BPS must be in [10000, 250000] (0 = off is not allowed here)");

        (c.oiCapNonRwa, c.oiCapRwa) = _oiCaps();

        c.allowOpenPositions   = vm.envOr("ALLOW_OPEN_POSITIONS", false);
        c.createDemoSession    = vm.envOr("CREATE_DEMO_SESSION", true);
        c.demoSessionAgent     = vm.envOr("DEMO_SESSION_AGENT", address(0));
        c.deployNewTraderStake = vm.envOr("DEPLOY_NEW_TRADER_STAKE", false);
        c.traderStake          = vm.envOr("TRADER_STAKE", TRADER_STK);
    }

    /// @dev Per-side OI cap, same for long and short.
    ///        non-RWA = OI_CAP_NON_RWA_USDC, else
    ///                  clamp(InsuranceVault.totalAssets × OI_CAP_MULTIPLIER, 1,000, 50,000) USDC
    ///        RWA     = OI_CAP_RWA_USDC, else non-RWA × OI_CAP_RWA_BPS / 10,000
    ///      Rationale in docs/DEPLOY_130_CUTOVER.md §3.
    function _oiCaps() internal view returns (uint256 nonRwa, uint256 rwa) {
        uint256 overrideNon = vm.envOr("OI_CAP_NON_RWA_USDC", uint256(0));
        if (overrideNon != 0) {
            nonRwa = overrideNon * 1e18;
        } else {
            uint256 ins = IInsuranceVaultPerp(INS_VAULT).totalAssets();   // 18-dec
            uint256 mult = vm.envOr("OI_CAP_MULTIPLIER", OI_CAP_MULTIPLIER_DEFAULT);
            nonRwa = ins * mult;
            if (nonRwa < OI_CAP_FLOOR_USDC * 1e18) nonRwa = OI_CAP_FLOOR_USDC * 1e18;
            if (nonRwa > OI_CAP_CEILING_USDC * 1e18) nonRwa = OI_CAP_CEILING_USDC * 1e18;
            nonRwa = nonRwa / 1e18 * 1e18;   // whole USDC, easier to read back
        }
        uint256 overrideRwa = vm.envOr("OI_CAP_RWA_USDC", uint256(0));
        rwa = overrideRwa != 0
            ? overrideRwa * 1e18
            : nonRwa * vm.envOr("OI_CAP_RWA_BPS", OI_CAP_RWA_BPS_DEFAULT) / 10_000;
        require(nonRwa > 0 && rwa > 0, "OI caps must be non-zero (0 = unlimited)");
    }

    // ── preflight (read-only) ─────────────────────────────────────────────

    function _preflight(address deployer, Config memory c) internal view {
        console.log("=== #130 preflight ===");
        console.log("broadcaster      :", deployer);

        // 1. Still the #129 chain (a re-run after a partial cutover must stop here).
        require(ISettableExchange130(INS_VAULT).exchange() == OLD_EXCHANGE,
            "InsuranceVault.exchange != old exchange 0x827e... - already cut over? do NOT re-run; finish by hand (runbook sec.9)");
        require(ISettableExchange130(FEE_ROUTER).exchange() == OLD_EXCHANGE,
            "FeeRouter.exchange != old exchange 0x827e... - already cut over? do NOT re-run; finish by hand (runbook sec.9)");

        // 2. Ownership of everything the broadcast writes to.
        require(ISettableExchange130(INS_VAULT).owner() == deployer, "broadcaster is not InsuranceVault.owner");
        require(ISettableExchange130(FEE_ROUTER).owner() == deployer, "broadcaster is not FeeRouter.owner");
        require(PerpetualExchange(OLD_EXCHANGE).owner() == deployer, "broadcaster is not old exchange owner");
        if (!c.deployNewTraderStake) {
            require(c.traderStake.code.length > 0, "TRADER_STAKE has no code");
            require(TraderStake(c.traderStake).owner() == deployer, "broadcaster is not TraderStake.owner");
        }
        console.log("ok   ownership + still-#129-chain checks");

        // 3. Carbon registry the exchange will read (immutable on the exchange).
        require(ESG_V2.code.length > 0, "ESGRegistryV2 has no code");
        try IEsgRegistryV2Tier130(ESG_V2).medianCarbonTier(keccak256("sMSFT")) returns (
            CarbonTiers.Tier, uint256, uint256, bool isRated
        ) {
            require(isRated, "ESGRegistryV2: sMSFT not rated - registry not seeded");
        } catch {
            revert("ESGRegistryV2 has no medianCarbonTier - wrong registry");
        }
        console.log("ok   ESGRegistryV2 schema + seed");

        // 4. Oracle: every asset quotes, fresh within the exchange's maxPriceAge.
        string[11] memory syms = _syms();
        for (uint256 i = 0; i < N_ASSETS; i++) {
            try IOracle(c.oracle).getPrice(keccak256(bytes(syms[i]))) returns (uint256 p, uint256 at) {
                require(p > 0, string.concat("oracle: zero price for ", syms[i]));
                require(block.timestamp <= at + MAX_PRICE_AGE, string.concat("oracle: stale price for ", syms[i]));
            } catch {
                revert(string.concat("oracle refused to quote ", syms[i], " (GuardedOracle stale/frozen?)"));
            }
        }
        console.log("ok   oracle quotes all 11 assets:", c.oracleKind, c.oracle);

        // 5. Roles.
        console.log("guardian         :", c.guardian);
        console.log("marketOperator   :", c.marketOperator);
        if (c.guardian == deployer) {
            console.log("!!! GUARDIAN == owner key: the pause brake is then no separate key (SEAL: use its own hot key).");
        }

        // 6. Risk caps that will be written.
        console.log("InsuranceVault totalAssets (USDC):", IInsuranceVaultPerp(INS_VAULT).totalAssets() / 1e18);
        console.log("OI cap / side, crypto+gold (USDC) :", c.oiCapNonRwa / 1e18);
        console.log("OI cap / side, RWA (USDC)         :", c.oiCapRwa / 1e18);
        console.log("maxProfitBps (all assets)        :", c.maxProfitBps);

        // 7. Old exchange: open positions (hard gate) and margin still parked there.
        (uint256 openCount, uint256 openMargin) = _survey();
        uint256 parked = IERC20(USDC).balanceOf(OLD_EXCHANGE);
        console.log("old exchange USDC balance (margin users must withdraw + re-deposit):", parked / 1e18);
        console.log("old exchange ETH (execution fees, owner withdrawExecutionFees):", OLD_EXCHANGE.balance);
        if (openCount > 0) {
            console.log("!!! %s OPEN position(s), %s USDC margin, on the old exchange.", openCount, openMargin / 1e18);
            require(c.allowOpenPositions,
                "old exchange has open positions - close/liquidate them first (runbook sec.4), or set ALLOW_OPEN_POSITIONS=true deliberately");
            console.log("!!! ALLOW_OPEN_POSITIONS=true - proceeding by deliberate choice: their bail-out path dies with the re-point.");
        } else {
            console.log("ok   0 open positions on the old exchange");
        }
    }

    function _survey() internal view returns (uint256 openCount, uint256 openMargin) {
        uint256 next = PerpetualExchange(OLD_EXCHANGE).nextPositionId();
        uint256 limit = next > MAX_SCAN ? MAX_SCAN : next;
        console.log("old exchange nextPositionId:", next);
        for (uint256 i = 0; i < limit; i++) {
            PerpetualExchange.Position memory p = PerpetualExchange(OLD_EXCHANGE).getPosition(i);
            if (!p.isOpen) continue;
            openCount++;
            openMargin += p.margin;
            console.log("  OPEN id", i, "owner", p.owner);
        }
        require(next <= MAX_SCAN, "more positions than MAX_SCAN - survey incomplete; raise MAX_SCAN");
    }

    // ── the broadcast ─────────────────────────────────────────────────────

    function _execute(address deployer, Config memory c) internal returns (Deployed130 memory d) {
        // Read the live knobs to copy BEFORE broadcasting (plain view calls).
        PerpetualExchange old = PerpetualExchange(OLD_EXCHANGE);
        uint256 oldTradingFee = old.TRADING_FEE_BPS();
        uint256 oldBorrowFee  = old.BORROW_FEE_BPS_PER_HOUR();
        uint256 oldLiqPenalty = old.liquidationPenaltyBps();
        uint256 oldPremiumCap = old.markPremiumCapBps();
        uint256 oldVaultShare = old.vaultFeeShareBps();

        vm.startBroadcast(deployer);

        // ── 1. Exchange (ExchangeOpsLib is linked + deployed automatically) ──
        PerpetualExchange ex = new PerpetualExchange(USDC, c.oracle, ESG_V2);
        d.exchange = address(ex);

        ex.setMaxPriceAge(MAX_PRICE_AGE);
        ex.setExecutionFee(EXECUTION_FEE);
        ex.setAdlEnabled(ADL_ENABLED);
        ex.setKycRegistry(KYC);
        ex.setFeeRouter(FEE_ROUTER);
        ex.setInsuranceVault(INS_VAULT);
        // Copy any global knob the live exchange runs off-default.
        if (ex.TRADING_FEE_BPS() != oldTradingFee) ex.setTradingFeeBps(oldTradingFee);
        if (ex.BORROW_FEE_BPS_PER_HOUR() != oldBorrowFee) ex.setBorrowFeePerHour(oldBorrowFee);
        if (ex.liquidationPenaltyBps() != oldLiqPenalty) ex.setLiquidationPenaltyBps(oldLiqPenalty);
        if (ex.markPremiumCapBps() != oldPremiumCap) ex.setMarkPremiumCapBps(oldPremiumCap);
        if (ex.vaultFeeShareBps() != oldVaultShare) ex.setVaultFeeShareBps(oldVaultShare);

        // ── 2. Per-asset: RWA flag + the forced risk caps ────────────────────
        string[11] memory syms = _syms();
        for (uint256 i = 0; i < N_ASSETS; i++) {
            bytes32 id = keccak256(bytes(syms[i]));
            bool rwa = _isRwa(syms[i]);
            if (rwa) ex.setRwaAsset(id, true);
            uint256 cap = rwa ? c.oiCapRwa : c.oiCapNonRwa;
            ex.setMaxOpenInterest(id, cap, cap);
            ex.setMaxProfitBps(id, c.maxProfitBps);
        }

        // ── 3. Emergency roles ─────────────────────────────────────────────
        ex.setGuardian(c.guardian);
        ex.setMarketOperator(c.marketOperator);

        vm.stopBroadcast();

        // ── 4. Probe: the new exchange must be the #191 build ──────────────
        // CopyTracker's scoring calls `closeReasonOf`; built against an
        // exchange without it, every unfollow of a closed leg would revert.
        try ex.closeReasonOf(0) returns (PerpetualExchange.CloseReason) {
        } catch {
            revert("new exchange has no closeReasonOf - not the #191 build; refusing to wire CopyTracker");
        }

        vm.startBroadcast(deployer);

        // ── 5. TraderStake (retained by default — it holds live stakes) ────
        if (c.deployNewTraderStake) {
            d.traderStake = address(new TraderStake(USDC));
        } else {
            d.traderStake = c.traderStake;
        }

        // ── 6. StrategyRegistry + CopyTracker (exchange immutable) ─────────
        d.strategyRegistry = address(new StrategyRegistry(d.traderStake));
        d.copyTracker = address(new CopyTracker(USDC, d.exchange, d.strategyRegistry, FEE_ROUTER, d.traderStake));
        ex.setCopyTracker(d.copyTracker);
        TraderStake(d.traderStake).setCopyTracker(d.copyTracker);
        FeeRouter(FEE_ROUTER).setCopyTracker(d.copyTracker);

        // ── 7. AgentSessionManager (exchange immutable) ────────────────────
        AgentSessionManager sm = new AgentSessionManager(d.exchange);
        d.sessionManager = address(sm);
        ex.setAgentAuthorized(d.sessionManager, true);

        if (c.createDemoSession) {
            bytes32[] memory allowed = new bytes32[](2);
            allowed[0] = keccak256("sBTC");
            allowed[1] = keccak256("sETH");
            address agent = c.demoSessionAgent == address(0) ? deployer : c.demoSessionAgent;
            sm.createSessionWithAssets(
                agent, SESSION_MAX_PER_TRADE, SESSION_BUDGET, SESSION_MAX_LEVERAGE, SESSION_EXPIRY, allowed
            );
        }

        // ── 8. Retire the old session manager on the OLD exchange ──────────
        old.setAgentAuthorized(OLD_SESSION_MANAGER, false);

        // ── 9. LAST, irreversible: re-point the two peripherals ────────────
        ISettableExchange130(INS_VAULT).setExchange(d.exchange);
        ISettableExchange130(FEE_ROUTER).setExchange(d.exchange);

        vm.stopBroadcast();
    }

    function _printNext(Deployed130 memory d, Config memory c) internal pure {
        console.log("");
        console.log("=== #130 hardened-exchange cutover ===");
        console.log("EXCHANGE_NEW          =", d.exchange);
        console.log("COPYTRACKER_NEW       =", d.copyTracker);
        console.log("STRATEGY_REGISTRY_NEW =", d.strategyRegistry);
        console.log("SESSION_MANAGER_NEW   =", d.sessionManager);
        console.log("TRADER_STAKE          =", d.traderStake);
        console.log("oracle                =", c.oracleKind, c.oracle);
        console.log("demo sessionId        = 0 (if CREATE_DEMO_SESSION) - re-issue VCs");
        console.log("");
        console.log("Next: Verify130 against the real chain, then runbook sec.7 (ABIs, addresses.ts,");
        console.log("sessionManager.ts, agent/.env, workflows, KEEPER_MARKET_OPERATOR=1, EsgRewardDistributor).");
    }
}
