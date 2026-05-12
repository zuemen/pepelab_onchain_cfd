// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MockUSDC.sol";

contract MockSwapRouter {
    MockUSDC public immutable usdc;
    uint256 public constant RATE = 3000;

    constructor(address _usdc) {
        usdc = MockUSDC(_usdc);
    }

    // Swaps ETH for mUSDC (1 ETH = 3000 mUSDC)
    function swapETHForUSDC() external payable {
        require(msg.value > 0, "Must send ETH");
        uint256 amount = msg.value * RATE;
        usdc.mint(msg.sender, amount);
    }
}
