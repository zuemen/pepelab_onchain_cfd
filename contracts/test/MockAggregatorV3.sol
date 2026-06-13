// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Test helper mimicking a Chainlink AggregatorV3 price feed.
contract MockAggregatorV3 {
    uint8   public decimals;
    int256  public answer;
    uint256 public updatedAt;
    uint80  public roundId;

    constructor(uint8 _decimals, int256 _answer) {
        decimals  = _decimals;
        answer    = _answer;
        updatedAt = block.timestamp;
        roundId   = 1;
    }

    function setAnswer(int256 _answer) external {
        answer    = _answer;
        updatedAt = block.timestamp;
        roundId  += 1;
    }

    function setUpdatedAt(uint256 _ts) external {
        updatedAt = _ts;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}
