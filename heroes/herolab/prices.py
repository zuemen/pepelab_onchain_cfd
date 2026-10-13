from __future__ import annotations

import datetime as dt
from pathlib import Path

import pandas as pd

from .assets import ASSETS


def parse_yahoo_chart(payload: dict) -> pd.Series:
    """Yahoo v8 chart 回應 → 以 UTC 日期為索引的收盤價。收盤價為 null 的日子丟掉。"""
    result = payload["chart"]["result"][0]
    rows = {
        dt.datetime.fromtimestamp(ts, dt.timezone.utc).date(): float(close)
        for ts, close in zip(result["timestamp"], result["indicators"]["quote"][0]["close"])
        if close is not None
    }
    return pd.Series(rows, name="close").sort_index()


def load_prices(directory: Path, start: dt.date, end: dt.date) -> pd.DataFrame:
    """[start, end] 每個日曆日一列、每個資產一欄；非交易日沿用前一個收盤價。"""
    days = list(pd.date_range(start, end, freq="D").date)
    table = pd.DataFrame(index=days)
    for asset in ASSETS:
        raw = pd.read_csv(directory / f"{asset}.csv", parse_dates=["date"])
        series = pd.Series(raw["close"].to_numpy(), index=raw["date"].dt.date)
        # 先在聯集上補值，start 之前的收盤價才帶得進來
        union = sorted(set(series.index) | set(days))
        table[asset] = series.reindex(union).ffill().reindex(days).to_numpy()
    missing = [a for a in ASSETS if pd.isna(table[a].iloc[0])]
    if missing:
        raise ValueError(f"no price on or before {start} for: {missing}")
    return table
