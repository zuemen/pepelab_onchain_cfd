"""依風險目標反推參數。

目標（皆可調）：
  (T1) 保險庫年破產機率 < 0.1%；
  (T2) 單日壞帳 ES_99 < 保險庫規模的 X%（預設 10%）。
保險庫規模以「佔該資產 OI 的比例」u_0 表示（鏈上實際規模與 OI 未盤點，預設 5%，可用 --vault-to-oi 調整）。
反推流程：
  1. 對每個資產 × 碳分級 × 基礎設施情境，從分級上限的槓桿往下試，MMR 由現值 5% 往上試，
     第一組同時滿足 T1、T2 的 (L, m) 就是建議值；
  2. 在建議的 (L, m) 下，掃推價間隔 Δ_p 與清算人平均反應時間 ρ，找出滿足目標的上限；
  3. maxPriceAge：下限是推價間隔的最大值（否則正常運作就會 revert），上限是陳舊價套利的損益兩平時間 a*；
  4. 清算分配：清算人 5% 是 constant；保險庫比例取滿足 T1 的最小值與現值 20% 的較大者。
"""
from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np

from .gap_risk import make_book, simulate_gap, var_es
from .insurance import (VaultIncomeParams, daily_series, min_vault_from_max, ruin_approx, ruin_from_max,
                        ruin_max_stat)
from .params import TIERS, InfraScenario
from .processes import MertonParams


@dataclass
class Targets:
    annual_ruin: float = 0.001
    es99_frac_of_vault: float = 0.10
    vault_to_oi: float = 0.05


@dataclass
class AssetSetup:
    name: str
    proc: MertonParams
    day_hours: float
    year_days: float
    days_per_year: int
    is_jump: float = 1.0     # 重要性抽樣倍數（一般跳躍）
    is_crash: float = 1.0    # 重要性抽樣倍數（崩盤成分）


def run_book(setup: AssetSetup, L: int, m: float, tier: str, infra: InfraScenario, n_days: int,
             rng: np.random.Generator, n_pos: int = 60, adl_scan_fraction: float = 0.25, long_frac: float = 0.5,
             fine_dt_h: float | None = None):
    t = TIERS[tier]
    p = setup.proc

    def book_fn(g):
        return make_book(p, L, t.f, t.r, m, n_pos, g, long_frac=long_frac, max_age_days=7.0,
                         year_days=setup.year_days)

    return simulate_gap(p, book_fn, infra, setup.day_hours, n_days, rng, day_hours=setup.day_hours,
                        year_days=setup.year_days, adl_scan_fraction=adl_scan_fraction,
                        is_jump=setup.is_jump, is_crash=setup.is_crash, fine_dt_h=fine_dt_h)


def summarize(setup: AssetSetup, res, inc: VaultIncomeParams, targets: Targets, tags: dict,
              rng: np.random.Generator, ruin_paths: int = 20_000, ruin_seed: int | None = None) -> dict:
    """由帳簿模擬結果算每日壞帳分布、ES、年破產機率與滿足目標所需的最小保險庫規模。

    年破產機率用完整路徑的 Monte Carlo（ruin_max_stat，一次算出所有 u_0）；單日近似 ruin_approx 只列為對照。
    """
    w = res.weight / res.weight.sum()
    income, loss = daily_series(res.liq_equity, res.bad_debt_total, inc)
    v95, es95 = var_es(loss, 0.95, w)
    v99, es99 = var_es(loss, 0.99, w)
    rr = rng if ruin_seed is None else np.random.default_rng(ruin_seed)
    M = ruin_max_stat(income, loss, setup.days_per_year, ruin_paths, rr, w)
    ruin = ruin_from_max(M, targets.vault_to_oi)
    mv_ruin = min_vault_from_max(M, targets.annual_ruin)
    mv_es = es99 / targets.es99_frac_of_vault
    ok = (ruin <= targets.annual_ruin) and (es99 <= targets.es99_frac_of_vault * targets.vault_to_oi)
    bad_w = float((res.bad_debt * w).sum())
    return {"asset": setup.name, **tags,
            "mean_loss": float((loss * w).sum()), "p_loss": float(w[loss > 0].sum()),
            "var95": v95, "es95": es95, "var99": v99, "es99": es99,
            "mean_income": float((income * w).sum()), "annual_ruin": ruin,
            "annual_ruin_se": float(np.sqrt(max(ruin * (1 - ruin), 0.0) / ruin_paths)),
            "annual_ruin_single_day_approx": ruin_approx(income, loss, targets.vault_to_oi, setup.days_per_year, w),
            "min_vault_ruin": mv_ruin, "min_vault_es": mv_es, "min_vault": max(mv_ruin, mv_es),
            "feasible": bool(ok), "n_days": int(loss.size), "ess": float(1.0 / (w**2).sum()),
            "max_loss": float(loss.max()),
            "adl_share": float((res.adl_capacity * w).sum() / bad_w) if bad_w > 0 else 0.0}


