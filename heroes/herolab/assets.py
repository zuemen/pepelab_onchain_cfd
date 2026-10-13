"""資產清單與每個資產的固定屬性。

碳分級與 E/S/G 分數抄自 contracts/script/CarbonAttestations.sol（本機鏈部署時寫入的見證）；
費率與槓桿上限抄自 contracts/src/CarbonTiers.sol。兩邊沒有編譯期連結，改其中一邊要改另一邊。
"""

ASSETS = (
    "sBTC", "sETH", "sAAPL", "sTSLA", "sGOLD", "sBOND",
    "sNVDA", "sMSFT", "sGOOGL", "sICLN", "sESGU",
)

# 與 agent/keeper/feeds.ts 相同的來源代號。
YAHOO_SYMBOL = {
    "sBTC": "BTC-USD", "sETH": "ETH-USD", "sAAPL": "AAPL", "sTSLA": "TSLA",
    "sGOLD": "GC=F", "sBOND": "BGRN", "sNVDA": "NVDA", "sMSFT": "MSFT",
    "sGOOGL": "GOOGL", "sICLN": "ICLN", "sESGU": "ESGU",
}

CARBON_TIER = {
    "sBTC": "high", "sETH": "low", "sAAPL": "low", "sTSLA": "high",
    "sGOLD": "high", "sBOND": "low", "sNVDA": "low", "sMSFT": "high",
    "sGOOGL": "high", "sICLN": "low", "sESGU": "mid",
}

_TIER_MAX_LEVERAGE = {"low": 5, "mid": 2, "high": 1}
_TIER_FEE_BPS = {"low": 10, "mid": 40, "high": 100}

# (environmental, social, governance)
ESG = {
    "sBTC": (15, 40, 60), "sETH": (35, 55, 70), "sAAPL": (72, 78, 85),
    "sTSLA": (60, 52, 65), "sGOLD": (40, 50, 55), "sBOND": (86, 74, 80),
    "sNVDA": (55, 60, 75), "sMSFT": (78, 72, 88), "sGOOGL": (68, 65, 80),
    "sICLN": (90, 75, 78), "sESGU": (88, 80, 82),
}


def max_leverage(asset: str) -> int:
    return _TIER_MAX_LEVERAGE[CARBON_TIER[asset]]


def fee_bps(asset: str) -> int:
    return _TIER_FEE_BPS[CARBON_TIER[asset]]


def esg_composite(asset: str) -> int:
    """與前端 useESG 相同：Math.round((E + S + G) / 3)，四捨五入而非銀行家捨入。"""
    e, s, g = ESG[asset]
    return int((e + s + g) / 3 + 0.5)
