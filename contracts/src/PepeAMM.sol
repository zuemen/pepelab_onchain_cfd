// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IPriceOracle {
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt);
}

/// @title PepeAMM — Direct Oracle-priced swap for ETH <-> mUSDC (Zero Slippage)
contract PepeAMM is Ownable {
    IERC20 public immutable usdc;
    IPriceOracle public immutable oracle;

    uint256 public ethReserve;
    uint256 public usdcReserve;
    uint256 public constant FEE_BPS = 30;   // 0.3% swap fee
    bytes32 public constant ETH_ASSET_ID = 0x83e22e1d95f2093dd401ec5cba75bcd950cd90282356f086011849e4fbaad8a9;

    event LiquidityAdded(uint256 ethAmount, uint256 usdcAmount);
    event Swap(address indexed user, bool ethToUsdc, uint256 amountIn, uint256 amountOut, uint256 newPrice);

    error InsufficientLiquidity();
    error InsufficientOutput();

    constructor(address _usdc, address _oracle) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
        oracle = IPriceOracle(_oracle);
    }

    /// @notice admin 注入初始流動性（用於兌換儲備）
    function addLiquidity(uint256 usdcAmount) external payable onlyOwner {
        require(msg.value > 0 && usdcAmount > 0, "zero");
        usdc.transferFrom(msg.sender, address(this), usdcAmount);
        ethReserve  += msg.value;
        usdcReserve += usdcAmount;
        emit LiquidityAdded(msg.value, usdcAmount);
    }

    /// @notice ETH -> mUSDC, 依據 Oracle 價格兌換，無滑點
    function swapETHForUSDC(uint256 minUsdcOut) external payable returns (uint256 usdcOut) {
        (uint256 price8, ) = oracle.getPrice(ETH_ASSET_ID);
        require(price8 > 0, "invalid oracle price");

        uint256 ethInAfterFee = msg.value * (10000 - FEE_BPS) / 10000;
        // ethInAfterFee (18-dec) * price8 (8-dec) / 1e8 = usdcOut (18-dec)
        usdcOut = (ethInAfterFee * price8) / 100000000;

        if (usdcOut < minUsdcOut) revert InsufficientOutput();
        require(usdcReserve >= usdcOut, "insufficient USDC reserve in pool");

        ethReserve  += msg.value;
        usdcReserve -= usdcOut;
        usdc.transfer(msg.sender, usdcOut);

        emit Swap(msg.sender, true, msg.value, usdcOut, getPrice());
    }

    /// @notice mUSDC -> ETH, 依據 Oracle 價格兌換，無滑點
    function swapUSDCForETH(uint256 usdcIn, uint256 minEthOut) external returns (uint256 ethOut) {
        (uint256 price8, ) = oracle.getPrice(ETH_ASSET_ID);
        require(price8 > 0, "invalid oracle price");

        usdc.transferFrom(msg.sender, address(this), usdcIn);
        uint256 usdcInAfterFee = usdcIn * (10000 - FEE_BPS) / 10000;
        // usdcInAfterFee (18-dec) * 1e8 / price8 (8-dec) = ethOut (18-dec)
        ethOut = (usdcInAfterFee * 100000000) / price8;

        if (ethOut < minEthOut) revert InsufficientOutput();
        require(ethReserve >= ethOut, "insufficient ETH reserve in pool");

        usdcReserve += usdcIn;
        ethReserve  -= ethOut;

        (bool ok,) = payable(msg.sender).call{value: ethOut}("");
        require(ok, "eth transfer failed");

        emit Swap(msg.sender, false, usdcIn, ethOut, getPrice());
    }

    /// @notice 目前價格: 1 ETH = ? USDC（18-dec 格式，直接對齊 Oracle 價格）
    function getPrice() public view returns (uint256) {
        (uint256 price8, ) = oracle.getPrice(ETH_ASSET_ID);
        return price8 * 10 ** 10; // 轉換為 18 位小數
    }

    function getReserves() external view returns (uint256 eth, uint256 usdcR) {
        return (ethReserve, usdcReserve);
    }

    /// @notice 報價（前端預覽用，直接使用 Oracle 價格，無滑點）
    function quoteETHForUSDC(uint256 ethIn) external view returns (uint256) {
        (uint256 price8, ) = oracle.getPrice(ETH_ASSET_ID);
        if (price8 == 0) return 0;
        uint256 ethInAfterFee = ethIn * (10000 - FEE_BPS) / 10000;
        return (ethInAfterFee * price8) / 100000000;
    }

    function quoteUSDCForETH(uint256 usdcIn) external view returns (uint256) {
        (uint256 price8, ) = oracle.getPrice(ETH_ASSET_ID);
        if (price8 == 0) return 0;
        uint256 usdcInAfterFee = usdcIn * (10000 - FEE_BPS) / 10000;
        return (usdcInAfterFee * 100000000) / price8;
    }

    receive() external payable {}
}
