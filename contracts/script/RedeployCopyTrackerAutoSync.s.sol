// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "../src/CopyTracker.sol";
import "../src/PerpetualExchange.sol";
import "../src/StrategyRegistry.sol";
import "../src/FeeRouter.sol";
import "../src/TraderStake.sol";

/// @title  RedeployCopyTrackerAutoSync —— 部署自動同步版 CopyTracker（ADR-024）
/// @notice 只部署新的 CopyTracker（必要時在同一個 broadcast 裡把它的 owner 交給與交易所
///         相同的治理位址），**不送任何 owner 呼叫**：交易所、TraderStake、FeeRouter 的
///         改接由擁有者另外執行，腳本只把確切的 calldata 印出來（docs/OWNER_ACTIONS.md）。
///
///         為什麼不一起廣播：`exchange.setCopyTracker(new)` 會撤銷舊 tracker 在交易所的
///         授權，舊 tracker 上仍開著的跟單從此無法由 tracker 平倉（見下方「舊跟單」）。
///         這一步該由擁有者在確認過舊跟單的處理方式之後才送，而且三筆要一起送。
///
///         建構參數預設全部取自交易所「目前的」CopyTracker（`exchange.copyTracker()`），
///         新 tracker 綁定的 registry／traderStake／feeRouter／usdc 與現行版本一致；
///         這些都是 immutable，綁錯就只能再部署一次。環境變數可以覆寫，但會與鏈上交叉檢查：
///           - REGISTRY 必須是現行 tracker 的 registry（策略來源不能換），
///           - TRADER_STAKE 必須等於 registry.stakeContract()（罰沒對象與發布門檻同一份質押），
///           - FEE_ROUTER（非 0 時）的 exchange() 必須是 EXCHANGE，
///           - USDC 必須是交易所的結算幣。
///         另外探測交易所是否有自動同步用到的函式（maxLeverageForAsset、closeReasonOf、
///         getUserPositions、executionFee），舊版交易所會讓每次同步 revert，直接拒絕。
///
///         舊跟單：改接之後舊 tracker 不再是交易所授權的 agent，`unfollowAndCloseAll` 會因
///         `PositionStillOpen` 失敗。舊跟隨者的出口是在舊 tracker 上 `deactivateWithoutScoring`，
///         再到交易所 `closePosition` 自己平倉（部位一直是他們自己的）。舊 tracker 的
///         slashReserve 仍只由它的 owner 提領。
///
///   Env:
///     EXCHANGE             (必填) PerpetualExchange
///     BROADCASTER          預設 msg.sender（--sender）
///     USDC / REGISTRY / TRADER_STAKE / FEE_ROUTER
///                          預設取自 exchange.copyTracker() 的 immutable；覆寫時交叉檢查。
///                          交易所還沒有 tracker 時四個都必填（FEE_ROUTER 可為 0 = 不收跟單費）。
///     NEW_OWNER            新 tracker 的 owner。預設 exchange.owner()（與交易所同一個治理位址）；
///                          與部署者相同時不轉移。
///     RESUME_COPY_TRACKER  中斷後續跑：不再部署，改用這個位址（immutable 會逐一比對）。
///     VERIFY_ONLY          true = 不廣播，只讀回 RESUME_COPY_TRACKER 並印出接線狀態。
///     EXPECT_WIRED         VERIFY_ONLY 時加上 true：三處接線都必須已指向新 tracker，否則失敗。
///
///   Fork 模擬（不需金鑰、不送任何交易）：
///     forge script script/RedeployCopyTrackerAutoSync.s.sol:RedeployCopyTrackerAutoSync \
///       --fork-url https://sepolia.base.org --sender $DEPLOYER
///   廣播（只有部署與 owner 轉移）：
///     forge script script/RedeployCopyTrackerAutoSync.s.sol:RedeployCopyTrackerAutoSync \
///       --rpc-url https://sepolia.base.org --account $ACCOUNT --sender $DEPLOYER --broadcast --slow
contract RedeployCopyTrackerAutoSync is Script {
    /// 與 agent/shared/src/payoutSafety.ts 的 COMPROMISED_ADDRESSES 相同。
    address internal constant LEAKED_DEPLOYER = 0xE80A81360608C1342e66743F70a00f75d792Eb93;

    struct Config {
        address deployer;
        address exchange;
        address usdc;
        address registry;
        address traderStake;
        address feeRouter;
        bool    feeRouterSet;   // FEE_ROUTER 有給（可能刻意給 0）
        address newOwner;
        address resumeCopyTracker;
        bool    verifyOnly;
        bool    expectWired;
    }

    /// 擁有者要送的一筆呼叫。
    struct OwnerCall {
        string  label;
        address target;
        address owner;
        bytes   payload;
    }

    function run() external {
        Config memory cfg = _configFromEnv();
        if (cfg.verifyOnly) {
            require(cfg.resumeCopyTracker != address(0), "VERIFY_ONLY needs RESUME_COPY_TRACKER");
            cfg = resolve(cfg);
            _checkInputs(cfg);
            verify(cfg, cfg.resumeCopyTracker);
            _printWiring(cfg, cfg.resumeCopyTracker);
            if (cfg.expectWired) requireWired(cfg, cfg.resumeCopyTracker);
            console.log("VERIFY_ONLY: read-back passed.");
            return;
        }
        runWith(cfg);
    }

    /// @notice 整個流程（測試直接呼叫，避免環境變數在案例之間外洩）。
    function runWith(Config memory cfg) public returns (address newCt) {
        cfg = resolve(cfg);
        preflight(cfg);
        newCt = _execute(cfg);
        verify(cfg, newCt);
        _printFollowUp(cfg, newCt);
    }

    // ── Config ───────────────────────────────────────────────────────────────

    function _configFromEnv() internal view returns (Config memory c) {
        c.deployer          = vm.envOr("BROADCASTER", msg.sender);
        c.exchange          = vm.envAddress("EXCHANGE");
        c.usdc              = vm.envOr("USDC", address(0));
        c.registry          = vm.envOr("REGISTRY", address(0));
        c.traderStake       = vm.envOr("TRADER_STAKE", address(0));
        c.feeRouterSet      = vm.envExists("FEE_ROUTER");
        c.feeRouter         = vm.envOr("FEE_ROUTER", address(0));
        c.newOwner          = vm.envOr("NEW_OWNER", address(0));
        c.resumeCopyTracker = vm.envOr("RESUME_COPY_TRACKER", address(0));
        c.verifyOnly        = vm.envOr("VERIFY_ONLY", false);
        c.expectWired       = vm.envOr("EXPECT_WIRED", false);
    }

    /// @notice 把沒給的欄位補成交易所現行 CopyTracker 的 immutable；NEW_OWNER 預設 exchange.owner()。
    function resolve(Config memory cfg) public view returns (Config memory) {
        require(cfg.exchange.code.length > 0, "EXCHANGE has no code");
        address live = PerpetualExchange(cfg.exchange).copyTracker();
        if (live != address(0)) {
            CopyTracker cur = CopyTracker(live);
            if (cfg.usdc == address(0))        cfg.usdc        = address(cur.usdc());
            if (cfg.registry == address(0))    cfg.registry    = address(cur.registry());
            if (cfg.traderStake == address(0)) cfg.traderStake = address(cur.traderStake());
            if (!cfg.feeRouterSet && cfg.feeRouter == address(0)) cfg.feeRouter = address(cur.feeRouter());
        }
        if (cfg.newOwner == address(0)) cfg.newOwner = PerpetualExchange(cfg.exchange).owner();
        return cfg;
    }

    // ── Preflight ────────────────────────────────────────────────────────────

    function preflight(Config memory cfg) public view {
        _checkInputs(cfg);
        if (cfg.resumeCopyTracker != address(0)) _checkImmutables(cfg, cfg.resumeCopyTracker, "RESUME_COPY_TRACKER");
    }

    function _checkInputs(Config memory cfg) internal view {
        require(cfg.usdc != address(0) && cfg.registry != address(0),
            "USDC / REGISTRY unresolved - EXCHANGE has no CopyTracker yet, pass them explicitly");
        require(cfg.usdc.code.length > 0, "USDC has no code");
        require(cfg.registry.code.length > 0, "REGISTRY has no code");
        require(address(PerpetualExchange(cfg.exchange).usdc()) == cfg.usdc, "USDC is not the exchange's settlement token");

        // 自動同步用到的交易所函式；舊版交易所沒有，每次同步都會 revert。
        _probe(cfg.exchange, abi.encodeWithSignature("maxLeverageForAsset(bytes32)", bytes32(0)),
            "EXCHANGE lacks maxLeverageForAsset - redeploy the exchange from this revision first");
        _probe(cfg.exchange, abi.encodeWithSignature("closeReasonOf(uint256)", uint256(0)),
            "EXCHANGE lacks closeReasonOf - unfollow scoring would revert");
        _probe(cfg.exchange, abi.encodeWithSignature("getUserPositions(address)", address(0)),
            "EXCHANGE lacks getUserPositions");
        _probe(cfg.exchange, abi.encodeWithSignature("executionFee()"), "EXCHANGE lacks executionFee");

        // 策略來源與質押不能換：新 tracker 的 registry／traderStake 是 immutable。
        address live = PerpetualExchange(cfg.exchange).copyTracker();
        if (live != address(0)) {
            require(address(CopyTracker(live).registry()) == cfg.registry,
                "REGISTRY differs from the exchange's current CopyTracker.registry()");
        }
        require(address(StrategyRegistry(cfg.registry).stakeContract()) == cfg.traderStake,
            "TRADER_STAKE is not REGISTRY.stakeContract() - slashing would target a different stake");
        if (cfg.traderStake != address(0)) require(cfg.traderStake.code.length > 0, "TRADER_STAKE has no code");
        if (cfg.feeRouter != address(0)) {
            require(cfg.feeRouter.code.length > 0, "FEE_ROUTER has no code");
            require(FeeRouter(cfg.feeRouter).exchange() == cfg.exchange, "FEE_ROUTER.exchange() is not EXCHANGE");
            require(address(FeeRouter(cfg.feeRouter).usdc()) == cfg.usdc, "FEE_ROUTER settles in a different USDC");
        }

        require(cfg.deployer != address(0), "BROADCASTER is zero");
        require(!_isCompromised(cfg.deployer), "deployer is a known-compromised address");
        require(!_is7702Delegated(cfg.deployer), "deployer is EIP-7702 delegated - treated as taken over");
        // owner 掌握 withdrawSlashReserve：不能交給已知外洩的位址。
        require(!_isCompromised(cfg.newOwner), "NEW_OWNER is a known-compromised address");
        require(!_is7702Delegated(cfg.newOwner), "NEW_OWNER is EIP-7702 delegated - treated as taken over");
    }

    function _checkImmutables(Config memory cfg, address ctAddr, string memory what) internal view {
        require(ctAddr.code.length > 0, string.concat(what, " has no code"));
        CopyTracker ct = CopyTracker(ctAddr);
        // 自動同步版才有的 getter：防止續跑到一個舊版 tracker 上。
        (bool ok, bytes memory ret) = ctAddr.staticcall(abi.encodeWithSignature("MAX_TIP_WEI()"));
        require(ok && ret.length == 32, string.concat(what, " is not an auto-sync CopyTracker (no MAX_TIP_WEI)"));
        // 審查修正版才有的 getter（冷卻下限、執行費同意上限）：不續跑到修正前編出來的 tracker。
        (ok, ret) = ctAddr.staticcall(abi.encodeWithSignature("MIN_SYNC_INTERVAL()"));
        require(ok && ret.length == 32, string.concat(what, " predates the auto-sync fee-cap/cooldown fixes (no MIN_SYNC_INTERVAL)"));
        // 指定執行者（personal 模式）：不續跑到沒有 setSyncExecutor 的版本。
        (ok, ret) = ctAddr.staticcall(abi.encodeWithSignature("syncExecutor(address,uint256)", address(0), uint256(0)));
        require(ok && ret.length == 32, string.concat(what, " predates the designated-executor fix (no syncExecutor)"));
        require(address(ct.exchange()) == cfg.exchange, string.concat(what, ": different exchange"));
        require(address(ct.usdc()) == cfg.usdc, string.concat(what, ": different USDC"));
        require(address(ct.registry()) == cfg.registry, string.concat(what, ": different registry"));
        require(address(ct.traderStake()) == cfg.traderStake, string.concat(what, ": different trader stake"));
        require(address(ct.feeRouter()) == cfg.feeRouter, string.concat(what, ": different fee router"));
    }

    // ── Execute ──────────────────────────────────────────────────────────────

    function _execute(Config memory cfg) internal returns (address) {
        vm.startBroadcast(cfg.deployer);
        CopyTracker ct = cfg.resumeCopyTracker != address(0)
            ? CopyTracker(cfg.resumeCopyTracker)
            : new CopyTracker(cfg.usdc, cfg.exchange, cfg.registry, cfg.feeRouter, cfg.traderStake);
        // 新合約自己的 owner 轉移（部署者就是它的 owner），不是對既有協議的 owner 呼叫。
        if (ct.owner() == cfg.deployer && cfg.newOwner != cfg.deployer) ct.transferOwnership(cfg.newOwner);
        vm.stopBroadcast();
        return address(ct);
    }

    // ── Verify ───────────────────────────────────────────────────────────────

    function verify(Config memory cfg, address newCt) public view {
        _checkImmutables(cfg, newCt, "CopyTracker_NEW");
        require(Ownable(newCt).owner() == cfg.newOwner, "readback: CopyTracker_NEW.owner() is not NEW_OWNER");
    }

    /// @notice 擁有者要送的改接呼叫，**依陣列順序送**：FeeRouter → TraderStake → exchange（最後）。
    ///         exchange 那一筆才讓新 tracker 生效、同時撤銷舊 tracker 的授權，所以放在最後：中途任何
    ///         一筆失敗時，新 tracker 都還不能開平倉，舊 tracker 上既有的跟單也還關得掉（fail closed——
    ///         最壞只是舊 tracker 的「新」跟單在收跟單費時失敗）。反過來先送 exchange，中途失敗就變成
    ///         舊 tracker 已失去授權、新 tracker 卻收不了跟單費或罰不了沒（docs/OWNER_ACTIONS.md 第 8 步）。
    function ownerCalls(Config memory cfg, address newCt) public view returns (OwnerCall[] memory calls) {
        uint256 n = 1 + (cfg.traderStake != address(0) ? 1 : 0) + (cfg.feeRouter != address(0) ? 1 : 0);
        calls = new OwnerCall[](n);
        uint256 k;
        if (cfg.feeRouter != address(0)) {
            calls[k++] = OwnerCall(
                "FeeRouter.setCopyTracker (copy fee; distributeCopyFee is gated on it)",
                cfg.feeRouter,
                Ownable(cfg.feeRouter).owner(),
                abi.encodeCall(FeeRouter.setCopyTracker, (newCt))
            );
        }
        if (cfg.traderStake != address(0)) {
            calls[k++] = OwnerCall(
                "TraderStake.setCopyTracker (slashing)",
                cfg.traderStake,
                Ownable(cfg.traderStake).owner(),
                abi.encodeCall(TraderStake.setCopyTracker, (newCt))
            );
        }
        calls[k++] = OwnerCall(
            "PerpetualExchange.setCopyTracker - LAST (authorizes new, de-authorizes old)",
            cfg.exchange,
            Ownable(cfg.exchange).owner(),
            abi.encodeCall(PerpetualExchange.setCopyTracker, (newCt))
        );
    }

    /// @notice 三處接線都已指向 `newCt`。
    function requireWired(Config memory cfg, address newCt) public view {
        require(PerpetualExchange(cfg.exchange).copyTracker() == newCt, "not wired: exchange.copyTracker()");
        require(PerpetualExchange(cfg.exchange).authorizedAgents(newCt), "not wired: exchange.authorizedAgents(new)");
        if (cfg.traderStake != address(0)) {
            require(TraderStake(cfg.traderStake).copyTracker() == newCt, "not wired: traderStake.copyTracker()");
        }
        if (cfg.feeRouter != address(0)) {
            require(FeeRouter(cfg.feeRouter).copyTracker() == newCt, "not wired: feeRouter.copyTracker()");
        }
    }

    // ── Output ───────────────────────────────────────────────────────────────

    function _printFollowUp(Config memory cfg, address newCt) internal view {
        console.log("=== RedeployCopyTrackerAutoSync: deployed, read-back passed ===");
        console.log("CopyTracker_NEW :", newCt);
        console.log("owner           :", cfg.newOwner);
        console.log("exchange        :", cfg.exchange);
        console.log("registry        :", cfg.registry);
        console.log("traderStake     :", cfg.traderStake);
        console.log("feeRouter       :", cfg.feeRouter);
        address old = PerpetualExchange(cfg.exchange).copyTracker();
        console.log("CopyTracker_OLD (still wired):", old);

        OwnerCall[] memory calls = ownerCalls(cfg, newCt);
        console.log("");
        console.log("=== Owner calls - NOT broadcast by this script ===");
        console.log("Send them IN THIS ORDER, back to back (or as ONE timelock batch in this order).");
        console.log("The exchange call goes last: until it lands the new tracker cannot trade and the old one");
        console.log("can still close its legs, so a partial run fails closed.");
        console.log("A missing FeeRouter call makes every new follow revert (distributeCopyFee is gated);");
        console.log("a missing TraderStake call makes every slash fail (SlashFailed).");
        for (uint256 i; i < calls.length; ++i) {
            console.log(string.concat("- [", vm.toString(i), "] ", calls[i].label));
            console.log("  target:", calls[i].target);
            console.log("  from (owner):", calls[i].owner);
            console.log("  payload:");
            console.logBytes(calls[i].payload);
        }

        console.log("");
        console.log("Existing follows on CopyTracker_OLD: after the exchange call the old tracker can no");
        console.log("longer close its legs. Before switching, ask followers to unfollowAndCloseAll on the old");
        console.log("tracker; afterwards their exit is old.deactivateWithoutScoring + exchange.closePosition.");
        console.log("Next: update frontend/src/contracts/addresses.ts + abi/CopyTracker.json (forge artifact),");
        console.log("      then re-run with VERIFY_ONLY=true RESUME_COPY_TRACKER=<new> EXPECT_WIRED=true.");
    }

    function _printWiring(Config memory cfg, address newCt) internal view {
        console.log("exchange.copyTracker() == new :", PerpetualExchange(cfg.exchange).copyTracker() == newCt);
        if (cfg.traderStake != address(0)) {
            console.log("traderStake.copyTracker() == new :", TraderStake(cfg.traderStake).copyTracker() == newCt);
        }
        if (cfg.feeRouter != address(0)) {
            console.log("feeRouter.copyTracker() == new :", FeeRouter(cfg.feeRouter).copyTracker() == newCt);
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _probe(address target, bytes memory data, string memory err) internal view {
        (bool ok, bytes memory ret) = target.staticcall(data);
        require(ok && ret.length >= 32, err);
    }

    function _isCompromised(address a) internal pure returns (bool) {
        return a == LEAKED_DEPLOYER;
    }

    /// 0xef0100 ‖ delegate(20)：與 payoutSafety.ts 同一條規則。
    function _is7702Delegated(address a) internal view returns (bool) {
        bytes memory c = a.code;
        return c.length == 23 && c[0] == 0xef && c[1] == 0x01 && c[2] == 0x00;
    }
}
