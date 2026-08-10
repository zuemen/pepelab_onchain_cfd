// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice TESTNET-ONLY mock stablecoin (USDT). Mirrors MockUSDC so both
///         stablecoins behave identically.
///         Simplification: 18 decimals to match the rest of the system —
///         real USDT uses 6. NEVER deploy this contract to a production network.
contract MockUSDT is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT   = 1_000e18;
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    mapping(address => uint256) public lastFaucet;

    address public swapRouter;

    error FaucetCooldown(uint256 nextAvailable);
    error NotMinter(address caller);
    error FaucetCallerMustBeEOA();

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
    /// @dev M9: see MockUSDC.faucet — the per-address cooldown is trivially
    ///      bypassed by a contract that deploys N children in one transaction.
    ///      `msg.sender == tx.origin` blocks the loop at the cost of contract
    ///      wallets, which is acceptable for a TESTNET faucet.
    function faucet() external {
        // solhint-disable-next-line avoid-tx-origin
        if (msg.sender != tx.origin) revert FaucetCallerMustBeEOA();
        uint256 last = lastFaucet[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) {
            revert FaucetCooldown(last + FAUCET_COOLDOWN);
        }
        lastFaucet[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }

    /// @notice Mint for deploy scripts, seeds, and the swap router.
    /// @dev PA-3: previously unrestricted, which made free-minting into a swap
    ///      router a zero-cost drain. Owner + registered router only.
    function mint(address to, uint256 amount) external {
        if (msg.sender != owner() && msg.sender != swapRouter) revert NotMinter(msg.sender);
        _mint(to, amount);
    }
}
