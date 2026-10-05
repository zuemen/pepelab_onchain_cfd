"""清算價公式與首次穿越機率的測試。"""
import math

import numpy as np
import pytest

from risk_model import liquidation as lq
from risk_model.params import TIERS

M = 0.05
F_LOW = TIERS["Low"].f


# ── 封閉解 vs Monte Carlo ─────────────────────────────────────────────────────

@pytest.mark.parametrize("L,sigma,side,mu", [
    (5, 0.8, lq.LONG, 0.0),
    (5, 0.8, lq.SHORT, 0.0),
    (3, 1.5, lq.LONG, 0.3),
    (3, 1.5, lq.SHORT, -0.3),
    (2, 2.5, lq.LONG, 0.0),
])
def test_closed_form_matches_mc_within_ci(L, sigma, side, mu):
    T = 1 / 365
    nu = mu - 0.5 * sigma**2
    bar = math.log(float(lq.liq_ratio_program(L, M, F_LOW, side)))
    cf = float(lq.liquidation_prob_gbm(L, sigma, T, side, M, F_LOW, mu))
    rng = np.random.default_rng(12345)
    est, se = lq.mc_first_passage(bar, nu, sigma, T, 60_000, 32, rng, side=side, bridge=True)
    assert se > 0
    assert abs(est - cf) <= 4 * se + 1e-6, (est, cf, se)


def test_discrete_monitoring_converges_to_closed_form():
    """只看格點的 MC 低估連續監控機率；步長越細越接近（Brownian bridge 修正就是在補這個差）。"""
    T, sigma, L = 1 / 365, 1.5, 5
    nu = -0.5 * sigma**2
    bar = math.log(float(lq.liq_ratio_program(L, M, F_LOW, lq.LONG)))
    cf = float(lq.liquidation_prob_gbm(L, sigma, T, lq.LONG, M, F_LOW))
    rng = np.random.default_rng(7)
    coarse, _ = lq.mc_first_passage(bar, nu, sigma, T, 60_000, 4, rng, bridge=False)
    fine, se = lq.mc_first_passage(bar, nu, sigma, T, 60_000, 256, rng, bridge=False)
    assert coarse < fine <= cf + 4 * se
    assert abs(fine - cf) < abs(coarse - cf)


def test_first_passage_limits():
    # 障礙就在起點：機率 1；波動趨近 0 且無漂移：機率 0
    assert float(lq.fp_prob_lower(0.0, 0.0, 0.5, 1.0)) == 1.0
    assert float(lq.fp_prob_upper(0.0, 0.0, 0.5, 1.0)) == 1.0
    assert float(lq.fp_prob_lower(-0.1, 0.0, 1e-4, 1.0)) < 1e-12
    # 上界版是下界版的鏡像：P(max X ≥ c; ν) = P(min X ≤ −c; −ν)
    for nu in (-0.4, 0.0, 0.3):
        a = float(lq.fp_prob_upper(0.12, nu, 0.7, 0.5))
        b = float(lq.fp_prob_lower(-0.12, -nu, 0.7, 0.5))
        assert a == pytest.approx(b, rel=1e-12)


# ── 清算價公式的邊界情況 ──────────────────────────────────────────────────────

def test_L1_long_liq_price_is_m_plus_f():
    for tier in TIERS.values():
        assert float(lq.liq_ratio_program(1, M, tier.f, lq.LONG)) == pytest.approx(M + tier.f)
        assert float(lq.bankrupt_ratio_program(1, tier.f, lq.LONG)) == pytest.approx(tier.f)
        assert float(lq.liq_ratio_taskbook(1, M, lq.LONG)) == 0.0


def test_m_to_zero_liq_equals_bankruptcy():
    for L in (1, 2, 5):
        assert float(lq.liq_ratio_program(L, 0.0, F_LOW, lq.LONG)) == pytest.approx(
            float(lq.bankrupt_ratio_program(L, F_LOW, lq.LONG)))
        assert float(lq.liq_ratio_program(L, 0.0, F_LOW, lq.SHORT)) == pytest.approx(
            float(lq.bankrupt_ratio_program(L, F_LOW, lq.SHORT)))
        # 沒有費用、m → 0 時，程式式與任務書式都退化成 1 ∓ 1/L
        assert float(lq.liq_ratio_program(L, 0.0, 0.0, lq.LONG)) == pytest.approx(
            float(lq.liq_ratio_taskbook(L, 0.0, lq.LONG)))
        assert float(lq.liq_ratio_program(L, 0.0, 0.0, lq.SHORT)) == pytest.approx(
            float(lq.liq_ratio_taskbook(L, 0.0, lq.SHORT)))


