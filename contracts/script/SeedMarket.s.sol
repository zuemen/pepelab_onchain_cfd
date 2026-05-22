// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/MockUSDC.sol";
import "../src/TraderStake.sol";
import "../src/StrategyRegistry.sol";
import "../src/PerpetualExchange.sol";
import "../src/CopyTracker.sol";

/// @notice Seeds 50 fake traders + deployer star account on Sepolia.
///         Usage:
///   forge script script/SeedMarket.s.sol \
///     --rpc-url $SEPOLIA_RPC_URL --private-key $PRIVATE_KEY \
///     --broadcast --skip-simulation --slow -v
///
///   Required env vars:
///     PRIVATE_KEY, MOCK_USDC, TRADER_STAKE, STRATEGY_REGISTRY,
///     PERPETUAL_EXCHANGE, COPY_TRACKER
///
///   After running: Marketplace shows 50+ traders, deployer has followers,
///   whale wall has large trades, history has 150+ records.
contract SeedMarket is Script {
    // Asset IDs — keccak256(symbol) matches on-chain IDs
    bytes32 constant SBTC   = keccak256("sBTC");
    bytes32 constant SETH   = keccak256("sETH");
    bytes32 constant SAAPL  = keccak256("sAAPL");
    bytes32 constant STSLA  = keccak256("sTSLA");
    bytes32 constant SGOLD  = keccak256("sGOLD");
    bytes32 constant SBOND  = keccak256("sBOND");
    bytes32 constant SNVDA  = keccak256("sNVDA");
    bytes32 constant SMSFT  = keccak256("sMSFT");
    bytes32 constant SGOOGL = keccak256("sGOOGL");
    bytes32 constant SICLN  = keccak256("sICLN");
    bytes32 constant SESGU  = keccak256("sESGU");

    // Standard Anvil/Hardhat test mnemonic; indices 1–50 used for traders
    string constant MNEMONIC = "test test test test test test test test test test test junk";

    uint256 constant EXEC_FEE    = 0.001 ether;
    uint256 constant TRADER_ETH  = 0.025 ether;
    uint256 constant TRADER_USDC = 30_000e18;
    uint256 constant STAKE_AMT   = 200e18;
    uint256 constant DEPOSIT_AMT = 5_000e18;
    uint256 constant MGN_PER_POS = 1_000e18;
    uint256 constant FOLLOW_USDC = 2_000e18;  // per-follower margin for followTrader

    MockUSDC          usdc;
    TraderStake       stakeC;
    StrategyRegistry  registry;
    PerpetualExchange exchange;
    CopyTracker       copyT;

    function run() external {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address star       = vm.addr(deployerPk);

        usdc     = MockUSDC(vm.envAddress("MOCK_USDC"));
        stakeC   = TraderStake(vm.envAddress("TRADER_STAKE"));
        registry = StrategyRegistry(vm.envAddress("STRATEGY_REGISTRY"));
        exchange = PerpetualExchange(vm.envAddress("PERPETUAL_EXCHANGE"));
        copyT    = CopyTracker(vm.envAddress("COPY_TRACKER"));

        // ── Section A: Star (deployer) ────────────────────────────────────────
        vm.startBroadcast(deployerPk);

        usdc.mint(star, 200_000e18);

        usdc.approve(address(stakeC), 5_000e18);
        try stakeC.stake(5_000e18) {} catch {}

        try registry.registerTrader("PepeFi Alpha") {} catch {}

        StrategyRegistry.Allocation[] memory starAlloc = _starStrategy();
        try registry.publishStrategy(starAlloc) {} catch {}

        usdc.approve(address(exchange), 100_000e18);
        try exchange.depositMargin(100_000e18) {} catch {}

        // 8 positions: 4 matching strategy allocs + 4 extras for history depth
        try exchange.openPosition{value: EXEC_FEE}(SBTC,  true,  10_000e18, 1) {} catch {}
        try exchange.openPosition{value: EXEC_FEE}(SMSFT, true,  10_000e18, 1) {} catch {}
        try exchange.openPosition{value: EXEC_FEE}(SICLN, true,  10_000e18, 1) {} catch {}
        try exchange.openPosition{value: EXEC_FEE}(SBOND, true,  10_000e18, 1) {} catch {}
        try exchange.openPosition{value: EXEC_FEE}(SETH,  true,  10_000e18, 1) {} catch {}
        try exchange.openPosition{value: EXEC_FEE}(SAAPL, true,  10_000e18, 1) {} catch {}
        try exchange.openPosition{value: EXEC_FEE}(SESGU, true,  10_000e18, 1) {} catch {}
        try exchange.openPosition{value: EXEC_FEE}(SGOLD, false, 10_000e18, 1) {} catch {}

        vm.stopBroadcast();

        console.log("Star seeded:", star);

        // ── Section B: 50 traders ─────────────────────────────────────────────
        for (uint256 i = 1; i <= 50; i++) {
            uint256 pk     = vm.deriveKey(MNEMONIC, uint32(i));
            address trader = vm.addr(pk);

            // Deployer funds the trader
            vm.startBroadcast(deployerPk);
            usdc.mint(trader, TRADER_USDC);
            (bool ok,) = payable(trader).call{value: TRADER_ETH}("");
            if (!ok) console.log("ETH fund failed for trader", i);
            vm.stopBroadcast();

            // Trader self-operates
            vm.startBroadcast(pk);

            usdc.approve(address(stakeC), STAKE_AMT);
            try stakeC.stake(STAKE_AMT) {} catch {}

            try registry.registerTrader(_name(i)) {} catch {}

            StrategyRegistry.Allocation[] memory alloc = _strategy(i);
            try registry.publishStrategy(alloc) {} catch {}

            usdc.approve(address(exchange), DEPOSIT_AMT);
            try exchange.depositMargin(DEPOSIT_AMT) {} catch {}

            _openPositions(i, MGN_PER_POS);

            vm.stopBroadcast();

            console.log("Seeded trader", i);
        }

        // ── Section C: 15 followers ───────────────────────────────────────────
        // Star strategy has 4 allocations → follower sends EXEC_FEE × 4
        for (uint256 i = 1; i <= 15; i++) {
            uint256 pk = vm.deriveKey(MNEMONIC, uint32(i));

            vm.startBroadcast(pk);

            usdc.approve(address(copyT), FOLLOW_USDC);
            try copyT.followTrader{value: EXEC_FEE * 4}(star, FOLLOW_USDC) {} catch {}

            vm.stopBroadcast();

            console.log("Follower seeded:", i);
        }

        console.log("SeedMarket complete. Star:", star);
    }

    // ── Star strategy (4 allocs, equal weight) ───────────────────────────────

    function _starStrategy() internal pure returns (StrategyRegistry.Allocation[] memory alloc) {
        alloc = new StrategyRegistry.Allocation[](4);
        alloc[0] = StrategyRegistry.Allocation(SBTC,  2500, true, 1);
        alloc[1] = StrategyRegistry.Allocation(SMSFT, 2500, true, 1);
        alloc[2] = StrategyRegistry.Allocation(SICLN, 2500, true, 1);
        alloc[3] = StrategyRegistry.Allocation(SBOND, 2500, true, 1);
    }

    // ── 7 strategy variants (i % 7) ──────────────────────────────────────────

    function _strategy(uint256 i) internal pure returns (StrategyRegistry.Allocation[] memory alloc) {
        uint256 v = i % 7;
        if (v == 0) {
            // Whale Diversified: 5 assets × 2000 bps, all long 1x
            alloc = new StrategyRegistry.Allocation[](5);
            alloc[0] = StrategyRegistry.Allocation(SBTC,  2000, true, 1);
            alloc[1] = StrategyRegistry.Allocation(SETH,  2000, true, 1);
            alloc[2] = StrategyRegistry.Allocation(SAAPL, 2000, true, 1);
            alloc[3] = StrategyRegistry.Allocation(SMSFT, 2000, true, 1);
            alloc[4] = StrategyRegistry.Allocation(SGOLD, 2000, true, 1);
        } else if (v == 1) {
            // ESG Pioneer: ICLN + MSFT + BOND + ETH
            alloc = new StrategyRegistry.Allocation[](4);
            alloc[0] = StrategyRegistry.Allocation(SICLN, 3000, true, 1);
            alloc[1] = StrategyRegistry.Allocation(SMSFT, 3000, true, 1);
            alloc[2] = StrategyRegistry.Allocation(SBOND, 2000, true, 1);
            alloc[3] = StrategyRegistry.Allocation(SETH,  2000, true, 1);
        } else if (v == 2) {
            // Crypto Bull: BTC + ETH leveraged, GOLD buffer
            alloc = new StrategyRegistry.Allocation[](3);
            alloc[0] = StrategyRegistry.Allocation(SBTC,  5000, true, 2);
            alloc[1] = StrategyRegistry.Allocation(SETH,  3000, true, 2);
            alloc[2] = StrategyRegistry.Allocation(SGOLD, 2000, true, 1);
        } else if (v == 3) {
            // Tech Growth: AAPL + NVDA leveraged + GOOGL + MSFT
            alloc = new StrategyRegistry.Allocation[](4);
            alloc[0] = StrategyRegistry.Allocation(SAAPL,  3000, true, 1);
            alloc[1] = StrategyRegistry.Allocation(SNVDA,  3000, true, 2);
            alloc[2] = StrategyRegistry.Allocation(SGOOGL, 2000, true, 1);
            alloc[3] = StrategyRegistry.Allocation(SMSFT,  2000, true, 1);
        } else if (v == 4) {
            // Green ETF: ESGU + ICLN + BOND
            alloc = new StrategyRegistry.Allocation[](3);
            alloc[0] = StrategyRegistry.Allocation(SESGU, 4000, true, 1);
            alloc[1] = StrategyRegistry.Allocation(SICLN, 4000, true, 1);
            alloc[2] = StrategyRegistry.Allocation(SBOND, 2000, true, 1);
        } else if (v == 5) {
            // RWA Balanced: GOLD + BOND + AAPL long, ETH short hedge
            alloc = new StrategyRegistry.Allocation[](4);
            alloc[0] = StrategyRegistry.Allocation(SGOLD, 2500, true,  1);
            alloc[1] = StrategyRegistry.Allocation(SBOND, 2500, true,  1);
            alloc[2] = StrategyRegistry.Allocation(SAAPL, 2500, true,  1);
            alloc[3] = StrategyRegistry.Allocation(SETH,  2500, false, 1);
        } else {
            // Speculative: TSLA + NVDA long leveraged, BTC short, GOOGL long
            alloc = new StrategyRegistry.Allocation[](4);
            alloc[0] = StrategyRegistry.Allocation(STSLA,  3000, true,  2);
            alloc[1] = StrategyRegistry.Allocation(SNVDA,  3000, true,  2);
            alloc[2] = StrategyRegistry.Allocation(SBTC,   2000, false, 1);
            alloc[3] = StrategyRegistry.Allocation(SGOOGL, 2000, true,  1);
        }
    }

    // ── 5 position styles (i % 5); whales (i % 7 == 0) get 2x leverage ──────

    function _openPositions(uint256 i, uint256 mgn) internal {
        uint256 lev   = (i % 7 == 0) ? 2 : 1;
        uint256 style = i % 5;

        if (style == 0) {
            // Crypto + Commodity longs
            try exchange.openPosition{value: EXEC_FEE}(SBTC,  true,  mgn, lev) {} catch {}
            try exchange.openPosition{value: EXEC_FEE}(SETH,  true,  mgn, lev) {} catch {}
            try exchange.openPosition{value: EXEC_FEE}(SGOLD, true,  mgn, lev) {} catch {}
        } else if (style == 1) {
            // Tech equity longs
            try exchange.openPosition{value: EXEC_FEE}(SAAPL, true, mgn, lev) {} catch {}
            try exchange.openPosition{value: EXEC_FEE}(SMSFT, true, mgn, lev) {} catch {}
            try exchange.openPosition{value: EXEC_FEE}(SNVDA, true, mgn, lev) {} catch {}
        } else if (style == 2) {
            // Mixed: ETH + AAPL long, BTC short
            try exchange.openPosition{value: EXEC_FEE}(SETH,  true,  mgn, lev) {} catch {}
            try exchange.openPosition{value: EXEC_FEE}(SAAPL, true,  mgn, lev) {} catch {}
            try exchange.openPosition{value: EXEC_FEE}(SBTC,  false, mgn, lev) {} catch {}
        } else if (style == 3) {
            // ESG ETF longs
            try exchange.openPosition{value: EXEC_FEE}(SESGU, true, mgn, lev) {} catch {}
            try exchange.openPosition{value: EXEC_FEE}(SICLN, true, mgn, lev) {} catch {}
            try exchange.openPosition{value: EXEC_FEE}(SBOND, true, mgn, lev) {} catch {}
        } else {
            // Speculative: TSLA + BTC long, ETH short
            try exchange.openPosition{value: EXEC_FEE}(STSLA, true,  mgn, lev) {} catch {}
            try exchange.openPosition{value: EXEC_FEE}(SBTC,  true,  mgn, lev) {} catch {}
            try exchange.openPosition{value: EXEC_FEE}(SETH,  false, mgn, lev) {} catch {}
        }
    }

    // ── Name helper ───────────────────────────────────────────────────────────

    function _name(uint256 i) internal pure returns (string memory) {
        if (i ==  1) return "Alpha Whale";
        if (i ==  2) return "ETH Maxi";
        if (i ==  3) return "DeFi Sage";
        if (i ==  4) return "Green Investor";
        if (i ==  5) return "RWA Pioneer";
        if (i ==  6) return "Pepe Trader";
        if (i ==  7) return "Mega Bull";
        if (i ==  8) return "Quant Alpha";
        if (i ==  9) return "ESG Hawk";
        if (i == 10) return "Meme Lord";
        if (i % 7 == 0) return string.concat("Whale", _itoa(uint32(i)));
        if (i % 3 == 0) return string.concat("Investor", _itoa(uint32(i)));
        return string.concat("Trader", _itoa(uint32(i)));
    }

    function _itoa(uint32 n) internal pure returns (string memory) {
        if (n == 0) return "0";
        bytes memory rev = new bytes(10);
        uint256 len;
        uint32  tmp = n;
        while (tmp > 0) {
            rev[len++] = bytes1(uint8(48 + tmp % 10));
            tmp /= 10;
        }
        bytes memory result = new bytes(len);
        for (uint256 j; j < len; j++) {
            result[j] = rev[len - 1 - j];
        }
        return string(result);
    }
}
