"""整條管線的對帳：回放的結果（events.json）和算出來的績效資料必須對得上。
  python check_pipeline.py [events.json] [schedule.json] [--data <dir>]
預設 out/events.json 與 out/schedule.json；小規模回放要傳 tests/fixtures/schedule_smoke.json。
績效資料預設讀 frontend/public/data/heroes/<events.json 的 chainId>/；--data 指定別的目錄（fork 演練）。
任何一項不符就以非零結束。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from herolab.reconcile import TONNE, carbon_mismatch, expected_follower_counts, retired_tonnes

HERE = Path(__file__).parent
DATA = HERE.parent / "frontend" / "public" / "data" / "heroes"
E18 = 10**18
# 未平倉部位的估值與 getPositionValue 相同，只差資金費率（鏈上的指數不在事件裡、不估），所以容許本金 2% 的差距
EQUITY_TOLERANCE = 0.02


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("events", nargs="?", default=str(HERE / "out" / "events.json"))
    parser.add_argument("schedule", nargs="?", default=str(HERE / "out" / "schedule.json"))
    parser.add_argument("--data", default=None)
    args = parser.parse_args()
    schedule_path = Path(args.schedule)
    doc = json.loads(Path(args.events).read_text())
    schedule = json.loads(schedule_path.read_text())
    data = Path(args.data) if args.data else DATA / str(doc["chainId"])
    index = json.loads((data / "index.json").read_text())
    problems: list[str] = []

    if doc["stats"]["failed"] != 0:
        problems.append(f"{doc['stats']['failed']} of {doc['stats']['sent']} transactions failed: {doc['stats']['failures'][:3]}")
    if (index["chainId"], index["range"]) != (doc["chainId"], doc["range"]):
        problems.append("index.json is from a different replay (chainId or range differs)")
    if index.get("timeCompressed") != bool(doc.get("timeCompressed")):
        problems.append("index.json and events.json disagree on timeCompressed")
    # 時間壓縮：每個模擬日都要有區塊範圍，而且依序、不重疊（分析靠它還原日期）
    if doc.get("timeCompressed"):
        days = doc.get("days", [])
        if [d["date"] for d in days] != [d["date"] for d in schedule["days"]]:
            problems.append(f"events.json records block ranges for {len(days)} days, the schedule has {len(schedule['days'])}")
        for prev, cur in zip(days, days[1:]):
            if cur["fromBlock"] <= prev["toBlock"]:
                problems.append(f"block ranges overlap: {prev['date']} ends at {prev['toBlock']}, {cur['date']} starts at {cur['fromBlock']}")
    if (schedule["start"], schedule["end"]) != (doc["range"]["from"], doc["range"]["to"]):
        problems.append(f"{schedule_path.name} covers {schedule['start']}..{schedule['end']}, not this replay's range")
    # 回放跳過的動作（例如交易者質押不足、不能發布或被跟隨）會讓鏈上與排程不一致，一律攤出來
    for line in doc["stats"]["skipped"]:
        problems.append(f"skipped: {line}")
    # #333：退役事件的總噸數與鏈上的累計退役噸數一致
    carbon = carbon_mismatch(doc)
    if carbon is not None:
        problems.append(carbon)
    expected_follows = expected_follower_counts(schedule, [t["index"] for t in doc["traders"]])

    summaries = {t["address"].lower(): t for t in index["traders"]}
    for trader in doc["traders"]:
        address = trader["address"].lower()
        detail = json.loads((data / f"{address}.json").read_text())
        closes_on_chain = sum(1 for e in doc["events"]
                              if e["name"] == "PositionClosed" and e["args"]["owner"].lower() == address)
        if summaries[address]["closedTrades"] != closes_on_chain:
            problems.append(f"{trader['name']}: {summaries[address]['closedTrades']} closed trades in the data, {closes_on_chain} on chain")
        on_chain = int(trader["finalEquity"]) / E18
        computed = detail["equityCurve"][-1]["equity"]
        if abs(computed - on_chain) > trader["capitalUsd"] * EQUITY_TOLERANCE:
            problems.append(f"{trader['name']}: final equity {computed:.2f} in the data, {on_chain:.2f} on chain")
        if trader["followerCount"] != expected_follows[trader["index"]]:
            problems.append(f"{trader['name']}: follower count {trader['followerCount']} on chain, "
                            f"{expected_follows[trader['index']]} follows in the schedule")

    for line in problems:
        print("MISMATCH:", line)
    if not problems:
        closes = sum(t["closedTrades"] for t in index["traders"])
        retirements = sum(1 for e in doc["events"] if e["name"] == "CarbonRetired")
        print(f"pipeline ok: {len(doc['traders'])} traders, {closes} closed trades, {doc['stats']['sent']} tx, 0 failed, "
              f"{retirements} retirements / {retired_tonnes(doc['events']) / TONNE:g} t (simulated credits)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
