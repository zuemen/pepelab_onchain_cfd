"""價格過程：幾何布朗運動（GBM）與 Merton 跳躍擴散。

記號（時間單位一律是「年」）：
    ln S_t = ln S_0 + ν t + σ W_t + Σ_{i=1}^{N_t} Y_i
    N_t ~ Poisson(λ t)，Y_i ~ N(μ_J, σ_J²)，彼此獨立。
GBM 是 λ = 0 的特例。漂移的換算：
    ν = μ − σ²/2 − λ κ，κ = E[e^Y] − 1 = exp(μ_J + σ_J²/2) − 1
這樣 E[S_t] = S_0 e^{μ t}（μ 是價格的期望成長率）。
"""
from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np
from scipy import stats


@dataclass(frozen=True)
class MertonParams:
    """Merton 跳躍擴散參數（年化）。lam = 0 時就是 GBM。"""

    sigma: float          # 擴散波動度（年化）
    mu: float = 0.0       # 價格期望成長率（年化）；風險評估預設 0
    lam: float = 0.0      # 跳躍強度（次／年）
    mu_j: float = 0.0     # 對數跳幅平均
    sigma_j: float = 0.0  # 對數跳幅標準差
    name: str = ""
    # 壓力情境用的第二個獨立跳躍成分（「崩盤」）：強度、對數跳幅平均、標準差。預設關閉。
    crash_lam: float = 0.0
    crash_mu: float = 0.0
    crash_sigma: float = 0.0

    @property
    def kappa(self) -> float:
        return float(np.exp(self.mu_j + 0.5 * self.sigma_j**2) - 1.0)

    @property
    def crash_kappa(self) -> float:
        return float(np.exp(self.crash_mu + 0.5 * self.crash_sigma**2) - 1.0)

    @property
    def nu(self) -> float:
        """對數價格漂移 ν = μ − σ²/2 − λκ（有崩盤成分時再減 λ_c κ_c）。"""
        return self.mu - 0.5 * self.sigma**2 - self.lam * self.kappa - self.crash_lam * self.crash_kappa

    @property
    def total_var_per_year(self) -> float:
        """對數報酬的年化總變異數 σ² + λ(μ_J² + σ_J²)（＋崩盤成分）。"""
        return (self.sigma**2 + self.lam * (self.mu_j**2 + self.sigma_j**2)
                + self.crash_lam * (self.crash_mu**2 + self.crash_sigma**2))

    def with_crash(self, lam: float, mu: float, sigma: float) -> "MertonParams":
        return replace(self, crash_lam=lam, crash_mu=mu, crash_sigma=sigma, name=self.name + "＋崩盤")

    def as_gbm(self) -> "MertonParams":
        """把跳躍拿掉、波動度維持總變異數不變的 GBM（用來對照「同樣波動但沒有跳空」）。"""
        return replace(self, sigma=float(np.sqrt(self.total_var_per_year)), lam=0.0, mu_j=0.0, sigma_j=0.0,
                       crash_lam=0.0, crash_mu=0.0, crash_sigma=0.0)


def gbm_nu(mu: float, sigma: float) -> float:
    """GBM 的對數漂移 ν = μ − σ²/2。"""
    return mu - 0.5 * sigma**2


