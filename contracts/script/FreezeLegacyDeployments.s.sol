// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";

/// @notice P0-09 / 選項卡 D6「凍結 Sepolia」：拿掉外洩舊部署者金鑰在舊部署上的所有權限。
///
///         外洩地址 0xE80A…Eb93 的私鑰在公開 git 歷史裡，任何人都能用它簽名。這支腳本
///         以「那把金鑰本人」的身分，把它持有的 owner() 與 AccessControl 角色逐一放棄
///         （或移交給新的安全地址），讓搶到金鑰的人再也不能改設定、改價格、升級代理、
///         或給自己 MINTER 去增發合成資產。
///
///         每一筆的處理方式與理由寫在 docs/RUNBOOK_FREEZE_LEGACY.md，腳本內的 reason
///         字串是摘要。盤點方法（CREATE nonce 全掃 + 全區段 OwnershipTransferred /
///         RoleGranted 事件）也在 runbook。
///
///         ── 三種模式 ───────────────────────────────────────────────────────────
///           1. 計畫（預設）：只讀鏈上狀態、印出完整計畫與每筆目前狀態，不產生任何交易。
///                FREEZE_CHAIN=sepolia forge script script/FreezeLegacyDeployments.s.sol --rpc-url <RPC>
///           2. 模擬：FREEZE_EXECUTE=true，**不加 --broadcast**。forge 在本機模擬每一筆交易
///              並跑完讀回驗證，不需要私鑰、不送出任何東西。
///           3. 執行：FREEZE_EXECUTE=true + FREEZE_CONFIRM=FREEZE-<chainId> + --broadcast，
///              並以環境變數 LEAKED_PRIVATE_KEY 提供外洩金鑰（腳本會確認它對應 0xE80A…）。
///              在 anvil 分叉上演練時改用 --unlocked（anvil_impersonateAccount），不需要私鑰。
///              一律加 --slow：Base 上的外洩地址有 EIP-7702 委派，RPC 要求 nonce 嚴格連續，
///              forge 預設批次送出會被拒（見 rotate-key.sh 的同一個坑）。
///
///         ── 安全性質 ───────────────────────────────────────────────────────────
///           - 冪等：每筆先讀狀態，已經不由外洩地址持有的就跳過；中途失敗可直接重跑。
///           - AccessControl：同一合約先放棄非 admin 角色、DEFAULT_ADMIN_ROLE 最後；
///             放棄 DEFAULT_ADMIN 之前，必須確認「保留清單」中的另一個 admin 仍持有，
///             否則整支腳本中止。刻意讓它無 admin 的（8 顆 SyntheticAssetV2）在計畫裡標明。
///           - 保留清單（keeper 的 KEEPER_ROLE、guardian、risk、vault 的 MINTER_ROLE、
///             MockOracle 的 keeper owner）在執行前後都驗證，確保沒有誤傷。
///           - 執行後逐項讀回；另有 verify() 入口在廣播後對真實鏈重讀一次。
///
///         腳本與文件都不含任何私鑰字面值。
contract FreezeLegacyDeployments is Script {
    address constant LEAKED = 0xE80A81360608C1342e66743F70a00f75d792Eb93;

    bytes32 constant DEFAULT_ADMIN = 0x00;
    bytes32 constant KEEPER_ROLE   = keccak256("KEEPER_ROLE");
    bytes32 constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 constant RISK_ROLE     = keccak256("RISK_ROLE");
    bytes32 constant PAUSER_ROLE   = keccak256("PAUSER_ROLE");
    bytes32 constant MINTER_ROLE   = keccak256("MINTER_ROLE");

    uint256 constant SEPOLIA      = 11155111;
    uint256 constant BASE_SEPOLIA = 84532;

    // ── Sepolia V2 stack 的保留角色持有人（docs/ROLE_SEPARATION.md） ──────────────
    address constant V2_ADMIN    = 0x2a588AeA3271B159c9188d95E0d10614711f83e3;
    address constant V2_KEEPER   = 0x540aECD37E7A7885824e7b7e996eBddfb842ef17;
    address constant V2_GUARDIAN = 0x9913f5D63817B1b98a2c07713d4516CC3b33A4e4;
    address constant V2_RISK     = 0xECe96A5EC46e20E0F9A441c9D787E89CE366B165;

    address constant S_GUARDED_ORACLE = 0x32A19D04ef2ca5A7DA02Df39419729fA745749A1;
    address constant S_ASSET_VAULT_V2 = 0x3a37415981F6f4fC27FA6c8C62F1d4e47115fD17;
    address constant S_MOCK_ORACLE    = 0x17CA20A37Cf04F2f589B2573EC95f1411D29d958;
    address constant B_MOCK_ORACLE    = 0xeD90c4F3B48213888870C1FC8486921Cb0990Aa3;

    enum Action { RenounceOwnership, TransferOwnership, RenounceRole }
    enum State { Pending, Done, NotHeld }

    struct Item {
        string label;
        address target;
        Action action;
        bytes32 role;
        string reason;
        bool intentionalNoAdmin; // 放棄後該合約永久沒有 DEFAULT_ADMIN（刻意）
    }

    /// 執行前後都必須成立：holder 持有 target 上的 role（role = 0 且 isOwner = true 時檢查 owner()）。
    struct Keep {
        string label;
        address target;
        bytes32 role;
        bool isOwner;
        address holder;
    }

    Item[] internal items;
    Keep[] internal keeps;
    address internal newOwner; // 只用於 TransferOwnership（Base 的 oracle adapter）

    error WrongChain(uint256 chainId);
    error UnknownChain(string name);
    error NotConfirmed(string expected);
    error KeyMismatch(address derived);
    error KeepBroken(string label, address target, address holder);
    error OtherAdminMissing(string label, address target);
    error StillHeld(string label, address target);
    error UnexpectedOwner(string label, address target, address actual, address expected);
    error BadNewOwner(address newOwner);

    // ════════════════════════════════════════════════════════════════════════
    // 入口
    // ════════════════════════════════════════════════════════════════════════

    function run() external {
        _build();
        _printPlan();
        _checkKeeps(unicode"執行前");
        _checkAdminsBeforeRenounce();

        if (!vm.envOr("FREEZE_EXECUTE", false)) {
            console.log("");
            console.log(unicode"== 計畫模式：沒有產生任何交易。要模擬請設 FREEZE_EXECUTE=true（不加 --broadcast）。");
            return;
        }

        string memory expected = string.concat("FREEZE-", vm.toString(block.chainid));
        bool confirmed = keccak256(bytes(vm.envOr("FREEZE_CONFIRM", string("")))) == keccak256(bytes(expected));

        uint256 pk = vm.envOr("LEAKED_PRIVATE_KEY", uint256(0));
        if (pk != 0) {
            // 真正要簽名時才需要確認字串；模擬（不加 --broadcast）不簽名也不送出。
            if (!confirmed) revert NotConfirmed(expected);
            if (vm.addr(pk) != LEAKED) revert KeyMismatch(vm.addr(pk));
            vm.startBroadcast(pk);
        } else {
            // 沒給私鑰：forge 模擬可以用任意 sender；廣播時只有 anvil 的 --unlocked 能簽。
            if (!confirmed) console.log(unicode"   （未設 FREEZE_CONFIRM：只能模擬；加 --broadcast 會因為沒有簽名者而失敗）");
            vm.startBroadcast(LEAKED);
        }

        uint256 sent;
        for (uint256 i = 0; i < items.length; i++) {
            Item storage it = items[i];
            if (_state(it) != State.Pending) continue;
            if (it.action == Action.RenounceOwnership) {
                IOwnable(it.target).renounceOwnership();
            } else if (it.action == Action.TransferOwnership) {
                IOwnable(it.target).transferOwnership(newOwner);
            } else {
                IAccessControlMin(it.target).renounceRole(it.role, LEAKED);
            }
            sent++;
        }
        vm.stopBroadcast();

        console.log("");
        console.log(string.concat(unicode"== 已送出（或模擬）", vm.toString(sent), unicode" 筆交易；開始讀回驗證"));
        _verifyAll();
    }

    /// @notice 廣播完成後對真實鏈重讀一次（唯讀，不需要私鑰）。
    ///         FREEZE_CHAIN=sepolia forge script script/FreezeLegacyDeployments.s.sol --sig "verify()" --rpc-url <RPC>
    function verify() external {
        _build();
        _verifyAll();
    }

    // ════════════════════════════════════════════════════════════════════════
    // 計畫
    // ════════════════════════════════════════════════════════════════════════

    function _build() internal {
        delete items;
        delete keeps;
        string memory chain = vm.envString("FREEZE_CHAIN");
        bytes32 c = keccak256(bytes(chain));
        if (c == keccak256("sepolia")) {
            if (block.chainid != SEPOLIA) revert WrongChain(block.chainid);
            _planSepolia();
        } else if (c == keccak256("base-sepolia")) {
            if (block.chainid != BASE_SEPOLIA) revert WrongChain(block.chainid);
            _planBaseSepolia();
        } else {
            revert UnknownChain(chain);
        }
    }

    function _planSepolia() internal {
        // ── 1. V2 硬化金庫：外洩金鑰能升級代理（UUPS）、改風控、改價，最危險，先處理 ──
        //     另一個 DEFAULT_ADMIN（V2_ADMIN）仍在，所以兩顆都不會變成無 admin。
        string memory r1 = "V2 admin/keeper/guardian already held by separated keys (ROLE_SEPARATION.md); leaked copy is pure liability";
        _role("GuardedOracle", S_GUARDED_ORACLE, KEEPER_ROLE, r1);
        _role("GuardedOracle", S_GUARDED_ORACLE, GUARDIAN_ROLE, r1);
        _role("GuardedOracle", S_GUARDED_ORACLE, DEFAULT_ADMIN, r1);
        _role("AssetVaultV2", S_ASSET_VAULT_V2, RISK_ROLE, r1);
        _role("AssetVaultV2", S_ASSET_VAULT_V2, PAUSER_ROLE, r1);
        _role("AssetVaultV2", S_ASSET_VAULT_V2, DEFAULT_ADMIN, r1);

        // ── 2. 8 顆 SyntheticAssetV2：外洩金鑰是唯一 admin，可以給自己 MINTER 增發後向金庫贖回 ──
        //     刻意無 admin：唯一的 MINTER 是金庫代理（位址不會因升級改變），之後不需要再授權。
        string memory r2 = "leaked key is SOLE admin and could grant itself MINTER then redeem against AssetVaultV2; MINTER stays with vault proxy";
        _roleNoAdmin("sBTC (V2)",  0xeCF271592C0D64663906318f250d49c255E332Ac, r2);
        _roleNoAdmin("sETH (V2)",  0x576856E68FdE8D586EAa2E2c21e74c4D37587e8F, r2);
        _roleNoAdmin("sAAPL (V2)", 0x84C27703db71062061364E5B8E015139b2ac0163, r2);
        _roleNoAdmin("sTSLA (V2)", 0x0e8b6478038876741925A5B7A571596E6f4a695E, r2);
        _roleNoAdmin("sGOLD (V2)", 0xc97b8195cBd00fec5D3aAb103C9E313414B11a10, r2);
        _roleNoAdmin("sBOND (V2)", 0xb84C17a704F9e7d96c3aF84Df05C6a8da5c344eb, r2);
        _roleNoAdmin("sNVDA (V2)", 0xB5586Ef5bBA7DAa698a4a6745C9D46F0b3bECfeE, r2);
        _roleNoAdmin("sMSFT (V2)", 0xCB2c5c834f1f0d54E6Da1f3628B1c624aAa750cf, r2);

        // ── 3. 前端 Sepolia（legacy demo）現行 V1 合約：renounce ──
        //     使用者的提領／平倉／贖回／解除質押都不需要 owner；owner 只剩改參數與接線的能力。
        string memory r3 = "current Sepolia V1 (legacy demo); user exit paths are permissionless; owner powers only retune/rewire";
        _own("PerpetualExchange", 0x0c6459d38617E60017bDc4ed69ec26137DA5c32b, r3);
        _own("InsuranceVault",    0x8bDE83dBC2CA450B539346e224E7819348C7b091, r3);
        _own("FeeRouter",         0x2297e580166aF35dd0065379286f782933653079, r3);
        _own("TraderStake",       0x3fe1dbC82eA267085CAB5eb67C6b7d3E68A7d673, r3);
        _own("KYCRegistry",       0x7d40A2D3e39cDD1Dc613071D3C463AA161f7C5bB, r3);
        _own("ESGRegistry",       0xdCFdDd38e1d80C1A5eeB44c05187Ec7979B98c13, r3);
        _own("AssetVault (V1)",   0xB4D10cBC6143E410dd7b48797334C4397b99325f, r3);
        _own("PepeAMM",           0x3e6503BA0F4ad9E4743b695141CeB48709106A0c, r3);
        _own("PepeToken",         0xa364F43627A17BE5bfbcb32693f3eD7E44ebe1D9, r3);
        _own("PepeClaim",         0x852c0fBa54552aafbA4798709d90056159682A4C, r3);
        _own("EsgRewardDistributor", 0xA1a522B9d31e5B48E41DcCd050DE10dA2e3BEdD0, r3);
        _own("PepeIncentives",    0x65b9F1B4d18822d4faBa763621E3e4eA065aE5D7, r3);
        _own("PepeStaking",       0xf5d0953A443259ebdFC62fE49189998988e309f9, r3);
        _own("MockUSDT",          0xA08C0F92804173Bf796FDa3FA66654F96aDDB5F1, r3);

        // ── 4. 已被取代的舊 Sepolia 部署：renounce ──
        //     舊 MockOracle 特別重要：舊 exchange 仍讀它們，owner 能任意改價。
        string memory r4 = "superseded Sepolia deployment; no longer referenced by frontend/keeper; freeze config forever";
        _own("PerpetualExchange (2026-05 #1)", 0x00f6cf0113399a7A451c7f85fe094a28092d3e0c, r4);
        _own("PerpetualExchange (old)", 0xb3e978E96e36FeDa703827D9dfE142d502C3bd1d, r4);
        _own("PerpetualExchange (old)", 0xc100f942366305E2917d5a7B5eD0F5F1E930a49c, r4);
        _own("PerpetualExchange (old)", 0x4cC711AEa7c6D7E19e99676b51b7A69ee08c31Eb, r4);
        _own("PerpetualExchange (never wired)", 0xdC5cc6Ab502d8D8F648eCc2D9F130F68F7C306b4, r4);
        _own("PerpetualExchange (old)", 0xF2A6F7B684BEB8554df34A4463143B6408FB6F84, r4);
        _own("FeeRouter (old)",   0x0FfA7f279fED4E19b3018A4461A8F387aA6c16C2, r4);
        _own("FeeRouter (old)",   0x54e5a77638760eD90D43E1E25a6D9b4A566beB82, r4);
        _own("FeeRouter (old)",   0xBb7c02d02EFa81a44bC0fb7E0bC2F531Ee39FB2B, r4);
        _own("FeeRouter (old)",   0xc2aAB2dCAdA7b8D9e47132A6bf0246873ad0078D, r4);
        _own("FeeRouter (old)",   0xCCD05CBdC2f7961a4C27D3633694022722786A0F, r4);
        _own("TraderStake (old)", 0x11D1E96aa302a93897de8e60CB00b38247Fafc78, r4);
        _own("TraderStake (old)", 0x2cBB4310Dfc62A591975f71c818EF4E3f655Bc1d, r4);
        _own("TraderStake (old)", 0x73756CF6e0738db54E2823512997033e309fcd24, r4);
        _own("TraderStake (old)", 0xE8D78859B61AF6CEd5318044bAd0E265f1D1CE8E, r4);
        _own("MockOracle (old)",  0x18c35cb3D3DdC522D0b7996e01d4a5C8b9cf16f4, r4);
        _own("MockOracle (old)",  0x3f1E53C64bc644D07b8FA76baC8aEE33b96194d8, r4);
        _own("MockOracle (old)",  0x446eeaC0368Dad42fC9e3B57ECC24FAb747CDFf5, r4);
        _own("MockOracle (old)",  0x6196E77023318EE3DF0745b001161c17c2c109bF, r4);
        _own("MockOracle (old)",  0x6D798128a5553E703B20f9A789260f999b6fb511, r4);
        _own("MockOracle (old)",  0xC262dB3e0d73ce0aeE21DA6669d2B483ABE78Ff2, r4);
        _own("PepeAMM (old)",     0x2B4516FD9af3aB104A920fe3C197340BbfAb847b, r4);
        _own("PepeAMM (old)",     0x4cF1A7DB08BDcC59FAA2514606F1096AB85D159f, r4);
        _own("PepeAMM (old)",     0x612674Ab98589228309353FCc2f9d88Cc830CBdF, r4);
        _own("PepeIncentives (old)", 0x33963D72EB305ddBb027E1aEC2785579ba685d71, r4);
        _own("PepeIncentives (old)", 0xb2999a8A3589Cd408aD38703E06f95B855BF79bD, r4);
        _own("InsuranceVault (old)", 0xE40ABfbDb4B70A3788faF0E6A04e10C4204A6eB3, r4);
        _own("MockUSDT (old)",    0xccedA707C3831b23a6C9bC4AF81FEF69b78410F2, r4);

        // ── 5. 早期練習代幣（deployer nonce 0、1，非本產品）：renounce ──
        string memory r5 = "pre-project test ERC20 (deployer nonce 0/1); owner can only mint; nothing depends on it";
        _own("CoolToken (nonce 0)",   0x69fd695Bc7C3aFdb35ABA35cD6890C506400b035, r5);
        _own("HaerinToken (nonce 1)", 0xC9b0e5C219AA1B3eB00E92Fd9a883B182F0AE8Ae, r5);

        // ── 保留清單：執行前後都必須成立 ──
        _keepRole("GuardedOracle admin", S_GUARDED_ORACLE, DEFAULT_ADMIN, V2_ADMIN);
        _keepRole("GuardedOracle keeper (price-keeper.yml)", S_GUARDED_ORACLE, KEEPER_ROLE, V2_KEEPER);
        _keepRole("GuardedOracle guardian", S_GUARDED_ORACLE, GUARDIAN_ROLE, V2_GUARDIAN);
        _keepRole("AssetVaultV2 admin", S_ASSET_VAULT_V2, DEFAULT_ADMIN, V2_ADMIN);
        _keepRole("AssetVaultV2 risk", S_ASSET_VAULT_V2, RISK_ROLE, V2_RISK);
        _keepRole("AssetVaultV2 pauser", S_ASSET_VAULT_V2, PAUSER_ROLE, V2_GUARDIAN);
        _keepOwner("MockOracle owner = keeper (price-keeper.yml)", S_MOCK_ORACLE, V2_KEEPER);
        for (uint256 i = 0; i < items.length; i++) {
            if (items[i].intentionalNoAdmin) {
                _keepRole(string.concat(items[i].label, " MINTER = AssetVaultV2"), items[i].target, MINTER_ROLE, S_ASSET_VAULT_V2);
            }
        }
    }

    function _planBaseSepolia() internal {
        // Base 上只剩三顆 oracle adapter 由外洩金鑰持有。鏈上沒有任何合約指向它們，但有兩條
        // 鏈下依賴：base-sepolia-keeper.yml 的 KEEPER_RELAY_SOURCE 是 AggregatorOracle（keeper
        // 優先讀它、再中繼進現行交易所讀的 MockOracle），ops/monitoring 的 oracleDeviation 也把它
        // 當參考價。owner 能 setFeed／setPriceId 把來源指向任意合約，等於能經由 keeper 影響現行
        // 交易所的價格，所以要拿走；來源之後仍需要維護，因此預設移交（ADAPTER_NEW_OWNER）而不是放棄。
        bool renounce = vm.envOr("ADAPTER_RENOUNCE", false);
        if (!renounce) {
            newOwner = vm.envOr("ADAPTER_NEW_OWNER", address(0));
            if (newOwner == address(0) || newOwner == LEAKED) revert BadNewOwner(newOwner);
        }
        string memory r = "keeper relay source (KEEPER_RELAY_SOURCE) and monitoring reference; owner could point feeds anywhere";
        _adapter("ChainlinkOracleAdapter", 0x37DC7b70899BFfB17949366a5b6a86203C428E2f, renounce, r);
        _adapter("PythOracleAdapter",      0x551C0B2e75a9129fe697210223F1Ca6e64F3C6d5, renounce, r);
        _adapter("AggregatorOracleAdapter", 0x8215158642350a3f329aB9597186d21f957A813D, renounce, r);

        _keepOwner("Base MockOracle owner = keeper (price-keeper-base)", B_MOCK_ORACLE, V2_KEEPER);
    }

    // ── 建表小工具 ────────────────────────────────────────────────────────────

    function _own(string memory label, address t, string memory reason) internal {
        items.push(Item(label, t, Action.RenounceOwnership, 0, reason, false));
    }

    function _adapter(string memory label, address t, bool renounce, string memory reason) internal {
        items.push(Item(label, t, renounce ? Action.RenounceOwnership : Action.TransferOwnership, 0, reason, false));
    }

    function _role(string memory label, address t, bytes32 role, string memory reason) internal {
        items.push(Item(label, t, Action.RenounceRole, role, reason, false));
    }

    function _roleNoAdmin(string memory label, address t, string memory reason) internal {
        items.push(Item(label, t, Action.RenounceRole, DEFAULT_ADMIN, reason, true));
    }

    function _keepRole(string memory label, address t, bytes32 role, address holder) internal {
        keeps.push(Keep(label, t, role, false, holder));
    }

    function _keepOwner(string memory label, address t, address holder) internal {
        keeps.push(Keep(label, t, 0, true, holder));
    }

    // ════════════════════════════════════════════════════════════════════════
    // 狀態、檢查、驗證
    // ════════════════════════════════════════════════════════════════════════

    function _state(Item storage it) internal view returns (State) {
        if (it.action == Action.RenounceRole) {
            return IAccessControlMin(it.target).hasRole(it.role, LEAKED) ? State.Pending : State.Done;
        }
        address o = IOwnable(it.target).owner();
        if (o == LEAKED) return State.Pending;
        if (it.action == Action.RenounceOwnership && o == address(0)) return State.Done;
        if (it.action == Action.TransferOwnership && o == newOwner) return State.Done;
        return State.NotHeld; // 已被別人接手（例如先前手動移交）：不碰
    }

    function _printPlan() internal view {
        console.log(unicode"== 凍結舊部署：外洩地址", LEAKED);
        console.log("   chainId", block.chainid, unicode" 外洩地址 ETH 餘額 (wei)", LEAKED.balance);
        console.log(unicode"   項目數", items.length, unicode" 保留檢查數", keeps.length);
        if (newOwner != address(0)) console.log(unicode"   adapter 新 owner", newOwner);
        uint256 pending;
        for (uint256 i = 0; i < items.length; i++) {
            Item storage it = items[i];
            State s = _state(it);
            if (s == State.Pending) pending++;
            string memory act = it.action == Action.RenounceOwnership
                ? "renounceOwnership()"
                : it.action == Action.TransferOwnership
                    ? "transferOwnership(newOwner)"
                    : string.concat("renounceRole(", _roleName(it.role), ")");
            string memory st = s == State.Pending ? "PENDING" : s == State.Done ? "done" : "not-held(skip)";
            console.log(string.concat(
                "  [", vm.toString(i + 1), "] ", st, "  ", it.label, " ", vm.toString(it.target), "  ", act,
                it.intentionalNoAdmin ? "  [INTENTIONAL: no admin afterwards]" : ""
            ));
            console.log(string.concat("        why: ", it.reason));
        }
        console.log(string.concat(unicode"   待處理 ", vm.toString(pending), unicode" 筆"));
    }

    function _checkKeeps(string memory phase) internal view {
        for (uint256 i = 0; i < keeps.length; i++) {
            Keep storage k = keeps[i];
            bool ok = k.isOwner
                ? IOwnable(k.target).owner() == k.holder
                : IAccessControlMin(k.target).hasRole(k.role, k.holder);
            if (!ok) revert KeepBroken(k.label, k.target, k.holder);
        }
        console.log(string.concat(unicode"   保留清單（", phase, unicode"）全部成立：", vm.toString(keeps.length), unicode" 項"));
    }

    /// 放棄 DEFAULT_ADMIN 前：除了刻意無 admin 的項目，保留清單裡必須有同一合約的另一個 admin。
    function _checkAdminsBeforeRenounce() internal view {
        for (uint256 i = 0; i < items.length; i++) {
            Item storage it = items[i];
            if (it.action != Action.RenounceRole || it.role != DEFAULT_ADMIN || it.intentionalNoAdmin) continue;
            bool found;
            for (uint256 j = 0; j < keeps.length; j++) {
                Keep storage k = keeps[j];
                if (k.target == it.target && !k.isOwner && k.role == DEFAULT_ADMIN && k.holder != LEAKED
                    && IAccessControlMin(k.target).hasRole(DEFAULT_ADMIN, k.holder)) {
                    found = true;
                    break;
                }
            }
            if (!found) revert OtherAdminMissing(it.label, it.target);
        }
    }

    function _verifyAll() internal view {
        uint256 bad;
        for (uint256 i = 0; i < items.length; i++) {
            Item storage it = items[i];
            if (it.action == Action.RenounceRole) {
                if (IAccessControlMin(it.target).hasRole(it.role, LEAKED)) revert StillHeld(it.label, it.target);
            } else {
                address o = IOwnable(it.target).owner();
                if (o == LEAKED) revert StillHeld(it.label, it.target);
                address want = it.action == Action.TransferOwnership ? newOwner : address(0);
                if (o != want) {
                    // 不是外洩地址就達成凍結目的；但與計畫不符要讓人看見。
                    console.log(string.concat(unicode"   注意：", it.label, unicode" owner 不是預期值：", vm.toString(o)));
                    bad++;
                }
            }
        }
        // 外洩地址在每一顆項目合約上，連其他已知角色也不能持有。
        bytes32[6] memory all = [DEFAULT_ADMIN, KEEPER_ROLE, GUARDIAN_ROLE, RISK_ROLE, PAUSER_ROLE, MINTER_ROLE];
        for (uint256 i = 0; i < items.length; i++) {
            if (items[i].action != Action.RenounceRole) continue;
            for (uint256 r = 0; r < all.length; r++) {
                if (IAccessControlMin(items[i].target).hasRole(all[r], LEAKED)) revert StillHeld(items[i].label, items[i].target);
            }
        }
        _checkKeeps(unicode"執行後");
        console.log(string.concat(
            unicode"== 讀回完成：外洩地址在 ", vm.toString(items.length), unicode" 個項目上都已無權限",
            bad == 0 ? "" : string.concat(unicode"（", vm.toString(bad), unicode" 項 owner 與預期不同，見上方）")
        ));
    }

    function _roleName(bytes32 r) internal pure returns (string memory) {
        if (r == DEFAULT_ADMIN) return "DEFAULT_ADMIN_ROLE";
        if (r == KEEPER_ROLE) return "KEEPER_ROLE";
        if (r == GUARDIAN_ROLE) return "GUARDIAN_ROLE";
        if (r == RISK_ROLE) return "RISK_ROLE";
        if (r == PAUSER_ROLE) return "PAUSER_ROLE";
        if (r == MINTER_ROLE) return "MINTER_ROLE";
        return vm.toString(r);
    }
}

interface IOwnable {
    function owner() external view returns (address);
    function renounceOwnership() external;
    function transferOwnership(address newOwner) external;
}

interface IAccessControlMin {
    function hasRole(bytes32 role, address account) external view returns (bool);
    function renounceRole(bytes32 role, address callerConfirmation) external;
}
