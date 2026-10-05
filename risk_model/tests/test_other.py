"""過程、校準、保險庫、資金費率的測試。"""
import math

import numpy as np
import pytest

from risk_model import calibration as cal
from risk_model import funding as fd
from risk_model import insurance as ins
from risk_model.processes import MertonParams, merton_cdf, merton_increments, merton_logpdf


def test_merton_increment_moments():
    p = MertonParams(sigma=0.6, mu=0.1, lam=40.0, mu_j=-0.02, sigma_j=0.05)
    dt = 1 / 365
    x = merton_increments(p, dt, np.random.default_rng(0), size=(400_000,))
    mean_th = (p.nu + p.lam * p.mu_j) * dt
    var_th = (p.sigma**2 + p.lam * (p.mu_j**2 + p.sigma_j**2)) * dt
    assert x.mean() == pytest.approx(mean_th, abs=4 * math.sqrt(var_th / x.size))
    assert x.var() == pytest.approx(var_th, rel=0.03)
    # E[S_t/S_0] = e^{μ dt}
    assert np.exp(x).mean() == pytest.approx(math.exp(p.mu * dt), abs=5e-4)


def test_merton_density_integrates_to_one():
    p = MertonParams(sigma=0.4, lam=80.0, mu_j=0.0, sigma_j=0.03)
    xs = np.linspace(-0.3, 0.3, 20001)
    dens = np.exp(merton_logpdf(xs, 1 / 365, p))
    assert np.trapezoid(dens, xs) == pytest.approx(1.0, abs=1e-6)
    assert float(merton_cdf(np.array([0.3]), 1 / 365, p)[0]) == pytest.approx(1.0, abs=1e-8)


def test_threshold_method_recovers_jumps_on_synthetic_data():
    """門檻法只抓得到 |跳幅| > 4σ√dt 的跳躍：偵測到的強度 ≈ λ·P(|J| > 門檻)。"""
    from scipy import stats
    p = MertonParams(sigma=0.4, lam=100.0, mu_j=0.0, sigma_j=0.04)
    dt = 1 / 8760
    r = merton_increments(p, dt, np.random.default_rng(4), size=(8760 * 3,))
    est = cal.threshold_jumps(r, dt)
    assert est["sigma"] == pytest.approx(0.4, rel=0.1)
    thr = 4 * 0.4 * math.sqrt(dt)
    visible = 2 * stats.norm.sf(thr, 0, math.sqrt(p.sigma_j**2 + p.sigma**2 * dt))
    assert est["lam"] == pytest.approx(100.0 * visible, rel=0.25)


def test_offline_calibration_uses_cache_or_snapshot():
    """離線時：有本機快取就用快取，沒有就讀 calibrated_params.json（原始價格不進版控）。"""
    for a in cal.ASSETS:
        c = cal.calibrate(a, offline=True)
        assert c.thr_sigma > 0 and c.mle_sigma > 0
        assert not c.used_defaults


def test_snapshot_matches_parameters(monkeypatch, tmp_path):
    """沒有原始資料時讀到的參數，與參數檔記錄的值完全相同。"""
    import json
    monkeypatch.setattr(cal, "cache_path", lambda a: tmp_path / "absent.csv")
    snap = json.loads(cal.SNAPSHOT.read_text(encoding="utf-8"))["assets"]
    for a in cal.ASSETS:
        c = cal.calibrate(a, offline=True)
        assert c.from_snapshot
        assert c.thr_sigma == snap[a]["thr_sigma"] and c.thr_lam == snap[a]["thr_lam"]


def test_default_calibration_never_touches_network_or_snapshot(monkeypatch, tmp_path):
    """沒有 CSV、沒有任何旗標時：不呼叫網路、不改參數檔，直接讀參數檔。"""
    def boom(*a, **k):
        raise AssertionError("不應該連網")

    monkeypatch.setattr(cal, "cache_path", lambda a: tmp_path / "absent.csv")
    monkeypatch.setattr(cal, "fetch_binance_klines", boom)
    monkeypatch.setattr(cal, "fetch_yahoo_daily", boom)
    monkeypatch.setattr(cal, "_get_json", boom)
    before = cal.SNAPSHOT.read_bytes()
    out = cal.calibrate_all()
    assert all(c.from_snapshot for c in out.values())
    assert cal.SNAPSHOT.read_bytes() == before


def test_ruin_max_stat_matches_path_simulation():
    """「打穿所需初始規模」M 的分布，與逐日模擬保險庫餘額得到的破產機率一致。"""
    rng = np.random.default_rng(8)
    n = 50_000
    loss = np.where(rng.random(n) < 0.01, rng.exponential(0.004, n), 0.0)
    income = np.full(n, 1e-4)
    M = ins.ruin_max_stat(income, loss, 365, 20_000, np.random.default_rng(1))
    for u0 in (0.01, 0.02):
        mc = ins.ruin_mc(income, loss, u0, 365, 20_000, rng)
        p = ins.ruin_from_max(M, u0)
        se = (mc["se"] ** 2 + p * (1 - p) / M.size) ** 0.5
        assert abs(p - mc["p_ruin"]) < 4 * se, (u0, p, mc)
        # 單日近似忽略多日累積，只會低估
        assert ins.ruin_approx(income, loss, u0, 365) <= p + 4 * se
    assert ins.min_vault_from_max(M, 0.05) == pytest.approx(np.quantile(M, 0.95))


def test_lundberg_bound_holds():
    rng = np.random.default_rng(9)
    n = 50_000
    loss = np.where(rng.random(n) < 0.02, rng.exponential(0.003, n), 0.0)
    income = np.full(n, 1.2e-4)
    lb = ins.lundberg(income, loss)
    assert lb["R"] > 0
    u0 = 0.01
    mc = ins.ruin_mc(income, loss, u0, 2000, 4000, rng)
    assert mc["p_ruin"] <= math.exp(-lb["R"] * u0) + 3 * mc["se"]


def test_funding_rate_program_examples():
    e18 = 10**18
    assert fd.funding_rate_bps(2 * e18, e18) == 24          # 75·(1/3) = 25，兩段截斷後 24
    assert fd.funding_rate_bps(e18, 2 * e18) == -24
    assert fd.funding_rate_bps(10**30, 1) == 74             # 兩邊都 > 0 時最多 74
    assert fd.funding_rate_bps(e18, 0) == 0                  # 一邊為 0 不累積
    assert fd.funding_rate_from_x(0.01) == 0                 # |X| < 1/75 的死區
    assert fd.funding_rate_from_x(0.5) == 37


def test_receiver_cap_and_kappa():
    assert fd.receiver_per_unit(0.0074, 0.95, 0.05) == pytest.approx(0.074)   # 19 倍被截在 10 倍
    assert fd.receiver_per_unit(0.003, 0.6, 0.4) == pytest.approx(0.0045)
    th = 20
    assert fd.half_life_h(fd.kappa_continuous(th)) == pytest.approx(math.log(2) * 8 / (th * 0.0075))
    assert fd.kappa_discrete(th) > fd.kappa_continuous(th)


def test_ou_fit_recovers_kappa():
    th, eta = 20, 0.01
    t, X = fd.simulate_imbalance(th, eta, "block", 24 * 60, 0.25, 200, np.random.default_rng(3), x0=0.0)
    k = fd.fit_ou_kappa(t, X)
    assert k == pytest.approx(fd.kappa_continuous(th), rel=0.15)
