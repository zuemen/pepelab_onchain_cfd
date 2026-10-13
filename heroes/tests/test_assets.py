from herolab.assets import ASSETS, YAHOO_SYMBOL, esg_composite, fee_bps, max_leverage


def test_universe_is_the_eleven_listed_assets():
    assert len(ASSETS) == 11
    assert set(YAHOO_SYMBOL) == set(ASSETS)
    assert YAHOO_SYMBOL["sBOND"] == "BGRN"  # 綠色債券 ETF，不是 TLT


def test_leverage_ceiling_follows_carbon_tier():
    assert max_leverage("sETH") == 5   # Low
    assert max_leverage("sESGU") == 2  # Mid
    assert max_leverage("sBTC") == 1   # High


def test_fee_follows_carbon_tier():
    assert (fee_bps("sETH"), fee_bps("sESGU"), fee_bps("sBTC")) == (10, 40, 100)


def test_esg_composite_rounds_half_up_like_the_frontend():
    # (15 + 40 + 60) / 3 = 38.33 -> 38；(35 + 55 + 70) / 3 = 53.33 -> 53
    assert esg_composite("sBTC") == 38
    assert esg_composite("sETH") == 53
