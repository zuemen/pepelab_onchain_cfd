"""保險庫（InsuranceVault）償付能力。

程式實際（docs/PARAMS_INVENTORY.md §4）：
- 收入：清算時 closeAmount > 0 的 liquidationPenaltyBps（鏈上 20%）；交易手續費的 vaultFeeShareBps（鏈上 0，
  開倉與平倉都會路由）；FeeRouter 績效費分潤（跟單獲利 × 10% 績效費 × 10% 保險庫 = 1%）；LP 存入、注資。
- 支出：壞帳 bailout(min(缺口, totalAssets))，**先**由保險庫付，**之後**才 ADL。所以 ADL 不會減少保險庫的支出，
  只在保險庫見底後保護其他交易者；「ADL 先吸收」只能當作設計替代方案的情境。
- LP 的 withdraw 沒有冷卻期（壓力時可能先跑），模型不計（見文件限制）。

模型（離散時間、以日為步）：
    U_t = U_{t−1} − D_t + I_t，U_0 = u_0（以「佔 OI 的比例」表示）
當某日 D_t > U_{t−1} 即視為被打穿（保險庫無法全額 bailout，缺口進入 ADL／BadDebt）。
(D_t, I_t) 取自 gap_risk 的帳簿模擬（同一日的壞帳與罰金收入成對抽樣，保留相關性）。
極端尾端（年破產機率 0.1% 對應每日約 3e-6）靠 gap_risk 的重要性抽樣（放大跳躍強度再以概似比加權）取得樣本。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy import optimize


@dataclass
class VaultIncomeParams:
    """保險庫收入參數（皆以「每日、佔 OI 的比例」計）。"""

    vault_share: float = 0.20          # liquidationPenaltyBps / 1e4
    vault_fee_share: float = 0.0       # vaultFeeShareBps / 1e4（鏈上 0）
    fee_rate: float = 0.001            # 交易手續費率 f
    daily_turnover: float = 0.5        # 每日開＋平倉名目 / OI
    copy_profit_per_day: float = 0.0   # 跟單獲利 / OI（每日）；×1% 進保險庫

    def fixed_income_per_day(self) -> float:
        return self.vault_fee_share * self.fee_rate * self.daily_turnover + 0.01 * self.copy_profit_per_day


def daily_series(liq_equity: np.ndarray, bad_debt: np.ndarray, inc: VaultIncomeParams) -> tuple[np.ndarray, np.ndarray]:
    """由帳簿模擬的每日 (清算正權益, 壞帳) 得到 (收入, 支出)。"""
    income = inc.vault_share * np.asarray(liq_equity, dtype=float) + inc.fixed_income_per_day()
    return income, np.asarray(bad_debt, dtype=float)


def _w(loss, w):
    w = np.ones(np.asarray(loss).size) if w is None else np.asarray(w, dtype=float)
    return w / w.sum()


def ruin_mc(income: np.ndarray, loss: np.ndarray, u0: float, n_days: int, n_paths: int,
            rng: np.random.Generator, w: np.ndarray | None = None, chunk: int = 20_000) -> dict:
    """以成對 bootstrap（依權重抽樣）模擬 n_days 天的保險庫餘額，回傳破產機率、標準誤與期末餘額分位數。"""
    pw = _w(loss, w)
    cdf = np.cumsum(pw)
    ruined_total = 0
    finals, first_days = [], []
    done = 0
    while done < n_paths:
        n = min(chunk, n_paths - done)
        u = np.full(n, float(u0))
        ruined = np.zeros(n, dtype=bool)
        first = np.full(n, -1)
        for d in range(n_days):
            idx = np.minimum(np.searchsorted(cdf, rng.random(n), side="right"), cdf.size - 1)
            dl = loss[idx]
            newly = (~ruined) & (dl > u)
            first[newly] = d
            ruined |= newly
            u = np.maximum(u - dl, 0.0) + income[idx]
        ruined_total += int(ruined.sum())
        finals.append(u)
        first_days.append(first[first >= 0])
        done += n
    p = ruined_total / n_paths
    finals = np.concatenate(finals)
    return {"p_ruin": p, "se": math.sqrt(max(p * (1 - p), 1e-300) / n_paths), "n_paths": n_paths,
            "final_q05": float(np.quantile(finals, 0.05)), "final_median": float(np.median(finals)),
            "first_ruin_days": np.concatenate(first_days) if first_days else np.array([])}


def ruin_max_stat(income: np.ndarray, loss: np.ndarray, n_days: int, n_paths: int, rng: np.random.Generator,
                  w: np.ndarray | None = None, chunk: int = 10_000) -> np.ndarray:
    """每條 bootstrap 路徑的「打穿所需初始規模」M = max_t [D_t − C_{t−1}]，C_{t−1} = Σ_{s<t}(I_s − D_s)。

    推導：沒被打穿前 U_{t−1} = u_0 + C_{t−1}；第 t 天被打穿 ⇔ D_t > U_{t−1} ⇔ u_0 < D_t − C_{t−1}。
    所以「n_days 天內被打穿」⇔ u_0 < M。一次模擬就得到所有 u_0 的破產機率：ψ(u_0) = P(M > u_0)，
    而滿足 ψ ≤ 目標的最小 u_0 就是 M 的 (1 − 目標) 分位數。日子依權重（重要性抽樣）成對抽出。
    """
    pw = _w(loss, w)
    cdf = np.cumsum(pw)
    loss = np.asarray(loss, dtype=float)
    income = np.asarray(income, dtype=float)
    out = []
    done = 0
    while done < n_paths:
        n = min(chunk, n_paths - done)
        idx = np.minimum(np.searchsorted(cdf, rng.random((n, n_days)), side="right"), cdf.size - 1)
        D = loss[idx]
        net = income[idx] - D
        c_prev = np.cumsum(net, axis=1) - net
        out.append((D - c_prev).max(axis=1))
        done += n
    return np.concatenate(out)


def ruin_from_max(M: np.ndarray, u0: float) -> float:
    return float((M > u0).mean())


def min_vault_from_max(M: np.ndarray, target: float) -> float:
    """滿足 P(M > u_0) ≤ target 的最小 u_0。樣本不足以解析 target 時回傳樣本最大值（保守）。"""
    if M.size * target < 1:
        return float(max(M.max(), 0.0))
    return float(max(np.quantile(M, 1 - target), 0.0))


def weighted_sf(loss: np.ndarray, w: np.ndarray | None = None):
    """回傳 sf(x) = P(D > x) 的函式（加權經驗分布）。"""
    pw = _w(loss, w)
    o = np.argsort(loss)
    xs = np.asarray(loss, dtype=float)[o]
    tail = np.concatenate([np.cumsum(pw[o][::-1])[::-1], [0.0]])  # tail[i] = P(D ≥ xs[i])

    def sf(x):
        i = np.searchsorted(xs, x, side="right")
        return tail[i]
    return sf


def ruin_approx(income: np.ndarray, loss: np.ndarray, u0: float, n_days: int, w: np.ndarray | None = None) -> float:
    """年破產機率的半解析近似：U_t ≈ u_0 + t·(E[I] − E[D])（確定性漂移），
        ψ ≈ 1 − Π_t (1 − P(D > U_t))
    P(D > x) 用（重要性抽樣加權的）經驗分布。它只算「某一天的單日損失超過當時餘額」，
    忽略連續幾天損失累積的路徑，所以另用 ruin_mc 做完整路徑的 Monte Carlo 對照。"""
    pw = _w(loss, w)
    mu_net = float((np.asarray(income) * pw).sum() - (np.asarray(loss) * pw).sum())
    sf = weighted_sf(loss, w)
    log_surv = 0.0
    for t in range(n_days):
        U = u0 + t * mu_net
        if U <= 0:
            return 1.0
        p = float(sf(U))
        log_surv += math.log1p(-min(p, 1 - 1e-15))
    return 1.0 - math.exp(log_surv)


def min_vault_for_ruin(income, loss, n_days, target, w=None) -> float:
    """年破產機率 = target 時的最小 u_0（二分搜尋，ψ 對 u_0 單調遞減）。"""
    lo, hi = 1e-7, 2.0
    if ruin_approx(income, loss, hi, n_days, w) > target:
        return float("inf")
    if ruin_approx(income, loss, lo, n_days, w) <= target:
        return lo
    for _ in range(45):
        mid = math.sqrt(lo * hi)
        if ruin_approx(income, loss, mid, n_days, w) > target:
            lo = mid
        else:
            hi = mid
    return hi


def lundberg(income: np.ndarray, loss: np.ndarray, w: np.ndarray | None = None) -> dict:
    """Cramér–Lundberg（離散時間版）：每日淨理賠 Z = D − I，若 E[Z] < 0，
    調整係數 R > 0 滿足 E[e^{RZ}] = 1，無限期破產機率 ψ(u) ≤ e^{−R u}。"""
    pw = _w(loss, w)
    z = np.asarray(loss, dtype=float) - np.asarray(income, dtype=float)
    mz = float((z * pw).sum())
    if float(np.max(np.asarray(loss, dtype=float)[pw > 0], initial=0.0)) <= 0:
        return {"R": float("inf"), "mean_net_claim": mz, "note": "樣本內沒有任何壞帳"}
    if mz >= 0:
        return {"R": 0.0, "mean_net_claim": mz, "note": "E[D] ≥ E[I]：長期必然破產（無 R）"}
    zmax = float(z[pw > 0].max())
    if zmax <= 0:
        return {"R": float("inf"), "mean_net_claim": mz, "note": "樣本內沒有任何一天淨損失"}
    logpw = np.log(np.maximum(pw, 1e-300))

    def g(R):
        a = R * z + logpw
        m = a.max()
        return m + math.log(np.exp(a - m).sum())

    hi = 1.0 / zmax
    while g(hi) <= 0:
        hi *= 2
        if hi > 1e12:
            return {"R": float("inf"), "mean_net_claim": mz, "note": "R 發散"}
    R = optimize.brentq(g, 1e-12 * hi, hi)
    return {"R": float(R), "mean_net_claim": mz, "note": ""}
