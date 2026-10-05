"""Phase 3（Besu 特性重新校準）的測試：Δ 收斂、keeper SLA 單調性、oracle 停擺、資金費間隔、機構 VaR。"""
import math

import numpy as np
import pytest

from risk_model import besu as bz
from risk_model import besu_institution as bi
from risk_model import gap_risk as gr
from risk_model.params import TIERS
from risk_model.processes import MertonParams

LOW = TIERS["Low"]
# 小一點的跳躍強度、偏崩跌的跳幅，讓少量樣本也看得到壞帳
P_JUMP = MertonParams(sigma=0.6, lam=40.0, mu_j=-0.06, sigma_j=0.04)


def _bf(p, L=5, m=0.05, n_pos=40):
    return lambda g: gr.make_book(p, L, LOW.f, LOW.r, m, n_pos, g)


def _mean(res):
    return float(np.average(res.bad_debt_total, weights=res.weight))


def _run(p, variants, n=600, seed=11, horizon_h=24.0, n_pos=40):
    return bz.simulate_besu_multi(p, variants, horizon_h, n, np.random.default_rng(seed), n_pos=n_pos, chunk=24)


def test_effective_delta_is_max_of_block_and_push():
    assert bz.effective_delta_s(2, 1) == 2
    assert bz.effective_delta_s(2, 10) == 10
    assert bz.BesuScenario("x", block_s=2, push_s=0.5).delta_s == 2


def test_delta_to_block_interval_without_jumps_gives_zero_bad_debt():
    """沒有跳躍、keeper 下一個區塊清算：Δ → 出塊間隔（2 秒）時壞帳趨近 0，且隨 Δ 變長不減少。"""
    p = MertonParams(sigma=0.8)
    vs = [bz.Variant(f"d{d}", _bf(p), bz.BesuScenario(f"d{d}", push_s=d, max_price_age_s=d + 60,
                                                      keeper=bz.KeeperSLA(2, 2)))
          for d in (2, 600, 21600)]
    r = _run(p, vs, n=400)
    m = {d: _mean(r[f"d{d}"]) for d in (2, 600, 21600)}
    assert m[2] < 1e-9
    assert m[2] <= m[600] <= m[21600]
    assert m[21600] > 0


def test_delta_converges_with_jumps():
    """有跳躍時 Δ → 出塊間隔，壞帳收斂到「跳躍本身」的下限：2 秒與 10 秒的差，遠小於 2 秒與 6 小時的差。"""
    vs = [bz.Variant(f"d{d}", _bf(P_JUMP), bz.BesuScenario(f"d{d}", push_s=d, max_price_age_s=d + 60,
                                                           keeper=bz.KeeperSLA(2, 2)))
          for d in (2, 10, 21600)]
    r = _run(P_JUMP, vs, n=800)
    m = {d: _mean(r[f"d{d}"]) for d in (2, 10, 21600)}
    assert m[2] > 0                         # 跳躍造成的壞帳不會因 Δ → 0 消失
    assert m[21600] > m[2]
    assert abs(m[10] - m[2]) < 0.25 * (m[21600] - m[2])


def test_keeper_delays_monotone_in_p99():
    z = np.random.default_rng(0).standard_normal(1000)
    d = [bz.keeper_delays(bz.KeeperSLA(median_s=p / 5, p99_s=p), 2.0, z) for p in (10, 60, 600)]
    assert np.all(d[0] <= d[1]) and np.all(d[1] <= d[2])
    assert np.all(d[0] >= 2.0)              # 至少一個區塊
    # p99 的定義
    big = bz.keeper_delays(bz.KeeperSLA(median_s=20, p99_s=100), 2.0, np.random.default_rng(1).standard_normal(400_000))
    assert np.quantile(big, 0.99) == pytest.approx(100, rel=0.03)
    assert np.median(big) == pytest.approx(20, rel=0.02)


def test_keeper_sla_monotonicity():
    """keeper 越慢（p99 越大）、停擺越頻繁，期望壞帳不減少（共同亂數，容許抽樣誤差）。"""
    vs = []
    for p99 in (2, 120, 3600):
        vs.append(bz.Variant(f"p{p99}", _bf(P_JUMP), bz.BesuScenario(
            f"p{p99}", keeper=bz.KeeperSLA(median_s=max(2, p99 / 5), p99_s=p99))))
    r = _run(P_JUMP, vs, n=800)
    m = {k: _mean(v) for k, v in r.items()}
    assert m["p2"] <= m["p120"] * 1.02 + 1e-12
    assert m["p120"] <= m["p3600"] * 1.02 + 1e-12
    assert m["p3600"] > m["p2"]


