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

interface IInsVault130 {
    function exchange() external view returns (address);
    function owner() external view returns (address);
}

/// @notice Shared constants + the read-only post-cutover assertions for the
///         #130 hardened-exchange cutover. `Redeploy130Hardened` runs
///         `_verify130` right after its own broadcast (so a fork simulation
///         exercises every assertion below), and `Verify130` runs it standalone
///         against the addresses the real broadcast printed.
abstract contract Cutover130Base is Script {
    // ── Base Sepolia (84532) pieces that stay where they are ────────────────
    address internal constant USDC           = 0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035;
    address internal constant MOCK_ORACLE    = 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3;
    address internal constant GUARDED_ORACLE = 0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842;
    address internal constant FEE_ROUTER     = 0x00f6cf0113399a7A451c7f85fe094a28092d3e0c;
    address internal constant INS_VAULT      = 0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812;
    address internal constant KYC            = 0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d;
    address internal constant TRADER_STK     = 0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe;
    address internal constant ESG_V2         = 0xBF5B9cD78566791d79c687A732b4ed5bc3E95dFf;
    address internal constant KEEPER         = 0x540aECD37E7A7885824e7b7e996eBddfb842ef17;
    address internal constant DEPLOYER_OWNER = 0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585;

    // ── #129's outputs — the chain currently live, being replaced ───────────
    address internal constant OLD_EXCHANGE        = 0x827eA0c62a32e995927101259042F8A27D99124D;
    address internal constant OLD_COPY_TRACKER    = 0xC9e91f7D36e910C58042164032c625427b23CCB2;
    address internal constant OLD_SESSION_MANAGER = 0xdF9C1E53523568709f65Afe3C4AD2E6a6D99d14B;

    // Read off the live exchange 0x827e… on 2026-09-30 (cast call). The
    // replacement must match these; everything else starts at the contract
    // default, which equals what the live one runs today.
    uint256 internal constant MAX_PRICE_AGE = 21_600;   // 6h
    uint256 internal constant EXECUTION_FEE = 1e14;     // 0.0001 ETH
    bool    internal constant ADL_ENABLED   = true;

    uint256 internal constant DEFAULT_MAX_PROFIT_BPS = 50_000;   // 5x margin

    uint256 internal constant N_ASSETS = 11;

    function _syms() internal pure returns (string[11] memory s) {
        s = ["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"];
    }

    /// @dev Every `regulated: true` asset in frontend/src/lib/pepefi/assetMeta.ts
    ///      — the same eight #129 flagged, re-read on chain 2026-09-30
    ///      (`rwaAsset(id)` true for exactly these on 0x827e…).
    function _isRwa(string memory sym) internal pure returns (bool) {
        bytes32 h = keccak256(bytes(sym));
        return h == keccak256("sAAPL") || h == keccak256("sTSLA") || h == keccak256("sNVDA")
            || h == keccak256("sMSFT") || h == keccak256("sGOOGL") || h == keccak256("sICLN")
            || h == keccak256("sESGU") || h == keccak256("sBOND");
    }

    struct Deployed130 {
        address exchange;
        address copyTracker;
        address strategyRegistry;
        address sessionManager;
        address traderStake;
    }

    struct Expect130 {
        address owner;           // exchange + CopyTracker owner (deployer, or the timelock after handover)
        address guardian;
        address marketOperator;
        address oracle;
        uint256 maxProfitBps;
        uint256 oiCapNonRwa;     // 0 = only assert "set (non-zero)"
        uint256 oiCapRwa;        // 0 = only assert "set (non-zero)"
    }

    function _eq(string memory field, address got, address want) internal pure {
        if (got != want) {
            console.log("MISMATCH", field);
            console.log("  got  :", got);
            console.log("  want :", want);
            revert(string.concat("verify130 mismatch: ", field));
        }
        console.log("ok  ", field);
    }

    function _check(bool cond, string memory what) internal pure {
        if (!cond) revert(string.concat("verify130 failed: ", what));
        console.log("ok  ", what);
    }

    /// @notice Every post-cutover property, read back from chain. Reverts on
    ///         the first mismatch with the field name.
    function _verify130(Deployed130 memory d, Expect130 memory e) internal view {
        PerpetualExchange ex = PerpetualExchange(d.exchange);

        console.log("--- PerpetualExchange (hardened, #191) ---");
        _eq("exchange.owner", ex.owner(), e.owner);
        _eq("exchange.guardian", ex.guardian(), e.guardian);
        _check(e.guardian != address(0), "guardian is set (non-zero)");
        _eq("exchange.marketOperator", ex.marketOperator(), e.marketOperator);
        _eq("exchange.oracle", address(ex.oracle()), e.oracle);
        _eq("exchange.usdc", address(ex.usdc()), USDC);
        _eq("exchange.esgRegistry", address(ex.esgRegistry()), ESG_V2);
        _eq("exchange.kyc", address(ex.kyc()), KYC);
        _eq("exchange.feeRouter", address(ex.feeRouter()), FEE_ROUTER);
        _eq("exchange.insuranceVault", address(ex.insuranceVault()), INS_VAULT);
        _eq("exchange.copyTracker", ex.copyTracker(), d.copyTracker);
        _check(ex.maxPriceAge() == MAX_PRICE_AGE, "exchange.maxPriceAge == 21600");
        _check(ex.executionFee() == EXECUTION_FEE, "exchange.executionFee == 1e14");
        _check(ex.adlEnabled() == ADL_ENABLED, "exchange.adlEnabled == true");
        _check(!ex.paused(), "exchange not paused");
        // #191 probe: the getter CopyTracker's scoring depends on.
        ex.closeReasonOf(0);
        console.log("ok   exchange.closeReasonOf present");

        console.log("--- risk caps (per asset) ---");
        string[11] memory syms = _syms();
        for (uint256 i = 0; i < N_ASSETS; i++) {
            bytes32 id = keccak256(bytes(syms[i]));
            bool rwa = _isRwa(syms[i]);
            if (ex.rwaAsset(id) != rwa) revert(string.concat("verify130 failed: rwaAsset flag ", syms[i]));

            uint256 cap = rwa ? e.oiCapRwa : e.oiCapNonRwa;
            uint256 l = ex.maxLongOI(id);
            uint256 s = ex.maxShortOI(id);
            if (l == 0 || s == 0) revert(string.concat("verify130 failed: OI cap left at 0 (unlimited) for ", syms[i]));
            if (cap != 0 && (l != cap || s != cap)) revert(string.concat("verify130 failed: OI cap != expected for ", syms[i]));
            if (ex.maxProfitBps(id) != e.maxProfitBps) revert(string.concat("verify130 failed: maxProfitBps for ", syms[i]));
            console.log(string.concat("ok   ", syms[i], rwa ? " (RWA)" : ""), "OI/side USDC", l / 1e18);
        }
        console.log("ok   maxProfitBps on all 11 =", e.maxProfitBps);

        console.log("--- agents ---");
        _check(ex.authorizedAgents(d.sessionManager), "new AgentSessionManager authorised on new exchange");
        _check(ex.authorizedAgents(d.copyTracker), "new CopyTracker authorised on new exchange");
        _check(!ex.authorizedAgents(OLD_SESSION_MANAGER), "old AgentSessionManager NOT authorised on new exchange");
        _check(!ex.authorizedAgents(OLD_COPY_TRACKER), "old CopyTracker NOT authorised on new exchange");
        _check(
            !PerpetualExchange(OLD_EXCHANGE).authorizedAgents(OLD_SESSION_MANAGER),
            "old AgentSessionManager revoked on OLD exchange"
        );
        _eq("sessionManager.exchange", address(AgentSessionManager(d.sessionManager).exchange()), d.exchange);

        console.log("--- CopyTracker / StrategyRegistry ---");
        CopyTracker ct = CopyTracker(d.copyTracker);
        _eq("copyTracker.exchange", address(ct.exchange()), d.exchange);
        _eq("copyTracker.registry", address(ct.registry()), d.strategyRegistry);
        _eq("copyTracker.usdc", address(ct.usdc()), USDC);
        _eq("copyTracker.feeRouter", address(ct.feeRouter()), FEE_ROUTER);
        _eq("copyTracker.traderStake", address(ct.traderStake()), d.traderStake);
        _eq("copyTracker.owner", ct.owner(), e.owner);
        _eq("strategyRegistry.stakeContract", address(StrategyRegistry(d.strategyRegistry).stakeContract()), d.traderStake);

        console.log("--- re-pointed peripherals (irreversible step) ---");
        _eq("insuranceVault.exchange", IInsVault130(INS_VAULT).exchange(), d.exchange);
        _eq("feeRouter.exchange", FeeRouter(FEE_ROUTER).exchange(), d.exchange);
        _eq("feeRouter.copyTracker", FeeRouter(FEE_ROUTER).copyTracker(), d.copyTracker);
        _eq("traderStake.copyTracker", TraderStake(d.traderStake).copyTracker(), d.copyTracker);

        // Freshness is the keeper's job, not wiring: a price that is merely
        // older than 6h right now is reported, not failed (dispatch the keeper
        // and re-run if you want a clean sheet). A missing price IS a failure.
        console.log("--- oracle feed ---");
        uint256 staleCount;
        for (uint256 i = 0; i < N_ASSETS; i++) {
            bytes32 id = keccak256(bytes(syms[i]));
            (uint256 p, uint256 at) = IOracle(e.oracle).getPrice(id);
            if (p == 0) revert(string.concat("verify130 failed: oracle has no price for ", syms[i]));
            if (block.timestamp > at + MAX_PRICE_AGE) {
                staleCount++;
                console.log(string.concat("WARN ", syms[i], " price older than 6h - dispatch the keeper"));
            }
        }
        if (staleCount == 0) console.log("ok   all 11 assets priced and fresh on the exchange's oracle");
        else console.log("WARN stale assets:", staleCount, "(wiring still verified)");
    }
}

