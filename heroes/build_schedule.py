"""產生回放排程。
  python build_schedule.py                          # 全部 24 位、2024-10-01 到價格檔最後一天
  python build_schedule.py --end 2024-10-30 --indices 10,13,31 --followers 4 --out tests/fixtures/schedule_smoke.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import pandas as pd

from herolab.prices import load_prices
from herolab.roster import TRADERS
from herolab.schedule import build_schedule

HERE = Path(__file__).parent
FIRST = dt.date(2024, 4, 1)


def last_common_close(directory: Path) -> dt.date:
    """每個資產最後一筆收盤價的日期，取最早的那個：之後的日子有資產還沒有價格。"""
    return min(pd.read_csv(p, parse_dates=["date"])["date"].max().date() for p in directory.glob("*.csv"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2024-10-01")
    parser.add_argument("--end", default=None)
    parser.add_argument("--indices", default=None, help="逗號分隔的交易者 index；預設全部")
    parser.add_argument("--followers", type=int, default=60)
    parser.add_argument("--out", default=str(HERE / "out" / "schedule.json"))
    args = parser.parse_args()

    start = dt.date.fromisoformat(args.start)
    end = dt.date.fromisoformat(args.end) if args.end else last_common_close(HERE / "prices")
    wanted = {int(i) for i in args.indices.split(",")} if args.indices else None
    traders = [t for t in TRADERS if wanted is None or t.index in wanted]

    doc = build_schedule(load_prices(HERE / "prices", FIRST, end), traders, start, end, args.followers)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1) + "\n", newline="\n")
    rebalances = sum(len(t["rebalances"]) for t in doc["traders"])
    print(f"{out}: {len(doc['days'])} days, {len(doc['traders'])} traders, "
          f"{rebalances} rebalances, {len(doc['followers'])} followers")


if __name__ == "__main__":
    main()
