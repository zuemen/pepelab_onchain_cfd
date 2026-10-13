"""整條管線的對帳：回放的結果（events.json）和算出來的績效資料必須對得上。
  python check_pipeline.py [events.json]
任何一項不符就以非零結束。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
DATA = HERE.parent / "frontend" / "public" / "data" / "heroes"
E18 = 10**18
# 未平倉部位的淨值只算價格變動，不含尚未實現的借款費與資金費率，所以容許本金 2% 的差距
EQUITY_TOLERANCE = 0.02


def main() -> int:
    events_path = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "out" / "events.json"
    doc = json.loads(events_path.read_text())
    index = json.loads((DATA / "index.json").read_text())
    problems: list[str] = []

    if doc["stats"]["failed"] != 0:
        problems.append(f"{doc['stats']['failed']} of {doc['stats']['sent']} transactions failed: {doc['stats']['failures'][:3]}")
    if (index["chainId"], index["range"]) != (doc["chainId"], doc["range"]):
        problems.append("index.json is from a different replay (chainId or range differs)")

    summaries = {t["address"].lower(): t for t in index["traders"]}
    for trader in doc["traders"]:
        address = trader["address"].lower()
        detail = json.loads((DATA / f"{address}.json").read_text())
        closes_on_chain = sum(1 for e in doc["events"]
                              if e["name"] == "PositionClosed" and e["args"]["owner"].lower() == address)
        if summaries[address]["closedTrades"] != closes_on_chain:
            problems.append(f"{trader['name']}: {summaries[address]['closedTrades']} closed trades in the data, {closes_on_chain} on chain")
        on_chain = int(trader["finalEquity"]) / E18
        computed = detail["equityCurve"][-1]["equity"]
        if abs(computed - on_chain) > trader["capitalUsd"] * EQUITY_TOLERANCE:
            problems.append(f"{trader['name']}: final equity {computed:.2f} in the data, {on_chain:.2f} on chain")
        follows = sum(1 for e in doc["events"]
                      if e["name"] == "TraderFollowed" and e["args"]["trader"].lower() == address)
        if trader["followerCount"] != follows:
            problems.append(f"{trader['name']}: follower count {trader['followerCount']} on chain, {follows} follow events")

    for line in problems:
        print("MISMATCH:", line)
    if not problems:
        closes = sum(t["closedTrades"] for t in index["traders"])
        print(f"pipeline ok: {len(doc['traders'])} traders, {closes} closed trades, {doc['stats']['sent']} tx, 0 failed")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
