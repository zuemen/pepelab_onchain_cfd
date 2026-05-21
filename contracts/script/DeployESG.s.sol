// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/ESGRegistry.sol";

contract DeployESG is Script {
    bytes32 constant SBTC  = keccak256("sBTC");
    bytes32 constant SETH  = keccak256("sETH");
    bytes32 constant SAAPL = keccak256("sAAPL");
    bytes32 constant STSLA = keccak256("sTSLA");
    bytes32 constant SGOLD = keccak256("sGOLD");
    bytes32 constant SBOND = keccak256("sBOND");

    function run() external {
        vm.startBroadcast();
        ESGRegistry esg = new ESGRegistry();
        esg.setESG(SGOLD, 45, 60, 70, "BBB");
        esg.setESG(SBOND, 82, 78, 85, "AAA");
        esg.setESG(SETH,  75, 65, 72, "AA");
        esg.setESG(SAAPL, 72, 76, 80, "AA");
        esg.setESG(STSLA, 85, 55, 48, "BBB");
        esg.setESG(SBTC,  22, 50, 40, "CCC");
        vm.stopBroadcast();
        console.log("ESGRegistry deployed:", address(esg));
    }
}
