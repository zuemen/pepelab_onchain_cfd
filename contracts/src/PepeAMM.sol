// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title PepeAMM — constant-product (x*y=k) AMM for ETH <-> mUSDC
contract PepeAMM is Ownable {
    IERC20 public immutable usdc;
    uint256 public ethReserve;
    uint256 public usdcReserve;
    uint256 public constant FEE_BPS = 30;   // 0.3% swap fee (Uniswap style)

    event LiquidityAdded(uint256 ethAmount, uint256 usdcAmount);
    event Swap(address indexed user, bool ethToUsdc, uint256 amountIn, uint256 amountOut, uint256 newPrice);

    error InsufficientLiquidity();
    error InsufficientOutput();

    constructor(address _usdc) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
    }

    /// @notice admin 注入初始流動性（ETH via msg.value + USDC）
    function addLiquidity(uint256 usdcAmount) external payable onlyOwner {
        require(msg.value > 0 && usdcAmount > 0, "zero");
        usdc.transferFrom(msg.sender, address(this), usdcAmount);
        ethReserve  += msg.value;
        usdcReserve += usdcAmount;
        emit LiquidityAdded(msg.value, usdcAmount);
    }

    /// @notice ETH -> mUSDC,用 x*y=k
    function swapETHForUSDC(uint256 minUsdcOut) external payable returns (uint256 usdcOut) {
        if (ethReserve == 0 || usdcReserve == 0) revert InsufficientLiquidity();
        uint256 ethInAfterFee = msg.value * (10_000 - FEE_BPS) / 10_000;
        // usdcOut = usdcReserve - k / (ethReserve + ethInAfterFee)
        uint256 k = ethReserve * usdcReserve;
        usdcOut = usdcReserve - k / (ethReserve + ethInAfterFee);
        if (usdcOut < minUsdcOut) revert InsufficientOutput();
        ethReserve  += msg.value;
        usdcReserve -= usdcOut;
        usdc.transfer(msg.sender, usdcOut);
        emit Swap(msg.sender, true, msg.value, usdcOut, getPrice());
    }

    /// @notice mUSDC -> ETH
    function swapUSDCForETH(uint256 usdcIn, uint256 minEthOut) external returns (uint256 ethOut) {
        if (ethReserve == 0 || usdcReserve == 0) revert InsufficientLiquidity();
        usdc.transferFrom(msg.sender, address(this), usdcIn);
        uint256 usdcInAfterFee = usdcIn * (10_000 - FEE_BPS) / 10_000;
        uint256 k = ethReserve * usdcReserve;
        ethOut = ethReserve - k / (usdcReserve + usdcInAfterFee);
        if (ethOut < minEthOut) revert InsufficientOutput();
        usdcReserve += usdcIn;
        ethReserve  -= ethOut;
        (bool ok,) = payable(msg.sender).call{value: ethOut}("");
        require(ok, "eth transfer failed");
        emit Swap(msg.sender, false, usdcIn, ethOut, getPrice());
    }

    /// @notice 目前價格:1 ETH = ? USDC（18-dec）
    function getPrice() public view returns (uint256) {
        if (ethReserve == 0) return 0;
        return usdcReserve * 1e18 / ethReserve;
    }

    function getReserves() external view returns (uint256 eth, uint256 usdcR) {
        return (ethReserve, usdcReserve);
    }

    /// @notice 報價（前端預覽用）
    function quoteETHForUSDC(uint256 ethIn) external view returns (uint256) {
        if (ethReserve == 0) return 0;
        uint256 ethInAfterFee = ethIn * (10_000 - FEE_BPS) / 10_000;
        return usdcReserve - (ethReserve * usdcReserve) / (ethReserve + ethInAfterFee);
    }

    function quoteUSDCForETH(uint256 usdcIn) external view returns (uint256) {
        if (usdcReserve == 0) return 0;
        uint256 usdcInAfterFee = usdcIn * (10_000 - FEE_BPS) / 10_000;
        return ethReserve - (ethReserve * usdcReserve) / (usdcReserve + usdcInAfterFee);
    }

    receive() external payable {}
}
