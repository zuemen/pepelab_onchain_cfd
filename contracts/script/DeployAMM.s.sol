// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/MockUSDC.sol";
import "../src/PepeAMM.sol";

/// @notice Deploys PepeAMM and seeds initial 1 ETH : 3000 mUSDC liquidity.
///         Usage:
///   forge script script/DeployAMM.s.sol \
///     --rpc-url $SEPOLIA_RPC_URL --private-key $PRIVATE_KEY \
///     --broadcast --skip-simulation --slow -v
///
///   Required env var: MOCK_USDC (address of deployed MockUSDC)
contract DeployAMM is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("PRIVATE_KEY");
        address deployer   = vm.addr(deployerPk);
        address usdcAddr   = vm.envAddress("MOCK_USDC");

        MockUSDC usdc = MockUSDC(usdcAddr);

        vm.startBroadcast(deployerPk);

        // 1. Deploy PepeAMM
        PepeAMM amm = new PepeAMM(usdcAddr);

        // 2. Mint initial USDC for liquidity seed
        uint256 usdcSeed = 3_000e18;
        usdc.mint(deployer, usdcSeed);

        // 3. Approve and add initial liquidity: 1 ETH : 3 000 mUSDC
        usdc.approve(address(amm), usdcSeed);
        amm.addLiquidity{value: 1 ether}(usdcSeed);

        vm.stopBroadcast();

        console.log("PepeAMM deployed:  ", address(amm));
        console.log("Initial price (18d):", amm.getPrice());
        console.log("ETH reserve (wei): ", amm.ethReserve());
        console.log("USDC reserve (18d):", amm.usdcReserve());
        console.log("Update addresses.ts -> PepeAMM:", address(amm));
    }
}
