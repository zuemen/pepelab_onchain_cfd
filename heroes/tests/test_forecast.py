import numpy as np
import pandas as pd

from herolab.forecast import bootstrap, fan, log_returns, price_paths

RNG = np.random.default_rng(0)
RETURNS = RNG.normal(0, 0.03, size=(300, 2))


def test_same_seed_same_paths():
    assert np.array_equal(bootstrap(RETURNS, seed=5), bootstrap(RETURNS, seed=5))
    assert not np.array_equal(bootstrap(RETURNS, seed=5), bootstrap(RETURNS, seed=6))


def test_paths_are_made_of_contiguous_historical_blocks_shared_by_all_assets():
    days = np.arange(300, dtype=float)[:, None] * np.ones((1, 2))  # 第 t 天的「報酬」就是 t
    sampled = bootstrap(days, horizon=25, paths=4, block=10, seed=1)
    assert sampled.shape == (4, 25, 2)
    for path in sampled:
        assert np.array_equal(path[:, 0], path[:, 1])  # 兩個資產抽到同一段日子
        for start in (0, 10, 20):
            block = path[start:start + 10, 0]
            assert np.array_equal(np.diff(block), np.ones(len(block) - 1))


def test_price_paths_start_at_todays_close():
    paths = price_paths(np.array([100.0, 50.0]), bootstrap(RETURNS, horizon=90, paths=10))
    assert paths.shape == (10, 91, 2)
    assert np.allclose(paths[:, 0, 0], 100.0) and np.allclose(paths[:, 0, 1], 50.0)


def test_percentiles_never_cross():
    paths = price_paths(np.array([100.0]), bootstrap(RETURNS[:, :1], horizon=90))
    result = fan(paths[:, :, 0] * 100, 10_000.0)
    bands = [np.array(result["percentiles"][k]) for k in ("p5", "p25", "p50", "p75", "p95")]
    for lower, upper in zip(bands, bands[1:]):
        assert np.all(lower <= upper)


def test_a_price_that_never_moves_gives_one_outcome():
    flat = pd.DataFrame({"a": [100.0] * 50, "b": [7.0] * 50})
    paths = price_paths(np.array([100.0, 7.0]), bootstrap(log_returns(flat), horizon=90))
    result = fan(paths[:, :, 0] * 100, 10_000.0)
    p = result["percentiles"]
    assert p["p5"] == p["p25"] == p["p50"] == p["p75"] == p["p95"]
    assert result["lossProbPct"] == 0.0 and result["halfLossProbPct"] == 0.0


def test_loss_probabilities_count_paths_that_end_below_the_capital_and_below_half():
    equity = np.array([[100.0, 120.0], [100.0, 90.0], [100.0, 40.0], [100.0, 100.0]])
    result = fan(equity, 100.0)
    assert result["lossProbPct"] == 50.0
    assert result["halfLossProbPct"] == 25.0
