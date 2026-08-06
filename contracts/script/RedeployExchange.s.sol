// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/PerpetualExchange.sol";
import "../src/CopyTracker.sol";
import "../src/AgentSessionManager.sol";
import "../src/TraderStake.sol";
import "../src/FeeRouter.sol";

interface ISettableExchange {
    function setExchange(address) external;
}

/// @notice Replace the live Base Sepolia PerpetualExchange because its funding
///         cadence is baked into the bytecode and is wrong.
///
///         The deployed exchange (2026-06-14) has `FUNDING_INTERVAL = 300`
///         — five minutes. With `MAX_FUNDING_RATE_BPS = 75` that is up to
///         0.75% × 288 ≈ 216% per DAY at full one-sided open interest. The
///         source has since been corrected to 8 hours (2.25%/day), but
///         `FUNDING_INTERVAL` is `constant`, so there is no setter and the fix
///         only reaches the chain through a redeploy.
///
///         This is not theoretical. Verified on chain 2026-08-06: position #0
///         holds $100 notional, is up 29% on price, and owes **$1,826.96** in
///         funding — enough to make a winning position liquidatable. Any agent
///         that holds a position for more than a day or two is killed by
///         funding rather than by the market.
///
///         What has to move and why:
///           - PerpetualExchange — the bad constant lives here
///           - CopyTracker       — its `exchange` is immutable
///           - AgentSessionManager — its `exchange` is immutable, so session
///                                   ids restart from 0 on the new instance
///         What does NOT have to move (both expose a setter):
///           - InsuranceVault.setExchange
///           - FeeRouter.setExchange
///
///         Everything else — MockUSDC, MockOracle, StrategyRegistry, KYCRegistry,
///         TraderStake — is untouched, so prices, KYC state and trader registry
///         all carry over.
///
/// @dev    ## PA-8 — what this script used to get wrong
///
///         **1. `traderStake.setCopyTracker` was missing.** TraderStake only
///         accepts `slash` from the address in its `copyTracker` slot, which
///         still pointed at the OLD tracker. The new CopyTracker could open and
///         close copied positions but could never slash a trader's stake — the
///         one mechanism that makes "skin in the game" more than a label — and
///         it would have failed silently, since nothing reads back that wiring.
///
///         **2. `feeRouter.setCopyTracker` was missing.** FeeRouter gates
///         `receivePerformanceFee` on the same slot, so every copy-trading close
///         that earned a performance fee would have reverted outright. Not
///         degraded: reverted. `RedeployCopyTracker.s.sol` already does all
///         three calls; this script did one of them.
///
///         **3. The docstring was the opposite of the truth.** It claimed the
///         old exchange "stays live" and "nothing is destroyed". But
///         `InsuranceVault.bailout` and `depositFromProtocol` both hard-require
///         `msg.sender == exchange`, and this script repoints that slot at the
///         new exchange. From that transaction onward:
///
///           - `closePosition` on the OLD exchange reverts `NotAuthorized`
///             whenever the close needs a bailout (loss exceeded margin) or
///             routes a vault fee share;
///           - `liquidatePosition` on the OLD exchange reverts the moment the
///             insurance backstop is touched;
///           - a solvent close with no vault interaction still works.
///
///         So the old venue is not "still functional". It is a venue where the
///         positions that most need to be closed are exactly the ones that can
///         no longer close. That is the reverse of a safe migration, and the
///         ordering guidance below exists because of it.
///
///         ## Required order of operations
///
///           1. Announce and stop new opens on the old exchange (front end).
///           2. Run this script with `DRY_RUN=true` and read the open-position
///              count. Do not proceed while it is non-zero.
///           3. Have users close, or liquidate what is liquidatable, until the
///              dry run reports 0 open positions.
///           4. Have users withdraw free margin from the old exchange.
///           5. Only then broadcast. Repointing the vault is the last, and the
///              irreversible-for-the-old-venue, step.
///
///         Run:
///           # step 2 — reads only, sends nothing
///           DRY_RUN=true forge script script/RedeployExchange.s.sol:RedeployExchange \
///             --rpc-url https://sepolia.base.org -vvv
///
///           # step 5 — the real thing
///           forge script script/RedeployExchange.s.sol:RedeployExchange \
///             --rpc-url https://sepolia.base.org --broadcast -vvv
contract RedeployExchange is Script {
    // ── Base Sepolia (84532) pieces that stay exactly where they are ─────────
    address constant USDC        = 0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035;
    address constant ORACLE      = 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3;
    address constant REGISTRY    = 0x54e8C43f9Eb151Bb8DD6e61d16a969C4D0e73915;
    address constant FEE_ROUTER  = 0x00f6cf0113399a7A451c7f85fe094a28092d3e0c;
    address constant INS_VAULT   = 0xB364E2e3e1e7a2b033eF03a4ACceF42066F3D812;
    address constant KYC         = 0x5D95fD9e7a5f80E5369e24783F1f98E0f952360d;
    address constant TRADER_STK  = 0x01aEB530bcFc69f036309ffe55acc7eA6C5a28Fe;
    address constant OLD_EXCHANGE = 0xEf75ECA6514cE96B18382E921aC6190a0cF8c072;

    // ── Config read off the live exchange on 2026-08-06 ──────────────────────
    // The replacement must be identical in every respect except the funding
    // cadence, otherwise this becomes a behaviour change wearing a bugfix's
    // clothes. Each value below was read with `cast call`, not assumed.
    uint256 constant MAX_PRICE_AGE = 21_600;   // 6h  (default in source is 24h)
    uint256 constant EXECUTION_FEE = 1e14;     // 0.0001 ETH
    bool    constant ADL_ENABLED   = true;
    // markPremiumCapBps = 0, vaultFeeShareBps = 0, portfolioMarginEnabled =
    // false, TRADING_FEE_BPS = 10, BORROW_FEE_BPS_PER_HOUR = 1 — all already the
    // constructor defaults, so they are deliberately not re-set here.
    // liquidationPenaltyBps also keeps its constructor default (2000 = 20%); it
    // is a new setter that the old deployment predates, so leaving it alone is
    // what "identical except the cadence" means.

    // Only these two are KYC-gated on the live exchange. The other equity
    // synthetics (sNVDA / sMSFT / sGOOGL) are NOT flagged there; that asymmetry
    // is reproduced rather than silently "fixed", because changing it here would
    // hide a policy decision inside a funding bugfix. Worth revisiting separately.
    bytes32 constant SBTC  = keccak256("sBTC");
    bytes32 constant SETH  = keccak256("sETH");
    bytes32 constant SAAPL = keccak256("sAAPL");
    bytes32 constant STSLA = keccak256("sTSLA");

    // Demo session mirrored from session #0 on the current manager.
    uint256 constant SESSION_MAX_PER_TRADE = 1_000e18;
    uint256 constant SESSION_BUDGET        = 3_000e18;
    uint256 constant SESSION_MAX_LEVERAGE  = 5;
    uint256 constant SESSION_EXPIRY        = 1_816_650_312; // 2027-07

    /// @dev Bound the scan so a large `nextPositionId` cannot make the dry run
    ///      time out against a public RPC. 49 positions existed on 2026-08-06.
    uint256 constant MAX_SCAN = 2_000;

    function run() external {
        bool dryRun = vm.envOr("DRY_RUN", false);

        // ── Pre-flight: how much is still live on the old venue? ─────────────
        (uint256 openCount, uint256 openMargin) = _survey();

        if (dryRun) {
            console.log("");
            console.log("DRY RUN - nothing was sent.");
            if (openCount > 0) {
                console.log("!!! %s position(s) are still OPEN on the old exchange.", openCount);
                console.log("!!! Repointing InsuranceVault.setExchange now would leave them in a");
                console.log("!!! venue whose bailout and vault-fee paths revert NotAuthorized.");
                console.log("!!! A losing position that needs the insurance floor could not be");
                console.log("!!! closed OR liquidated. Close/liquidate them first.");
            } else {
                console.log("0 open positions on the old exchange - safe to migrate.");
            }
            console.log("Re-run without DRY_RUN (and with --broadcast) to deploy.");
            openMargin; // surveyed for the log above
            return;
        }

        if (openCount > 0) {
            console.log("");
            console.log("!!! PROCEEDING WITH %s OPEN POSITION(S) ON THE OLD EXCHANGE.", openCount);
            console.log("!!! Those positions lose access to the insurance vault the moment");
            console.log("!!! setExchange lands below. This is a deliberate, logged choice.");
        }

        vm.startBroadcast();
        address deployer = msg.sender;

        // Guard: refuse to run against an exchange that does not have the bug,
        // so re-running this by mistake cannot silently fork the deployment.
        require(
            PerpetualExchange(OLD_EXCHANGE).FUNDING_INTERVAL() == 300,
            "old exchange already has the fixed cadence - nothing to migrate"
        );

        // ── 1. The exchange itself ───────────────────────────────────────────
        PerpetualExchange exchange = new PerpetualExchange(USDC, ORACLE);
        require(exchange.FUNDING_INTERVAL() == 8 hours, "new exchange still has the old cadence");

        exchange.setMaxPriceAge(MAX_PRICE_AGE);
        exchange.setExecutionFee(EXECUTION_FEE);
        exchange.setAdlEnabled(ADL_ENABLED);
        exchange.setKycRegistry(KYC);
        exchange.setFeeRouter(FEE_ROUTER);
        exchange.setInsuranceVault(INS_VAULT);
        exchange.setRwaAsset(SAAPL, true);
        exchange.setRwaAsset(STSLA, true);

        // ── 2. CopyTracker (its exchange is immutable) ───────────────────────
        CopyTracker copyTracker = new CopyTracker(
            USDC, address(exchange), REGISTRY, FEE_ROUTER, TRADER_STK
        );
        // setCopyTracker also flips authorizedAgents for it — see PerpetualExchange.
        exchange.setCopyTracker(address(copyTracker));

        // PA-8: the two calls that were missing. Without them the new tracker is
        // wired on the exchange only, and both of the paths that reach back out
        // of it are broken — silently for slashing, loudly for fees.
        TraderStake(TRADER_STK).setCopyTracker(address(copyTracker));
        FeeRouter(FEE_ROUTER).setCopyTracker(address(copyTracker));

        // ── 3. AgentSessionManager (its exchange is immutable) ───────────────
        AgentSessionManager sessionManager = new AgentSessionManager(address(exchange));
        exchange.setAgentAuthorized(address(sessionManager), true);

        // Demo session #0, asset-gated to the two assets that have a live feed
        // on this chain. Same shape as the session it replaces.
        bytes32[] memory allowed = new bytes32[](2);
        allowed[0] = SBTC;
        allowed[1] = SETH;
        uint256 sessionId = sessionManager.createSessionWithAssets(
            deployer,
            SESSION_MAX_PER_TRADE,
            SESSION_BUDGET,
            SESSION_MAX_LEVERAGE,
            SESSION_EXPIRY,
            allowed
        );

        // ── 4. Repoint the two peripherals that expose a setter ──────────────
        //      LAST, and irreversible for the old venue: see the PA-8 note above.
        ISettableExchange(INS_VAULT).setExchange(address(exchange));
        ISettableExchange(FEE_ROUTER).setExchange(address(exchange));

        vm.stopBroadcast();

        // ── 5. Read the wiring back rather than assuming it took ─────────────
        require(
            TraderStake(TRADER_STK).copyTracker() == address(copyTracker),
            "traderStake.copyTracker not repointed"
        );
        require(
            FeeRouter(FEE_ROUTER).copyTracker() == address(copyTracker),
            "feeRouter.copyTracker not repointed"
        );

        console.log("=== Base Sepolia exchange redeploy (funding cadence fix) ===");
        console.log("PerpetualExchange   :", address(exchange));
        console.log("CopyTracker         :", address(copyTracker));
        console.log("AgentSessionManager :", address(sessionManager));
        console.log("demo sessionId      :", sessionId);
        console.log("FUNDING_INTERVAL    :", exchange.FUNDING_INTERVAL(), "(was 300)");
        console.log("");
        console.log("Rewired to the new CopyTracker:");
        console.log("  exchange.copyTracker    :", exchange.copyTracker());
        console.log("  traderStake.copyTracker :", TraderStake(TRADER_STK).copyTracker());
        console.log("  feeRouter.copyTracker   :", FeeRouter(FEE_ROUTER).copyTracker());
        console.log("");
        console.log("OLD exchange at", OLD_EXCHANGE);
        console.log("It is NOT fully functional any more: InsuranceVault.exchange now points");
        console.log("at the new address, so on the old venue any close that needs a bailout,");
        console.log("and any liquidation that touches the insurance backstop, reverts");
        console.log("NotAuthorized. Only fully solvent closes still work there.");
        console.log("Migrate free margin with:");
        console.log("  cast send <OLD> 'withdrawMargin(uint256)' <amount> ...");
        console.log("  cast send <USDC> 'approve(address,uint256)' <NEW> <amount> ...");
        console.log("  cast send <NEW> 'depositMargin(uint256)' <amount> ...");
        console.log("");
        console.log("Also update: frontend/src/contracts/addresses.ts, agent/.env,");
        console.log("and revoke the old AgentSessionManager with setAgentAuthorized(old,false).");
    }

    /// @dev Counts positions still open on the old exchange. Pure reads, so it
    ///      runs identically in dry-run and in the real pass.
    function _survey() internal view returns (uint256 openCount, uint256 openMargin) {
        uint256 next = PerpetualExchange(OLD_EXCHANGE).nextPositionId();
        uint256 limit = next > MAX_SCAN ? MAX_SCAN : next;

        console.log("=== old exchange survey ===");
        console.log("address        :", OLD_EXCHANGE);
        console.log("nextPositionId :", next);
        if (next > limit) {
            console.log("scanning first :", limit, "(MAX_SCAN)");
        }

        for (uint256 i = 0; i < limit; i++) {
            PerpetualExchange.Position memory p = PerpetualExchange(OLD_EXCHANGE).getPosition(i);
            if (!p.isOpen) continue;
            openCount++;
            openMargin += p.margin;
            console.log("  OPEN id", i, "owner", p.owner);
        }
        console.log("open positions :", openCount);
        console.log("margin at risk :", openMargin / 1e18, "USDC");
    }
}
