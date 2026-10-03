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

interface ISendHook { function tokensToSend(address from, address to, uint256 value) external; }
interface IReceiveHook { function tokensReceived(address from, address to, uint256 value) external; }

/// @notice TEST-ONLY: a hypothetical FiatToken upgrade with ERC-777-style
///         transfer hooks — `tokensToSend` on a registered `from` BEFORE the
///         balances move, `tokensReceived` on a registered `to` AFTER
///         (registration stands in for ERC-1820 opt-in). With
///         `bubble` false a failing hook is swallowed (the transfer still
///         happens); with `bubble` true the hook's revert aborts the transfer.
///         Native USDC has no hooks today; ADR-011 M-1 regression.
contract HookedUSDC6 is ERC20 {
    bool public bubble;
    mapping(address => bool) public hooked;
    constructor() ERC20("Hooked USDC", "USDC") {}
    function register(address a) external { hooked[a] = true; }
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 a) external { _mint(to, a); }
    function setBubble(bool b) external { bubble = b; }

    function _update(address from, address to, uint256 v) internal override {
        bool hooks = from != address(0) && to != address(0);
        if (hooks && hooked[from]) _call(from, abi.encodeCall(ISendHook.tokensToSend, (from, to, v)));
        super._update(from, to, v);
        if (hooks && hooked[to]) _call(to, abi.encodeCall(IReceiveHook.tokensReceived, (from, to, v)));
    }

    function _call(address target, bytes memory data) private {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok && bubble) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }
}
