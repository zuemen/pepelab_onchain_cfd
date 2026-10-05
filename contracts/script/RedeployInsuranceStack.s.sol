// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../src/InsuranceVault.sol";
import "../src/FeeRouter.sol";
import "../src/CopyTracker.sol";
import "../src/PerpetualExchange.sol";
import "../src/TraderStake.sol";
import "../src/StrategyRegistry.sol";

/// @title  RedeployInsuranceStack — new InsuranceVault + platform FeeRouter + CopyTracker, as one batch
/// @notice OWNER_ACTIONS.md step 5 item 4, specified in INSURANCE_VAULT_SHARES.md §5.1–§5.3.
///
///         WHY THE THREE MOVE TOGETHER
///         FeeRouter.insuranceVault and FeeRouter.platformTreasury are immutable,
///         and CopyTracker.feeRouter is immutable. The live platform FeeRouter's
///         treasury is the leaked deployer 0xE80A…Eb93 — no setter exists, so the
///         only fix is a new router, which forces a new CopyTracker; and the new
///         virtual-share vault can only be adopted by a router built against it.
///         Swapping any one of them alone means redeploying the others again later.
///
///         WHY ONE BROADCAST BLOCK (AND WHY IT ONLY NARROWS THE WINDOW)
///         Between seeding the vault and handing it to the timelock, the deployer
///         owns a funded vault. A leaked deployer key in that window could
///         `setExchange(self)` and `bailout` the seed out (§5.3). So deploy → seed →
///         wire → transferOwnership all run inside one forge broadcast block. That
///         is still several separate transactions: `--slow` sends them one after
///         another, each waiting for the previous receipt, so the window between
///         the seed deposit and the vault's transferOwnership shrinks to a few
///         blocks — it is narrowed, not eliminated. The read-back at the end runs
///         against forge's simulated state, before anything is sent — only a later
///         VERIFY_ONLY run proves the real chain.
///
///         WHY SEED BEFORE WIRING
///         FeeRouter.routeExternalRevenue is permissionless. Once the vault has a
///         fee router, anyone can push assets into it. Assets that arrive while
///         totalSupply == 0 accrue to the virtual shares permanently (§3.3). So the
///         seed goes in while feeRouter and exchange are both still zero, and the
///         script refuses to seed a vault that already has an inflow source.
///
///         PRECONDITION: EXCHANGE MUST BE THE POST-#130 EXCHANGE
///         The migration window that follows (§5.3 step 5) uses setAssetMode /
///         marketOperator, which the exchange live at 0x827e… does not have. The
///         preflight probes `marketOperator()` and refuses an exchange without it,
///         instead of deploying a stack that can never be cut over safely.
///
///         TRADER_STAKE IS REQUIRED AND CROSS-CHECKED
///         CopyTracker.registry and CopyTracker.traderStake are immutable. If #130
///         ran with DEPLOY_NEW_TRADER_STAKE=true, the old TraderStake is no longer
///         the one the registry gates on; a default would silently bind the new
///         CopyTracker to it forever. So there is no default, the registry's
///         stakeContract() must equal TRADER_STAKE, and the exchange's current
///         CopyTracker (when set) must point at the same registry and stake.
///
///         WHAT THIS DOES NOT DO
///         It does not touch the exchange or TraderStake. Repointing them is a
///         timelock matter (48h); the exact scheduleBatch / executeBatch calldata
///         is printed at the end — one batch, so exchange.copyTracker and
///         TraderStake.copyTracker can never disagree. Do NOT set
///         the old vault's `exchange` to zero afterwards — positions still open on
///         the old exchange would revert at liquidation (§5.3 step 6).
///
///   Env:
///     EXCHANGE            (required) the post-#130 PerpetualExchange
///     STRATEGY_REGISTRY   (required) the post-#130 StrategyRegistry
///     TREASURY            (required) platform revenue address. Not zero, not a
///                         known-compromised address, not EIP-7702 delegated.
///                         A Safe is fine — unlike x402's payTo it need not be an EOA.
///                         Not a protocol contract either (USDC, exchange, …):
///                         the router's treasury is immutable, fees sent there stay.
///     TIMELOCK            (required unless KEEP_DEPLOYER_OWNER=true) a
///                         TimelockController with minDelay >= MIN_TIMELOCK_DELAY
///                         that already owns EXCHANGE — i.e. HandoverToTimelock
///                         phase 1 has run. That is what proves it is the real
///                         governance timelock (its proposer/executor were
///                         cross-checked there), not a typo or a role-less one
///                         that would brick the new contracts forever.
///     KEEP_DEPLOYER_OWNER default false. Leaves vault + router + CopyTracker owned by the
///                         deployer. Only for a chain where governance is not live
///                         yet; it reopens the §5.3 key-exposure window, and the
///                         script says so loudly.
///     USDC                default Base Sepolia MockUSDC
///     TRADER_STAKE        (required) the TraderStake STRATEGY_REGISTRY gates on —
///                         the new one if #130 ran with DEPLOY_NEW_TRADER_STAKE=true.
///                         Must equal registry.stakeContract(); there is no default.
///     SEED_AMOUNT         default exactly 1 whole token (10**decimals); smaller is refused
///     MIN_TIMELOCK_DELAY  default 24h, same floor as HandoverToTimelock
///     RESUME_VAULT / RESUME_FEE_ROUTER / RESUME_COPY_TRACKER
///                         continue an interrupted run instead of starting over.
///                         Every immutable is checked against this config first.
///                         Whether the vault still needs seeding is decided by what
///                         the DEPLOYER's shares redeem for, not by totalSupply:
///                         anyone can deposit, so a stranger's 1-wei deposit must
///                         not count as the platform seed.
///     VERIFY_ONLY         true = no broadcast; re-run the address checks, read back
///                         the three RESUME_* addresses against the config and exit
///                         non-zero on any mismatch. Set BROADCASTER to the address
///                         that seeded — the seed position is read back too.
///                         Run this against the real chain after broadcasting.
///
///   Seed shares stay with the deployer. If that key ever leaks, the seed can be
///   withdrawn and the §3.3 zero-supply trap reopens — moving the shares to the
///   treasury is an owner decision this script does not make.
///
///   Fork simulation (no key, sends nothing):
///     forge script script/RedeployInsuranceStack.s.sol:RedeployInsuranceStack \
///       --fork-url https://sepolia.base.org --sender $DEPLOYER
///   Broadcast:
///     forge script script/RedeployInsuranceStack.s.sol:RedeployInsuranceStack \
///       --rpc-url https://sepolia.base.org --account $ACCOUNT --sender $DEPLOYER --broadcast --slow
contract RedeployInsuranceStack is Script {
    // Base Sepolia — same values as Redeploy102Exchange / HandoverToTimelock.
    address internal constant DEFAULT_USDC         = 0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035;

    /// Mirrors agent/shared/src/payoutSafety.ts COMPROMISED_ADDRESSES.
    address internal constant LEAKED_DEPLOYER = 0xE80A81360608C1342e66743F70a00f75d792Eb93;

    struct Config {
        address deployer;
        address usdc;
        address exchange;
        address registry;
        address traderStake;
        address treasury;
        address timelock;
        bool    keepDeployerOwner;
        uint256 minTimelockDelay;
        uint256 seedAmount;
        address resumeVault;
        address resumeRouter;
        address resumeCopyTracker;
        bool    verifyOnly;
    }

    struct Deployed {
        address vault;
        address router;
        address copyTracker;
    }

    function run() external {
        Config memory cfg = _configFromEnv();
        if (cfg.verifyOnly) {
            Deployed memory d = Deployed(cfg.resumeVault, cfg.resumeRouter, cfg.resumeCopyTracker);
            require(d.vault != address(0) && d.router != address(0) && d.copyTracker != address(0),
                "VERIFY_ONLY needs RESUME_VAULT, RESUME_FEE_ROUTER and RESUME_COPY_TRACKER");
            _checkAddresses(cfg);
            verify(cfg, d);
            console.log("VERIFY_ONLY: all read-backs match.");
            return;
        }
        runWith(cfg);
    }

    /// @notice Whole procedure for an explicit config. `run()` builds the config
    ///         from the environment; tests call this directly so no env leaks
    ///         between cases.
    function runWith(Config memory cfg) public returns (Deployed memory d) {
        preflight(cfg);
        d = _execute(cfg);
        verify(cfg, d);
        _printFollowUp(cfg, d);
    }

    // ── Config ───────────────────────────────────────────────────────────────

    function _configFromEnv() internal view returns (Config memory c) {
        c.deployer          = vm.envOr("BROADCASTER", msg.sender);
        c.usdc              = vm.envOr("USDC", DEFAULT_USDC);
        c.exchange          = vm.envAddress("EXCHANGE");
        c.registry          = vm.envAddress("STRATEGY_REGISTRY");
        c.traderStake       = vm.envAddress("TRADER_STAKE");
        c.treasury          = vm.envOr("TREASURY", address(0));
        c.timelock          = vm.envOr("TIMELOCK", address(0));
        c.keepDeployerOwner = vm.envOr("KEEP_DEPLOYER_OWNER", false);
        c.minTimelockDelay  = vm.envOr("MIN_TIMELOCK_DELAY", uint256(24 hours));
        c.seedAmount        = vm.envOr("SEED_AMOUNT", uint256(0));
        c.resumeVault       = vm.envOr("RESUME_VAULT", address(0));
        c.resumeRouter      = vm.envOr("RESUME_FEE_ROUTER", address(0));
        c.resumeCopyTracker = vm.envOr("RESUME_COPY_TRACKER", address(0));
        c.verifyOnly        = vm.envOr("VERIFY_ONLY", false);
    }

    // ── Preflight: refuse everything we can refuse before spending gas ───────

    function preflight(Config memory cfg) public view {
        _checkAddresses(cfg);

        uint256 unit = 10 ** _decimals(cfg.usdc);
        if (cfg.seedAmount == 0) cfg.seedAmount = unit;
        require(cfg.seedAmount >= unit, "SEED_AMOUNT below one whole token (INSURANCE_VAULT_SHARES.md 5.2)");

        _preflightResume(cfg);

        bool needsSeed = cfg.resumeVault == address(0) || !_deployerSeeded(cfg, InsuranceVault(cfg.resumeVault));
        if (needsSeed) {
            if (cfg.resumeVault != address(0)) _requireSeedable(InsuranceVault(cfg.resumeVault));
            require(IERC20(cfg.usdc).balanceOf(cfg.deployer) >= cfg.seedAmount,
                "deployer holds less USDC than SEED_AMOUNT - seed must be NEW funds, not withdrawn from the old vault");
        }
    }

    /// Everything about the inputs that does not depend on a run being in
    /// progress. VERIFY_ONLY runs this too, so a read-back against the real
    /// chain re-checks the treasury instead of trusting the earlier run.
    function _checkAddresses(Config memory cfg) internal view {
        require(cfg.usdc.code.length > 0, "USDC has no code");
        require(cfg.registry.code.length > 0, "STRATEGY_REGISTRY has no code");
        require(cfg.traderStake.code.length > 0, "TRADER_STAKE has no code");
        require(cfg.exchange.code.length > 0, "EXCHANGE has no code");

        // Post-#130 probe. The §5.3 migration window needs marketOperator /
        // setAssetMode; the pre-#130 exchange has neither.
        (bool ok, bytes memory ret) = cfg.exchange.staticcall(abi.encodeWithSignature("marketOperator()"));
        require(ok && ret.length == 32,
            "EXCHANGE predates #130 (no marketOperator) - run Redeploy130Hardened first, INSURANCE_VAULT_SHARES.md 5.3");
        require(address(PerpetualExchange(cfg.exchange).usdc()) == cfg.usdc, "EXCHANGE settles in a different USDC");

        // CopyTracker.registry / .traderStake are immutable: the pair must be the
        // one the post-#130 stack actually uses, not a stale default.
        require(address(StrategyRegistry(cfg.registry).stakeContract()) == cfg.traderStake,
            "TRADER_STAKE is not STRATEGY_REGISTRY.stakeContract() - the new CopyTracker would bind the wrong stake forever");
        _checkLiveCopyTracker(cfg);

        // Treasury — the whole reason this batch exists is a bad treasury.
        require(cfg.treasury != address(0), "TREASURY is required and must not be zero");
        require(!_isCompromised(cfg.treasury), "TREASURY is a known-compromised address");
        require(!_is7702Delegated(cfg.treasury), "TREASURY is EIP-7702 delegated - treated as taken over");
        require(cfg.treasury != cfg.usdc && cfg.treasury != cfg.exchange && cfg.treasury != cfg.registry
                && cfg.treasury != cfg.traderStake && cfg.treasury != cfg.timelock
                && cfg.treasury != cfg.resumeVault && cfg.treasury != cfg.resumeRouter
                && cfg.treasury != cfg.resumeCopyTracker,
            "TREASURY is a protocol contract - the router's treasury is immutable, fees would be stuck");

        // Deployer — it holds the seed and owns everything until the handover.
        require(cfg.deployer != address(0), "BROADCASTER is zero");
        require(!_isCompromised(cfg.deployer), "deployer is a known-compromised address");
        require(!_is7702Delegated(cfg.deployer), "deployer is EIP-7702 delegated - a sweeper would take the seed");

        if (cfg.keepDeployerOwner) {
            require(cfg.timelock == address(0), "set TIMELOCK or KEEP_DEPLOYER_OWNER, not both");
        } else {
            require(cfg.timelock != address(0),
                "TIMELOCK is required (or KEEP_DEPLOYER_OWNER=true where governance is not live)");
            require(cfg.timelock.code.length > 0, "TIMELOCK has no code");
            uint256 delay;
            try TimelockController(payable(cfg.timelock)).getMinDelay() returns (uint256 d) { delay = d; }
            catch { revert("TIMELOCK is not a TimelockController"); }
            require(delay >= cfg.minTimelockDelay, "timelock minDelay below MIN_TIMELOCK_DELAY");
            // Ownership moved here is final (one-step Ownable, immutables
            // everywhere). Only accept the timelock that already governs the
            // exchange: HandoverToTimelock cross-checked its proposer/executor.
            require(PerpetualExchange(cfg.exchange).owner() == cfg.timelock,
                "EXCHANGE is not owned by TIMELOCK - run HandoverToTimelock phase 1 first; a wrong or role-less timelock would brick the stack");
            TimelockController tl = TimelockController(payable(cfg.timelock));
            require(!tl.hasRole(tl.PROPOSER_ROLE(), cfg.deployer), "deployer is a timelock proposer - no real delay");
            require(!tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), cfg.deployer), "deployer administers the timelock - no real delay");
        }
    }

    /// The exchange's current CopyTracker must already use the same registry and
    /// stake as this config — otherwise the inputs are not the post-#130 pair.
    /// Skipped when the exchange has no CopyTracker yet (nothing to compare).
    /// After the cutover this is the new CopyTracker, which passes by construction.
    function _checkLiveCopyTracker(Config memory cfg) internal view {
        address live = PerpetualExchange(cfg.exchange).copyTracker();
        if (live == address(0)) return;
        (bool okR, bytes memory r) = live.staticcall(abi.encodeWithSignature("registry()"));
        (bool okS, bytes memory st) = live.staticcall(abi.encodeWithSignature("traderStake()"));
        require(okR && okS && r.length == 32 && st.length == 32,
            "EXCHANGE.copyTracker() has no registry()/traderStake() - cannot cross-check STRATEGY_REGISTRY / TRADER_STAKE");
        require(abi.decode(r, (address)) == cfg.registry,
            "STRATEGY_REGISTRY differs from the exchange's current CopyTracker.registry()");
        require(abi.decode(st, (address)) == cfg.traderStake,
            "TRADER_STAKE differs from the exchange's current CopyTracker.traderStake()");
    }

    /// Every immutable of a resumed contract is checked against this config.
    /// Resuming onto a contract built from different inputs would silently
    /// produce a stack wired to the wrong thing, and immutables cannot be fixed.
    function _preflightResume(Config memory cfg) internal view {
        if (cfg.resumeVault != address(0)) {
            require(cfg.resumeVault.code.length > 0, "RESUME_VAULT has no code");
            // The getters below would also pass on an old pre-virtual-share vault
            // or on the vault being replaced, so probe for the new one directly.
            (bool ok, bytes memory ret) =
                cfg.resumeVault.staticcall(abi.encodeWithSignature("DECIMALS_OFFSET()"));
            require(ok && ret.length == 32 && abi.decode(ret, (uint8)) == 6,
                "RESUME_VAULT is not a virtual-share InsuranceVault (no DECIMALS_OFFSET 6)");
            require(cfg.resumeVault != address(PerpetualExchange(cfg.exchange).insuranceVault()),
                "RESUME_VAULT is the exchange's current vault - the one this batch replaces");
            require(address(InsuranceVault(cfg.resumeVault).usdc()) == cfg.usdc, "RESUME_VAULT: different USDC");
        }
        if (cfg.resumeRouter != address(0)) {
            require(cfg.resumeVault != address(0), "RESUME_FEE_ROUTER needs RESUME_VAULT - its insuranceVault is immutable");
            FeeRouter r = FeeRouter(cfg.resumeRouter);
            require(cfg.resumeRouter.code.length > 0, "RESUME_FEE_ROUTER has no code");
            require(address(r.insuranceVault()) == cfg.resumeVault, "RESUME_FEE_ROUTER: built for a different vault");
            require(r.platformTreasury() == cfg.treasury, "RESUME_FEE_ROUTER: different TREASURY");
            require(address(r.usdc()) == cfg.usdc, "RESUME_FEE_ROUTER: different USDC");
        }
        if (cfg.resumeCopyTracker != address(0)) {
            require(cfg.resumeRouter != address(0), "RESUME_COPY_TRACKER needs RESUME_FEE_ROUTER - its feeRouter is immutable");
            CopyTracker ct = CopyTracker(cfg.resumeCopyTracker);
            require(cfg.resumeCopyTracker.code.length > 0, "RESUME_COPY_TRACKER has no code");
            require(address(ct.feeRouter()) == cfg.resumeRouter, "RESUME_COPY_TRACKER: different fee router");
            require(address(ct.exchange()) == cfg.exchange, "RESUME_COPY_TRACKER: different exchange");
            require(address(ct.registry()) == cfg.registry, "RESUME_COPY_TRACKER: different registry");
            require(address(ct.traderStake()) == cfg.traderStake, "RESUME_COPY_TRACKER: different trader stake");
            require(address(ct.usdc()) == cfg.usdc, "RESUME_COPY_TRACKER: different USDC");
        }
    }

    // ── Execute: one broadcast ───────────────────────────────────────────────

    function _execute(Config memory cfg) internal returns (Deployed memory d) {
        uint256 seed = _seed(cfg);

        vm.startBroadcast(cfg.deployer);

        // 1. Vault — feeRouter and exchange start at zero: no inflow source yet.
        InsuranceVault vault = cfg.resumeVault != address(0)
            ? InsuranceVault(cfg.resumeVault)
            : new InsuranceVault(cfg.usdc);

        // 2. Seed, only while nothing can flow in. "Already seeded" means the
        //    deployer's own position, not totalSupply — deposit is open to anyone.
        if (!_deployerSeeded(cfg, vault)) {
            _requireSeedable(vault);
            IERC20(cfg.usdc).approve(address(vault), seed);
            vault.deposit(seed);
            require(_deployerSeeded(cfg, vault), "seed deposit did not give the deployer a seed-sized position");
        }

        // 3. Router — treasury and vault are immutable from here on.
        FeeRouter router = cfg.resumeRouter != address(0)
            ? FeeRouter(cfg.resumeRouter)
            : new FeeRouter(cfg.usdc, cfg.treasury, address(vault));

        // 4. CopyTracker — feeRouter is immutable from here on.
        CopyTracker ct = cfg.resumeCopyTracker != address(0)
            ? CopyTracker(cfg.resumeCopyTracker)
            : new CopyTracker(cfg.usdc, cfg.exchange, cfg.registry, address(router), cfg.traderStake);

        // 5. Wire — only what the deployer still owns, only what differs.
        if (vault.owner() == cfg.deployer) {
            if (vault.feeRouter() != address(router)) vault.setFeeRouter(address(router));
            if (vault.exchange() != cfg.exchange) vault.setExchange(cfg.exchange);
        }
        if (router.owner() == cfg.deployer) {
            if (router.exchange() != cfg.exchange) router.setExchange(cfg.exchange);
            if (router.copyTracker() != address(ct)) router.setCopyTracker(address(ct));
        }

        // 6. Hand over inside the same broadcast block — narrows (does not
        //    eliminate) the §5.3 window: these are still separate transactions.
        if (!cfg.keepDeployerOwner) {
            if (vault.owner() == cfg.deployer) vault.transferOwnership(cfg.timelock);
            if (router.owner() == cfg.deployer) router.transferOwnership(cfg.timelock);
            // withdrawSlashReserve is owner-only: left with the deployer, that key
            // would control every slashed trader stake.
            if (ct.owner() == cfg.deployer) ct.transferOwnership(cfg.timelock);
        }

        vm.stopBroadcast();

        d = Deployed(address(vault), address(router), address(ct));
    }

    // ── Verify: read everything back, revert on any mismatch ────────────────

    function verify(Config memory cfg, Deployed memory d) public view {
        address expectedOwner = cfg.keepDeployerOwner ? cfg.deployer : cfg.timelock;
        InsuranceVault vault = InsuranceVault(d.vault);
        FeeRouter router = FeeRouter(d.router);
        CopyTracker ct = CopyTracker(d.copyTracker);

        require(vault.owner() == expectedOwner, "readback: vault.owner()");
        require(vault.exchange() == cfg.exchange, "readback: vault.exchange()");
        require(vault.feeRouter() == d.router, "readback: vault.feeRouter()");
        require(address(vault.usdc()) == cfg.usdc, "readback: vault.usdc()");
        require(vault.totalSupply() > 0, "readback: vault.totalSupply() is zero");
        require(_deployerSeeded(cfg, vault), "readback: deployer's seed position below SEED_AMOUNT");
        require(vault.totalAssets() >= _seed(cfg), "readback: vault.totalAssets() below SEED_AMOUNT");

        require(router.owner() == expectedOwner, "readback: router.owner()");
        require(router.platformTreasury() == cfg.treasury, "readback: router.platformTreasury()");
        require(!_isCompromised(router.platformTreasury()), "readback: platformTreasury is compromised");
        require(address(router.insuranceVault()) == d.vault, "readback: router.insuranceVault()");
        require(router.exchange() == cfg.exchange, "readback: router.exchange()");
        require(router.copyTracker() == d.copyTracker, "readback: router.copyTracker()");
        require(address(router.usdc()) == cfg.usdc, "readback: router.usdc()");

        require(address(ct.feeRouter()) == d.router, "readback: copyTracker.feeRouter()");
        require(address(ct.exchange()) == cfg.exchange, "readback: copyTracker.exchange()");
        require(address(ct.registry()) == cfg.registry, "readback: copyTracker.registry()");
        require(address(ct.traderStake()) == cfg.traderStake, "readback: copyTracker.traderStake()");
        require(address(ct.usdc()) == cfg.usdc, "readback: copyTracker.usdc()");
        require(ct.owner() == expectedOwner, "readback: copyTracker.owner()");

        require(cfg.treasury != d.vault && cfg.treasury != d.router && cfg.treasury != d.copyTracker,
            "readback: platformTreasury is one of the new contracts");
    }

    // ── Output ───────────────────────────────────────────────────────────────

    function _printFollowUp(Config memory cfg, Deployed memory d) internal view {
        console.log("=== RedeployInsuranceStack: done, read-back passed ===");
        console.log("InsuranceVault_NEW :", d.vault);
        console.log("FeeRouter_NEW      :", d.router);
        console.log("CopyTracker_NEW    :", d.copyTracker);
        console.log("platformTreasury   :", cfg.treasury);
        console.log("vault totalSupply  :", InsuranceVault(d.vault).totalSupply());

        if (cfg.keepDeployerOwner) {
            console.log("");
            console.log("!!! KEEP_DEPLOYER_OWNER: vault, router and CopyTracker are still owned by", cfg.deployer);
            console.log("!!! A leaked deployer key can setExchange(self) and bailout the seed until");
            console.log("!!! ownership moves to a timelock. Hand over as soon as governance is live.");
        }

        _printBatch(cfg, d);

        console.log("");
        console.log("Migration window when the schedule matures (INSURANCE_VAULT_SHARES.md 5.3 step 5):");
        console.log("  1. marketOperator/guardian: every asset -> ReduceOnly");
        console.log("  2. executeBatch with the exact calldata above (same targets/values/payloads/salt)");
        console.log("  3. move protocol-owned vault positions IMMEDIATELY after step 2");
        console.log("  4. back to Active once the new vault covers the OI caps");
        console.log("Do NOT set the old vault's exchange to zero - open positions there would revert at liquidation.");
        console.log("Next: update addresses.ts + abi/InsuranceVault.json + ops/monitoring/deployed.json (5.4),");
        console.log("      then re-run with VERIFY_ONLY=true and RESUME_* against the real chain.");
    }

    /// @notice The four follow-up calls as ONE timelock batch. Scheduling them
    ///         separately lets exchange.copyTracker and TraderStake.copyTracker
    ///         disagree (one executes without the other); a batch is all-or-nothing.
    ///         The salt is reproducible from the script name and the new
    ///         CopyTracker, so a re-run prints the same operation id.
    function followUpBatch(Config memory cfg, Deployed memory d)
        public
        view
        returns (
            address[] memory targets,
            uint256[] memory values,
            bytes[] memory payloads,
            bytes32 predecessor,
            bytes32 salt,
            uint256 delay
        )
    {
        targets = new address[](4);
        values = new uint256[](4);
        payloads = new bytes[](4);
        targets[0] = cfg.exchange;
        payloads[0] = abi.encodeCall(PerpetualExchange.setInsuranceVault, (d.vault));
        targets[1] = cfg.exchange;
        payloads[1] = abi.encodeCall(PerpetualExchange.setFeeRouter, (d.router));
        targets[2] = cfg.exchange;
        payloads[2] = abi.encodeCall(PerpetualExchange.setCopyTracker, (d.copyTracker));
        targets[3] = cfg.traderStake;
        payloads[3] = abi.encodeCall(TraderStake.setCopyTracker, (d.copyTracker));
        predecessor = bytes32(0);
        salt = keccak256(abi.encodePacked("RedeployInsuranceStack", d.copyTracker));
        delay = cfg.timelock == address(0) ? 0 : TimelockController(payable(cfg.timelock)).getMinDelay();
    }

    function _printBatch(Config memory cfg, Deployed memory d) internal view {
        (address[] memory targets, uint256[] memory values, bytes[] memory payloads,
         bytes32 predecessor, bytes32 salt, uint256 delay) = followUpBatch(cfg, d);
        string[4] memory labels = [
            "PerpetualExchange.setInsuranceVault",
            "PerpetualExchange.setFeeRouter",
            "PerpetualExchange.setCopyTracker (authorizes new, de-authorizes old)",
            "TraderStake.setCopyTracker"
        ];

        console.log("");
        console.log("=== Follow-up: ONE timelock batch (all four calls, all-or-nothing) ===");
        console.log("Schedule AND execute these four together via scheduleBatch / executeBatch.");
        console.log("Never schedule them one by one: exchange.copyTracker and TraderStake.copyTracker");
        console.log("must switch in the same transaction, or copy trades and slashing disagree.");
        for (uint256 i = 0; i < 4; i++) {
            console.log(string.concat("- [", vm.toString(i), "] ", labels[i]));
            console.log("  target:", targets[i]);
            console.log("  value :", values[i]);
            console.log("  payload:");
            console.logBytes(payloads[i]);
        }
        console.log("predecessor:");
        console.logBytes32(predecessor);
        console.log("salt = keccak256(abi.encodePacked(\"RedeployInsuranceStack\", CopyTracker_NEW)):");
        console.logBytes32(salt);

        if (cfg.timelock == address(0)) {
            console.log("No TIMELOCK (KEEP_DEPLOYER_OWNER): there is no atomic batch. Send the four payloads");
            console.log("above from the owner back to back, and finish all four before anything else.");
            return;
        }

        TimelockController tl = TimelockController(payable(cfg.timelock));
        console.log("timelock:", cfg.timelock);
        console.log("delay = timelock.getMinDelay():", delay);
        console.log("operation id (hashOperationBatch):");
        console.logBytes32(tl.hashOperationBatch(targets, values, payloads, predecessor, salt));
        console.log("scheduleBatch calldata (to the timelock, from a PROPOSER):");
        console.logBytes(abi.encodeCall(TimelockController.scheduleBatch,
            (targets, values, payloads, predecessor, salt, delay)));
        console.log("executeBatch calldata (to the timelock, from an EXECUTOR, after the delay, value 0):");
        console.logBytes(abi.encodeCall(TimelockController.executeBatch,
            (targets, values, payloads, predecessor, salt)));

        if (Ownable(cfg.traderStake).owner() != cfg.timelock) {
            console.log("!!! TraderStake is not owned by TIMELOCK - executeBatch would revert as a whole.");
            console.log("!!! Hand TraderStake to the timelock before scheduling.");
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _seed(Config memory cfg) internal view returns (uint256) {
        return cfg.seedAmount == 0 ? 10 ** _decimals(cfg.usdc) : cfg.seedAmount;
    }

    /// What the deployer's shares redeem for, against SEED_AMOUNT with 0.1%
    /// allowance for share-math rounding. A stranger's dust deposit, or a vault
    /// drained by bailout, does not pass.
    function _deployerSeeded(Config memory cfg, InsuranceVault v) internal view returns (bool) {
        uint256 seed = _seed(cfg);
        return v.previewWithdraw(v.balanceOf(cfg.deployer)) >= seed - seed / 1000;
    }

    /// §3.3: at zero supply, anything already in the vault — or anything that
    /// can still flow in — belongs to the virtual shares permanently.
    function _requireSeedable(InsuranceVault v) internal view {
        if (v.totalSupply() != 0) return;
        require(v.feeRouter() == address(0) && v.exchange() == address(0),
            "vault has zero supply but an inflow source is wired - inflows would accrue to virtual shares forever");
        require(v.totalAssets() == 0,
            "vault has zero supply but holds assets - they already belong to the virtual shares; deploy a fresh vault");
    }

    function _isCompromised(address a) internal pure returns (bool) {
        return a == LEAKED_DEPLOYER;
    }

    /// 0xef0100 ‖ delegate(20) — same rule as payoutSafety.ts: a delegated EOA is
    /// treated as taken over, because on this testnet that is what it has meant.
    function _is7702Delegated(address a) internal view returns (bool) {
        bytes memory c = a.code;
        return c.length == 23 && c[0] == 0xef && c[1] == 0x01 && c[2] == 0x00;
    }

    function _decimals(address token) internal view returns (uint8) {
        try IERC20Metadata(token).decimals() returns (uint8 d) { return d; } catch { return 18; }
    }
}
