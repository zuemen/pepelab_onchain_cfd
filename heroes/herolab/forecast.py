"""未來 90 天的淨值區間（issue #332）：歷史日報酬的區塊自助抽樣（block bootstrap）。

做法：從歷史的日報酬裡一次抽一段連續 block 天（所有資產用同一段日子，保留資產之間的相關性與波動聚集），
接成 horizon 天的價格路徑；每條路徑都讓策略從今天的收盤價、全新的本金開始跑一次。
這是「歷史波動再來一次」的模擬，不是預測模型：不假設漲跌方向，也不會出現歷史上沒有過的單日波動。
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

HORIZON_DAYS = 90
PATHS = 1_000
BLOCK_DAYS = 10
SEED = 332
PERCENTILES = (5, 25, 50, 75, 95)


def log_returns(prices: pd.DataFrame) -> np.ndarray:
    """(天數 − 1, 資產數) 的日對數報酬。"""
    values = prices.to_numpy(dtype=float)
    return np.diff(np.log(values), axis=0)


def bootstrap(returns: np.ndarray, horizon: int = HORIZON_DAYS, paths: int = PATHS, block: int = BLOCK_DAYS,
              seed: int = SEED) -> np.ndarray:
    """(paths, horizon, 資產數) 的抽樣日報酬。同一個種子永遠抽到同一組。"""
    days = returns.shape[0]
    block = min(block, days)
    rng = np.random.default_rng(seed)
    starts = rng.integers(0, days - block + 1, size=(paths, math.ceil(horizon / block)))
    index = (starts[..., None] + np.arange(block)).reshape(paths, -1)[:, :horizon]
    return returns[index]


def price_paths(last: np.ndarray, sampled: np.ndarray) -> np.ndarray:
    """(paths, horizon + 1, 資產數)；第 0 天是今天的收盤價。"""
    paths = sampled.shape[0]
    cumulative = np.concatenate([np.zeros((paths, 1, sampled.shape[2])), np.cumsum(sampled, axis=1)], axis=1)
    return last[None, None, :] * np.exp(cumulative)


def fan(equity: np.ndarray, capital: float) -> dict:
    """equity 是 (paths, horizon + 1)。逐日的百分位，以及期末虧損、虧掉一半以上的機率。"""
    bands = np.percentile(equity, PERCENTILES, axis=0)
    final = equity[:, -1]
    return {
        "percentiles": {f"p{p}": [round(float(v), 2) for v in band] for p, band in zip(PERCENTILES, bands)},
        "lossProbPct": round(float((final < capital - 1e-6).mean()) * 100, 1),
        "halfLossProbPct": round(float((final < capital / 2).mean()) * 100, 1),
    }