def evaluate(setup: AssetSetup, L: int, m: float, tier: str, infra: InfraScenario, n_days: int,
             rng: np.random.Generator, targets: Targets, inc: VaultIncomeParams | None = None,
             ruin_paths: int = 20_000, ruin_seed: int | None = None, **kw) -> dict:
    inc = inc or VaultIncomeParams(fee_rate=TIERS[tier].f)
    res = run_book(setup, L, m, tier, infra, n_days, rng, **kw)
    return summarize(setup, res, inc, targets, {"tier": tier, "L": L, "m": m, "infra": infra.name}, rng,
                     ruin_paths, ruin_seed)


def recommend_L_m(setup: AssetSetup, tier: str, infra: InfraScenario, n_days: int, rng, targets: Targets,
                  m_grid=(0.05, 0.075, 0.10, 0.15), ruin_paths: int = 20_000) -> dict:
    """從分級上限往下找第一組可行的 (L, m)。m 必須 < 1/L − f（否則一開倉就可清算）。"""
    t = TIERS[tier]
    tried = []
    for L in range(t.max_leverage, 0, -1):
        for m in m_grid:
            if m >= 1.0 / L - t.f:
                continue
            r = evaluate(setup, L, m, tier, infra, n_days, rng, targets, ruin_paths=ruin_paths)
            tried.append(r)
            if r["feasible"]:
                return {"best": r, "tried": tried}
    return {"best": None, "tried": tried}


def sweep_infra(setup: AssetSetup, L: int, m: float, tier: str, push_grid_h, rho_grid_h, n_days: int, rng,
                targets: Targets, max_price_age_h: float = 6.0, ruin_paths: int = 20_000) -> list[dict]:
    """掃推價間隔 Δ_p 與清算人平均反應時間 ρ。

    每一格用同一個子種子、在 1 分鐘細格點上模擬市價（common random numbers）：
    各格看到同一批帳簿與市價路徑，差異只來自推價與清算的檢查點。
    """
    out = []
    base = int(rng.integers(0, 2**31))
    for d in push_grid_h:
        for rho in rho_grid_h:
            infra = InfraScenario(name=f"push{d:.3g}h_rho{rho:.3g}h", push_mode="fixed", push_interval_h=d,
                                  liquidator_mean_h=rho, max_price_age_h=max(max_price_age_h, d))
            cell = np.random.default_rng(base)
            r = evaluate(setup, L, m, tier, infra, n_days, cell, targets, ruin_paths=ruin_paths, fine_dt_h=1 / 60,
                         ruin_seed=base + 1)
            r.update({"push_h": d, "rho_h": rho})
            out.append(r)
    return out


def vault_share_sweep(setup: AssetSetup, L: int, m: float, tier: str, infra: InfraScenario, shares, n_days: int,
                      rng, targets: Targets, ruin_paths: int = 20_000) -> list[dict]:
    """保險庫分配比例的敏感度：同一組模擬樣本、只改收入比例（清算人固定 5%，持有人拿剩下的）。"""
    base_inc = VaultIncomeParams(fee_rate=TIERS[tier].f)
    res = run_book(setup, L, m, tier, infra, n_days, rng)
    out = []
    for s in shares:
        inc = replace(base_inc, vault_share=s)
        r = summarize(setup, res, inc, targets, {"tier": tier, "L": L, "m": m, "infra": infra.name}, rng,
                      ruin_paths)
        r["vault_share"] = s
        out.append(r)
    return out
