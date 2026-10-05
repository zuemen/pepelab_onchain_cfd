"""資金費率：程式的 OI 失衡費率與失衡回復速度。

程式實際（`PerpetualExchange.sol:1458-1518`，docs/PARAMS_INVENTORY.md §2.1）：
    d = OI_L − OI_S，T = OI_L + OI_S（OI 是開倉名目加總，不隨價格重估）
    rate_bps = trunc( trunc(1e18·d/T) · 75 / 1e18 )        兩段截斷，兩邊都 > 0 才累積，範圍 [−74, +74]
    付方每單位名目：|rate|·1e-4·區間數；收方：付方 × OI_付/OI_收，但最多 10 倍（超出部分留在 exchange 池）
    每 8 小時一個區間，只算滿的區間；累積只在 _pokeFunding 被呼叫時發生（開／平／清算／settleFunding），
    而且用「呼叫當下」的 OI 計算所有經過的區間。

狀態變數：X_t = d/T ∈ [−1, 1]（正規化 OI 失衡）。任務書以 OU 過程 dX = −κX dt + η dW 描述 mark − index 價差；
本程式 mark = index·(1 + trunc(trunc(1e18·X)·cap/1e18)/1e4)（markPremiumCapBps = cap ≤ 200，鏈上 0），
所以價差 ≈ cap·X/1e4 與 X 成正比：X 是 OU，價差就是 OU（κ 相同、η 乘 cap/1e4）。鏈上 cap = 0，價差恆為 0。

回復機制：資金費本身不改變 OI；X 會回復只因為交易者對資金費有反應（套利資金進入收方、付方減倉）。
以「套利彈性」θ 表示：每 8 小時，付方費率為 F（小數）時，失衡被修正 θ·F。
線性化後 κ = θ·0.0075 / 8h，半衰期 = ln2/κ。
"""
from __future__ import annotations

import math

import numpy as np

RATE_SLOPE = 75e-4         # 每單位 X 的付方費率（每 8h）
INTERVAL_H = 8.0
E18 = 10**18


def funding_rate_bps(long_oi: int, short_oi: int, max_rate_bps: int = 75) -> int:
    """逐行重現 `_fundingRateBps`（兩段截斷；任一邊為 0 時不累積，回傳 0）。"""
    if long_oi == 0 or short_oi == 0:
        return 0
    d = long_oi - short_oi
    t = long_oi + short_oi
    imb = abs(d) * E18 // t
    imb = imb if d >= 0 else -imb
    r = abs(imb) * max_rate_bps // E18
    return r if imb >= 0 else -r


def funding_rate_from_x(x: float, total_e18: int = 10**24) -> int:
    """以失衡 X 與總 OI（18 位小數）換成整數 OI 後計算程式費率。"""
    long_oi = int(round(total_e18 * (1 + x) / 2))
    short_oi = total_e18 - long_oi
    return funding_rate_bps(long_oi, short_oi)


def receiver_per_unit(payer_rate: float, payer_oi: float, receiver_oi: float, cap: float = 10.0) -> float:
    """收方每單位名目收入（小數）：付方 × OI_付/OI_收，上限 10 倍。"""
    if receiver_oi <= 0:
        return 0.0
    return min(payer_rate * payer_oi / receiver_oi, cap * payer_rate)


def kappa_continuous(theta: float) -> float:
    """每區塊連續累積（無截斷）的回復速度 κ（每小時）。"""
    return theta * RATE_SLOPE / INTERVAL_H


def kappa_discrete(theta: float) -> float:
    """每 8 小時一次（線性、無截斷）的等效 κ（每小時）：X_{k+1} = (1 − θ·0.0075)X_k。"""
    a = 1 - theta * RATE_SLOPE
    if a <= 0:
        return float("inf")
    return -math.log(a) / INTERVAL_H


def half_life_h(kappa: float) -> float:
    return math.log(2) / kappa if kappa > 0 else float("inf")


def simulate_imbalance(theta: float, eta: float, regime: str, hours: float, dt_h: float, n_paths: int,
                       rng: np.random.Generator, x0: float = 0.6) -> tuple[np.ndarray, np.ndarray]:
    """模擬 X_t。eta 是每 √小時 的失衡雜訊（方向性交易流）。

    regime：
      "block"：每區塊累積、費率線性（不截斷）→ 套利力 −θ·0.0075·X/8h 連續作用；
      "8h"：程式實際（8h 一次、兩段截斷），套利者持有倉位 → 每 8h 一次修正 −θ·F(X)；
      "8h_snipe"：程式實際，但套利者只在結算前一刻進場、結算後立刻離場（見 sniping_edge）
               → 結算瞬間 X 被壓低，之後馬上回到原值，常駐失衡沒有回復力。
    回傳 (時間格點, 路徑 (n_paths, n_steps+1))。
    """
    n = int(round(hours / dt_h))
    t = np.arange(n + 1) * dt_h
    X = np.empty((n_paths, n + 1))
    X[:, 0] = x0
    steps_per_interval = int(round(INTERVAL_H / dt_h))
    rate_lut_x = np.linspace(-1, 1, 4001)
    rate_lut = np.array([funding_rate_from_x(v) for v in rate_lut_x]) * 1e-4
    for k in range(1, n + 1):
        x = X[:, k - 1] + eta * math.sqrt(dt_h) * rng.standard_normal(n_paths)
        if regime == "block":
            x = x - theta * RATE_SLOPE * X[:, k - 1] * dt_h / INTERVAL_H
        elif regime == "8h" and k % steps_per_interval == 0:
            F = np.interp(X[:, k - 1], rate_lut_x, rate_lut)
            F = np.sign(F) * np.floor(np.abs(F) * 1e4 + 1e-9) * 1e-4
            x = x - theta * F
        X[:, k] = np.clip(x, -0.99, 0.99)
    return t, X


def fit_ou_kappa(t_h: np.ndarray, X: np.ndarray, sample_every_h: float = 8.0) -> float:
    """以 AR(1)（每 sample_every_h 取樣）OLS 估計 κ（每小時）：X_{k+1} = b·X_k + ε，κ = −ln b / Δ。"""
    step = int(round(sample_every_h / (t_h[1] - t_h[0])))
    Xs = X[:, ::step]
    x0 = Xs[:, :-1].ravel()
    x1 = Xs[:, 1:].ravel()
    b = float((x0 * x1).sum() / (x0 * x0).sum())
    if b <= 0 or b >= 1:
        return 0.0 if b >= 1 else float("inf")
    return -math.log(b) / sample_every_h


def sniping_edge(x: float, fee: float) -> dict:
    """8h 快照累積下的套利：結算前一刻開倉、結算後立刻平倉（持有 < 1 小時，借貸費 = 0）。

    收方狙擊者每單位名目：receiver − 2f；付方躲費者（結算前平倉、結算後重開）：F − 2f。
    """
    F = abs(funding_rate_from_x(x)) * 1e-4
    payer_share = (1 + abs(x)) / 2
    recv = receiver_per_unit(F, payer_share, 1 - payer_share)
    return {"rate": F, "receiver": recv, "snipe_edge": recv - 2 * fee, "dodge_edge": F - 2 * fee}


def buffer_exhaust_intervals(L: int, m: float, f: float, rate: float = 74e-4) -> float:
    """純機械效果：擁擠方每 8h 付 rate，要幾個區間會把開倉時的緩衝 1/L − m − f 吃光（被清算）。"""
    buf = 1.0 / L - m - f
    return buf / rate
