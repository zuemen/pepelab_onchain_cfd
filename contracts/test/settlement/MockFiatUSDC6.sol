// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice TEST-ONLY stand-in for Circle's FiatToken (Base native USDC):
///         6 decimals, EIP-2612 permit, `isBlacklisted`, `paused`. Like
///         FiatToken, a blacklisted msg.sender / from / to, or a paused token,
///         makes transfer, transferFrom and approve revert.
contract MockFiatUSDC6 is ERC20, ERC20Permit {
    mapping(address => bool) public isBlacklisted;
    bool public paused;
    /// @dev Optional transfer fee in bps (native USDC has none; used to
    ///      prove the wrapper mints on the balance delta).
    uint256 public feeBps;

    constructor() ERC20("USD Coin", "USDC") ERC20Permit("USD Coin") {}

    function decimals() public pure override returns (uint8) { return 6; }

    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function blacklist(address a) external { isBlacklisted[a] = true; }
    function unBlacklist(address a) external { isBlacklisted[a] = false; }
    function pause() external { paused = true; }
    function unpause() external { paused = false; }
    function setFeeBps(uint256 bps) external { feeBps = bps; }

    function approve(address spender, uint256 value) public override returns (bool) {
        _check(msg.sender); _check(spender);
        return super.approve(spender, value);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            _check(msg.sender); _check(from); _check(to);
            uint256 fee = value * feeBps / 10_000;
            if (fee > 0) {
                super._update(from, address(0xFEE), fee);
                value -= fee;
            }
        }
        super._update(from, to, value);
    }

    function _check(address a) private view {
        require(!paused, "Pausable: paused");
        require(!isBlacklisted[a], "Blacklistable: account is blacklisted");
    }
}

/// @notice TEST-ONLY: a 6-decimal token with no `isBlacklisted` at all, and
///         one whose `isBlacklisted` reverts — the wrapper must fail OPEN.
contract PlainUSDC6 is ERC20 {
    constructor() ERC20("Plain USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract RevertingProbeUSDC6 is ERC20 {
    constructor() ERC20("Reverting USDC", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function isBlacklisted(address) external pure returns (bool) { revert("gone"); }
}
