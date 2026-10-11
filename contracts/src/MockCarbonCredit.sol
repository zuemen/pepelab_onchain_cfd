// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title MockCarbonCredit —— 模擬碳權（SIMULATED — NOT A REAL CARBON OFFSET）
/// @notice **This token is simulated.** It is minted by this project on a
///         testnet and is not issued by, bridged from, or backed by any carbon
///         registry (Verra, Gold Standard, Toucan, KlimaDAO, …). One whole
///         token (1e18 units) is *labelled* one tonne of CO2e, but no tonne of
///         CO2e was ever avoided or removed to create it, and burning it offsets
///         nothing. 本代幣是模擬碳權：由本專案在測試網自行鑄造，不對應任何真實的
///         減碳或移除量，銷毀它不抵銷任何真實排放。
/// @dev    Spec #93 / issue #105: Base Sepolia has no real carbon-credit token and
///         bridging to mainnet Toucan / KlimaDAO was out of reach, so the
///         retirement *architecture* (fee → `CarbonRetirement` → irreversible
///         on-chain burn event) is real while the *underlying asset* is this
///         mock. Pretending otherwise would destroy the argument; saying so does
///         not — the same posture as README's "trusted relay, not a trustless
///         integration" for the price feed. The disclosure is therefore not only
///         prose: it is in `name()` (what every wallet and block explorer shows)
///         and in the machine-readable `SIMULATED` constant the UI can check.
///
///         Issuance is owner-only (the owner plays the part of a registry issuing
///         credits to a project's inventory). Burning is open to any holder via
///         `ERC20Burnable`; `totalBurned` counts every burn so that
///         `totalSupply() == totalIssued - totalBurned` always holds and a
///         retired tonne can be shown to be gone rather than merely moved.
contract MockCarbonCredit is ERC20, ERC20Burnable, Ownable {
    /// @notice Machine-readable honesty flag: this credit is simulated.
    bool public constant SIMULATED = true;

    /// @notice Cumulative credits ever issued (1e18 = one *labelled* tonne).
    uint256 public totalIssued;
    /// @notice Cumulative credits ever burned, by anyone.
    uint256 public totalBurned;

    event CreditsIssued(address indexed to, uint256 tonnes);

    error ZeroAmount();
    error ZeroAddress();

    constructor(address issuer)
        ERC20("Mock Carbon Credit (SIMULATED, not a real offset)", "mtCO2e")
        Ownable(issuer)
    {}

    /// @notice Issue `tonnes` simulated credits to `to` (e.g. a seller's inventory).
    function issue(address to, uint256 tonnes) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (tonnes == 0) revert ZeroAmount();
        totalIssued += tonnes;
        _mint(to, tonnes);
        emit CreditsIssued(to, tonnes);
    }

    /// @dev OZ v5 funnels mint, burn and transfer through `_update`; a burn is
    ///      `to == address(0)`. Counting here covers both `burn` and `burnFrom`.
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (to == address(0)) totalBurned += value;
    }
}
