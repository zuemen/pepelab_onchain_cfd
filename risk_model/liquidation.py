"""清算價、破產價與首次穿越（清算）機率。

程式實際（`PerpetualExchange.sol:1160-1177`）：
    closeAmount = M + pnl − (M·L·f + M·(L−1)·r·h) − Φ
    可清算 ⇔ closeAmount ≤ m·M·L
其中 pnl = ±Q·(S − S_0)、Q = M·L/S_0。令 β = r·h·(L−1)/L、φ = Φ/(M·L)，可化為
    多單：S ≤ S* = S_0·(1 − 1/L + m + f + β + φ)
    空單：S ≥ S* = S_0·(1 + 1/L − m − f − β − φ)
破產價（closeAmount = 0）：
    多單：S_b = S_0·(1 − 1/L + f + β + φ)；空單：S_b = S_0·(1 + 1/L − f − β − φ)
任務書（MM 以現價名目 m·Q·S 計）：
    多單：S*_tb = S_0·(1 − 1/L)/(1 − m)；空單：S*_tb = S_0·(1 + 1/L)/(1 + m)
推導細節見 docs/RISK_MODEL.md 第二部 §2。
"""
from __future__ import annotations

import math

import numpy as np
from scipy import stats

from .processes import MertonParams, merton_increments

LONG, SHORT = +1, -1


def beta_borrow(r: float, hours: float, L: float) -> float:
    """每單位開倉名目的累積借貸費 β = r·h·(L−1)/L（h 是整數小時）。"""
    return r * math.floor(hours) * (L - 1) / L


def liq_ratio_program(L, m, f, side=LONG, beta=0.0, phi=0.0):
    """程式版清算價 S*/S_0（線性）。"""
    L = np.asarray(L, dtype=float)
    if side == LONG:
        return 1.0 - 1.0 / L + m + f + beta + phi
    return 1.0 + 1.0 / L - m - f - beta - phi


def bankrupt_ratio_program(L, f, side=LONG, beta=0.0, phi=0.0):
    """程式版破產價 S_b/S_0（closeAmount = 0）。"""
    L = np.asarray(L, dtype=float)
    if side == LONG:
        return 1.0 - 1.0 / L + f + beta + phi
    return 1.0 + 1.0 / L - f - beta - phi


def liq_ratio_taskbook(L, m, side=LONG):
    """任務書版清算價 S*/S_0（分式；MM = m·Q·S、不含費用）。"""
    L = np.asarray(L, dtype=float)
    if side == LONG:
        return (1.0 - 1.0 / L) / (1.0 - m)
    return (1.0 + 1.0 / L) / (1.0 + m)


def equity_per_notional(price_ratio, L, f, side=LONG, beta=0.0, phi=0.0):
    """closeAmount / (M·L)，以 x = S/S_0 表示：多單 x − S_b/S_0，空單 S_b/S_0 − x。"""
    b = bankrupt_ratio_program(L, f, side, beta, phi)
    return (price_ratio - b) if side == LONG else (b - price_ratio)


# ── 程式不等式的整數精確模擬（逐點對照用） ─────────────────────────────────────

def _sdiv(a: int, b: int) -> int:
    """Solidity 的有號整數除法：向零截斷（Python 的 // 是向負無限大取整）。"""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


