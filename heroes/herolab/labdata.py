"""策略實驗室的資料檔（issue #332）：參數格點、每一組（策略、參數、標的）的結果，與一份索引。

全部預先算好，前端只讀檔、不計算。資料不綁定任何鏈：價格是真實歷史價格，不是鏈上的。
"""
from __future__ import annotations

import datetime as dt
import itertools
from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import forecast
from .assets import ASSETS, CARBON_TIER, borrow_bps_per_hour, fee_bps, max_leverage
from .lab import (
    MARTINGALE_BASE_PCT, Backtest, Fill, backtest_hold, backtest_portfolio, backtest_single, effective_leverage,
    metrics,
)
from .roster import EQUITIES, LOW_CARBON

SCHEMA_VERSION = 1
CAPITAL = 10_000.0
# 持倉組合類規則回看最多 100 天（均線趨勢的 window）；預測時接在模擬路徑前面的真實歷史。
LOOKBACK_DAYS = 130


@dataclass(frozen=True)
class StrategySpec:
    id: str
    kind: str  # "single"（逐筆、單一資產）| "portfolio"（持倉組合、一籃資產）
    params: tuple[tuple[str, tuple], ...]
    rule: str | None = None  # 持倉組合類用的 rules.py 規則，也是對應模擬交易者的依據


# 每種策略 2–3 個主要參數、每個 2–3 個值。全部組合都會預先算好。
STRATEGIES: tuple[StrategySpec, ...] = (
    StrategySpec("dca", "single", (("every_days", (7, 30)), ("leverage", (1, 2)))),
    StrategySpec("martingale", "single", (("multiplier", (1.5, 2)), ("drop_pct", (5, 10)), ("take_profit_pct", (5, 10)))),
    StrategySpec("grid", "single", (("spacing_pct", (3, 6, 10)), ("levels", (5, 10)))),
    StrategySpec("momentum", "portfolio", (("lookback", (30, 90)), ("every_days", (7, 30)), ("leverage", (1, 2))), "momentum"),
    StrategySpec("mean_reversion", "portfolio", (("lookback", (30, 60)), ("every_days", (14, 30)), ("leverage", (1, 2))), "mean_reversion"),
    StrategySpec("trend", "portfolio", (("window", (50, 100)), ("every_days", (14, 30)), ("leverage", (1, 2))), "trend"),
)

# 一籃資產。動量與均值回歸從中挑 3 檔，均線趨勢全部持有、方向看均線。
BASKETS: dict[str, list[str]] = {
    "low_carbon": LOW_CARBON,
    "equities": EQUITIES,
    "macro": ["sGOLD", "sBOND", "sBTC", "sESGU"],
    "crypto_mix": ["sBTC", "sETH", "sGOLD", "sNVDA"],
}
PORTFOLIO_FIXED = {"top_k": 3}


def param_key(values) -> str:
    """結果檔名裡的參數段；前端用 String(value) 組出同一個字串，所以整數不能寫成 2.0。"""
    return "_".join(str(v) for v in values)


def result_name(strategy: str, target: str, values) -> str:
    return f"{strategy}__{target}__{param_key(values)}.json"


def combos() -> list[tuple[StrategySpec, str, dict]]:
    out = []
    for spec in STRATEGIES:
        targets = ASSETS if spec.kind == "single" else tuple(BASKETS)
        names = [k for k, _ in spec.params]
        for values in itertools.product(*(v for _, v in spec.params)):
            for target in targets:
                out.append((spec, target, dict(zip(names, values))))
    return out


# 一筆交易寫成陣列，欄位依序是 TRADE_FIELDS；寫成物件的話，欄位名稱會占掉一半的檔案大小。
TRADE_FIELDS = ("day", "asset", "action", "isLong", "price", "marginUsd", "pnlUsd")


def _fill(f: Fill) -> list:
    return [f.day, f.asset, f.action, f.is_long, round(f.price, 4), round(f.margin, 2),
            None if f.pnl is None else round(f.pnl, 2)]


def _curve(values) -> list[int]:
    """淨值曲線只用來畫圖，取到整數美元；指標是用完整精度算的。"""
    return [int(round(float(v))) for v in values]


