"""策略實驗室的回測引擎（issue #332）：純函式，輸入價格、策略與參數，輸出逐日淨值、每筆交易與指標。

費用與鏈上相同：每一筆都是交易所的一個部位，開倉與平倉各收「名目 × 碳分級手續費」，槓桿借來的部分
按小時收借款費（開倉時凍結）；部位價值不到「名目 × 維持保證金率」就被清算，剩下的錢扣掉清算獎勵與罰金
才退回。資金費率不模擬。只有日收盤價，所以一天最多在收盤價成交一次。

策略分兩類：
- 逐筆（單一資產）：定期定額、馬丁加倉、網格。每一步自己決定開哪一筆、平哪一筆。
- 持倉組合（一籃資產）：動量、均值回歸、均線趨勢。訊號直接用 rules.py 的 RULES，換倉日全平再照新版開，
  與回放（agent/heroes/plan.ts 的 planOpens）相同。
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Callable, Mapping, Sequence

import numpy as np
import pandas as pd

from .analytics import max_drawdown_pct, risk_score, sharpe
from .assets import borrow_bps_per_hour, fee_bps, max_leverage
from .model import Rebalance
from .rules import RULES

MIN_MARGIN = 10.0  # PerpetualExchange.MIN_MARGIN
MAINTENANCE_BPS = 500  # DEFAULT_MAINTENANCE_MARGIN_BPS
# 清算後退回的比例：剩餘價值扣掉清算獎勵 5%（LIQUIDATION_REWARD_BPS）與罰金 20%（liquidationPenaltyBps）。
LIQUIDATION_REFUND = 0.75
# 馬丁加倉每一輪的第一筆占本金的比例。
MARTINGALE_BASE_PCT = 2.0
_EPS = 1e-9


@dataclass(eq=False)  # 用身分比對：兩筆條件相同的部位仍是兩個部位
class Lot:
    """一個未平倉部位。價值與 PerpetualExchange.getPositionValue 相同（不含資金費率）。"""

    asset: str
    is_long: bool
    leverage: int
    margin: float
    entry: float
    day: int
    fee_bps: int
    borrow_bps: int

    @property
    def open_fee(self) -> float:
        return self.margin * self.leverage * self.fee_bps / 10_000

    def value(self, price: float, day: int) -> float:
        move = price / self.entry - 1.0
        notional = self.margin * self.leverage
        pnl = notional * (move if self.is_long else -move)
        close_fee = notional * self.fee_bps / 10_000
        borrow = self.margin * (self.leverage - 1) * self.borrow_bps * 24 * (day - self.day) / 10_000
        return max(self.margin + pnl - close_fee - borrow, 0.0)


@dataclass(frozen=True)
class Fill:
    day: int
    asset: str
    action: str  # "open" | "close" | "liquidated"
    is_long: bool
    price: float
    margin: float
    pnl: float | None = None  # 只有平倉與清算有：退回 − 保證金 − 開倉手續費


class Account:
    """一個交易所帳戶：可用保證金加上一組部位。"""

    def __init__(self, capital: float):
        self.cash = capital
        self.lots: list[Lot] = []
        self.fills: list[Fill] = []

    def open(self, day: int, asset: str, price: float, spend: float, is_long: bool = True,
             leverage: int = 1) -> Lot | None:
        """spend 是這一筆總共要花的錢（保證金 + 開倉手續費）。保證金低於交易所下限或錢不夠時不開。"""
        rate = fee_bps(asset)
        margin = spend / (1 + leverage * rate / 10_000)
        if margin < MIN_MARGIN or spend > self.cash + _EPS:
            return None
        self.cash -= spend
        lot = Lot(asset, is_long, leverage, margin, price, day, rate, borrow_bps_per_hour(asset))
        self.lots.append(lot)
        self.fills.append(Fill(day, asset, "open", is_long, price, margin))
        return lot

    def close(self, lot: Lot, day: int, price: float, liquidated: bool = False) -> float:
        value = lot.value(price, day)
        refund = value * LIQUIDATION_REFUND if liquidated else value
        self.cash += refund
        self.lots.remove(lot)
        pnl = refund - lot.margin - lot.open_fee
        self.fills.append(Fill(day, lot.asset, "liquidated" if liquidated else "close", lot.is_long, price,
                               lot.margin, pnl))
        return refund

    def liquidate(self, day: int, quote: Mapping[str, float]) -> None:
        for lot in list(self.lots):
            if lot.value(quote[lot.asset], day) <= lot.margin * lot.leverage * MAINTENANCE_BPS / 10_000:
                self.close(lot, day, quote[lot.asset], liquidated=True)

    def equity(self, day: int, quote: Mapping[str, float]) -> float:
        return self.cash + sum(lot.value(quote[lot.asset], day) for lot in self.lots)


Step = Callable[[Account, int, Mapping[str, float]], None]


@dataclass
class Backtest:
    equity: np.ndarray
    fills: list[Fill] = field(default_factory=list)

    @property
    def closed_pnls(self) -> list[float]:
        return [f.pnl for f in self.fills if f.pnl is not None]


def run(prices: Mapping[str, Sequence[float]], step: Step, capital: float) -> Backtest:
    """每天依序：先清算（價格是一夜之間變的），再讓策略在收盤價下單，最後記下淨值。"""
    n_days = len(next(iter(prices.values())))
    account = Account(capital)
    equity = np.empty(n_days)
    for day in range(n_days):
        quote = {asset: float(series[day]) for asset, series in prices.items()}
        account.liquidate(day, quote)
        step(account, day, quote)
        equity[day] = account.equity(day, quote)
    return Backtest(equity, account.fills)


# ── 逐筆策略（單一資產） ──────────────────────────────────────────────────────


def effective_leverage(asset: str, leverage: int) -> int:
    """碳分級的槓桿上限比參數低時用上限，與交易所開倉的規則相同。"""
    return min(int(leverage), max_leverage(asset))


def dca(asset: str, params: dict, capital: float, n_days: int) -> Step:
    """定期定額：每 every_days 天買一次，本金平均分給整段期間的每一次。"""
    every = int(params["every_days"])
    leverage = effective_leverage(asset, params.get("leverage", 1))
    amount = capital / len(range(0, n_days, every))

    def step(account: Account, day: int, quote: Mapping[str, float]) -> None:
        if day % every == 0:
            account.open(day, asset, quote[asset], min(amount, account.cash), leverage=leverage)

    return step


def martingale(asset: str, params: dict, capital: float, n_days: int) -> Step:
    """馬丁加倉：每一輪先買本金的 2%；價格比上一筆再跌 drop_pct 就加倉，金額是上一筆的 multiplier 倍；
    這一輪的部位價值比投入的錢（含手續費）多 take_profit_pct 就全部平倉，隔天重新開始一輪。
    錢不夠買下一筆就不加倉，等停利或期間結束。"""
    multiplier = float(params["multiplier"])
    drop = float(params["drop_pct"]) / 100
    take_profit = float(params["take_profit_pct"]) / 100
    base = capital * MARTINGALE_BASE_PCT / 100
    state = {"next": base, "last": None, "lots": [], "closed_on": None}

    def start(account: Account, day: int, price: float) -> None:
        lot = account.open(day, asset, price, base)
        if lot is not None:
            state.update(next=base * multiplier, last=price, lots=[lot])

    def step(account: Account, day: int, quote: Mapping[str, float]) -> None:
        price = quote[asset]
        lots = [lot for lot in state["lots"] if lot in account.lots]  # 被清算的已經不在帳上
        if not lots:
            if state["closed_on"] != day:
                start(account, day, price)
            return
        cost = sum(lot.margin + lot.open_fee for lot in lots)
        if sum(lot.value(price, day) for lot in lots) >= cost * (1 + take_profit):
            for lot in lots:
                account.close(lot, day, price)
            state.update(lots=[], closed_on=day)
            return
        if price <= state["last"] * (1 - drop) and state["next"] <= account.cash + _EPS:
            lot = account.open(day, asset, price, state["next"])
            if lot is not None:
                lots.append(lot)
                state.update(next=state["next"] * multiplier, last=price)
        state["lots"] = lots

    return step


def grid(asset: str, params: dict, capital: float, n_days: int) -> Step:
    """網格：以第一天的收盤價為基準，往下每隔 spacing_pct 一格、共 levels 格，每格分到本金的 1/levels。
    收盤價跌到某一格就買那一格（一格同時只持有一筆，不重複成交）；漲回上一格就賣掉。
    手上沒有任何一格、而價格已經漲過基準一格時，基準移到當天收盤價。"""
    spacing = float(params["spacing_pct"]) / 100
    levels = int(params["levels"])
    per_level = capital / levels
    state: dict = {"anchor": None, "held": {}}

    def level(i: int) -> float:
        return state["anchor"] * (1 - spacing) ** i

    def step(account: Account, day: int, quote: Mapping[str, float]) -> None:
        price = quote[asset]
        if state["anchor"] is None:
            state["anchor"] = price
        held: dict[int, Lot] = {i: lot for i, lot in state["held"].items() if lot in account.lots}
        for i, lot in sorted(held.items()):
            if price >= level(i - 1):
                account.close(lot, day, price)
                del held[i]
        if not held and price >= state["anchor"] * (1 + spacing):
            state["anchor"] = price
        for i in range(1, levels + 1):
            if i not in held and price <= level(i):
                lot = account.open(day, asset, price, min(per_level, account.cash))
                if lot is not None:
                    held[i] = lot
        state["held"] = held

    return step


def hold(weights: Mapping[str, float]) -> Step:
    """買入持有（對照線）：第一天照權重以 1 倍全部買進，之後不動。"""

    def step(account: Account, day: int, quote: Mapping[str, float]) -> None:
        if day == 0:
            for asset, spend, is_long, lev in plan_opens(account.cash, [(a, w, True, 1) for a, w in weights.items()]):
                account.open(day, asset, quote[asset], min(spend, account.cash), is_long, lev)

    return step


SINGLE: dict[str, Callable[[str, dict, float, int], Step]] = {
    "dca": dca,
    "martingale": martingale,
    "grid": grid,
}


# ── 持倉組合策略（一籃資產） ──────────────────────────────────────────────────


def plan_opens(cash: float, legs: list[tuple[str, float, bool, int]]) -> list[tuple[str, float, bool, int]]:
    """與 agent/heroes/plan.ts 的 planOpens 相同：可用保證金照權重拆給每一檔，並預留開倉手續費。
    legs 是 (資產, 權重, 做多, 槓桿)，權重合計為 1；回傳 (資產, 這一筆要花的錢, 做多, 槓桿)。"""
    load = sum(w * lev * fee_bps(a) / 10_000 for a, w, _, lev in legs)
    budget = cash / (1 + load)
    orders = []
    for asset, weight, is_long, lev in legs:
        margin = budget * weight
        if margin >= MIN_MARGIN:
            orders.append((asset, margin * (1 + lev * fee_bps(asset) / 10_000), is_long, lev))
    return orders


def rebalancer(rebalances: list[Rebalance], days: Sequence[dt.date]) -> Step:
    """換倉日先全部平倉，再照這一版開新部位。"""
    position = {d: i for i, d in enumerate(days)}
    by_day = {position[r.date]: r for r in rebalances if r.date in position}

    def step(account: Account, day: int, quote: Mapping[str, float]) -> None:
        r = by_day.get(day)
        if r is None:
            return
        for lot in list(account.lots):
            account.close(lot, day, quote[lot.asset])
        legs = [(leg.asset, leg.weight_bps / 10_000, leg.is_long, leg.leverage) for leg in r.legs]
        for asset, spend, is_long, lev in plan_opens(account.cash, legs):
            account.open(day, asset, quote[asset], min(spend, account.cash), is_long, lev)

    return step


# ── 一次跑完 ─────────────────────────────────────────────────────────────────


def backtest_single(strategy: str, asset: str, params: dict, closes: Sequence[float], capital: float) -> Backtest:
    return run({asset: closes}, SINGLE[strategy](asset, params, capital, len(closes)), capital)


def backtest_portfolio(rule: str, params: dict, prices: pd.DataFrame, start: dt.date, capital: float) -> Backtest:
    """prices 要包含 start 之前足夠的回看期（規則只看得到當天以前的價格）；淨值從 start 那天起算。"""
    rebalances = RULES[rule](prices, {**params, "start": start.isoformat()}, 0)
    days = [d for d in prices.index if d >= start]
    window = prices.loc[days]
    return run({a: window[a].to_numpy() for a in params["universe"]}, rebalancer(rebalances, days), capital)


def backtest_hold(closes: Mapping[str, Sequence[float]], capital: float) -> Backtest:
    """等權重買入持有。"""
    return run(closes, hold({a: 1 / len(closes) for a in closes}), capital)


# ── 指標 ─────────────────────────────────────────────────────────────────────


def metrics(bt: Backtest, capital: float) -> dict:
    """與交易者排行榜（analytics.py）相同的指標。勝率只算已平倉的部位；沒有平倉時為 None。"""
    equity = pd.Series(bt.equity)
    closed = bt.closed_pnls
    return {
        "totalReturnPct": round((float(equity.iloc[-1]) / capital - 1) * 100, 2),
        "maxDrawdownPct": round(max_drawdown_pct(equity), 2),
        "sharpe": round(sharpe(equity), 2),
        "winRatePct": round(sum(1 for p in closed if p > 0) / len(closed) * 100, 1) if closed else None,
        "closedTrades": len(closed),
        "trades": len(bt.fills),
        "riskScore": risk_score(equity),
    }
