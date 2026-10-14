"""整條管線對帳用的純函式：排程預期鏈上會是什麼樣子。"""
from __future__ import annotations


def expected_follower_counts(schedule: dict, trader_indices: list[int]) -> dict[int, int]:
    """每位交易者在排程裡被跟隨了幾次——與 CopyTracker.getFollowerCount 相同的算法
    （每次 followTrader 都 push 一次，取消不移除）。"""
    counts = {index: 0 for index in trader_indices}
    for follower in schedule["followers"]:
        for action in follower["actions"]:
            if action["type"] == "follow" and action["traderIndex"] in counts:
                counts[action["traderIndex"]] += 1
    return counts
