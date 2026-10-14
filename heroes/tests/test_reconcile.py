from herolab.reconcile import expected_follower_counts


def test_every_scheduled_follow_counts_even_after_an_unfollow():
    # CopyTracker.followTrader 每跟隨一次就 push 一次 followersByTrader，取消不會移除：
    # getFollowerCount 是「跟隨過幾次」，所以取消過、又重新跟隨的都要算進去
    schedule = {"followers": [
        {"index": 40, "actions": [
            {"date": "2024-10-09", "type": "follow", "traderIndex": 10, "amountUsd": 1000},
            {"date": "2024-10-14", "type": "unfollow", "traderIndex": 10},
            {"date": "2024-10-20", "type": "follow", "traderIndex": 10, "amountUsd": 500},
        ]},
        {"index": 41, "actions": [{"date": "2024-10-10", "type": "follow", "traderIndex": 10, "amountUsd": 500}]},
        {"index": 42, "actions": [{"date": "2024-10-11", "type": "follow", "traderIndex": 31, "amountUsd": 500}]},
    ]}
    assert expected_follower_counts(schedule, [10, 13, 31]) == {10: 3, 13: 0, 31: 1}
