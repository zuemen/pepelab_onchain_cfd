// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/MockUSDC.sol";
import "../src/PerpetualExchange.sol";
import "../src/StrategyRegistry.sol";
import "../src/TraderStake.sol";

/// @notice Seeds 12 demo whale traders on Sepolia (or Anvil).
///         Run with:
///   forge script script/SeedWhales.s.sol \
///     --rpc-url $SEPOLIA_RPC_URL --private-key $PRIVATE_KEY \
///     --broadcast --skip-simulation --slow -v
///
///   Required env vars: USDC_ADDR, REGISTRY_ADDR, STAKE_ADDR, EXCHANGE_ADDR
contract SeedWhales is Script {
    bytes32 constant SBTC  = keccak256("sBTC");
    bytes32 constant SETH  = keccak256("sETH");
    bytes32 constant SAAPL = keccak256("sAAPL");
    bytes32 constant STSLA = keccak256("sTSLA");
    bytes32 constant SGOLD = keccak256("sGOLD");
    bytes32 constant SBOND = keccak256("sBOND");

    string constant MNEMONIC =
        "test test test test test test test test test test test junk";

    function run() external {
        address usdcAddr     = vm.envAddress("USDC_ADDR");
        address registryAddr = vm.envAddress("REGISTRY_ADDR");
        address stakeAddr    = vm.envAddress("STAKE_ADDR");
        address exchangeAddr = vm.envAddress("EXCHANGE_ADDR");

        MockUSDC          usdc     = MockUSDC(usdcAddr);
        PerpetualExchange exchange = PerpetualExchange(exchangeAddr);
        StrategyRegistry  registry = StrategyRegistry(registryAddr);
        TraderStake       ts       = TraderStake(stakeAddr);

        uint256 execFee = exchange.executionFee();

        for (uint32 i = 0; i < 12; i++) {
            // Indices 1-12 — index 0 is reserved for the deployer in Seed.s.sol
            uint256 pk     = vm.deriveKey(MNEMONIC, i + 1);
            address trader = vm.addr(pk);
            string memory name = _nameFor(i);

            bool    isWhale  = (i % 4 == 0);
            uint256 stakeAmt = (uint256(i % 3) + 1) * 300e18; // 300 / 600 / 900
            uint256 mgnTotal = isWhale ? 5_000e18 : 800e18;
            uint256 mgn1     = isWhale ? 2_000e18 : 300e18;
            uint256 mgn2     = isWhale ? 1_500e18 : 200e18;

            // ── Step 1: deployer funds the trader ─────────────────────────────
            vm.startBroadcast();
            {
                (bool ok,) = payable(trader).call{value: 0.025 ether}("");
                require(ok, "ETH fund failed");
                usdc.mint(trader, 20_000e18);
            }
            vm.stopBroadcast();

            // ── Step 2: trader self-registers, stakes, publishes, opens ───────
            vm.startBroadcast(pk);
            {
                // Stake (try — may already be staked on re-run)
                usdc.approve(stakeAddr, stakeAmt);
                try ts.stake(stakeAmt) {} catch {}

                // Register display name
                try registry.registerTrader(name) {} catch {}

                // Publish strategy
                StrategyRegistry.Allocation[] memory allocs = _strategyFor(i);
                try registry.publishStrategy(allocs) {} catch {}

                // Deposit margin into exchange
                usdc.approve(exchangeAddr, mgnTotal);
                exchange.depositMargin(mgnTotal);

                // Open two positions (wrap in try in case oracle price missing)
                (bytes32 a1, bool l1, uint256 lv1,
                 bytes32 a2, bool l2, uint256 lv2) = _positionsFor(i);

                try exchange.openPosition{value: execFee}(a1, l1, mgn1, lv1) {}
                catch (bytes memory reason) {
                    console.log("  pos1 skipped:", name);
                    console.logBytes(reason);
                }
                try exchange.openPosition{value: execFee}(a2, l2, mgn2, lv2) {}
                catch (bytes memory reason) {
                    console.log("  pos2 skipped:", name);
                    console.logBytes(reason);
                }
            }
            vm.stopBroadcast();

            console.log("Seeded:", name, trader);
        }
    }

    // ── Strategy library ─────────────────────────────────────────────────────

    function _strategyFor(uint32 i)
        internal pure
        returns (StrategyRegistry.Allocation[] memory allocs)
    {
        if (i == 0) {
            // Whale Alpha — BTC + ETH crypto long
            allocs = new StrategyRegistry.Allocation[](2);
            allocs[0] = StrategyRegistry.Allocation(SBTC,  6000, true,  2);
            allocs[1] = StrategyRegistry.Allocation(SETH,  4000, true,  2);

        } else if (i == 1) {
            // Gold Bull — Gold heavy + Bond buffer
            allocs = new StrategyRegistry.Allocation[](2);
            allocs[0] = StrategyRegistry.Allocation(SGOLD, 7000, true,  1);
            allocs[1] = StrategyRegistry.Allocation(SBOND, 3000, true,  1);

        } else if (i == 2) {
            // ESG Master — AAPL + Bond + ETH, ESG friendly
            allocs = new StrategyRegistry.Allocation[](3);
            allocs[0] = StrategyRegistry.Allocation(SAAPL, 4000, true,  1);
            allocs[1] = StrategyRegistry.Allocation(SBOND, 4000, true,  1);
            allocs[2] = StrategyRegistry.Allocation(SETH,  2000, true,  1);

        } else if (i == 3) {
            // Crypto Degen — high leverage long BTC + short ETH
            allocs = new StrategyRegistry.Allocation[](2);
            allocs[0] = StrategyRegistry.Allocation(SBTC,  5000, true,  5);
            allocs[1] = StrategyRegistry.Allocation(SETH,  5000, false, 5);

        } else if (i == 4) {
            // Bond Steady — defensive bond + gold
            allocs = new StrategyRegistry.Allocation[](2);
            allocs[0] = StrategyRegistry.Allocation(SBOND, 6000, true,  1);
            allocs[1] = StrategyRegistry.Allocation(SGOLD, 4000, true,  1);

        } else if (i == 5) {
            // Tesla Maxi — equity growth
            allocs = new StrategyRegistry.Allocation[](2);
            allocs[0] = StrategyRegistry.Allocation(STSLA, 7000, true,  2);
            allocs[1] = StrategyRegistry.Allocation(SAAPL, 3000, true,  1);

        } else if (i == 6) {
            // Diamond Hands — diversified long hold
            allocs = new StrategyRegistry.Allocation[](3);
            allocs[0] = StrategyRegistry.Allocation(SBTC,  4000, true,  1);
            allocs[1] = StrategyRegistry.Allocation(SETH,  3000, true,  1);
            allocs[2] = StrategyRegistry.Allocation(SGOLD, 3000, true,  1);

        } else if (i == 7) {
            // Index Tracker — equal weight across 4 core assets
            allocs = new StrategyRegistry.Allocation[](4);
            allocs[0] = StrategyRegistry.Allocation(SBTC,  2500, true,  1);
            allocs[1] = StrategyRegistry.Allocation(SETH,  2500, true,  1);
            allocs[2] = StrategyRegistry.Allocation(SAAPL, 2500, true,  1);
            allocs[3] = StrategyRegistry.Allocation(STSLA, 2500, true,  1);

        } else if (i == 8) {
            // Macro Trader — gold + bond leveraged inflation hedge
            allocs = new StrategyRegistry.Allocation[](2);
            allocs[0] = StrategyRegistry.Allocation(SGOLD, 5000, true,  2);
            allocs[1] = StrategyRegistry.Allocation(SBOND, 5000, true,  2);

        } else if (i == 9) {
            // Quant Bot — stat-arb: long BTC, short ETH, long TSLA, long GOLD
            allocs = new StrategyRegistry.Allocation[](4);
            allocs[0] = StrategyRegistry.Allocation(SBTC,  3000, true,  2);
            allocs[1] = StrategyRegistry.Allocation(SETH,  3000, false, 2);
            allocs[2] = StrategyRegistry.Allocation(STSLA, 2000, true,  2);
            allocs[3] = StrategyRegistry.Allocation(SGOLD, 2000, true,  1);

        } else if (i == 10) {
            // Green Investor — ESG bond + AAPL
            allocs = new StrategyRegistry.Allocation[](2);
            allocs[0] = StrategyRegistry.Allocation(SBOND, 6000, true,  1);
            allocs[1] = StrategyRegistry.Allocation(SAAPL, 4000, true,  1);

        } else {
            // i == 11 Apple Holder — equity concentrated
            allocs = new StrategyRegistry.Allocation[](2);
            allocs[0] = StrategyRegistry.Allocation(SAAPL, 6000, true,  2);
            allocs[1] = StrategyRegistry.Allocation(STSLA, 4000, true,  2);
        }
    }

    // Returns the two positions each trader opens on-chain
    function _positionsFor(uint32 i) internal pure returns (
        bytes32 a1, bool l1, uint256 lv1,
        bytes32 a2, bool l2, uint256 lv2
    ) {
        if      (i == 0)  { a1=SBTC;  l1=true;  lv1=2; a2=SETH;  l2=true;  lv2=2; }
        else if (i == 1)  { a1=SGOLD; l1=true;  lv1=1; a2=SBOND; l2=true;  lv2=1; }
        else if (i == 2)  { a1=SAAPL; l1=true;  lv1=1; a2=SBOND; l2=true;  lv2=1; }
        else if (i == 3)  { a1=SBTC;  l1=true;  lv1=5; a2=SETH;  l2=false; lv2=5; }
        else if (i == 4)  { a1=SBOND; l1=true;  lv1=1; a2=SGOLD; l2=true;  lv2=1; }
        else if (i == 5)  { a1=STSLA; l1=true;  lv1=2; a2=SAAPL; l2=true;  lv2=1; }
        else if (i == 6)  { a1=SBTC;  l1=true;  lv1=1; a2=SETH;  l2=true;  lv2=1; }
        else if (i == 7)  { a1=SBTC;  l1=true;  lv1=1; a2=SAAPL; l2=true;  lv2=1; }
        else if (i == 8)  { a1=SGOLD; l1=true;  lv1=2; a2=SBOND; l2=true;  lv2=2; }
        else if (i == 9)  { a1=SBTC;  l1=true;  lv1=2; a2=SETH;  l2=false; lv2=2; }
        else if (i == 10) { a1=SBOND; l1=true;  lv1=1; a2=SAAPL; l2=true;  lv2=1; }
        else              { a1=SAAPL; l1=true;  lv1=2; a2=STSLA; l2=true;  lv2=2; }
    }

    function _nameFor(uint32 i) internal pure returns (string memory) {
        if      (i == 0)  return "Whale Alpha";
        else if (i == 1)  return "Gold Bull";
        else if (i == 2)  return "ESG Master";
        else if (i == 3)  return "Crypto Degen";
        else if (i == 4)  return "Bond Steady";
        else if (i == 5)  return "Tesla Maxi";
        else if (i == 6)  return "Diamond Hands";
        else if (i == 7)  return "Index Tracker";
        else if (i == 8)  return "Macro Trader";
        else if (i == 9)  return "Quant Bot";
        else if (i == 10) return "Green Investor";
        else              return "Apple Holder";
    }
}
