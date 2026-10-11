// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

interface IBurnableCarbonCredit is IERC20 {
    function burn(uint256 value) external;
}

/// @title CarbonRetirement —— 以手續費買入並永久銷毀（模擬）碳權
/// @notice Spends the settlement-token budget it holds (funded by
///         `PlatformFeeSplitter` with a fixed slice of the platform's fee share)
///         to buy carbon credits from a fixed seller at a fixed price, and burns
///         them in the same transaction. Every retirement emits
///         `CarbonRetired(amount, tonnesCO2e, timestamp)` and is kept in an
///         on-chain list anyone can read.
///
///         **SIMULATED — 模擬碳權.** On this deployment the credit is
///         `MockCarbonCredit`, a token this project mints itself; it represents
///         no real emission reduction, and burning it offsets nothing. The
///         seller is likewise a project-controlled address standing in for a
///         carbon project, so the "purchase price" does not reach any real
///         project. What *is* real is the mechanism: a non-discretionary share of
///         platform fees is routed here, and a retirement is an irreversible,
///         publicly verifiable burn. `SIMULATED` and `DISCLOSURE` carry the same
///         statement on-chain so no reader of this contract — explorer, UI or
///         integrator — can miss it.
/// @dev    Issue #105, ADR-022. Design points:
///         - No owner, no setters. `seller`, `pricePerTonne`, `credit` and `usdc`
///           are immutable: nobody can redirect proceeds or reprice credits after
///           deployment (the same "constant, not a parameter" stance as
///           ADR-003). Changing any of them means a new, visible deployment.
///         - `retire` is permissionless. It can only spend the budget this
///           contract already holds, only on credits, and only by burning them —
///           a caller chooses *when* and *how much*, never *where the money goes*.
///         - Buy and burn are atomic: the contract never holds credits between
///           transactions (`credit.balanceOf(this) == 0` is an invariant), so a
///           bought tonne cannot be resold or moved instead of being retired.
///         - Decimals-agnostic: `pricePerTonne` is in settlement-token base units
///           per 1e18 credit units, so the same code works for the 18-dec
///           MockUSDC engine and the 6-dec USDC x402 router (ADR-011).
///         - Mainnet path: replace the mock credit + fixed seller with a real
///           pool/retirement aggregator; the fee routing and event stay the same.
contract CarbonRetirement is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Honesty ──────────────────────────────────────────────────────────────

    /// @notice Machine-readable honesty flag: retired credits are simulated.
    bool public constant SIMULATED = true;

    /// @notice Human-readable disclosure, readable from any block explorer.
    string public constant DISCLOSURE =
        "SIMULATED CARBON CREDITS: the credits retired here are MockCarbonCredit tokens minted by this project on a testnet, bought from a project-controlled seller. Burning them offsets no real-world emissions.";

    // ── Constants / immutables ───────────────────────────────────────────────

    /// @notice Credit units per (labelled) tonne of CO2e.
    uint256 public constant TONNE = 1e18;

    IERC20                public immutable usdc;
    IBurnableCarbonCredit public immutable credit;
    /// @notice Address credits are bought from and proceeds are paid to.
    address               public immutable seller;
    /// @notice Settlement-token base units paid per TONNE of credit.
    uint256               public immutable pricePerTonne;

    // ── State ────────────────────────────────────────────────────────────────

    struct Retirement {
        uint256 amount;      // settlement token spent
        uint256 tonnesCO2e;  // credits burned (1e18 = one labelled tonne)
        uint256 timestamp;
        address retiredBy;   // whoever called retire()
    }

    Retirement[] private _retirements;

    uint256 public totalRetiredTonnes;
    uint256 public totalSpent;

    // ── Events ───────────────────────────────────────────────────────────────

    /// @notice `amount` settlement token bought and burned `tonnesCO2e` credits.
    event CarbonRetired(uint256 amount, uint256 tonnesCO2e, uint256 timestamp);

    // ── Errors ───────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroPrice();
    error ZeroAmount();
    error InsufficientBudget(uint256 requested, uint256 available);
    error AmountTooSmall(uint256 amount);

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(address _usdc, address _credit, address _seller, uint256 _pricePerTonne) {
        if (_usdc == address(0) || _credit == address(0) || _seller == address(0)) revert ZeroAddress();
        if (_pricePerTonne == 0) revert ZeroPrice();
        usdc          = IERC20(_usdc);
        credit        = IBurnableCarbonCredit(_credit);
        seller        = _seller;
        pricePerTonne = _pricePerTonne;
    }

    // ── Retire ───────────────────────────────────────────────────────────────

    /// @notice Spend `amount` of this contract's settlement-token budget to buy
    ///         credits from `seller` at `pricePerTonne`, and burn them.
    /// @dev    The seller must hold the credits and have approved this contract.
    ///         Tonnes round down; the remainder (< pricePerTonne / TONNE + 1 base
    ///         units) goes to the seller with the rest of `amount`, so `amount`
    ///         is exactly what leaves the budget and exactly what the event says.
    /// @return tonnes Credits burned (1e18 = one labelled tonne CO2e).
    function retire(uint256 amount) external nonReentrant returns (uint256 tonnes) {
        if (amount == 0) revert ZeroAmount();
        uint256 available = usdc.balanceOf(address(this));
        if (amount > available) revert InsufficientBudget(amount, available);
        tonnes = Math.mulDiv(amount, TONNE, pricePerTonne);
        if (tonnes == 0) revert AmountTooSmall(amount);

        totalRetiredTonnes += tonnes;
        totalSpent         += amount;
        _retirements.push(Retirement(amount, tonnes, block.timestamp, msg.sender));

        // Buy: credits in from the seller, payment out to the seller.
        IERC20(address(credit)).safeTransferFrom(seller, address(this), tonnes);
        usdc.safeTransfer(seller, amount);
        // Retire: burn in the same transaction — the tonne leaves totalSupply.
        credit.burn(tonnes);

        emit CarbonRetired(amount, tonnes, block.timestamp);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// @notice Settlement token waiting to be spent on retirement.
    function budget() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    /// @notice Tonnes `amount` would retire at the fixed price.
    function quoteTonnes(uint256 amount) external view returns (uint256) {
        return Math.mulDiv(amount, TONNE, pricePerTonne);
    }

    /// @notice Credits the seller can currently deliver (balance capped by allowance).
    function availableTonnes() external view returns (uint256) {
        uint256 bal = credit.balanceOf(seller);
        uint256 allowed = credit.allowance(seller, address(this));
        return bal < allowed ? bal : allowed;
    }

    function retirementCount() external view returns (uint256) {
        return _retirements.length;
    }

    function getRetirement(uint256 index) external view returns (Retirement memory) {
        return _retirements[index];
    }

    /// @notice Up to `limit` retirements, newest first, skipping the `offset`
    ///         most recent ones — so a UI can page from the latest backwards.
    function getRecentRetirements(uint256 offset, uint256 limit)
        external
        view
        returns (Retirement[] memory page)
    {
        uint256 n = _retirements.length;
        if (offset >= n) return new Retirement[](0);
        uint256 remaining = n - offset;
        uint256 size = limit < remaining ? limit : remaining;
        page = new Retirement[](size);
        for (uint256 i = 0; i < size; i++) {
            page[i] = _retirements[n - 1 - offset - i];
        }
    }
}
