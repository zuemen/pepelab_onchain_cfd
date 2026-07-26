// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice TESTNET-ONLY mock stablecoin (USDT). `mint` is intentionally
///         unrestricted so deploy scripts, seeds, and tests can fund accounts
///         freely. Mirrors MockUSDC so both stablecoins behave identically.
///         Simplification: 18 decimals to match the rest of the system —
///         real USDT uses 6. NEVER deploy this contract to a production network.
contract MockUSDT is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT   = 1_000e18;
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    mapping(address => uint256) public lastFaucet;

    address public swapRouter;

    error FaucetCooldown(uint256 nextAvailable);

    constructor() ERC20("Mock Tether USD", "USDT") Ownable(msg.sender) {}

    /// @dev Owner-only: otherwise anyone could front-run deployment and claim
    ///      the router slot, gaining the right to burn arbitrary balances.
    function setSwapRouter(address _router) external onlyOwner {
        require(swapRouter == address(0), "Already set");
        swapRouter = _router;
    }

    function burnFrom(address from, uint256 amount) external {
        require(msg.sender == swapRouter, "Only router can burn");
        _burn(from, amount);
    }

    /// @notice One call per 24 h, mints 1 000 USDT.
    function faucet() external {
        uint256 last = lastFaucet[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) {
            revert FaucetCooldown(last + FAUCET_COOLDOWN);
        }
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Unrestricted mint for deploy scripts and tests.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
