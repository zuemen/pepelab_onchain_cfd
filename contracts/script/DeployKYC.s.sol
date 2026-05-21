// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/KYCRegistry.sol";

contract DeployKYC is Script {
    function run() external {
        vm.startBroadcast();
        KYCRegistry kyc = new KYCRegistry();
        vm.stopBroadcast();
        console.log("KYCRegistry deployed:", address(kyc));
    }
}
