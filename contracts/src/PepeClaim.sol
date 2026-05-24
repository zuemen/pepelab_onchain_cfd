// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IKYCRegistry {
    function isVerified(address user) external view returns (bool);
}

contract PepeClaim is Ownable {
    IERC20       public immutable pepe;
    IKYCRegistry public immutable kyc;

    uint256 public claimAmount = 1000e18;

    mapping(address => bool) public claimed;

    event Claimed(address indexed user, uint256 amount);
    event ClaimAmountSet(uint256 newAmount);
    event Withdrawn(address indexed to, uint256 amount);

    constructor(address _pepe, address _kyc) Ownable(msg.sender) {
        pepe = IERC20(_pepe);
        kyc  = IKYCRegistry(_kyc);
    }

    function claim() external {
        require(kyc.isVerified(msg.sender), "KYC required");
        require(!claimed[msg.sender],       "already claimed");
        claimed[msg.sender] = true;
        require(pepe.transfer(msg.sender, claimAmount), "transfer failed");
        emit Claimed(msg.sender, claimAmount);
    }

    function setClaimAmount(uint256 amount) external onlyOwner {
        claimAmount = amount;
        emit ClaimAmountSet(amount);
    }

    function withdraw(uint256 amount) external onlyOwner {
        require(pepe.transfer(owner(), amount), "transfer failed");
        emit Withdrawn(owner(), amount);
    }
}
