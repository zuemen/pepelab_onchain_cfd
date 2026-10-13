"""抓 11 個資產的日線收盤價寫進 heroes/prices/。用法：python fetch_prices.py"""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from herolab.assets import YAHOO_SYMBOL
from herolab.prices import parse_yahoo_chart

OUT = Path(__file__).parent / "prices"
FIRST = dt.date(2024, 4, 1)  # 回放從 2024-10-01 開始；多抓半年給策略規則當回看期


def _epoch(day: dt.date) -> int:
    return int(dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc).timestamp())


def fetch(symbol: str, first: dt.date, last: dt.date) -> dict:
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        + urllib.parse.quote(symbol)
        + f"?interval=1d&period1={_epoch(first)}&period2={_epoch(last) + 86400}"
    )
    # 沒有瀏覽器 User-Agent 會回 401（同 agent/keeper/feeds.ts）
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def main() -> int:
    last = dt.date.today() - dt.timedelta(days=1)  # 今天的 K 棒還沒收
    OUT.mkdir(exist_ok=True)
    for asset, symbol in YAHOO_SYMBOL.items():
        series = parse_yahoo_chart(fetch(symbol, FIRST, last))
        series = series[series.index <= last]
        if len(series) < 100:
            print(f"{asset}: only {len(series)} closes from {symbol}", file=sys.stderr)
            return 1
        series.to_csv(OUT / f"{asset}.csv", header=["close"], index_label="date")
        print(f"{asset}: {len(series)} closes, {series.index[0]} .. {series.index[-1]}")
        time.sleep(1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
