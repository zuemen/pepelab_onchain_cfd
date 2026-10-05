"""跳空壞帳模擬的測試。"""
import numpy as np
import pytest

from risk_model import gap_risk as gr
from risk_model.params import TIERS, InfraScenario
from risk_model.processes import MertonParams

LOW = TIERS["Low"]


def _book(p, L=5):
    return lambda g: gr.make_book(p, L, LOW.f, LOW.r, 0.05, 40, g)


def test_bad_debt_vanishes_as_delta_to_zero_without_jumps():
    """沒有跳躍、常駐 bot、推價間隔 → 0 時，價格連續，清算一定發生在破產價之前：壞帳 → 0。"""
    p = MertonParams(sigma=0.8)
    rng = np.random.default_rng(1)
    means = {}
    for d in (6.0, 1.0, 1 / 60):
        infra = InfraScenario("t", "fixed", d, 0.0, max(6.0, d))
        res = gr.simulate_gap(p, _book(p), infra, 24.0, 1500, rng)
        means[d] = float(np.average(res.bad_debt_total, weights=res.weight))
    assert means[1 / 60] < 1e-9
    assert means[1 / 60] <= means[1.0] <= means[6.0]
    assert means[6.0] > 0


def test_single_position_gap_below_bankruptcy_is_bad_debt():
    """單一倉位：價格一次跳到破產價以下，壞帳 = 破產價 − 清算價（每單位名目）。"""
    L, f, m = 5, LOW.f, 0.05
    book = gr.single_position_book(L, f, m)
    # 破產價 0.801。用「崩盤成分」強度極高、跳幅固定 ln 0.7：第一個推價區間內一定跳很多次，價格趨近 0
    p = MertonParams(sigma=1e-9).with_crash(1e9, float(np.log(0.7)), 0.0)
    infra = InfraScenario("t", "fixed", 1.0, 0.0, 6.0)
    rng = np.random.default_rng(3)
    res = gr._simulate_chunk(p, book, infra, 2.0, 5, rng, 24.0, 365.0, 0.2, 0.05, 1.0)
    # 1 小時內跳了很多次：價格趨近 0，壞帳 → 破產價 0.801 − 0
    assert np.all(res["bad_debt"] > 0.79)
    assert np.all(res["n_liquidations"] == 1)


def test_importance_sampling_is_unbiased():
    p = MertonParams(sigma=0.5, lam=20.0, mu_j=-0.08, sigma_j=0.04)
    infra = InfraScenario("t", "fixed", 1.0, 0.0, 6.0)
    plain = gr.simulate_gap(p, _book(p), infra, 24.0, 6000, np.random.default_rng(5))
    isr = gr.simulate_gap(p, _book(p), infra, 24.0, 6000, np.random.default_rng(6), is_jump=8.0)
    assert np.mean(isr.weight) == pytest.approx(1.0, abs=0.08)
    a = gr.loss_metrics(plain.bad_debt_total)
    b = gr.loss_metrics(isr.bad_debt_total, isr.weight)
    se = (a["p_pos_se"] ** 2 + b["p_pos_se"] ** 2) ** 0.5
    assert abs(a["p_pos"] - b["p_pos"]) < 4 * se + 1e-4


def test_liquidator_delay_and_staleness_increase_losses():
    """清算人越慢、壞帳越大；maxPriceAge 比推價間隔短時，可清算時間窗被切掉。"""
    p = MertonParams(sigma=0.6, lam=50.0, mu_j=-0.05, sigma_j=0.04)
    out = {}
    for rho in (0.0, 6.0):
        infra = InfraScenario("t", "fixed", 1.0, rho, 6.0)
        res = gr.simulate_gap(p, _book(p), infra, 24.0, 4000, np.random.default_rng(11))
        out[rho] = res.bad_debt_total.mean()
    assert out[6.0] > out[0.0]
    t, valid = gr.push_schedule(InfraScenario("t", "fixed", 3.0, 0.0, 1.0), 24.0, 4, np.random.default_rng(0))
    caught = gr.catch_mask(t, valid, InfraScenario("t", "fixed", 3.0, 1.0, 1.0), 24.0, np.random.default_rng(0))
    assert caught.shape == t.shape


def test_observed_push_schedule_matches_keeper_stats():
    infra = InfraScenario("obs", "observed", 1.5, 0.0, 6.0)
    t, valid = gr.push_schedule(infra, 24.0 * 30, 50, np.random.default_rng(2))
    gaps = np.diff(t, axis=1)[valid[:, 1:]]
    assert gaps.min() >= 68 / 60 - 1e-9
    assert gaps.max() <= 169 / 60 + 1e-9
    assert np.mean(gaps) * 60 == pytest.approx(90, abs=2.0)


def test_var_es_weighted():
    x = np.arange(1, 101, dtype=float)
    v, e = gr.var_es(x, 0.95)
    assert v == pytest.approx(95.0)
    assert e == pytest.approx(np.mean(x[95:]), abs=0.6)
    # 權重加倍等於樣本重複
    w = np.ones(100)
    w[-1] = 2.0
    x2 = np.concatenate([x, [100.0]])
    assert gr.var_es(x, 0.99, w)[1] == pytest.approx(gr.var_es(x2, 0.99)[1])
