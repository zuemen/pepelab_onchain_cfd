// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/PepeIncentives.sol";
import "../src/PepeToken.sol";

/// @notice Set a fresh PepeIncentives to the GameFi reward values and fund its pool.
///
///   GameFi (/pepe) spends PEPE on potions, gacha and skins; /rewards is where the
///   player earns it by using the platform. The contract's built-in defaults were set
///   before GameFi had prices: one 1,000 USDC × 5 position mined 25 PEPE, while the
///   cheapest potion costs 100. These values let a new player who opens one position
///   and copies one trader on day one reach 幼蛙 (Lv.5, ~1,600 PEPE), and keep 蛙神
///   (Lv.30, ~70,000 PEPE) a few weeks of real use away. Decided 2026-10-20.
///
///     trade mining   2% of notional, max 1,000 PEPE per position
///     copy reward    500 PEPE to each side, once per (follower, trader)
///     tiers          5k / 25k / 100k / 500k notional → 1k / 3k / 10k / 40k PEPE
///
///   All of these stay owner-tunable afterwards (setTradeMining / setCopyReward /
///   setTierParams); /rewards reads them from the chain, so retuning needs no PR.
///
///   The pool is minted, not transferred: the broadcaster must own PepeToken (the
///   deployer does). The old Base Sepolia instance 0xEBfA… is owned by 0x858b…, not the
///   deployer, so its ~1M PEPE cannot be withdrawn from here (GOVERNANCE_HANDOVER §1).
///
///   Required env vars:
///     PEPE_TOKEN        deployed PepeToken address
///     PEPE_INCENTIVES   the PepeIncentives to configure (owned by the broadcaster)
///   Optional:
///     PEPE_INCENTIVES_POOL  PEPE (18 decimals) to mint into the pool; default 1,000,000e18.
///                           Only the shortfall is minted, so a re-run does not double it.
///
///   Usage (Base Sepolia; simulate first with --fork-url and no --account/--broadcast):
///     forge script script/ConfigurePepeIncentivesGameFi.s.sol \
///       --rpc-url https://sepolia.base.org --account <keystore name> --sender <deployer> \
///       --broadcast --slow -v
contract ConfigurePepeIncentivesGameFi is Script {
    uint256 public constant TRADE_MINING_BPS = 200;        // 2%
    uint256 public constant TRADE_MINING_CAP = 1_000e18;
    uint256 public constant COPY_REWARD      = 500e18;
    uint256 public constant DEFAULT_POOL     = 1_000_000e18;

    address public broadcasterOverride;   // test hook, see Redeploy130Hardened
    function setBroadcasterOverride(address a) external { broadcasterOverride = a; }

    function tierThresholds() public pure returns (uint256[4] memory) {
        return [uint256(5_000e18), 25_000e18, 100_000e18, 500_000e18];
    }

    function tierRewards() public pure returns (uint256[4] memory) {
        return [uint256(1_000e18), 3_000e18, 10_000e18, 40_000e18];
    }

    function run() external {
        runWith(
            vm.envAddress("PEPE_TOKEN"),
            vm.envAddress("PEPE_INCENTIVES"),
            vm.envOr("PEPE_INCENTIVES_POOL", DEFAULT_POOL)
        );
    }

    /// @dev The same configuration without process-wide env (parallel tests).
    function runWith(address pepeToken, address incentivesAddr, uint256 pool) public {
        address deployer = broadcasterOverride != address(0) ? broadcasterOverride : msg.sender;
        PepeToken pepe = PepeToken(pepeToken);
        PepeIncentives incentives = PepeIncentives(incentivesAddr);

        require(incentivesAddr.code.length > 0, "PEPE_INCENTIVES has no code");
        require(address(incentives.pepe()) == pepeToken, "PEPE_INCENTIVES pays a different token");
        require(incentives.owner() == deployer, "the broadcaster does not own PEPE_INCENTIVES");
        uint256 have = pepe.balanceOf(incentivesAddr);
        require(have >= pool || pepe.owner() == deployer, "the broadcaster does not own PepeToken - cannot mint the pool");

        vm.startBroadcast(deployer);

        incentives.setTradeMining(TRADE_MINING_BPS, TRADE_MINING_CAP);
        incentives.setCopyReward(COPY_REWARD);
        incentives.setTierParams(tierThresholds(), tierRewards());
        if (have < pool) pepe.mint(incentivesAddr, pool - have);

        vm.stopBroadcast();

        console.log("PepeIncentives configured for GameFi:", incentivesAddr);
        console.log("Reward pool (PEPE, 18 decimals):", pepe.balanceOf(incentivesAddr));
    }
}