def merton_increments(p: MertonParams, dt, rng: np.random.Generator, size=None,
                      lam_scale: float = 1.0, crash_scale: float = 1.0, return_counts: bool = False):
    """產生對數價格增量 ΔX = ν dt + σ√dt Z + Σ_{i≤N} Y_i。

    dt 可以是純量或陣列（不規則時間格點，例如隨機推價間隔）；size 省略時用 dt 的形狀。
    跳躍：N ~ Poisson(λ dt)，N 個常態跳幅相加 = N μ_J + √N σ_J Z'（精確，不是近似）。
    lam_scale／crash_scale：重要性抽樣（importance sampling）用，以 λ' = λ·scale 產生跳躍，
    漂移 ν 仍用原過程的值；呼叫端要用回傳的跳躍次數計算概似比權重（見 gap_risk.simulate_gap）。
    """
    dt = np.asarray(dt, dtype=float)
    if size is None:
        size = dt.shape
    dt = np.broadcast_to(dt, size)
    out = p.nu * dt + p.sigma * np.sqrt(dt) * rng.standard_normal(size)
    n_reg = np.zeros(size, dtype=np.int64)
    n_crash = np.zeros(size, dtype=np.int64)
    if p.lam > 0:
        n_reg = rng.poisson(p.lam * lam_scale * dt)
        hit = n_reg > 0
        if hit.any():
            k = n_reg[hit].astype(float)
            out[hit] += k * p.mu_j + np.sqrt(k) * p.sigma_j * rng.standard_normal(k.shape)
    if p.crash_lam > 0:
        n_crash = rng.poisson(p.crash_lam * crash_scale * dt)
        hit = n_crash > 0
        if hit.any():
            k = n_crash[hit].astype(float)
            out[hit] += k * p.crash_mu + np.sqrt(k) * p.crash_sigma * rng.standard_normal(k.shape)
    if return_counts:
        return out, n_reg, n_crash
    return out


def simulate_log_paths(p: MertonParams, T: float, n_steps: int, n_paths: int,
                       rng: np.random.Generator) -> np.ndarray:
    """等距格點的 ln(S_t/S_0) 路徑，形狀 (n_paths, n_steps + 1)，第 0 欄是 0。"""
    dt = T / n_steps
    inc = merton_increments(p, dt, rng, size=(n_paths, n_steps))
    out = np.zeros((n_paths, n_steps + 1))
    np.cumsum(inc, axis=1, out=out[:, 1:])
    return out


def merton_logpdf(x: np.ndarray, dt: float, p: MertonParams, n_max: int | None = None) -> np.ndarray:
    """dt 期對數報酬的密度（Poisson 混合常態），回傳 log 密度。

    f(x) = Σ_{n=0}^{n_max} P(N=n) · φ(x; ν dt + n μ_J, σ² dt + n σ_J²)
    n_max 取到 Poisson 尾端機率 < 1e-12 為止。
    """
    x = np.asarray(x, dtype=float)
    m = p.lam * dt
    if p.lam <= 0:
        return stats.norm.logpdf(x, p.nu * dt, p.sigma * np.sqrt(dt))
    if n_max is None:
        n_max = int(stats.poisson.isf(1e-12, m)) + 2
    ns = np.arange(n_max + 1)
    logw = stats.poisson.logpmf(ns, m)
    mean = p.nu * dt + ns * p.mu_j
    sd = np.sqrt(p.sigma**2 * dt + ns * p.sigma_j**2)
    comp = stats.norm.logpdf(x[..., None], mean, sd) + logw
    mx = comp.max(axis=-1, keepdims=True)
    return (mx + np.log(np.exp(comp - mx).sum(axis=-1, keepdims=True)))[..., 0]


def merton_cdf(x: np.ndarray, dt: float, p: MertonParams, n_max: int | None = None) -> np.ndarray:
    """dt 期對數報酬的累積分布函數（同樣是 Poisson 混合）。"""
    x = np.asarray(x, dtype=float)
    m = p.lam * dt
    if p.lam <= 0:
        return stats.norm.cdf(x, p.nu * dt, p.sigma * np.sqrt(dt))
    if n_max is None:
        n_max = int(stats.poisson.isf(1e-12, m)) + 2
    ns = np.arange(n_max + 1)
    w = stats.poisson.pmf(ns, m)
    mean = p.nu * dt + ns * p.mu_j
    sd = np.sqrt(p.sigma**2 * dt + ns * p.sigma_j**2)
    return (stats.norm.cdf(x[..., None], mean, sd) * w).sum(axis=-1)
