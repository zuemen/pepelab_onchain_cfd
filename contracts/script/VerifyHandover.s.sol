// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "./HandoverToTimelock.s.sol";

interface IExchangeRoles {
    function guardian() external view returns (address);
    function marketOperator() external view returns (address);
}

/// @notice Read-only: reads back, from chain, who governs what after
///         `HandoverToTimelock`. Same target list and env as the handover
///         script (plus `DEPLOYER`, default the #130 deployer, and
///         `EXPECT_PHASE`, default 2).
///
///           TIMELOCK=0x… TIMELOCK_PROPOSER=0x<safe> TIMELOCK_EXECUTOR=0x<safe> \
///           EXCHANGE_NEW=0x… COPYTRACKER_NEW=0x… \
///           forge script script/VerifyHandover.s.sol:VerifyHandover --rpc-url "$BASE_SEPOLIA_RPC_URL" -vv
///
///         Phase 2 expectation: every Ownable owner == timelock; every
///         AccessControl target: timelock has DEFAULT_ADMIN and the deployer
///         does not. Phase 1: the deployer may still hold admin (the fallback).
///         Hot roles (exchange guardian / operator) must NOT be the timelock.
contract VerifyHandover is HandoverTargets {
    function run() external view {
        address timelock = vm.envAddress("TIMELOCK");
        address deployer = vm.envOr("DEPLOYER", address(0x27C21324D101e867E0634bf2ebe3F9Dcf3ACA585));
        uint256 phase    = vm.envOr("EXPECT_PHASE", uint256(2));
        require(phase == 1 || phase == 2, "EXPECT_PHASE must be 1 or 2");

        console.log("=== timelock ===");
        _checkTimelock(timelock, deployer);
        TimelockController tl = TimelockController(payable(timelock));
        require(tl.hasRole(ADMIN, timelock), "timelock does not self-administer");

        console.log("=== Ownable ===");
        Target[] memory owned = _ownableTargets();
        for (uint256 i = 0; i < owned.length; i++) {
            if (owned[i].addr == address(0)) { console.log("skip        ", owned[i].name); continue; }
            address o = IOwnable130(owned[i].addr).owner();
            if (o != timelock) {
                console.log("MISMATCH owner", owned[i].name, o);
                revert(string.concat("owner != timelock: ", owned[i].name));
            }
            console.log("owner=TL    ", owned[i].name, owned[i].addr);
        }

        console.log("=== AccessControl DEFAULT_ADMIN_ROLE ===");
        Target[] memory acl = _accessControlTargets();
        for (uint256 i = 0; i < acl.length; i++) {
            if (acl[i].addr == address(0)) { console.log("skip        ", acl[i].name); continue; }
            IAccessControl a = IAccessControl(acl[i].addr);
            require(a.hasRole(ADMIN, timelock), string.concat("timelock lacks admin: ", acl[i].name));
            bool dep = a.hasRole(ADMIN, deployer);
            if (phase == 2) require(!dep, string.concat("deployer still admin: ", acl[i].name));
            console.log(dep ? "admin TL+dep" : "admin=TL    ", acl[i].name, acl[i].addr);
        }

        console.log("=== hot roles (must stay off the timelock) ===");
        IExchangeRoles ex = IExchangeRoles(owned[0].addr);
        require(ex.guardian() != address(0) && ex.guardian() != timelock, "exchange guardian unset or on the timelock");
        require(ex.marketOperator() != timelock, "exchange marketOperator on the timelock");
        console.log("exchange guardian       :", ex.guardian());
        console.log("exchange marketOperator :", ex.marketOperator());
        if (acl[0].addr != address(0)) {
            console.log("vault PAUSER_ROLE deployer:", IAccessControl(acl[0].addr).hasRole(keccak256("PAUSER_ROLE"), deployer));
            console.log("vault RISK_ROLE   deployer:", IAccessControl(acl[0].addr).hasRole(keccak256("RISK_ROLE"), deployer));
        }
        console.log("");
        console.log("=== handover verified (phase", phase, ") ===");
    }
}
