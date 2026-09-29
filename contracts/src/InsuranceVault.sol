// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice LP vault that earns yield from protocol fees and covers extreme losses via bailout.
contract InsuranceVault is ERC20, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;   // M-4

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
    event Recapitalized(address indexed from, uint256 amount);
    event FeeRouterSet(address indexed feeRouter);
    event ExchangeSet(address indexed exchange);

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotAuthorized();
    error InsufficientVault();
    /// @notice H-4: shares exist but back zero assets, so there is no price at
    ///         which new capital can be issued shares fairly.
    error VaultInsolvent();

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc)
        ERC20("PepeFi Insurance Vault", "pIV")
        Ownable(msg.sender)
    {
        usdc = IERC20(_usdc);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    function setFeeRouter(address _fr) external onlyOwner {
        feeRouter = _fr;
        emit FeeRouterSet(_fr);
    }

    function setExchange(address _ex) external onlyOwner {
        exchange = _ex;
        emit ExchangeSet(_ex);
    }

    /// @notice H-4 escape hatch: inject assets WITHOUT minting shares, to restore
    ///         a vault that bailouts drained to zero. Deposits are refused while
    ///         `totalAssets == 0 && totalSupply > 0` (there is no fair share
    ///         price), so without this the vault could only be revived by
    ///         protocol fee flow. The value is a gift to existing shareholders,
    ///         which is why it is owner-only and explicit rather than a side
    ///         effect of someone else's deposit.
    function recapitalize(uint256 amount) external onlyOwner nonReentrant {
        require(amount > 0, "zero");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        totalAssets += amount;
        emit Recapitalized(msg.sender, amount);
    }

    // ── LP: deposit / withdraw ────────────────────────────────────────────────

    function deposit(uint256 usdcAmount) external nonReentrant returns (uint256 shares) {
        require(usdcAmount > 0, "zero");
        shares = previewDeposit(usdcAmount);
        totalAssets += usdcAmount;
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        _mint(msg.sender, shares);
        emit Deposited(msg.sender, usdcAmount, shares);
    }

    function withdraw(uint256 shares) external nonReentrant returns (uint256 usdcAmount) {
        require(shares > 0 && shares <= balanceOf(msg.sender), "bad shares");
        usdcAmount = previewWithdraw(shares);
        if (usdcAmount > totalAssets) revert InsufficientVault();
        totalAssets -= usdcAmount;
        _burn(msg.sender, shares);
        usdc.safeTransfer(msg.sender, usdcAmount);
        emit Withdrawn(msg.sender, shares, usdcAmount);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @dev First deposit mints 1:1. Subsequent deposits proportional to current share price.
    ///
    ///      H-4: the old guard was `supply == 0 || totalAssets == 0`, so once a
    ///      bailout had drained the vault to zero while shares were still
    ///      outstanding, the next depositor was minted 1:1 against a share price
    ///      of ZERO. PoC: alice deposits 1,000 → vault drained → bob deposits
    ///      1,000 and instantly owns only half of it, while alice's worthless
    ///      shares are resurrected at bob's expense.
    ///
    ///      There is no fair price in that state, so deposits are refused rather
    ///      than mispriced. `recapitalize()` (owner) or ordinary protocol fee
    ///      flow through `depositFromProtocol` restores a positive share price.
    function previewDeposit(uint256 usdcAmount) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return usdcAmount;
        if (totalAssets == 0) revert VaultInsolvent();
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
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        totalAssets += amount;
        emit ProtocolDeposit(msg.sender, amount);
    }

    /// @notice Exchange calls this when closeAmount < 0 (loss exceeds margin).
    ///         Pays `amount` USDC directly to `trader` as insurance floor.
    function bailout(uint256 amount, address trader) external {
        if (msg.sender != exchange) revert NotAuthorized();
        if (amount > totalAssets) revert InsufficientVault();
        totalAssets -= amount;
        usdc.safeTransfer(trader, amount);
        emit Bailout(trader, amount);
    }
}
