// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice LP vault that earns yield from protocol fees and covers extreme losses via bailout.
contract InsuranceVault is ERC20, Ownable, ReentrancyGuard {
    // ── Immutables ───────────────────────────────────────────────────────────

    IERC20 public immutable usdc;

    // ── State ────────────────────────────────────────────────────────────────

    address public feeRouter;
    address public exchange;
    uint256 public totalAssets; // explicit tracking; never read raw ERC20 balance

    // ── Events ───────────────────────────────────────────────────────────────

    event Deposited(address indexed user, uint256 usdcAmount, uint256 shares);
    event Withdrawn(address indexed user, uint256 shares, uint256 usdcAmount);
    event ProtocolDeposit(address indexed from, uint256 amount);
    event Bailout(address indexed trader, uint256 amount);

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotAuthorized();
    error InsufficientVault();

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc)
        ERC20("PepeLab Insurance Vault", "pIV")
        Ownable(msg.sender)
    {
        usdc = IERC20(_usdc);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setFeeRouter(address _fr) external onlyOwner { feeRouter = _fr; }
    function setExchange(address _ex)  external onlyOwner { exchange  = _ex; }

    // ── LP: deposit / withdraw ────────────────────────────────────────────────

    function deposit(uint256 usdcAmount) external nonReentrant returns (uint256 shares) {
        require(usdcAmount > 0, "zero");
        shares = previewDeposit(usdcAmount);
        totalAssets += usdcAmount;
        usdc.transferFrom(msg.sender, address(this), usdcAmount);
        _mint(msg.sender, shares);
        emit Deposited(msg.sender, usdcAmount, shares);
    }

    function withdraw(uint256 shares) external nonReentrant returns (uint256 usdcAmount) {
        require(shares > 0 && shares <= balanceOf(msg.sender), "bad shares");
        usdcAmount = previewWithdraw(shares);
        if (usdcAmount > totalAssets) revert InsufficientVault();
        totalAssets -= usdcAmount;
        _burn(msg.sender, shares);
        usdc.transfer(msg.sender, usdcAmount);
        emit Withdrawn(msg.sender, shares, usdcAmount);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @dev First deposit mints 1:1. Subsequent deposits proportional to current share price.
    function previewDeposit(uint256 usdcAmount) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0 || totalAssets == 0) return usdcAmount;
        return usdcAmount * supply / totalAssets;
    }

    function previewWithdraw(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 0;
        return shares * totalAssets / supply;
    }

    /// @notice Share price in 18-dec USDC per pIV. Returns 1e18 when no supply yet.
    function getSharePrice() external view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 1e18;
        return totalAssets * 1e18 / supply;
    }

    // ── Protocol entry points ─────────────────────────────────────────────────

    /// @notice FeeRouter (slash share) or Exchange (liquidation remainder) deposits here.
    ///         Caller must approve this contract for `amount` USDC before calling.
    function depositFromProtocol(uint256 amount) external {
        if (msg.sender != feeRouter && msg.sender != exchange) revert NotAuthorized();
        usdc.transferFrom(msg.sender, address(this), amount);
        totalAssets += amount;
        emit ProtocolDeposit(msg.sender, amount);
    }

    /// @notice Exchange calls this when closeAmount < 0 (loss exceeds margin).
    ///         Pays `amount` USDC directly to `trader` as insurance floor.
    function bailout(uint256 amount, address trader) external {
        if (msg.sender != exchange) revert NotAuthorized();
        if (amount > totalAssets) revert InsufficientVault();
        totalAssets -= amount;
        usdc.transfer(trader, amount);
        emit Bailout(trader, amount);
    }
}
