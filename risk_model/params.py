"""程式實際參數（以 `contracts/src/PerpetualExchange.sol` 與 Base Sepolia 鏈上值為準）。

所有數字的出處見 `docs/PARAMS_INVENTORY.md`；行號以 `PerpetualExchange.sol` 為準。
模型其他模組只從這裡取預設值，避免同一個參數在多處各寫一份。
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

BPS = 10_000.0
HOURS_PER_YEAR = 8760.0          # 加密資產 24/7
TRADING_DAYS_PER_YEAR = 252.0    # 股票（年化用）


@dataclass(frozen=True)
class CarbonTier:
    """碳分級（`CarbonTiers.sol:97-107`，internal constant，改了要重新部署）。"""

    name: str
    fee_bps: float              # 交易手續費 f（開、平各收一次）
    borrow_bps_per_hour: float  # 借貸費 r（只對借來的 M·(L−1) 計）
    max_leverage: int           # 該分級最大槓桿

    @property
    def f(self) -> float:
        return self.fee_bps / BPS

    @property
    def r(self) -> float:
        return self.borrow_bps_per_hour / BPS


TIERS: dict[str, CarbonTier] = {
    "Low": CarbonTier("Low", 10, 1, 5),
    "Mid": CarbonTier("Mid", 40, 4, 2),
    "High": CarbonTier("High", 100, 10, 1),
    "Unrated": CarbonTier("Unrated", 100, 10, 1),  # 與 High 同一列（CarbonTiers.sol:145-146）
}

# Base Sepolia 區塊 47714342 的實測（maxLeverageForAsset／tradingFeeBpsForAsset）
ONCHAIN_ASSET_TIER: dict[str, str] = {
    "sETH": "Low",
    "sAAPL": "Low",
    "sBTC": "High",   # 鏈上 1x／100 bps，High 或 Unrated（兩者同一列）
    "sTSLA": "High",
}

# 模型資產代號 → 鏈上合成資產
MODEL_TO_ONCHAIN: dict[str, str] = {"BTC": "sBTC", "ETH": "sETH", "AAPL": "sAAPL", "TSLA": "sTSLA"}
ASSET_CLASS: dict[str, str] = {"BTC": "crypto", "ETH": "crypto", "AAPL": "equity", "TSLA": "equity"}


@dataclass(frozen=True)
class ExchangeParams:
    """交易引擎參數。預設值＝Base Sepolia 鏈上現況。"""

    max_leverage: int = 5                  # MAX_LEVERAGE（:51，constant）
    mmr_bps: float = 500                   # DEFAULT_MAINTENANCE_MARGIN_BPS（:121），可逐資產覆寫
    liquidator_reward_bps: float = 500     # LIQUIDATION_REWARD_BPS（:56，constant）
    vault_penalty_bps: float = 2000        # liquidationPenaltyBps（:301，setter；鏈上 2000）
    vault_fee_share_bps: float = 0         # vaultFeeShareBps（鏈上 0）
    max_price_age_h: float = 6.0           # maxPriceAge：鏈上 21600 秒；原始碼預設 24h
    funding_interval_h: float = 8.0        # FUNDING_INTERVAL（:94）
    max_funding_rate_bps: int = 75         # MAX_FUNDING_RATE_BPS（:95）；兩段截斷後實際最高 74
    max_funding_catchup: int = 21          # MAX_FUNDING_CATCHUP_INTERVALS（:106）
    max_funding_receive_scale: int = 10    # MAX_FUNDING_RECEIVE_SCALE（:116）
    max_adl_scan: int = 128                # MAX_ADL_SCAN（:133）：掃描的「索引槽數」上限
    adl_enabled: bool = True               # 鏈上 true
    min_margin: float = 10.0               # MIN_MARGIN = 10 USDC（:52）

    @property
    def m(self) -> float:
        return self.mmr_bps / BPS

    @property
    def liquidator_share(self) -> float:
        return self.liquidator_reward_bps / BPS

    @property
    def vault_share(self) -> float:
        return self.vault_penalty_bps / BPS

    @property
    def holder_share(self) -> float:
        return 1.0 - self.liquidator_share - self.vault_share


ONCHAIN = ExchangeParams()
SOURCE_DEFAULT = replace(ONCHAIN, max_price_age_h=24.0)


@dataclass(frozen=True)
class FeeRouterParams:
    """FeeRouter 常數（`FeeRouter.sol:24-25`）：績效費＝跟單獲利的 10%，再分平台 20%／保險庫 10%／領單者 70%。"""

    performance_fee_bps: float = 1000
    vault_cut_bps: float = 1000

    def vault_take_of_copy_profit(self) -> float:
        """每 1 USDC 跟單獲利最後進保險庫的比例：10% × 10% = 1%。"""
        return (self.performance_fee_bps / BPS) * (self.vault_cut_bps / BPS)


@dataclass(frozen=True)
class KeeperParams:
    """keeper 推價（`.github/workflows/base-sepolia-keeper.yml`）。"""

    nominal_interval_min: float = 15.0      # cron */15
    observed_min_min: float = 68.0          # 實測最短
    observed_max_min: float = 169.0         # 實測最長
    observed_mean_min: float = 90.0         # 實測平均約 90
    observed_outage_h: float = 4.5          # 2026-09-30 曾 4.5 小時沒跑
    deviation_trigger: float = 0.001        # 偏離 ≥ 0.1% 才寫（每次執行時判斷）
    heartbeat_s: float = 900.0


KEEPER = KeeperParams()


@dataclass
class InfraScenario:
    """推價與清算的基礎設施情境：Δ 由「推價間隔」與「清算人反應」兩者決定。

    push_mode:
      - "fixed"：每 push_interval_h 推一次價
      - "observed"：68 分鐘＋指數分布（平均 22 分鐘），截在 169 分鐘，整體平均約 90 分鐘
    liquidator_mean_h：清算人「隨機檢查」的平均間隔（Poisson 到達）；0＝常駐 bot，價格一更新就清算。
    """

    name: str
    push_mode: str = "fixed"
    push_interval_h: float = 0.25
    liquidator_mean_h: float = 0.0
    max_price_age_h: float = 6.0
    label: str = ""
    extra: dict = field(default_factory=dict)


INFRA_CURRENT = InfraScenario(
    name="current",
    push_mode="observed",
    push_interval_h=1.5,
    liquidator_mean_h=4.0,
    max_price_age_h=6.0,
    label="現況：cron keeper（實測約 90 分）＋無清算 bot（假設平均 4h 有人手動清算）",
)
INFRA_BOT = InfraScenario(
    name="cron+bot",
    push_mode="observed",
    push_interval_h=1.5,
    liquidator_mean_h=0.0,
    max_price_age_h=6.0,
    label="只補清算 bot（推價仍是實測約 90 分）",
)
INFRA_IMPROVED = InfraScenario(
    name="improved",
    push_mode="fixed",
    push_interval_h=1.0 / 60.0,
    liquidator_mean_h=0.0,
    max_price_age_h=0.25,
    label="改善：常駐 keeper 每分鐘推價＋清算 bot",
)
