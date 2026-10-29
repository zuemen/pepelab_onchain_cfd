"""24 位模擬交易者，以及虛擬跟隨者何時跟隨、何時取消。

index 是 Anvil 預設助記詞的推導索引（m/44'/60'/0'/0/<index>）。0 是部署者、9 是展示帳號，
交易者用 10–33，虛擬跟隨者從 40 起。
"""
from __future__ import annotations

import datetime as dt
import random
from dataclasses import dataclass, field

# 碳分級為 Low 的資產（CarbonAttestations.sol）。sICLN 在 2026-10-16 改用 iShares 的 WACI 後是 High，
# 不在這裡（docs/data/carbon-tier-etf-waci.md）。
LOW_CARBON = ["sETH", "sAAPL", "sBOND", "sNVDA"]
EQUITIES = ["sAAPL", "sMSFT", "sGOOGL", "sNVDA", "sTSLA"]


@dataclass(frozen=True)
class TraderSpec:
    index: int
    name: str
    rule: str
    params: dict = field(hash=False)
    seed: int = 0
    capital_usd: int = 10_000
    stake_usd: int = 600


def _equal(assets: list[str]) -> dict[str, float]:
    return {a: 1.0 for a in assets}


TRADERS: tuple[TraderSpec, ...] = (
    TraderSpec(10, "Whale Alpha", "buy_hold", {"weights": {"sBTC": 0.5, "sETH": 0.3, "sGOLD": 0.2}}, 10, stake_usd=5000),
    TraderSpec(11, "Gold Bull", "fixed_mix", {"weights": {"sGOLD": 0.5, "sBOND": 0.3, "sETH": 0.2}, "every_days": 90}, 11, stake_usd=900),
    # 12 號原本是 ESG Master（esg_tilt，依平台自評的 ESG 分數選股）。#383 平台不再自評 ESG，
    # 規則與交易者一起拿掉；它已在鏈上註冊，前端由 frontend/src/lib/pepefi/hiddenTraders.ts 隱藏。
    # 12 號不重用：其他人的位址與鏈上紀錄都綁著各自的 index。
    TraderSpec(13, "Crypto Degen", "momentum", {"universe": LOW_CARBON, "top_k": 3, "lookback": 20, "every_days": 7, "leverage": 5}, 13, stake_usd=5000),
    TraderSpec(14, "Bond Steady", "fixed_mix", {"weights": {"sBOND": 0.5, "sGOLD": 0.3, "sAAPL": 0.2}, "every_days": 90}, 14, stake_usd=1200),
    TraderSpec(15, "Tesla Maxi", "buy_hold", {"weights": {"sTSLA": 0.5, "sAAPL": 0.3, "sETH": 0.2}}, 15, stake_usd=600),
    TraderSpec(16, "Diamond Hands", "buy_hold", {"weights": {"sBTC": 0.4, "sETH": 0.3, "sGOLD": 0.3}}, 16, stake_usd=2000),
    TraderSpec(17, "Index Tracker", "fixed_mix", {"weights": _equal(["sBTC", "sETH", "sAAPL", "sTSLA"]), "every_days": 60}, 17, stake_usd=900),
    TraderSpec(18, "Macro Trader", "risk_parity", {"universe": ["sGOLD", "sBOND", "sBTC", "sESGU"], "lookback": 60, "every_days": 45}, 18, stake_usd=1500),
    TraderSpec(19, "Quant Bot", "long_short", {"lookback": 60, "long_k": 3, "short_k": 1, "every_days": 30}, 19, stake_usd=2500),
    TraderSpec(20, "Green Investor", "fixed_mix", {"weights": {"sBOND": 0.5, "sICLN": 0.3, "sESGU": 0.2}, "every_days": 90}, 20, stake_usd=1800),
    TraderSpec(21, "Apple Holder", "buy_hold", {"weights": {"sAAPL": 0.5, "sTSLA": 0.3, "sETH": 0.2}}, 21, stake_usd=600),
    TraderSpec(22, "Momentum Mike", "momentum", {"top_k": 3, "lookback": 90, "every_days": 30}, 22, stake_usd=1200),
    TraderSpec(23, "Carbon Zero", "fixed_mix", {"weights": _equal(LOW_CARBON), "every_days": 60}, 23, stake_usd=4000),
    TraderSpec(24, "Risk Parity Pro", "risk_parity", {"universe": ["sBTC", "sETH", "sAAPL", "sGOLD", "sBOND", "sNVDA"], "lookback": 60, "every_days": 30}, 24, stake_usd=3500),
    TraderSpec(25, "Chip Chaser", "buy_hold", {"weights": {"sNVDA": 0.5, "sMSFT": 0.3, "sGOOGL": 0.2}}, 25, stake_usd=900),
    TraderSpec(26, "Clean Energy Fan", "buy_hold", {"weights": {"sICLN": 0.5, "sESGU": 0.3, "sBOND": 0.2}}, 26, stake_usd=600),
    TraderSpec(27, "Contrarian Cat", "mean_reversion", {"top_k": 3, "lookback": 60, "every_days": 30}, 27, stake_usd=600),
    TraderSpec(28, "Trend Rider", "trend", {"universe": ["sBTC", "sETH", "sGOLD", "sNVDA"], "window": 50, "every_days": 14}, 28, stake_usd=1500),
    TraderSpec(29, "Steady Eddie", "risk_parity", {"universe": ["sBOND", "sGOLD", "sESGU", "sAAPL"], "lookback": 90, "every_days": 60}, 29, stake_usd=2000),
    TraderSpec(30, "Pairs Trader", "long_short", {"universe": EQUITIES, "lookback": 30, "long_k": 2, "short_k": 1, "every_days": 14}, 30, stake_usd=900),
    TraderSpec(31, "Low Carbon Lev", "momentum", {"universe": LOW_CARBON, "top_k": 3, "lookback": 30, "every_days": 7, "leverage": 2}, 31, stake_usd=3000),
    TraderSpec(32, "Green Rotation", "momentum", {"universe": ["sICLN", "sESGU", "sBOND", "sAAPL", "sNVDA"], "top_k": 3, "lookback": 60, "every_days": 30}, 32, stake_usd=1200),
    TraderSpec(33, "Macro Hedge", "trend", {"universe": ["sGOLD", "sBOND", "sBTC", "sESGU"], "window": 100, "every_days": 30}, 33, stake_usd=1800),
)