def test_large_L_is_liquidatable_at_entry():
    """L 很大時多單 S*/S_0 → 1 + m + f > 1：一開倉就可清算。程式只靠 MAX_LEVERAGE = 5 擋住。"""
    L = 1e6
    assert float(lq.liq_ratio_program(L, M, F_LOW, lq.LONG)) == pytest.approx(1 + M + F_LOW, abs=1e-5)
    assert float(lq.liq_ratio_program(L, M, F_LOW, lq.SHORT)) == pytest.approx(1 - M - F_LOW, abs=1e-5)
    # 一開倉就可清算 ⇔ m ≥ 1/L − f（整數模擬程式）
    for L_int, m_bps in ((5, 1990), (5, 1989), (2, 4990), (2, 4989)):
        ca, mm, liq = lq.program_close_amount(100 * 10**18, L_int, 2000 * 10**18, 2000 * 10**8, True, 10, 1, 0, 0,
                                              m_bps)
        assert liq == (m_bps / 1e4 >= 1 / L_int - 0.001 - 1e-12), (L_int, m_bps, ca, mm)


def test_long_short_symmetry():
    for L in (1, 2, 3, 5):
        for tier in TIERS.values():
            beta = lq.beta_borrow(tier.r, 37.9, L)
            s_l = float(lq.liq_ratio_program(L, M, tier.f, lq.LONG, beta, 0.002))
            s_s = float(lq.liq_ratio_program(L, M, tier.f, lq.SHORT, beta, 0.002))
            assert s_l + s_s == pytest.approx(2.0)
            b_l = float(lq.bankrupt_ratio_program(L, tier.f, lq.LONG, beta, 0.002))
            b_s = float(lq.bankrupt_ratio_program(L, tier.f, lq.SHORT, beta, 0.002))
            assert b_l + b_s == pytest.approx(2.0)
            # 清算價與破產價的距離恰好是 m（MMR 以開倉名目計）
            assert s_l - b_l == pytest.approx(M)
            assert b_s - s_s == pytest.approx(M)


def test_inventory_numbers():
    """與 docs/PARAMS_INVENTORY.md §1.4 的數值對照表一致。"""
    assert float(lq.liq_ratio_program(5, M, 0.001, lq.LONG)) == pytest.approx(0.8510)
    assert float(lq.liq_ratio_program(2, M, 0.004, lq.LONG)) == pytest.approx(0.5540)
    assert float(lq.liq_ratio_program(1, M, 0.01, lq.LONG)) == pytest.approx(0.0600)
    assert float(lq.liq_ratio_program(5, M, 0.001, lq.SHORT)) == pytest.approx(1.1490)
    assert float(lq.liq_ratio_taskbook(5, M, lq.LONG)) == pytest.approx(0.8421, abs=1e-4)
    assert float(lq.liq_ratio_taskbook(2, M, lq.SHORT)) == pytest.approx(1.4286, abs=1e-4)


def test_program_inequality_pointwise():
    """整數精確模擬的程式不等式，與線性封閉式在離邊界 > 1e-9 的每一點都一致（含借貸費、資金費）。"""
    rng = np.random.default_rng(99)
    checked = 0
    for _ in range(3000):
        L = int(rng.integers(1, 6))
        tier = list(TIERS.values())[int(rng.integers(0, 3))]
        side = lq.LONG if rng.random() < 0.5 else lq.SHORT
        margin = int(rng.uniform(10, 1e6)) * 10**18
        entry = int(rng.uniform(1, 1e5) * 1e8) * 10**10
        secs = int(rng.uniform(0, 300) * 3600)
        idx_diff = int(rng.normal(0, 0.003) * 1e18)
        mmr = int(rng.choice([300, 500, 1000]))
        beta = lq.beta_borrow(tier.r, secs / 3600, L)
        phi = idx_diff / 1e18
        star = float(lq.liq_ratio_program(L, mmr / 1e4, tier.f, side, beta, phi))
        price8 = max(int(entry // 10**10 * star * (1 + rng.normal(0, 0.03))), 1)
        ratio = price8 * 10**10 / entry
        if abs(ratio - star) < 1e-9:
            continue
        _, _, liq = lq.program_close_amount(margin, L, entry, price8, side == lq.LONG, int(tier.fee_bps),
                                            int(tier.borrow_bps_per_hour), secs, idx_diff, mmr)
        closed = ratio <= star if side == lq.LONG else ratio >= star
        assert liq == closed, (L, tier.name, side, ratio, star)
        checked += 1
    assert checked > 2900


def test_solidity_division_truncates_toward_zero():
    assert lq._sdiv(-7, 2) == -3
    assert lq._sdiv(7, -2) == -3
    assert lq._sdiv(-7, -2) == 3
    assert lq._sdiv(7, 2) == 3