def test_keeper_outage_raises_bad_debt():
    """keeper 停擺越頻繁，期望壞帳不減少。停擺只有在「已達清算價、但還沒清算」的期間價格繼續惡化時才增加壞帳，
    所以用波動較高的過程與較長的停擺，讓少量樣本就看得到差異。"""
    p = MertonParams(sigma=1.5, lam=40.0, mu_j=-0.06, sigma_j=0.04)
    vs = [bz.Variant(f"o{rate}", _bf(p), bz.BesuScenario(
        f"o{rate}", keeper=bz.KeeperSLA(2, 10, outage_per_day=rate, outage_median_min=360, outage_p99_min=1200)))
        for rate in (0.0, 0.3, 2.0)]
    r = _run(p, vs, n=800)
    m = {k: _mean(v) for k, v in r.items()}
    assert m["o0.0"] <= m["o0.3"] * 1.02 + 1e-12
    assert m["o0.3"] <= m["o2.0"] * 1.02 + 1e-12
    assert m["o2.0"] > m["o0.0"]


def test_oracle_outage_raises_bad_debt():
    """推價停擺：停擺越久，恢復時的跳空越大，壞帳越高（同一批路徑）。"""
    p = MertonParams(sigma=0.9)
    vs = [bz.Variant(f"u{u}", _bf(p), bz.BesuScenario(
        f"u{u}", keeper=bz.KeeperSLA(2, 2), oracle=bz.OracleOutage() if u == 0 else bz.OracleOutage(fixed_min=u)))
        for u in (0, 60, 600)]
    r = _run(p, vs, n=500)
    m = {u: _mean(r[f"u{u}"]) for u in (0, 60, 600)}
    assert m[0] < 1e-9
    assert m[0] <= m[60] <= m[600]
    assert m[600] > 0


def test_outage_windows_and_valid_mask():
    u = np.array([0.5])
    w = bz.outage_windows(0.0, 5, 60, 86_400, 86_400, u, np.array([[0.25, 0, 0]]), np.zeros((1, 3)), fixed_min=60)
    assert w[0, 0, 1] - w[0, 0, 0] == pytest.approx(3600)
    t = np.arange(1, 43_201) * 2.0
    valid = bz.push_valid_mask(t, w)
    assert (~valid).sum() == 1800           # 一小時、每 2 秒一次推價
    none = bz.outage_windows(0.0, 5, 60, 86_400, 86_400, u, np.zeros((1, 3)), np.zeros((1, 3)))
    assert np.all(np.isinf(none))


def test_stale_price_blocks_liquidation_until_next_push():
    """單一倉位：價格過期時清算 revert，等下一次推價才清算。"""
    book = gr.single_position_book(5, LOW.f, 0.05)
    th = float(book.theta[0])
    t = np.array([10.0, 20.0, 400.0, 450.0])
    Y = np.array([[th - 0.01, th - 0.02, th - 0.10, th - 0.30]])
    valid = np.ones_like(Y, dtype=bool)
    kw = np.full((1, bz.MAX_EVENTS, 2), np.inf)
    # 第一次嘗試延遲 100 秒：t = 110 執行時價格年齡 90 秒 > maxPriceAge 60 → revert；
    # 第二次嘗試從下一次推價（t = 400）起算、延遲 30 秒：t = 430 時價格年齡 30 秒 → 以 t = 400 的價格清算
    delays = np.full((1, 1, bz.MAX_ATTEMPTS), 30.0)
    delays[0, 0, 0] = 100.0
    out = bz.evaluate_paths(book, t, Y, valid, delays, kw, max_price_age_s=60, block_s=2, horizon_s=1000)
    eq = float(np.exp(Y[0, 2]) - book.bk[0])
    assert out["n_liquidations"][0] == 1
    assert out["bad_debt"][0] == pytest.approx(max(-eq, 0.0))
    # maxPriceAge 夠長：在 t = 110 以第二次推價的價格清算
    out2 = bz.evaluate_paths(book, t, Y, valid, delays, kw, max_price_age_s=3600, block_s=2, horizon_s=1000)
    eq2 = float(np.exp(Y[0, 1]) - book.bk[0])
    assert out2["liq_equity"][0] + out2["bad_debt"][0] == pytest.approx(abs(eq2))