FIRST_FOLLOWER_INDEX = 40
FOLLOW_AMOUNTS = (500, 1_000, 2_000, 5_000)  # 最小的一檔 10% × 500 = 50，高於交易所的最低保證金 10


@dataclass(frozen=True)
class FollowAction:
    date: dt.date
    kind: str  # "follow" | "unfollow"
    follower_index: int
    trader_index: int
    amount_usd: int = 0


def follower_actions(days: list[dt.date], traders, n_followers: int, seed: int) -> list[FollowAction]:
    """每個跟隨者跟 1–2 位交易者（名冊越前面越常被選），約六成之後會取消。"""
    if n_followers <= 0 or len(days) < 8 or not traders:
        return []
    rng = random.Random(seed)
    lead = min(30, len(days) // 4)
    hold_min, hold_max = min(30, max(2, len(days) // 6)), min(200, max(3, len(days) // 2))
    popularity = [1.0 / (rank + 1) for rank in range(len(traders))]
    actions: list[FollowAction] = []
    for n in range(n_followers):
        follower = FIRST_FOLLOWER_INDEX + n
        picks: list[int] = []
        for _ in range(rng.choice((1, 1, 2))):
            choice = rng.choices(range(len(traders)), weights=popularity)[0]
            if choice not in picks:
                picks.append(choice)
        for pick in picks:
            start = rng.randrange(lead, len(days) - lead)
            actions.append(FollowAction(days[start], "follow", follower, traders[pick].index, rng.choice(FOLLOW_AMOUNTS)))
            stop = start + rng.randint(hold_min, hold_max)
            if rng.random() < 0.6 and stop < len(days):
                actions.append(FollowAction(days[stop], "unfollow", follower, traders[pick].index))
    return actions
