from herolab.assets import ASSETS, YAHOO_SYMBOL, fee_bps, max_leverage


def test_universe_is_the_eleven_listed_assets():
    assert len(ASSETS) == 11
    assert set(YAHOO_SYMBOL) == set(ASSETS)
    assert YAHOO_SYMBOL["sBOND"] == "BGRN"  # 綠色債券 ETF，不是 TLT


def test_leverage_ceiling_follows_carbon_tier():
    assert max_leverage("sETH") == 5   # Low
    assert max_leverage("sESGU") == 1  # High（iShares 的 WACI，docs/data/carbon-tier-etf-waci.md）
    assert max_leverage("sICLN") == 1  # High
    assert max_leverage("sBTC") == 1   # High


def test_fee_follows_carbon_tier():
    assert (fee_bps("sETH"), fee_bps("sESGU"), fee_bps("sBTC")) == (10, 100, 100)

