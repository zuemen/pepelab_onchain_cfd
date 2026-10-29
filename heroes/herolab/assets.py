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
    "sGOOGL": "high", "sICLN": "high", "sESGU": "high",
}

_TIER_MAX_LEVERAGE = {"low": 5, "mid": 2, "high": 1}
_TIER_FEE_BPS = {"low": 10, "mid": 40, "high": 100}
_TIER_BORROW_BPS_PER_HOUR = {"low": 1, "mid": 4, "high": 10}


def max_leverage(asset: str) -> int:
    return _TIER_MAX_LEVERAGE[CARBON_TIER[asset]]


def fee_bps(asset: str) -> int:
    return _TIER_FEE_BPS[CARBON_TIER[asset]]


def borrow_bps_per_hour(asset: str) -> int:
    """槓桿借來的那一部分每小時收的借款費；開倉時凍結。"""
    return _TIER_BORROW_BPS_PER_HOUR[CARBON_TIER[asset]]
