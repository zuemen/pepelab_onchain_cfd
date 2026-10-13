import random

import pytest

from herolab.weights import to_bps


def test_equal_weights_split_evenly():
    assert to_bps({"a": 1, "b": 1, "c": 1, "d": 1}) == {"a": 2500, "b": 2500, "c": 2500, "d": 2500}


def test_a_dominant_weight_is_capped_at_half():
    bps = to_bps({"a": 90, "b": 5, "c": 5})
    assert bps == {"a": 5000, "b": 2500, "c": 2500}


def test_a_tiny_weight_is_lifted_to_the_floor():
    bps = to_bps({"a": 1, "b": 50, "c": 49})
    assert bps["a"] == 1000 and sum(bps.values()) == 10_000


def test_fewer_than_three_assets_is_refused():
    with pytest.raises(ValueError, match="at least 3"):
        to_bps({"a": 1, "b": 1})


def test_any_positive_weights_come_out_publishable():
    rng = random.Random(42)
    for _ in range(500):
        n = rng.randint(3, 8)
        bps = to_bps({f"x{i}": rng.uniform(0.0, 10.0) for i in range(n)})
        assert sum(bps.values()) == 10_000
        assert all(1000 <= v <= 5000 for v in bps.values()), bps
        assert all(v % 100 == 0 for v in bps.values())