def test_keeper_outage_delays_execution():
    book = gr.single_position_book(5, LOW.f, 0.05)
    th = float(book.theta[0])
    t = np.arange(1, 501) * 2.0
    Y = np.where(t >= 100, th - 0.01, 0.0)[None, :] - np.where(t >= 600, 0.3, 0.0)[None, :]
    valid = np.ones_like(Y, dtype=bool)
    delays = np.full((1, 1, bz.MAX_ATTEMPTS), 2.0)
    kw = np.full((1, bz.MAX_EVENTS, 2), np.inf)
    a = bz.evaluate_paths(book, t, Y, valid, delays, kw, max_price_age_s=60, block_s=2, horizon_s=1000)
    kw[0, 0] = (50.0, 700.0)                 # keeper 停擺到 t = 700，期間價格再跳空 −30%
    b = bz.evaluate_paths(book, t, Y, valid, delays, kw, max_price_age_s=60, block_s=2, horizon_s=1000)
    assert a["bad_debt"][0] == 0 and a["n_liquidations"][0] == 1
    expect = float(book.bk[0] - np.exp(Y[0, -1]))          # 停擺結束後以跳空後的價格清算
    assert b["bad_debt"][0] == pytest.approx(expect)
    assert expect > 0.15


def test_merton_grid_matches_jump_rate():
    p = MertonParams(sigma=0.0, lam=1000.0, mu_j=0.0, sigma_j=0.01).with_crash(200.0, -0.1, 0.0)
    inc, n_reg, n_cr = bz.merton_grid(p, 1 / 365 / 1000, 4000, 1000, np.random.default_rng(3))
    assert n_reg.mean() == pytest.approx(1000 / 365, rel=0.05)
    assert n_cr.mean() == pytest.approx(200 / 365, rel=0.08)
    assert inc.shape == (4000, 1000)


def test_importance_sampling_unbiased_on_besu_sim():
    p = MertonParams(sigma=0.5, lam=20.0, mu_j=-0.08, sigma_j=0.04)
    v = [bz.Variant("b", _bf(p), bz.BesuScenario("b", push_s=60, keeper=bz.KeeperSLA(2, 2)))]
    a = bz.simulate_besu_multi(p, v, 24, 3000, np.random.default_rng(5), grid_s=60, n_pos=40)["b"]
    b = bz.simulate_besu_multi(p, v, 24, 3000, np.random.default_rng(6), grid_s=60, n_pos=40, is_jump=8.0)["b"]
    assert np.mean(b.weight) == pytest.approx(1.0, abs=0.08)
    pa = float(np.mean(a.bad_debt_total > 0))
    pb = float(np.average(b.bad_debt_total > 0, weights=b.weight))
    assert abs(pa - pb) < 4 * math.sqrt(pa * (1 - pa) / 3000) + 4e-3


def test_max_price_age_tradeoff():
    """maxPriceAge 越短，誤擋（價格過期的時間）越多、時效暴露越小。"""
    outs = [bz.OracleOutage(rate_per_day=24, median_min=0.2, p99_min=1.0)]
    blocked = [bz.blocked_time_fraction(a, 2.0, outs) for a in (10, 60, 600)]
    expo = [bz.stale_exposure(a, 2.0, outs)["mean"] for a in (10, 60, 600)]
    assert blocked[0] > blocked[1] > blocked[2] >= 0
    assert expo[0] <= expo[1] <= expo[2]
    assert bz.blocked_time_fraction(1.0, 2.0, []) == pytest.approx(0.5)     # A < Δ：每個區間有一半過期
    # E[(U − a)⁺] 的封閉式 vs 數值
    z = np.random.default_rng(2).standard_normal(400_000)
    U = 5 * np.exp(bz.lognormal_sigma(5, 60) * z)
    assert bz.lognormal_excess_mean(5, 60, 10) == pytest.approx(np.maximum(U - 10, 0).mean(), rel=0.03)


