// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice LP vault that earns yield from protocol fees and covers extreme losses via bailout.
///
/// @dev    P1-05: share pricing uses virtual shares and a virtual asset (the
///         OpenZeppelin ERC-4626 `_decimalsOffset` construction):
///
///             shares = amount * (totalSupply + 10^DECIMALS_OFFSET) / (totalAssets + 1)   (floor)
///             assets = shares * (totalAssets + 1) / (totalSupply + 10^DECIMALS_OFFSET)   (floor)
///
///         The 10^DECIMALS_OFFSET virtual shares act like a permanent holder
///         nobody controls, so value pushed into the vault while the real
///         supply is tiny is mostly captured by them and cannot be recovered
///         by whoever pushed it. Consequences (derivation in
///         docs/INSURANCE_VAULT_SHARES.md, fuzzed in InsuranceVaultShares.t.sol):
///           - a holder's value can only be raised by a later depositor's
///             rounding remainder, which is below one share-unit's price;
///             raising that price costs the raiser ~10^DECIMALS_OFFSET times
///             what a later depositor can lose, so the raiser's net is <= 1 wei;
///           - both conversions round toward the vault, so a deposit/withdraw
///             round trip never returns more than was put in, in any state
///             (including after a bailout lowered the share price).
///         Shares carry `asset decimals + DECIMALS_OFFSET` decimals, so one
///         whole pIV is still worth ~1 USDC at launch.
///
///         `totalAssets` stays the real, explicitly tracked balance; the
///         virtual asset exists only inside the two conversions. The exchange
///         reads `totalAssets()` as the cover available to `bailout`, and that
///         number is unchanged by this design.
contract InsuranceVault is ERC20, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;   // M-4

    // ── Constants ────────────────────────────────────────────────────────────

    /// @notice log10 of the virtual share count (see contract @dev).
    uint8 public constant DECIMALS_OFFSET = 6;
    uint256 private constant VIRTUAL_SHARES = 10 ** DECIMALS_OFFSET;
    uint256 private constant VIRTUAL_ASSETS = 1;

    // ── Immutables ───────────────────────────────────────────────────────────

    IERC20 public immutable usdc;
    /// @dev Decimals of `usdc`, read once at construction (18 if unreadable).
    uint8 private immutable _assetDecimals;

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
    /// @notice The deposit is too small to mint a single share at the current
    ///         share price; it would have been a gift to existing holders.
    error ZeroShares();

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc)
        ERC20("PepeFi Insurance Vault", "pIV")
        Ownable(msg.sender)
    {
        usdc = IERC20(_usdc);
        _assetDecimals = _readAssetDecimals(_usdc);
    }

    /// @dev Same tolerance as OZ ERC4626: a token without a usable `decimals()`
    ///      is treated as 18 decimals instead of bricking the constructor.
    function _readAssetDecimals(address token) private view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeCall(IERC20Metadata.decimals, ()));
        if (ok && data.length >= 32) {
            uint256 d = abi.decode(data, (uint256));
            if (d <= type(uint8).max - DECIMALS_OFFSET) return uint8(d);
        }
        return 18;
    }

    /// @notice Share decimals = asset decimals + DECIMALS_OFFSET (24 on the
    ///         18-decimal MockUSDC, 12 on a 6-decimal USDC). Display code must
    ///         read this instead of assuming 18.
    function decimals() public view override returns (uint8) {
        return _assetDecimals + DECIMALS_OFFSET;
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
        // With virtual shares a deposit only rounds to 0 shares when it is
        // worth less than one share-unit (1e-6 of the asset's smallest unit at
        // par). Refusing it keeps a depositor from receiving nothing.
        if (shares == 0) revert ZeroShares();
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

    /// @dev Virtual-share conversion, rounded down (toward the vault). On an
    ///      empty vault 1 asset unit mints 10^DECIMALS_OFFSET share units, so
    ///      one whole USDC buys one whole pIV.
    ///
    ///      H-4: once a bailout has drained `totalAssets` to zero while shares
    ///      are still outstanding there is no fair price for new capital, so
    ///      deposits are refused rather than priced against worthless shares.
    ///      `recapitalize()` (owner) or ordinary protocol fee flow through
    ///      `depositFromProtocol` restores a positive share price.
    function previewDeposit(uint256 usdcAmount) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply != 0 && totalAssets == 0) revert VaultInsolvent();
        return Math.mulDiv(usdcAmount, supply + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS);
    }

    /// @dev Virtual-share conversion, rounded down (toward the vault). Never
    ///      exceeds `totalAssets` for any `shares <= totalSupply()`, because
    ///      supply / (supply + VIRTUAL_SHARES) < 1.
    function previewWithdraw(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 0;
        return Math.mulDiv(shares, totalAssets + VIRTUAL_ASSETS, supply + VIRTUAL_SHARES);
    }

    /// @notice Display price: asset base units per ONE WHOLE pIV
    ///         (10^decimals() share units), from the real totals. On the
    ///         18-decimal MockUSDC this is 18-decimal USDC per pIV, as before.
    ///         Returns 10^assetDecimals (1.0) when there is no supply.
    ///         What a holder can actually redeem is `previewWithdraw`, which
    ///         also counts the virtual shares.
    function getSharePrice() external view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 10 ** _assetDecimals;
        return Math.mulDiv(totalAssets, 10 ** decimals(), supply);
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
