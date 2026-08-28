// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @notice TESTNET-ONLY mock stablecoin.
///         NEVER deploy this contract to a production network.
contract MockUSDC is ERC20, Ownable {
    uint256 public constant FAUCET_AMOUNT   = 1_000e18;
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    mapping(address => uint256) public lastFaucet;

    address public swapRouter;

    error FaucetCooldown(uint256 nextAvailable);
    error NotMinter(address caller);
    error FaucetCallerMustBeEOA();

    /// @dev The on-chain symbol is a plain "USDC", matching MockUSDT's plain
    ///      "USDT" and the UI's single-source label in
    ///      frontend/src/lib/pepefi/tokenLabel.ts (ADR-0002 rule 1). It used to
    ///      be "mUSDC", which showed up raw in MetaMask and on BaseScan and had
    ///      people asking what a third stablecoin was. The `name()` still says
    ///      "Mock" so a wallet never confuses this with Circle's real USDC —
    ///      that one is the x402 settlement token and is a different address.
    constructor() ERC20("Mock USD Coin", "USDC") Ownable(msg.sender) {}

    /// @dev Owner-only: previously anyone could front-run deployment and claim
    ///      the router slot, gaining the right to burn arbitrary balances.
    function setSwapRouter(address _router) external onlyOwner {
        require(swapRouter == address(0), "Already set");
        swapRouter = _router;
    }

    function burnFrom(address from, uint256 amount) external {
        require(msg.sender == swapRouter, "Only router can burn");
        _burn(from, amount);
    }

    /// @notice One call per 24 h, mints 1 000 USDC.
    /// @dev M9: the cooldown is per-address, so a contract could deploy N
    ///      children (or loop `new`) and drain N × FAUCET_AMOUNT in a single
    ///      transaction — the audit PoC did 50 claims at once. Requiring
    ///      `msg.sender == tx.origin` is the cheap fix: it costs contract
    ///      wallets (Safe, ERC-4337) the ability to use the faucet, which is an
    ///      acceptable trade for TESTNET demo tokens, and no protocol contract
    ///      calls `faucet()`. It is NOT a general-purpose anti-sybil measure:
    ///      one EOA per claim is still one claim per EOA.
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
    /// @dev PA-3: this used to be callable by anyone. The audit PoC minted
    ///      30,000 USDC to itself and swapped it through MockSwapRouter to
    ///      take the router's entire 10 ETH for free — and it made the
    ///      owner-only `setSwapRouter` guard pointless, since guarding the burn
    ///      side is worthless while the supply side is open.
    ///      `swapRouter` keeps mint rights because its ETH→USDC leg mints at a
    ///      fixed rate against ETH actually received, and it already holds the
    ///      matching burn right.
    function mint(address to, uint256 amount) external {
        if (msg.sender != owner() && msg.sender != swapRouter) revert NotMinter(msg.sender);
        _mint(to, amount);
    }
}
