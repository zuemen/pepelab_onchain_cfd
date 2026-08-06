// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/MockUSDC.sol";
import "../src/PepeAMM.sol";

/// @notice Deploys PepeAMM and seeds the initial ETH : mUSDC liquidity.
///
///         Usage:
///   forge script script/DeployAMM.s.sol \
///     --rpc-url $SEPOLIA_RPC_URL --private-key $PRIVATE_KEY \
///     --broadcast --skip-simulation --slow -v
///
///   Required env vars: MOCK_USDC, MOCK_ORACLE
///   Optional:          SEED_ETH (wei, default 1e18), SEED_USDC (18-dec, default 2300e18)
///
/// @dev    Audit 2026-08-06 fallout this script has to respect:
///
///         **PA-3 — `MockUSDC.mint` is `onlyOwner` now.** It used to be open to
///         anyone, which is how the PoC took the swap router's entire 10 ETH for
///         free. The seeding mint below only works when the signer is the
///         MockUSDC owner; that is checked up front so the failure is a sentence
///         rather than a `NotMinter` selector from inside a broadcast.
///
///         **PA-1 / PA-5 — PepeAMM is a real constant-product pool now.** Two
///         consequences here:
///           * `addLiquidity` returns LP shares and the first deposit burns
///             `MINIMUM_LIQUIDITY`. The shares are printed; they are what
///             `removeLiquidity` needs, and unlike before, the seed is
///             recoverable at all.
///           * The seeded reserve ratio IS the pool's opening price — it is no
///             longer read from the oracle. Seeding far from the oracle opens the
///             pool at a price arbitrage corrects immediately, out of the seeded
///             reserves. The deviation is computed and printed before broadcast.
///
///         **`receive()` reverts.** Bare ETH sent to the pool is refused;
///         liquidity only enters through `addLiquidity`. Do not "top up" the
///         pool with `cast send --value`.
contract DeployAMM is Script {
    /// @dev keccak256("sETH") — the id PepeAMM prices ETH against.
    bytes32 constant ETH_ASSET_ID =
        0x83e22e1d95f2093dd401ec5cba75bcd950cd90282356f086011849e4fbaad8a9;

    function run() external {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address deployer   = vm.addr(deployerPk);
        address usdcAddr   = vm.envAddress("MOCK_USDC");
        address oracleAddr = vm.envAddress("MOCK_ORACLE");

        uint256 seedEth  = vm.envOr("SEED_ETH",  uint256(1 ether));
        uint256 seedUsdc = vm.envOr("SEED_USDC", uint256(2_300e18));

        MockUSDC usdc = MockUSDC(usdcAddr);

        // PA-3: fail with a sentence, not a selector.
        require(
            usdc.owner() == deployer,
            "PRIVATE_KEY is not the MockUSDC owner - mint() became onlyOwner in PA-3"
        );

        // The opening price is the seed ratio. Say where it lands relative to
        // the oracle while it is still free to change.
        uint256 seedPrice8 = seedUsdc * 1e8 / seedEth;
        (uint256 oraclePrice8, uint256 updatedAt) = IPriceOracle(oracleAddr).getPrice(ETH_ASSET_ID);
        console.log("seed ETH (wei)    :", seedEth);
        console.log("seed mUSDC (18d)  :", seedUsdc);
        console.log("seed price (8d)   :", seedPrice8);
        console.log("oracle price (8d) :", oraclePrice8);
        console.log("oracle updatedAt  :", updatedAt);
        if (oraclePrice8 > 0) {
            uint256 hi = seedPrice8 > oraclePrice8 ? seedPrice8 : oraclePrice8;
            uint256 lo = seedPrice8 > oraclePrice8 ? oraclePrice8 : seedPrice8;
            uint256 devBps = (hi - lo) * 10_000 / oraclePrice8;
            console.log("deviation (bps)   :", devBps);
            if (devBps > 500) {
                console.log("!!! The pool would open more than 5% away from the oracle.");
                console.log("!!! Arbitrage closes that gap out of the seeded reserves.");
                console.log("!!! Adjust SEED_ETH / SEED_USDC before broadcasting.");
            }
        } else {
            console.log("!!! Oracle has no sETH price. Swaps revert until a keeper posts one.");
        }

        vm.startBroadcast(deployerPk);

        // 1. Deploy PepeAMM
        PepeAMM amm = new PepeAMM(usdcAddr, oracleAddr);

        // 2. Mint the seed mUSDC (onlyOwner since PA-3)
        usdc.mint(deployer, seedUsdc);

        // 3. Approve and add the initial liquidity. Unlike the old pool this is
        //    recoverable: the shares below burn back through removeLiquidity.
        usdc.approve(address(amm), seedUsdc);
        uint256 shares = amm.addLiquidity{value: seedEth}(seedUsdc);

        vm.stopBroadcast();

        console.log("");
        console.log("PepeAMM deployed:   ", address(amm));
        console.log("LP shares to seeder:", shares);
        console.log("Pool price (18d):   ", amm.getPrice());
        console.log("ETH reserve (wei):  ", amm.ethReserve());
        console.log("USDC reserve (18d): ", amm.usdcReserve());
        console.log("maxOracleAge (s):   ", amm.maxOracleAge());
        console.log("maxOracleDevBps:    ", amm.maxOracleDeviationBps());
        console.log("Update addresses.ts -> PepeAMM:", address(amm));
        console.log("NOTE: receive() reverts - never fund this pool with a bare ETH transfer.");
    }
}
