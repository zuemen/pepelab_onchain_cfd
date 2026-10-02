// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/v2/GuardedOracle.sol";

interface IVaultOracleRepoint {
    function oracle() external view returns (address);
    function setOracle(address newOracle) external;
    function hasRole(bytes32 role, address account) external view returns (bool);
    function maxPriceAge() external view returns (uint256);
    function outstandingValueDetailed() external view returns (uint256 total, uint256 unpriced);
    function version() external view returns (string memory);
}

interface IExchangeOracleRead {
    function oracle() external view returns (address);
}

/// @notice GuardedOracle is not upgradeable, so the rate limit (cumulative
///         move per window) and the bounded guardian halts (a guardian freeze
///         or pause lapses after 72h and is followed by a 24h cooldown; only
///         the admin holds a halt with no expiry) land by deploying a new
///         instance and re-pointing the V2 vault at it (`setOracle`,
///         DEFAULT_ADMIN_ROLE).
///
///         Copies from the live oracle: every asset's CURRENT price (refused
///         unless younger than min(vault.maxPriceAge, 6h) — `addAsset`
///         stamps `updatedAt = now`, so copying a stale price would launder it
///         into a fresh one), maxDeviationBps, referenceSource.
///
///         maxPriceAge is NOT copied: the live oracle runs 30 days, which lets
///         a price as old as a lapsed 72h guardian freeze count as valid at
///         this layer. The new oracle gets ORACLE_MAX_PRICE_AGE (default
///         21600 = 6h, the exchange's and the V2.5 vault's limit), bounded to
///         1h..30d so it can be neither "off" (0) nor shorter than the keeper's
///         heartbeat. Every copied price must also be younger than it, so no
///         asset is already expired -- and every read reverting -- the moment
///         the vault is re-pointed.
///         Then: window limit (REQUIRED non-zero), KEEPER_ROLE → keeper,
///         GUARDIAN_ROLE → GUARDIAN (and the deployer's constructor-granted
///         guardian role is renounced when they differ), vault.setOracle.
///         DEFAULT_ADMIN stays with the deployer — hand it to the timelock with
///         `HandoverToTimelock` (GUARDED_ORACLE=<new>).
///
///         Halts are NOT copied: the preflight refuses to run while the old
///         oracle is paused or has an asset frozen, and the new instance
///         starts with none. GUARDIAN should not also hold DEFAULT_ADMIN_ROLE
///         on the new oracle — an account with both is treated as the admin,
///         so its halts would never lapse. The script warns when
///         GUARDIAN == broadcaster.
///
///         NOT re-pointable: a PerpetualExchange deployed with
///         ORACLE_KIND=guarded holds the oracle immutable. If EXCHANGE_NEW is
///         given and reads the old oracle, the script says so — the keeper then
///         has to feed both oracles until that exchange is redeployed.
///
///         Env: GUARDIAN (required), KEEPER [0x540a…ef17], WINDOW_SECONDS [3600],
///              WINDOW_DEVIATION_BPS [2500], ORACLE_MAX_PRICE_AGE [21600, 3600..2592000],
///              VAULT_PROXY [0x916D…], OLD_GUARDED_ORACLE [0x8E9e…], EXCHANGE_NEW [optional]
///
///           forge script script/RedeployGuardedOracle.s.sol:RedeployGuardedOracle \
///             --fork-url https://sepolia.base.org --sender 0x27C2…A585 -vv    # simulate
contract RedeployGuardedOracle is Script {
    address internal constant BASE_VAULT      = 0x916D7Fc399d9afd23BAa113E2c2Cc601341ff10a;
    address internal constant BASE_OLD_ORACLE = 0x8E9e59BE9589Ad88EC14F3ef6bdcc43E8B76f842;
    address internal constant KEEPER          = 0x540aECD37E7A7885824e7b7e996eBddfb842ef17;

    address public broadcasterOverride;   // test hook, see Redeploy130Hardened
    function setBroadcasterOverride(address a) external { broadcasterOverride = a; }

    /// @notice Everything `run()` would otherwise read from the environment.
    struct Params {
        address guardian;
        address keeper;
        uint256 windowSeconds;
        uint256 windowDeviationBps;
        uint256 maxPriceAge;
        address vault;
        address oldOracle;
        address exchangeNew;   // 0 = not given
    }

    /// @dev Test hook: when set, `run()` reads NO environment variable. Fork
    ///      tests use it because `vm.setEnv` is process-wide: tests running in
    ///      parallel, or one after another, would otherwise read each other's
    ///      GUARDIAN / EXCHANGE_NEW.
    Params internal _params;
    bool internal _hasParams;
    function setParams(Params calldata p) external { _params = p; _hasParams = true; }

    function _config() internal view returns (Params memory c) {
        if (_hasParams) return _params;
        c.guardian = vm.envOr("GUARDIAN", address(0));
        c.keeper = vm.envOr("KEEPER", KEEPER);
        c.windowSeconds = vm.envOr("WINDOW_SECONDS", uint256(1 hours));
        c.windowDeviationBps = vm.envOr("WINDOW_DEVIATION_BPS", uint256(2_500));
        c.maxPriceAge = vm.envOr("ORACLE_MAX_PRICE_AGE", uint256(21_600));
        c.vault = vm.envOr("VAULT_PROXY", BASE_VAULT);
        c.oldOracle = vm.envOr("OLD_GUARDED_ORACLE", BASE_OLD_ORACLE);
        c.exchangeNew = vm.envOr("EXCHANGE_NEW", address(0));
    }

    function _syms() internal pure returns (string[11] memory s) {
        s = ["sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND", "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU"];
    }

    function run() external returns (address newOracle) {
        address deployer = broadcasterOverride != address(0) ? broadcasterOverride : msg.sender;
        Params memory c = _config();
        address guardian = c.guardian;
        require(guardian != address(0), "GUARDIAN env is required");
        address keeper   = c.keeper;
        uint256 window   = c.windowSeconds;
        uint256 winBps   = c.windowDeviationBps;
        require(winBps != 0, "WINDOW_DEVIATION_BPS must be non-zero - the rate limit is the point of this redeploy");
        uint256 maxAge   = c.maxPriceAge;
        require(maxAge >= 1 hours && maxAge <= 30 days, "ORACLE_MAX_PRICE_AGE must be 3600..2592000 (0 would switch the staleness check off)");
        address vaultAddr = c.vault;
        GuardedOracle old = GuardedOracle(c.oldOracle);
        IVaultOracleRepoint vault = IVaultOracleRepoint(vaultAddr);

        // ── preflight ─────────────────────────────────────────────────────
        require(vault.oracle() == address(old), "vault does not read OLD_GUARDED_ORACLE");
        require(vault.hasRole(0x00, deployer), "broadcaster lacks DEFAULT_ADMIN_ROLE on the vault (after the timelock handover: propose setOracle instead)");
        require(!old.paused(), "old oracle is paused - resolve before migrating");
        // Never re-stamp a quote older than the vault's own limit, capped at 6h
        // (the live vault ran maxPriceAge = 30 days, which would let a
        // days-old price be laundered into a fresh `updatedAt`).
        uint256 fresh = vault.maxPriceAge();
        if (fresh > 21_600) fresh = 21_600;
        // ...and never copy a price the NEW oracle would already call stale.
        if (fresh > maxAge) fresh = maxAge;
        string[11] memory syms = _syms();
        uint256[11] memory prices;
        for (uint256 i = 0; i < 11; i++) {
            (uint256 p, uint256 at, bool exists, bool frozen) = old.peek(keccak256(bytes(syms[i])));
            require(exists, string.concat("old oracle lacks ", syms[i]));
            require(!frozen, string.concat("old oracle has ", syms[i], " frozen - resolve first"));
            require(p > 0 && block.timestamp <= at + fresh,
                string.concat(syms[i], " price is stale by min(vault maxPriceAge, 6h, ORACLE_MAX_PRICE_AGE) - refusing to re-stamp it as fresh"));
            prices[i] = p;
        }
        (uint256 liabBefore, uint256 unpricedBefore) = vault.outstandingValueDetailed();
        console.log("=== GuardedOracle redeploy (rate limit) ===");
        console.log("vault          :", vaultAddr, vault.version());
        console.log("old oracle     :", address(old));
        console.log("liability      :", liabBefore);
        console.log("unpriced       :", unpricedBefore);

        // ── broadcast ────────────────────────────────────────────────────
        vm.startBroadcast(deployer);
        GuardedOracle n = new GuardedOracle(deployer);
        for (uint256 i = 0; i < 11; i++) n.addAsset(keccak256(bytes(syms[i])), prices[i]);
        n.setRiskParams(old.maxDeviationBps(), maxAge);
        address refSrc = old.referenceSource();
        if (refSrc != address(0)) {
            // A reference the keeper can write is no cross-check at all: a
            // confirmed post bypasses both the step cap and the window.
            require(refSrc != keeper && refSrc.code.length > 0, "referenceSource must be an independent feed, not the keeper");
            n.setReferenceSource(refSrc);
        }
        n.setWindowLimit(window, winBps);
        n.grantRole(n.KEEPER_ROLE(), keeper);
        n.grantRole(n.GUARDIAN_ROLE(), guardian);
        if (guardian != deployer) n.renounceRole(n.GUARDIAN_ROLE(), deployer);
        vault.setOracle(address(n));
        vm.stopBroadcast();
        newOracle = address(n);

        // ── read back ────────────────────────────────────────────────────
        require(vault.oracle() == newOracle, "vault not re-pointed");
        require(n.hasRole(n.KEEPER_ROLE(), keeper), "keeper role");
        require(n.hasRole(n.GUARDIAN_ROLE(), guardian), "guardian role");
        require(guardian == deployer || !n.hasRole(n.GUARDIAN_ROLE(), deployer), "deployer still guardian");
        require(n.hasRole(0x00, deployer), "admin");
        require(n.maxWindowDeviationBps() == winBps && n.windowDuration() == window, "window limit");
        require(n.maxDeviationBps() == old.maxDeviationBps() && n.maxPriceAge() == maxAge, "risk params");
        // Bounded guardian halts: the build being deployed must carry them,
        // and the new instance must start with no halt in force.
        require(n.GUARDIAN_HALT_DURATION() == 72 hours && n.GUARDIAN_HALT_COOLDOWN() == 24 hours, "guardian halt bounds");
        require(!n.paused(), "new oracle starts paused");
        {
            (uint256 pauseExpiry, uint256 pauseAllowedAt) = n.guardianPauseTerms();
            require(pauseAllowedAt == 0 && pauseExpiry == block.timestamp + 72 hours, "guardian pause terms");
        }
        for (uint256 i = 0; i < 11; i++) {
            (uint256 p, ) = n.getPrice(keccak256(bytes(syms[i])));
            require(p == prices[i], string.concat("price mismatch ", syms[i]));
            (, , , bool frozenNew) = n.peek(keccak256(bytes(syms[i])));
            require(!frozenNew, string.concat("new oracle starts with ", syms[i], " frozen"));
        }
        (uint256 liabAfter, uint256 unpricedAfter) = vault.outstandingValueDetailed();
        require(liabAfter == liabBefore && unpricedAfter <= unpricedBefore, "vault valuation changed across the re-point");

        console.log("NEW_GUARDED_ORACLE =", newOracle);
        console.log("window         :", window, "s, max move bps:", winBps);
        console.log("maxPriceAge    :", maxAge, "s; old oracle had", old.maxPriceAge());
        console.log("guardian halts : lapse after 72h, 24h cooldown; admin halts have no expiry");
        if (guardian == deployer) {
            console.log("!!! GUARDIAN == broadcaster: it also holds DEFAULT_ADMIN_ROLE, so its freezes and");
            console.log("!!! pauses will NOT lapse. Use a separate guardian key before the timelock handover.");
        }
        console.log("liability      :", liabAfter, "(unchanged)");

        address ex = c.exchangeNew;
        if (ex != address(0) && IExchangeOracleRead(ex).oracle() == address(old)) {
            console.log("!!! EXCHANGE_NEW reads the OLD GuardedOracle (immutable): the keeper must keep");
            console.log("!!! posting to both until that exchange is redeployed.");
        }
        console.log("Next: addresses.ts V2_STACK[84532].GuardedOracle, KEEPER_GUARDED_ORACLE in agent/.env +");
        console.log("workflows, then setPaused(true) on the old oracle once the keeper has moved. On an old");
        console.log("oracle that already has bounded halts, the ADMIN must send it: a guardian pause lapses after 72h.");
    }
}
