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


TONNE = 10**18


def retired_tonnes(events: list[dict]) -> int:
    """回放匯出的 CarbonRetired 事件加總（1e18 = 1 公噸模擬碳權）。"""
    return sum(int(e["args"]["tonnesCO2e"]) for e in events if e["name"] == "CarbonRetired")


def carbon_mismatch(doc: dict) -> str | None:
    """#333：匯出的退役事件總噸數必須等於鏈上 CarbonRetirement.totalRetiredTonnes()。
    對得上回 None，否則回一句說明。沒有讀回鏈上數字（#333 之前的回放）也算對不上。"""
    carbon = doc.get("carbon")
    if not carbon:
        return "events.json has no on-chain carbon readback (replay predates #333) - re-run the replay"
    on_chain = int(carbon["totalRetiredTonnes"])
    exported = retired_tonnes(doc["events"])
    if on_chain == exported:
        return None
    return f"retired tonnes: {exported / TONNE:g} in the exported events, {on_chain / TONNE:g} on chain"