def program_close_amount(margin_wei: int, leverage: int, entry_price_e18: int, oracle_price_e8: int,
                         is_long: bool, fee_bps: int, borrow_bps_per_hour: int, active_seconds: int,
                         funding_index_diff_e18: int, mmr_bps: int) -> tuple[int, int, bool]:
    """逐行重現 `liquidatePosition` 的整數運算（mark = index，即 markPremiumCapBps = 0）。

    回傳 (closeAmount, maintenanceMargin, 可清算與否)。
    """
    current = oracle_price_e8 * 10**10                                     # :1726 價格 ×1e10
    notional = margin_wei * leverage                                       # :1162
    size = notional * 10**18 // entry_price_e18                            # :2020（皆為正，// 即截斷）
    price_change = current - entry_price_e18
    pnl = _sdiv(price_change * size, 10**18)                               # :2022
    if not is_long:
        pnl = -pnl
    trading_fee = notional * fee_bps // 10_000                             # :1163
    borrowed = margin_wei * (leverage - 1)
    borrow_fee = borrowed * borrow_bps_per_hour * (active_seconds // 3600) // 10_000   # :1952
    funding = _sdiv(notional * funding_index_diff_e18, 10**18)             # :2095
    close_amount = margin_wei + pnl - (trading_fee + borrow_fee) - funding  # :1168
    maintenance = notional * mmr_bps // 10_000                             # :1171
    return close_amount, maintenance, close_amount <= maintenance          # :1175


# ── 首次穿越封閉解 ─────────────────────────────────────────────────────────────

def fp_prob_lower(b, nu, sigma, T):
    """X_t = νt + σW_t 在 [0, T] 內觸及下界 b（b < 0）的機率：
        P(min X ≤ b) = Φ((b − νT)/(σ√T)) + exp(2νb/σ²)·Φ((b + νT)/(σ√T))
    """
    b = np.asarray(b, dtype=float)
    sigma = np.asarray(sigma, dtype=float)
    s = sigma * np.sqrt(T)
    with np.errstate(over="ignore", invalid="ignore"):
        p = stats.norm.cdf((b - nu * T) / s) + np.exp(2 * nu * b / sigma**2) * stats.norm.cdf((b + nu * T) / s)
    return np.where(b >= 0, 1.0, np.clip(p, 0.0, 1.0))


def fp_prob_upper(c, nu, sigma, T):
    """觸及上界 c（c > 0）的機率（對 −X 套用下界公式）：
        P(max X ≥ c) = Φ((−c + νT)/(σ√T)) + exp(2νc/σ²)·Φ((−c − νT)/(σ√T))
    """
    c = np.asarray(c, dtype=float)
    sigma = np.asarray(sigma, dtype=float)
    s = sigma * np.sqrt(T)
    with np.errstate(over="ignore", invalid="ignore"):
        p = stats.norm.cdf((-c + nu * T) / s) + np.exp(2 * nu * c / sigma**2) * stats.norm.cdf((-c - nu * T) / s)
    return np.where(c <= 0, 1.0, np.clip(p, 0.0, 1.0))


def liquidation_prob_gbm(L, sigma, T, side=LONG, m=0.05, f=0.001, mu=0.0, beta=0.0, phi=0.0,
                         discrete_dt: float | None = None):
    """GBM 下 [0, T] 內觸及程式版清算價的機率（連續監控）。

    discrete_dt 有值時套用 Broadie–Glasserman–Kou 離散監控修正：
    障礙往遠離起點的方向移 0.5826·σ√Δ（只在離散的檢查點清算，比連續監控難觸發）。
    """
    nu = mu - 0.5 * np.asarray(sigma, dtype=float) ** 2
    ratio = liq_ratio_program(L, m, f, side, beta, phi)
    with np.errstate(divide="ignore", invalid="ignore"):
        bar = np.log(np.maximum(ratio, 1e-300))
    shift = 0.0 if discrete_dt is None else 0.5826 * np.asarray(sigma) * math.sqrt(discrete_dt)
    if side == LONG:
        bar = np.where(ratio <= 0, -np.inf, bar)
        return fp_prob_lower(bar - shift, nu, sigma, T)
    return fp_prob_upper(bar + shift, nu, sigma, T)


# ── Monte Carlo 驗證 ──────────────────────────────────────────────────────────

def mc_first_passage(barrier: float, nu: float, sigma: float, T: float, n_paths: int, n_steps: int,
                     rng: np.random.Generator, side=LONG, bridge: bool = True, chunk: int = 50_000):
    """MC 估計首次穿越機率，回傳 (估計值, 標準誤)。

    bridge=True：在每個格點之間用 Brownian bridge 的穿越機率
        p_i = exp(−2(x_i − b)(x_{i+1} − b)/(σ²Δt))（兩端都在障礙同一側時）
    做條件期望，估計量 1 − Π(1 − p_i)。對 GBM 這是不偏的（任何步長都對），只剩抽樣誤差。
    bridge=False：只看格點（離散監控），會低估連續監控的機率，步長越細越接近。
    """
    dt = T / n_steps
    est, sq, n_done = 0.0, 0.0, 0
    sgn = 1.0 if side == LONG else -1.0
    b = sgn * barrier  # 空單翻號後一律當下界處理
    while n_done < n_paths:
        n = min(chunk, n_paths - n_done)
        x_prev = np.zeros(n)
        surv = np.ones(n)
        hit = np.zeros(n, dtype=bool)
        for _ in range(n_steps):
            x_next = x_prev + sgn * (nu * dt + sigma * math.sqrt(dt) * rng.standard_normal(n))
            hit |= x_next <= b
            if bridge:
                a1, a2 = x_prev - b, x_next - b
                p = np.where((a1 > 0) & (a2 > 0), np.exp(-2 * np.maximum(a1, 0) * np.maximum(a2, 0) / (sigma**2 * dt)), 1.0)
                surv *= 1 - p
            x_prev = x_next
        y = (1 - surv) if bridge else hit.astype(float)
        est += y.sum()
        sq += (y**2).sum()
        n_done += n
    mean = est / n_paths
    var = sq / n_paths - mean**2
    return mean, math.sqrt(max(var, 0.0) / n_paths)


def mc_liquidation_prob_merton(p: MertonParams, L: float, T: float, side=LONG, m=0.05, f=0.001,
                               n_paths: int = 100_000, n_steps: int = 288, rng=None, chunk: int = 50_000):
    """Merton 下 [0, T] 內觸及清算價的機率（MC；擴散部分用 bridge 修正，跳躍在格點上發生）。"""
    rng = rng or np.random.default_rng(0)
    ratio = float(liq_ratio_program(L, m, f, side))
    if side == LONG and ratio <= 0:
        return 0.0, 0.0
    bar = math.log(ratio)
    sgn = 1.0 if side == LONG else -1.0
    b = sgn * bar
    dt = T / n_steps
    tot, sq, done = 0.0, 0.0, 0
    while done < n_paths:
        n = min(chunk, n_paths - done)
        x = np.zeros(n)
        surv = np.ones(n)
        for _ in range(n_steps):
            inc = merton_increments(p, dt, rng, size=(n,))
            xn = x + sgn * inc
            a1, a2 = x - b, xn - b
            pc = np.where((a1 > 0) & (a2 > 0), np.exp(-2 * np.maximum(a1, 0) * np.maximum(a2, 0) / (p.sigma**2 * dt)), 1.0)
            surv *= 1 - pc
            x = xn
        y = 1 - surv
        tot += y.sum()
        sq += (y**2).sum()
        done += n
    mean = tot / n_paths
    return mean, math.sqrt(max(sq / n_paths - mean**2, 0.0) / n_paths)