def test_funding_interval_quantization():
    r8 = bz.funding_interval_row(8.0)
    assert r8["cap_bps"] == 75 and r8["dead_zone"] == pytest.approx(1 / 75)
    r1 = bz.funding_interval_row(1.0)
    assert r1["cap_bps"] == 9 and r1["dead_zone"] == pytest.approx(1 / 9)
    blk = bz.funding_interval_row(2 / 3600)
    assert blk["cap_bps"] == 0 and blk["dead_zone"] == 1.0       # 整數 bps 下每區塊的費率永遠是 0
    assert blk["catchup_window_h"] == pytest.approx(42 / 3600)


def test_snapshot_misallocation_scales_with_interval():
    """快照制的錯配比例：I ≪ 持有時間時 ≈ I/(3·E[h])，隨 I 線性縮小。"""
    a = bz.snapshot_misallocation(8.0, 72.0, 0.0)
    assert a == pytest.approx(0.0, abs=1e-9)      # 持有時間恰為 8h 的整數倍：沒有錯配
    small = bz.snapshot_misallocation(0.01, 4.0, 1.0)
    assert small == pytest.approx(0.01 / (3 * 4.0 * math.exp(0.5)), rel=0.05)
    assert bz.snapshot_misallocation(8.0, 4.0, 1.5) > bz.snapshot_misallocation(1.0, 4.0, 1.5) > small


def test_catchup_requirement():
    k = bz.KeeperSLA(outage_per_day=0.1, outage_median_min=10, outage_p99_min=120)
    per_block = bz.catchup_miss_per_year(2 / 3600, k)
    eight_h = bz.catchup_miss_per_year(8.0, k)
    assert per_block == pytest.approx(36.5, rel=0.01)   # 42 秒的窗：幾乎每次停擺都會截斷
    assert eight_h < 1e-6


def test_institution_balanced_book_has_small_directional_risk():
    """機構：多空均衡時方向性損益幾乎相抵，多方擁擠時 VaR 明顯變大。"""
    p = MertonParams(sigma=0.6, lam=30.0, mu_j=-0.03, sigma_j=0.04)
    q = MertonParams(sigma=0.3, lam=2.0, mu_j=0.0, sigma_j=0.08)
    books = [bi.AssetBook("C", p, 24, 365, 5, 0.05, LOW.f, LOW.r, 0.6),
             bi.AssetBook("E", q, 6.5, 252, 5, 0.10, LOW.f, LOW.r, 0.4)]
    corr = np.array([[1.0, 0.3], [0.3, 1.0]])
    base = bz.BesuScenario("b", keeper=bz.KeeperSLA(2, 2))
    bal = bi.simulate_institution(books, corr, base, 600, np.random.default_rng(1), K=288, skew=0.0, chunk=200)
    skw = bi.simulate_institution(books, corr, base, 600, np.random.default_rng(1), K=288, skew=0.4, chunk=200)
    assert bi.risk_measures(skw["loss"])["var99"] > 3 * bi.risk_measures(bal["loss"])["var99"]
    ce = bi.component_es(skw)
    assert set(ce) == {"C", "E"}


def test_stress_gap_worse_than_path():
    p = MertonParams(sigma=0.6)
    b = bi.AssetBook("C", p, 24, 365, 5, 0.05, LOW.f, LOW.r, 1.0)
    base = bz.BESU_BASELINE
    g = bi.stress_book_loss(b, -0.40, "gap", base, np.random.default_rng(2), n_books=5)
    s = bi.stress_book_loss(b, -0.40, "path", base, np.random.default_rng(2), hours=24, n_books=5)
    assert g["bad"] > 0.1
    assert s["bad"] < 0.1 * g["bad"]


def test_market_stats_file_is_summary_only():
    """參數檔只放摘要統計量（相關係數、衝擊幅度），不放原始價格序列。"""
    st = bi.load_market_stats()
    c = np.array(st["correlation"]["robust"])
    assert c.shape == (4, 4) and np.allclose(np.diag(c), 1.0)
    assert np.all(np.linalg.eigvalsh(c) > 0)
    for ev in st["stress"]:
        for s in ev["shocks"].values():
            assert set(s) == {"close_to_close", "trough", "first_open_gap"}
    shocks = bi.event_shocks(st["stress"][0], "gap")
    assert shocks["BTC"] < -0.3                     # 2020-03-12：加密區間最低價跌幅超過 30%
