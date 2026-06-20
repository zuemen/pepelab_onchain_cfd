// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Platform token. On testnet a public `faucet()` lets anyone self-serve
///         PEPE (mirrors MockUSDC.faucet) so the token has liquidity on a fresh
///         network. TESTNET-ONLY — the faucet must NOT exist on a production
///         deployment.
contract PepeToken is ERC20, Ownable {
    uint256 public constant INITIAL_SUPPLY  = 100_000_000e18; // 100M PEPE
    uint256 public constant FAUCET_AMOUNT   = 10_000e18;      // 10k PEPE per claim
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    mapping(address => uint256) public lastFaucet;

    error FaucetCooldown(uint256 nextAvailable);

    constructor() ERC20("Pepe RWA Token", "PEPE") Ownable(msg.sender) {
        _mint(msg.sender, INITIAL_SUPPLY);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice TESTNET faucet — one call per 24 h, mints 10 000 PEPE to caller.
    function faucet() external {
        uint256 last = lastFaucet[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) {
            revert FaucetCooldown(last + FAUCET_COOLDOWN);
        }
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}