/// @notice #130 verification — read-only. Run after `Redeploy130Hardened`
///         broadcast, with the addresses it printed:
///
///           EXCHANGE_NEW=0x… COPYTRACKER_NEW=0x… STRATEGY_REGISTRY_NEW=0x… \
///           SESSION_MANAGER_NEW=0x… GUARDIAN=0x… \
///           forge script script/Verify130.s.sol:Verify130 --rpc-url "$BASE_SEPOLIA_RPC_URL" -vvv
///
///         Optional (defaults in brackets):
///           EXPECTED_OWNER   [0x27C2…A585]  — the timelock after HandoverToTimelock
///           MARKET_OPERATOR  [keeper 0x540a…ef17]
///           ORACLE_KIND      [mock]         — "guarded" if the cutover used GuardedOracle
///           MAX_PROFIT_BPS   [50000]
///           OI_CAP_NON_RWA_USDC / OI_CAP_RWA_USDC [0 = assert non-zero only]
///           TRADER_STAKE     [0x01aE…28Fe]
contract Verify130 is Cutover130Base {
    function run() external view {
        Deployed130 memory d = Deployed130({
            exchange:         vm.envAddress("EXCHANGE_NEW"),
            copyTracker:      vm.envAddress("COPYTRACKER_NEW"),
            strategyRegistry: vm.envAddress("STRATEGY_REGISTRY_NEW"),
            sessionManager:   vm.envAddress("SESSION_MANAGER_NEW"),
            traderStake:      vm.envOr("TRADER_STAKE", TRADER_STK)
        });
        string memory kind = vm.envOr("ORACLE_KIND", string("mock"));
        Expect130 memory e = Expect130({
            owner:          vm.envOr("EXPECTED_OWNER", DEPLOYER_OWNER),
            guardian:       vm.envAddress("GUARDIAN"),
            marketOperator: vm.envOr("MARKET_OPERATOR", KEEPER),
            oracle:         keccak256(bytes(kind)) == keccak256("guarded") ? GUARDED_ORACLE : MOCK_ORACLE,
            maxProfitBps:   vm.envOr("MAX_PROFIT_BPS", DEFAULT_MAX_PROFIT_BPS),
            oiCapNonRwa:    vm.envOr("OI_CAP_NON_RWA_USDC", uint256(0)) * 1e18,
            oiCapRwa:       vm.envOr("OI_CAP_RWA_USDC", uint256(0)) * 1e18
        });
        _verify130(d, e);
        console.log("");
        console.log("=== #130 wiring verified. Frontend/agent/workflow rewiring (runbook sec.7) still required. ===");
    }
}
