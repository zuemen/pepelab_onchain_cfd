// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPriceOracle {
    function getPrice(bytes32 assetId) external view returns (uint256 price, uint256 updatedAt);
}

/// @title  PepeAMM — constant-product ETH <-> mUSDC pool
///
/// @notice ## What changed and why (audit 2026-08-06, PA-1 / PA-2 / PA-5)
///
///         The previous implementation priced every swap at
///         `amountIn * oraclePrice` and never touched the reserves. That is not
///         an AMM: it is an infinite-depth order book quoting a price that lags
///         the market by one keeper tick, with the pool paying the difference.
///         The PoC in the audit drained 9.3% of the pool per oracle tick and
///         could be repeated until the reserves hit zero, because zero slippage
///         means arbitrage never pushes the quote back.
///
///         Pricing is now the standard constant product `x * y = k` with a
///         0.3% fee taken on the input leg. Slippage is therefore real: the
///         same round trip that used to be free now costs the attacker the fee
///         plus the price impact, and any drain moves the pool price against
///         the drainer.
///
///         ### The oracle's new role
///
///         The oracle no longer prices swaps. It is now a **freshness-gated
///         sanity band**:
///
///           1. `updatedAt` is checked on every swap (PA-2). A stale feed means
///              the band cannot be trusted, so swaps fail closed — the rest of
///              the system already behaves this way.
///           2. A swap may not push the pool price further outside
///              `maxOracleDeviationBps` of the oracle price. Trades that stay
///              inside the band always pass; trades that would leave it pass
///              only when they move the pool *closer* to the oracle, so
///              arbitrage back into line is never blocked. In practice this is
///              a per-trade price-impact cap that also stops a whale from
///              parking the pool at an absurd price between keeper ticks.
///
///         ### Liquidity is no longer a one-way door (PA-5)
///
///         `addLiquidity` mints proportional LP shares and `removeLiquidity`
///         burns them. Deposited liquidity is recoverable by whoever supplied
///         it, instead of being locked in the contract forever with not even
///         the owner able to withdraw.
///
///         TESTNET NOTE: this pool is deliberately small and single-pair. It is
///         demo infrastructure, not a production DEX.
contract PepeAMM is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20       public immutable usdc;
    IPriceOracle public immutable oracle;

    /// @notice Tracked reserves. Kept as storage rather than `balanceOf` so a
    ///         donation cannot silently move the price (and, with the rejecting
    ///         `receive()`, so ETH cannot be injected at all).
    uint256 public ethReserve;
    uint256 public usdcReserve;

    uint256 public constant FEE_BPS = 30;             // 0.3% swap fee
    uint256 public constant BPS_DENOM = 10_000;
    /// @dev Burned on the first deposit so `totalShares` can never return to
    ///      zero while reserves remain — the classic first-depositor rounding
    ///      attack needs that transition.
    uint256 public constant MINIMUM_LIQUIDITY = 1_000;

    bytes32 public constant ETH_ASSET_ID =
        0x83e22e1d95f2093dd401ec5cba75bcd950cd90282356f086011849e4fbaad8a9;

    // ── LP accounting (PA-5) ──────────────────────────────────────────────────

    uint256 public totalShares;
    mapping(address => uint256) public sharesOf;

    // ── Oracle sanity band (PA-2) ─────────────────────────────────────────────

    /// @notice Oracle quotes older than this make swaps fail closed.
    uint256 public maxOracleAge = 1 hours;
    uint256 public constant MIN_ORACLE_AGE = 1 minutes;
    uint256 public constant MAX_ORACLE_AGE = 1 days;

    /// @notice How far the pool price may sit from the oracle price after a
    ///         swap. 2000 bps = 20%. Setting it to `BPS_DENOM` disables the
    ///         band (100% divergence tolerated).
    uint256 public maxOracleDeviationBps = 2_000;
    uint256 public constant MIN_ORACLE_DEVIATION_BPS = 100;

    // ── Events ────────────────────────────────────────────────────────────────

    event LiquidityAdded(address indexed provider, uint256 ethAmount, uint256 usdcAmount, uint256 shares);
    event LiquidityRemoved(address indexed provider, uint256 ethAmount, uint256 usdcAmount, uint256 shares);
    event Swap(address indexed user, bool ethToUsdc, uint256 amountIn, uint256 amountOut, uint256 newPrice);
    event MaxOracleAgeSet(uint256 oldValue, uint256 newValue);
    event MaxOracleDeviationBpsSet(uint256 oldValue, uint256 newValue);

    // ── Errors ────────────────────────────────────────────────────────────────

    error InsufficientLiquidity();
    error InsufficientOutput();
    error InsufficientInput();
    error InsufficientShares();
    error InvalidOraclePrice();
    error StaleOraclePrice(uint256 updatedAt, uint256 maxAge);
    error PriceOutOfBand(uint256 poolPrice, uint256 oraclePrice);
    error EthNotAccepted();
    error EthTransferFailed();
    error InvalidParam();

    constructor(address _usdc, address _oracle) Ownable(msg.sender) {
        require(_usdc != address(0) && _oracle != address(0), "zero addr");
        usdc   = IERC20(_usdc);
        oracle = IPriceOracle(_oracle);
    }

    // ── Liquidity ─────────────────────────────────────────────────────────────

    /// @notice Deposit ETH + mUSDC and receive LP shares.
    /// @param  usdcAmount Maximum mUSDC the caller is willing to supply. On a
    ///         non-empty pool only the amount matching `msg.value` at the
    ///         current ratio is pulled, so there is no dust and no donation.
    /// @return shares LP shares minted to the caller.
    function addLiquidity(uint256 usdcAmount)
        external
        payable
        nonReentrant
        returns (uint256 shares)
    {
        if (msg.value == 0 || usdcAmount == 0) revert InsufficientInput();

        uint256 usdcIn;
        if (totalShares == 0) {
            usdcIn = usdcAmount;
            uint256 minted = _sqrt(msg.value * usdcIn);
            if (minted <= MINIMUM_LIQUIDITY) revert InsufficientLiquidity();
            shares      = minted - MINIMUM_LIQUIDITY;
            totalShares = minted;               // MINIMUM_LIQUIDITY stays unowned
        } else {
            // Ceil-divide so rounding favours the pool, never the depositor.
            usdcIn = (msg.value * usdcReserve + ethReserve - 1) / ethReserve;
            if (usdcIn > usdcAmount) revert InsufficientInput();
            shares = msg.value * totalShares / ethReserve;
            if (shares == 0) revert InsufficientLiquidity();
            totalShares += shares;
        }

        sharesOf[msg.sender] += shares;
        ethReserve  += msg.value;
        usdcReserve += usdcIn;

        usdc.safeTransferFrom(msg.sender, address(this), usdcIn);
        emit LiquidityAdded(msg.sender, msg.value, usdcIn, shares);
    }

    /// @notice Burn LP shares and withdraw the proportional reserves (PA-5).
    function removeLiquidity(uint256 shares, uint256 minEthOut, uint256 minUsdcOut)
        external
        nonReentrant
        returns (uint256 ethOut, uint256 usdcOut)
    {
        if (shares == 0) revert InsufficientInput();
        if (sharesOf[msg.sender] < shares) revert InsufficientShares();

        ethOut  = shares * ethReserve  / totalShares;
        usdcOut = shares * usdcReserve / totalShares;
        if (ethOut == 0 && usdcOut == 0) revert InsufficientOutput();
        if (ethOut < minEthOut || usdcOut < minUsdcOut) revert InsufficientOutput();

        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        ethReserve  -= ethOut;
        usdcReserve -= usdcOut;

        if (usdcOut > 0) usdc.safeTransfer(msg.sender, usdcOut);
        if (ethOut > 0) {
            (bool ok, ) = payable(msg.sender).call{value: ethOut}("");
            if (!ok) revert EthTransferFailed();
        }
        emit LiquidityRemoved(msg.sender, ethOut, usdcOut, shares);
    }

    // ── Swaps ─────────────────────────────────────────────────────────────────

    /// @notice ETH -> mUSDC at `x*y=k` with a 0.3% fee.
    /// @param  minUsdcOut Slippage floor; the swap reverts below it.
    function swapETHForUSDC(uint256 minUsdcOut)
        external
        payable
        nonReentrant
        returns (uint256 usdcOut)
    {
        if (msg.value == 0) revert InsufficientInput();
        uint256 ethR  = ethReserve;
        uint256 usdcR = usdcReserve;
        if (ethR == 0 || usdcR == 0) revert InsufficientLiquidity();

        uint256 oraclePrice8 = _freshOraclePrice();

        usdcOut = _getAmountOut(msg.value, ethR, usdcR);
        if (usdcOut == 0 || usdcOut >= usdcR) revert InsufficientOutput();
        if (usdcOut < minUsdcOut) revert InsufficientOutput();

        uint256 newEth  = ethR + msg.value;
        uint256 newUsdc = usdcR - usdcOut;
        _enforceBand(ethR, usdcR, newEth, newUsdc, oraclePrice8);

        ethReserve  = newEth;
        usdcReserve = newUsdc;

        usdc.safeTransfer(msg.sender, usdcOut);
        emit Swap(msg.sender, true, msg.value, usdcOut, getPrice());
    }

    /// @notice mUSDC -> ETH at `x*y=k` with a 0.3% fee.
    function swapUSDCForETH(uint256 usdcIn, uint256 minEthOut)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        if (usdcIn == 0) revert InsufficientInput();
        uint256 ethR  = ethReserve;
        uint256 usdcR = usdcReserve;
        if (ethR == 0 || usdcR == 0) revert InsufficientLiquidity();

        uint256 oraclePrice8 = _freshOraclePrice();

        ethOut = _getAmountOut(usdcIn, usdcR, ethR);
        if (ethOut == 0 || ethOut >= ethR) revert InsufficientOutput();
        if (ethOut < minEthOut) revert InsufficientOutput();

        uint256 newUsdc = usdcR + usdcIn;
        uint256 newEth  = ethR - ethOut;
        _enforceBand(ethR, usdcR, newEth, newUsdc, oraclePrice8);

        ethReserve  = newEth;
        usdcReserve = newUsdc;

        usdc.safeTransferFrom(msg.sender, address(this), usdcIn);
        (bool ok, ) = payable(msg.sender).call{value: ethOut}("");
        if (!ok) revert EthTransferFailed();

        emit Swap(msg.sender, false, usdcIn, ethOut, getPrice());
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /// @notice Pool spot price: 1 ETH = ? mUSDC, 18-dec. This is now the
    ///         *reserve ratio*, not the oracle quote — see `oraclePrice()` for
    ///         the external reference.
    function getPrice() public view returns (uint256) {
        if (ethReserve == 0) return 0;
        return usdcReserve * 1e18 / ethReserve;
    }

    /// @notice The external reference price (18-dec) and its `updatedAt`.
    function oraclePrice() external view returns (uint256 price18, uint256 updatedAt) {
        (uint256 price8, uint256 ts) = oracle.getPrice(ETH_ASSET_ID);
        return (price8 * 1e10, ts);
    }

    function getReserves() external view returns (uint256 eth, uint256 usdcR) {
        return (ethReserve, usdcReserve);
    }

    /// @notice Constant-product quote including the fee. Matches the swap
    ///         exactly for the same reserves.
    function quoteETHForUSDC(uint256 ethIn) external view returns (uint256) {
        if (ethIn == 0 || ethReserve == 0 || usdcReserve == 0) return 0;
        return _getAmountOut(ethIn, ethReserve, usdcReserve);
    }

    function quoteUSDCForETH(uint256 usdcIn) external view returns (uint256) {
        if (usdcIn == 0 || ethReserve == 0 || usdcReserve == 0) return 0;
        return _getAmountOut(usdcIn, usdcReserve, ethReserve);
    }

    /// @notice How far the pool currently sits from the oracle, in bps.
    function currentDeviationBps() external view returns (uint256) {
        (uint256 price8, ) = oracle.getPrice(ETH_ASSET_ID);
        if (price8 == 0 || ethReserve == 0) return type(uint256).max;
        return _deviationBps(usdcReserve * 1e8 / ethReserve, price8);
    }

    // ── Owner config ──────────────────────────────────────────────────────────

    function setMaxOracleAge(uint256 age) external onlyOwner {
        if (age < MIN_ORACLE_AGE || age > MAX_ORACLE_AGE) revert InvalidParam();
        emit MaxOracleAgeSet(maxOracleAge, age);
        maxOracleAge = age;
    }

    function setMaxOracleDeviationBps(uint256 bps) external onlyOwner {
        if (bps < MIN_ORACLE_DEVIATION_BPS || bps > BPS_DENOM) revert InvalidParam();
        emit MaxOracleDeviationBpsSet(maxOracleDeviationBps, bps);
        maxOracleDeviationBps = bps;
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    /// @dev PA-2: `updatedAt` is now checked. A stale reference means the
    ///      sanity band is meaningless, so swaps fail closed rather than
    ///      trading blind — same posture as the exchange's `maxPriceAge`.
    function _freshOraclePrice() internal view returns (uint256 price8) {
        uint256 ts;
        (price8, ts) = oracle.getPrice(ETH_ASSET_ID);
        if (price8 == 0) revert InvalidOraclePrice();
        if (ts == 0 || block.timestamp > ts + maxOracleAge) {
            revert StaleOraclePrice(ts, maxOracleAge);
        }
    }

    /// @dev Uniswap-V2 style output with the fee taken on the input leg.
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        internal
        pure
        returns (uint256)
    {
        uint256 amountInWithFee = amountIn * (BPS_DENOM - FEE_BPS);
        return (amountInWithFee * reserveOut) / (reserveIn * BPS_DENOM + amountInWithFee);
    }

    /// @dev The band is one-directional: a trade that leaves the band is only
    ///      refused when it also makes the divergence worse. Arbitrage pushing
    ///      the pool back toward the oracle is therefore always possible, which
    ///      is what stops the band from becoming a deadlock after a big move.
    function _enforceBand(
        uint256 oldEth,
        uint256 oldUsdc,
        uint256 newEth,
        uint256 newUsdc,
        uint256 oraclePrice8
    ) internal view {
        uint256 postDev = _deviationBps(newUsdc * 1e8 / newEth, oraclePrice8);
        if (postDev <= maxOracleDeviationBps) return;

        uint256 preDev = _deviationBps(oldUsdc * 1e8 / oldEth, oraclePrice8);
        if (postDev >= preDev) revert PriceOutOfBand(newUsdc * 1e18 / newEth, oraclePrice8 * 1e10);
    }

    function _deviationBps(uint256 poolPrice8, uint256 refPrice8) internal pure returns (uint256) {
        if (refPrice8 == 0) return type(uint256).max;
        uint256 diff = poolPrice8 > refPrice8 ? poolPrice8 - refPrice8 : refPrice8 - poolPrice8;
        return diff * BPS_DENOM / refPrice8;
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    /// @dev Bare ETH is refused. Accepting it would either be a donation the
    ///      sender can never recover (reserves are tracked in storage) or, if
    ///      credited to `ethReserve`, a free way to move the pool price without
    ///      minting shares. Liquidity goes in through `addLiquidity`.
    receive() external payable {
        revert EthNotAccepted();
    }
}
