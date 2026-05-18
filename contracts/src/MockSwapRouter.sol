// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./MockUSDC.sol";

contract MockSwapRouter {
    MockUSDC public immutable usdc;
    uint256 public constant RATE = 3000;   // 1 ETH = 3000 mUSDC

    event SwapEthToUsdc(
        address indexed user,
        uint256 ethIn,
        uint256 usdcOut,
        uint256 timestamp
    );
    event SwapUsdcToEth(
        address indexed user,
        uint256 usdcIn,
        uint256 ethOut,
        uint256 timestamp
    );

    error InsufficientEthInRouter(uint256 needed, uint256 available);
    error MustSendEth();
    error MustSendUsdc();
    error InsufficientUsdcBalance();
    error InsufficientUsdcAllowance();

    constructor(address _usdc) {
        usdc = MockUSDC(_usdc);
    }

    function swapETHForUSDC() external payable {
        if (msg.value == 0) revert MustSendEth();
        uint256 amount = msg.value * RATE;
        usdc.mint(msg.sender, amount);
        emit SwapEthToUsdc(msg.sender, msg.value, amount, block.timestamp);
    }

    function swapUSDCForETH(uint256 usdcAmount) external {
        if (usdcAmount == 0) revert MustSendUsdc();
        if (usdc.balanceOf(msg.sender) < usdcAmount) revert InsufficientUsdcBalance();
        if (usdc.allowance(msg.sender, address(this)) < usdcAmount) revert InsufficientUsdcAllowance();

        uint256 ethOut = usdcAmount / RATE;
        if (address(this).balance < ethOut) {
            revert InsufficientEthInRouter(ethOut, address(this).balance);
        }

        usdc.burnFrom(msg.sender, usdcAmount);

        (bool ok,) = payable(msg.sender).call{value: ethOut}("");
        require(ok, "ETH transfer failed");

        emit SwapUsdcToEth(msg.sender, usdcAmount, ethOut, block.timestamp);
    }

    function fundRouter() external payable {}

    function previewSwapEth(uint256 ethIn) external pure returns (uint256 usdcOut) {
        return ethIn * RATE;
    }

    function previewSwapUsdc(uint256 usdcIn) external pure returns (uint256 ethOut) {
        return usdcIn / RATE;
    }

    function ethReserve() external view returns (uint256) {
        return address(this).balance;
    }

    receive() external payable {}
}
