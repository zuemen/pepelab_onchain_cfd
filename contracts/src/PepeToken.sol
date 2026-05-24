// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract PepeToken is ERC20, Ownable {
    uint256 public constant INITIAL_SUPPLY = 100_000_000e18; // 100M PEPE

    constructor() ERC20("Pepe RWA Token", "PEPE") Ownable(msg.sender) {
        _mint(msg.sender, INITIAL_SUPPLY);
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