class Lab:
    """一次載入價格與模擬路徑，之後逐組計算。"""

    def __init__(self, prices: pd.DataFrame, start: dt.date, end: dt.date, paths: int = forecast.PATHS):
        self.prices = prices.loc[:end]
        self.start, self.end = start, end
        self.days = [d for d in self.prices.index if d >= start]
        window = self.prices.loc[self.days]
        sampled = forecast.bootstrap(forecast.log_returns(window), paths=paths)
        self.paths = forecast.price_paths(window.iloc[-1].to_numpy(dtype=float), sampled)  # (路徑, 91, 資產)
        self.column = {a: i for i, a in enumerate(window.columns)}
        self.future = [end + dt.timedelta(days=i) for i in range(1, forecast.HORIZON_DAYS + 1)]
        self.history = self.prices.iloc[-LOOKBACK_DAYS:]

    def _universe(self, target: str) -> list[str]:
        return [target] if target in ASSETS else BASKETS[target]

    def _backtest(self, spec: StrategySpec, target: str, params: dict, prices: pd.DataFrame,
                  start: dt.date) -> Backtest:
        if spec.kind == "single":
            closes = prices.loc[prices.index >= start, target].to_numpy(dtype=float)
            return backtest_single(spec.id, target, params, closes, CAPITAL)
        full = {**params, **PORTFOLIO_FIXED, "universe": BASKETS[target]}
        return backtest_portfolio(spec.rule, full, prices, start, CAPITAL)

    def _forecast(self, spec: StrategySpec, target: str, params: dict) -> dict:
        universe = self._universe(target)
        columns = [self.column[a] for a in universe]
        equity = np.empty((self.paths.shape[0], self.paths.shape[1]))
        for p in range(self.paths.shape[0]):
            path = self.paths[p][:, columns]
            if spec.kind == "single":
                bt = backtest_single(spec.id, target, params, path[:, 0], CAPITAL)
            else:
                future = pd.DataFrame(path[1:], index=self.future, columns=universe)
                prices = pd.concat([self.history[universe], future])
                bt = self._backtest(spec, target, params, prices, self.end)
            equity[p] = bt.equity
        fan = forecast.fan(equity, CAPITAL)
        fan["percentiles"] = {k: _curve(v) for k, v in fan["percentiles"].items()}
        return {"from": self.end.isoformat(), **fan}

    def result(self, spec: StrategySpec, target: str, params: dict) -> dict:
        bt = self._backtest(spec, target, params, self.prices, self.start)
        window = self.prices.loc[self.days, self._universe(target)]
        benchmark = backtest_hold({a: window[a].to_numpy(dtype=float) for a in window.columns}, CAPITAL)
        out = {
            "schemaVersion": SCHEMA_VERSION,
            "strategy": spec.id,
            "target": target,
            "params": params,
            "start": self.start.isoformat(),
            "equity": _curve(bt.equity),
            "benchmark": _curve(benchmark.equity),
            "trades": [_fill(f) for f in bt.fills],
            "metrics": metrics(bt, CAPITAL),
            "benchmarkMetrics": metrics(benchmark, CAPITAL),
            "forecast": self._forecast(spec, target, params),
        }
        if spec.kind == "single" and "leverage" in params:
            out["effectiveLeverage"] = effective_leverage(target, params["leverage"])
        return out

    def index(self) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "range": {"from": self.start.isoformat(), "to": self.end.isoformat()},
            "capitalUsd": CAPITAL,
            "tradeFields": list(TRADE_FIELDS),
            "martingaleBasePct": MARTINGALE_BASE_PCT,
            "forecast": {"horizonDays": forecast.HORIZON_DAYS, "paths": forecast.PATHS,
                         "blockDays": forecast.BLOCK_DAYS, "seed": forecast.SEED,
                         "percentiles": list(forecast.PERCENTILES)},
            "assets": [{"id": a, "carbonTier": CARBON_TIER[a], "feeBps": fee_bps(a),
                        "borrowBpsPerHour": borrow_bps_per_hour(a), "maxLeverage": max_leverage(a)} for a in ASSETS],
            "baskets": [{"id": k, "assets": v} for k, v in BASKETS.items()],
            "strategies": [{"id": s.id, "kind": s.kind, "rule": s.rule,
                            "params": [{"key": k, "values": list(v)} for k, v in s.params]} for s in STRATEGIES],
        }
