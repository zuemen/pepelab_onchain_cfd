// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "../src/MockCarbonCredit.sol";
import "../src/CarbonRetirement.sol";
import "../src/PlatformFeeSplitter.sol";
import "../src/FeeRouter.sol";
import "../src/InsuranceVault.sol";

/// @title  DeployCarbonRetirement — 碳權退役（模擬碳權）堆疊（issue #105、ADR-022）
/// @notice **尚未部署。** 這支腳本只在擁有者決定上線時執行；本 PR 沒有送出任何交易。
///
///         部署內容：
///         1. `MockCarbonCredit`（**模擬碳權**，本專案自行鑄造，不對應任何真實減碳）並發行
///            初始庫存給模擬賣方 `CARBON_SELLER`。
///         2. `CarbonRetirement(usdc, credit, seller, pricePerTonne)`：用預算買入並當場銷毀碳權。
///         3. `PlatformFeeSplitter(usdc, treasury, retirement, carbonShareBps)`：平台份額分流。
///         4. 預設（`CARBON_DEPLOY_ROUTER=true`）再部署一組獨立的 `InsuranceVault` + `FeeRouter`，
///            router 的 `platformTreasury` 就是 splitter，並 `bindFeeRouter`。這和
///            `DeployX402Router.s.sol` 是同一個模式：`FeeRouter` 原始碼一行不改，70/20/10 不變，
///            只是「平台收款人」換成分流合約。x402 收入要改走這組時，把 agent 的
///            `X402_FEE_ROUTER` 指到新 router（擁有者操作，見 ADR-022）。
///            `CARBON_DEPLOY_ROUTER=false` 時只部署 1–3，把 splitter 位址當成下一次
///            FeeRouter 部署的 treasury，部署後由同一個 broadcaster 呼叫 `bindFeeRouter`。
///
///         **不做的事**：不碰現行 Base Sepolia 的 FeeRouter／exchange／CopyTracker／InsuranceVault
///         （現行 FeeRouter 的 `platformTreasury` 是 immutable，換不掉；CopyTracker 的 `feeRouter`
///         也是 immutable）。不改 `frontend/src/contracts/addresses.ts`；前端讀
///         `VITE_CARBON_RETIREMENT`，未設定時整個區塊不顯示。
///
///         安全：broadcaster／treasury／seller／credit owner 若是已知外洩地址一律拒絕；只允許本機鏈
///         （anvil 31337）與 `CARBON_CHAIN_ID` 明確指定的鏈。
///
///         用法（keystore，不在指令列放私鑰；先 dry-run，不加 --broadcast）：
///           cd contracts
///           CARBON_USDC=0x… CARBON_CHAIN_ID=84532 \
///           forge script script/DeployCarbonRetirement.s.sol:DeployCarbonRetirement \
///             --rpc-url https://sepolia.base.org --account <keystore> --sender <地址> [--broadcast]
///
///         環境變數：
///           BROADCASTER              覆寫 broadcaster（預設 msg.sender）
///           CARBON_USDC              結算幣（必填）；6 位或 18 位皆可
///           CARBON_TREASURY          平台份額扣掉碳權後的收款人（預設 broadcaster）
///           CARBON_SELLER            模擬賣方：持有庫存、收取購買款（預設 broadcaster）。
///                                    與 broadcaster 相同時腳本代為 approve；否則印出賣方要送的 approve
///           CARBON_SHARE_BPS         平台份額中導向退役的比例，bps（預設 2500 = 平台 20% 的 1/4 = 手續費 5%）
///           CARBON_PRICE_PER_TONNE   每公噸（1e18 單位）的價格，結算幣最小單位（預設 10 × 10^decimals，模擬價）
///           CARBON_INITIAL_TONNES    初始庫存，整數公噸（預設 100000）
///           CARBON_CREDIT_OWNER      MockCarbonCredit 的最終 owner（預設 broadcaster）
///           CARBON_DEPLOY_ROUTER     true（預設）部署獨立的 FeeRouter + InsuranceVault 並綁定
///           CARBON_CHAIN_ID          非 31337 時必須等於目前 chainId
contract DeployCarbonRetirement is Script {
    /// Mirrors agent/shared/src/payoutSafety.ts COMPROMISED_ADDRESSES.
    address internal constant LEAKED_DEPLOYER = 0xE80A81360608C1342e66743F70a00f75d792Eb93;
    uint256 internal constant ANVIL_CHAIN_ID = 31337;

    uint256 internal constant DEFAULT_SHARE_BPS      = 2500;
    uint256 internal constant DEFAULT_PRICE_WHOLE    = 10;       // 10 settlement-token units per tonne (simulated)
    uint256 internal constant DEFAULT_INITIAL_TONNES = 100_000;

    struct Config {
        address broadcaster;
        address usdc;
        address treasury;
        address seller;
        address creditOwner;
        uint256 carbonShareBps;
        uint256 pricePerTonne;      // 0 = derive from token decimals
        uint256 initialTonnes;      // whole tonnes
        bool    deployRouter;
    }

    struct Deployment {
        MockCarbonCredit    credit;
        CarbonRetirement    retirement;
        PlatformFeeSplitter splitter;
        FeeRouter           router;      // zero when deployRouter = false
        InsuranceVault      vault;       // zero when deployRouter = false
    }

    error CompromisedAddress(string role, address who);
    error ChainNotConfirmed(uint256 chainId);
    error MissingUsdc();

    function run() external returns (Deployment memory d) {
        Config memory c = loadConfig(msg.sender);
        checkChain(block.chainid, vm.envOr("CARBON_CHAIN_ID", uint256(0)));
        validate(c);

        vm.startBroadcast(c.broadcaster);
        d = deploy(c);
        vm.stopBroadcast();

        report(c, d);
    }

    // ── 設定 ───────────────────────────────────────────────────────────────────

    function loadConfig(address broadcaster) public view returns (Config memory c) {
        c.broadcaster    = vm.envOr("BROADCASTER", broadcaster);
        c.usdc           = vm.envOr("CARBON_USDC", address(0));
        c.treasury       = vm.envOr("CARBON_TREASURY", c.broadcaster);
        c.seller         = vm.envOr("CARBON_SELLER", c.broadcaster);
        c.creditOwner    = vm.envOr("CARBON_CREDIT_OWNER", c.broadcaster);
        c.carbonShareBps = vm.envOr("CARBON_SHARE_BPS", DEFAULT_SHARE_BPS);
        c.pricePerTonne  = vm.envOr("CARBON_PRICE_PER_TONNE", uint256(0));
        c.initialTonnes  = vm.envOr("CARBON_INITIAL_TONNES", DEFAULT_INITIAL_TONNES);
        c.deployRouter   = vm.envOr("CARBON_DEPLOY_ROUTER", true);
    }

    function checkChain(uint256 chainId, uint256 confirmed) public pure {
        if (chainId == ANVIL_CHAIN_ID) return;
        if (confirmed != chainId) revert ChainNotConfirmed(chainId);
    }

    function isCompromised(address a) public pure returns (bool) {
        return a == LEAKED_DEPLOYER;
    }

    function validate(Config memory c) public pure {
        if (c.usdc == address(0)) revert MissingUsdc();
        if (isCompromised(c.broadcaster)) revert CompromisedAddress("broadcaster", c.broadcaster);
        if (isCompromised(c.treasury)) revert CompromisedAddress("treasury", c.treasury);
        if (isCompromised(c.seller)) revert CompromisedAddress("seller", c.seller);
        if (isCompromised(c.creditOwner)) revert CompromisedAddress("creditOwner", c.creditOwner);
    }

    /// @notice Price per tonne in settlement-token base units (explicit, or 10 whole tokens).
    function resolvePrice(Config memory c) public view returns (uint256) {
        if (c.pricePerTonne != 0) return c.pricePerTonne;
        return DEFAULT_PRICE_WHOLE * 10 ** IERC20Metadata(c.usdc).decimals();
    }

    // ── 部署（不含 broadcast，測試可直接呼叫）─────────────────────────────────────

    /// @dev 呼叫者（broadcast 時是 broadcaster；測試時是本合約）必須等於 c.broadcaster：
    ///      它是 MockCarbonCredit 的初始 owner（才能 issue）、splitter 的 deployer（才能 bind）、
    ///      新 InsuranceVault 的 owner（才能 setFeeRouter）。
    function deploy(Config memory c) public returns (Deployment memory d) {
        uint256 price = resolvePrice(c);

        d.credit     = new MockCarbonCredit(c.broadcaster);
        d.retirement = new CarbonRetirement(c.usdc, address(d.credit), c.seller, price);
        d.splitter   = new PlatformFeeSplitter(c.usdc, c.treasury, address(d.retirement), c.carbonShareBps);

        if (c.initialTonnes > 0) d.credit.issue(c.seller, c.initialTonnes * 1e18);
        if (c.seller == c.broadcaster) d.credit.approve(address(d.retirement), type(uint256).max);

        if (c.deployRouter) {
            d.vault  = new InsuranceVault(c.usdc);
            d.router = new FeeRouter(c.usdc, address(d.splitter), address(d.vault));
            d.vault.setFeeRouter(address(d.router));
            d.splitter.bindFeeRouter(address(d.router));
        }

        if (c.creditOwner != c.broadcaster) d.credit.transferOwnership(c.creditOwner);
    }

    function report(Config memory c, Deployment memory d) internal view {
        console.log("=== Carbon retirement stack (SIMULATED carbon credits) ===");
        console.log("MockCarbonCredit   :", address(d.credit));
        console.log("CarbonRetirement   :", address(d.retirement));
        console.log("PlatformFeeSplitter:", address(d.splitter));
        console.log("settlement token   :", c.usdc);
        console.log("treasury           :", c.treasury);
        console.log("seller (simulated) :", c.seller);
        console.log("carbonShareBps     :", c.carbonShareBps);
        console.log("pricePerTonne      :", d.retirement.pricePerTonne());
        if (c.seller != c.broadcaster) {
            console.log("  seller must call approve(CarbonRetirement, max) on MockCarbonCredit");
        }
        if (c.deployRouter) {
            console.log("FeeRouter (payee = splitter):", address(d.router));
            console.log("InsuranceVault (paired)     :", address(d.vault));
            console.log("  router owner may setExchange / setCopyTracker; x402: set agent X402_FEE_ROUTER");
        } else {
            console.log("FeeRouter: not deployed. Use the splitter as the next FeeRouter's treasury,");
            console.log("  then the broadcaster calls splitter.bindFeeRouter(router).");
        }
        console.log("frontend: set VITE_CARBON_RETIREMENT to the CarbonRetirement address");
    }
}
