# 交易者排行榜資料化 — 資料線 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用真實歷史價格產生 24 位模擬交易者的策略排程，在本機 Anvil 上以真合約回放，並把鏈上事件算成前端讀取的績效資料。

**Architecture:** Python（`heroes/`）只做資料科學：價格、策略規則、排程、績效分析。Node + ethers（`agent/heroes/`）只做鏈的讀寫：回放與事件匯出。兩邊以三個檔案交接：`schedule.json`（Python → Node）、`events.json`（Node → Python）、`frontend/public/data/heroes/*.json`（Python → 前端）。

**Tech Stack:** Python 3.11+（numpy、pandas、pytest）、Node 20 + tsx + ethers v6、Foundry Anvil。

**Spec:** GitHub issue zuemen/pepelab_onchain_cfd#309（本機草稿：`docs/superpowers/specs/2026-10-13-hero-leaderboard-design.md`）。畫面線計畫：`docs/superpowers/plans/2026-10-13-hero-leaderboard-ui-track.md`。

## Global Constraints

- 只在本機鏈（chainId 31337）運作。任何腳本連到其他 chainId 必須立刻中止。不碰 Base Sepolia 上的任何合約。
- 不修改 `contracts/src` 下任何既有合約。
- `agent/` 只用 npm；`frontend/` 只用 yarn；`heroes/` 的 Python 依賴裝在 `heroes/.venv`（repo 內）。
- repo 外的安裝（`apt install`、`foundryup`、`npm i -g`）交給人執行，不要自己跑完就回報成功（見 `docs/agents/environment.md`）。
- 開啟 Smart App Control 的 Windows 機器，`forge`／`anvil`／`cast` 只能在 WSL 執行，路徑是 `~/.foundry/bin/`。
- 用詞照 `frontend/CONTEXT.md` 的 Expert Mode 詞彙：交易者（Trader）、跟單／跟隨（Copy／Follow）、部位（Position）、策略（Strategy）。不要用「配置／採用」（那是 Simple Mode 的另一個商品）。
- 策略必須滿足 `StrategyRegistry.publishStrategy` 的規則：至少 3 個不同資產、單一資產權重 ≤ 5000 bps、權重合計 10000 bps、槓桿 ∈ {1, 2, 5}，且槓桿不超過該資產碳分級的上限。
- 所有損益報淨額（平倉取回金額 − 保證金 − 開倉手續費），另附毛額。
- 中間產物放 `heroes/out/`，不進版控。價格 CSV 與 `frontend/public/data/heroes/*.json` 進版控。
- 分支：`feat/309-hero-data`。每個 Task 結束提交一次。

## File Structure

```
heroes/
  .gitignore              .venv/ out/ __pycache__/ .pytest_cache/
  README.md               指令與三個介面的說明
  requirements.txt        numpy pandas pytest（釘版本）
  pytest.ini
  herolab/
    __init__.py
    assets.py             資產清單、Yahoo 代號、碳分級→槓桿上限、ESG 分數
    prices.py             Yahoo 回應解析、讀 CSV 成逐日價格表
    model.py              Leg、Rebalance、validate()
    weights.py            to_bps()：任意權重 → 合規的 bps
    rules.py              8 條策略規則與 RULES 登記表
    roster.py             24 位交易者、虛擬跟隨者的動作
    schedule.py           組出 schedule.json
    analytics.py          events.json → 績效資料
  fetch_prices.py         CLI：抓價格寫進 prices/
  build_schedule.py       CLI：產生 schedule.json
  build_analytics.py      CLI：產生績效資料
  check_pipeline.py       CLI：整條管線的對帳檢查
  prices/<asset>.csv      進版控
  tests/                  pytest
  tests/fixtures/schedule_smoke.json   進版控（3 位交易者 × 30 天）
agent/heroes/
  abi.ts                  回放用到的 ABI 片段
  plan.ts                 純函式：拆保證金、清算判斷
  plan.test.ts
  replay.ts               回放主程式
  priceTick.ts            展示時的價格寫入程序
scripts/heroes-replay.sh  起 Anvil → 部署 → 回放 → 存鏈狀態
```

---

### Task A1: Python 骨架、資產表、歷史價格

**Files:**
- Create: `heroes/.gitignore`, `heroes/requirements.txt`, `heroes/pytest.ini`, `heroes/herolab/__init__.py`, `heroes/herolab/assets.py`, `heroes/herolab/prices.py`, `heroes/fetch_prices.py`, `heroes/prices/*.csv`
- Test: `heroes/tests/test_assets.py`, `heroes/tests/test_prices.py`

**Interfaces:**
- Produces: `herolab.assets.ASSETS: tuple[str, ...]`、`YAHOO_SYMBOL: dict[str, str]`、`max_leverage(asset) -> int`、`esg_composite(asset) -> int`；`herolab.prices.parse_yahoo_chart(payload: dict) -> pd.Series`、`load_prices(directory: Path, start: date, end: date) -> pd.DataFrame`（index 為 `datetime.date`、每個資產一欄、每天一列、缺口沿用前值）。

**需要人先做的事（repo 外安裝）：** 在執行環境確認 `python3 -m venv --help` 與 `python3 -m pip --version` 可用。Ubuntu／WSL 缺的話請人執行 `sudo apt install python3-venv python3-pip`。

- [ ] **Step 1: 建骨架檔**

`heroes/.gitignore`：

```
.venv/
out/
__pycache__/
.pytest_cache/
```

`heroes/requirements.txt`：

```
# 釘版本讓數字可重現。numpy 2.3 起支援 Python 3.14。
numpy==2.3.4
pandas==2.3.3
pytest==9.1.1
```

`heroes/pytest.ini`：

```ini
[pytest]
pythonpath = .
testpaths = tests
```

`heroes/herolab/__init__.py`：空檔。

- [ ] **Step 2: 建 venv 並安裝**

Run（在 `heroes/` 內）：

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
```

Expected: 三個套件安裝成功。若某版本在這個 Python 沒有 wheel，改釘該套件支援此 Python 的最新修補版，並在 `requirements.txt` 的註解寫明原因。

- [ ] **Step 3: 寫資產表的失敗測試**

`heroes/tests/test_assets.py`：

```python
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
```

- [ ] **Step 4: 跑測試確認失敗**

Run: `pytest tests/test_assets.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'herolab.assets'`

- [ ] **Step 5: 實作資產表**

`heroes/herolab/assets.py`：

```python
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
```

- [ ] **Step 6: 跑測試確認通過**

Run: `pytest tests/test_assets.py -v`
Expected: 4 passed

- [ ] **Step 7: 寫價格的失敗測試**

`heroes/tests/test_prices.py`：

```python
import datetime as dt

import pytest

from herolab.assets import ASSETS
from herolab.prices import load_prices, parse_yahoo_chart


def test_parse_yahoo_chart_drops_null_closes():
    payload = {"chart": {"result": [{
        # 2024-10-01、10-02、10-03 的 13:30 UTC
        "timestamp": [1727789400, 1727875800, 1727962200],
        "indicators": {"quote": [{"close": [226.21, None, 225.67]}]},
    }]}}
    series = parse_yahoo_chart(payload)
    assert list(series.index) == [dt.date(2024, 10, 1), dt.date(2024, 10, 3)]
    assert series.iloc[0] == 226.21


def _write_all(tmp_path, rows):
    for asset in ASSETS:
        lines = ["date,close"] + [f"{d},{c}" for d, c in rows]
        (tmp_path / f"{asset}.csv").write_text("\n".join(lines) + "\n")


def test_load_prices_carries_last_close_over_gaps(tmp_path):
    # 10-04 是週五、10-07 是週一：週末沿用週五的收盤價
    _write_all(tmp_path, [("2024-10-03", 10.0), ("2024-10-04", 11.0), ("2024-10-07", 12.0)])
    table = load_prices(tmp_path, dt.date(2024, 10, 4), dt.date(2024, 10, 7))
    assert list(table.index) == [dt.date(2024, 10, d) for d in (4, 5, 6, 7)]
    assert list(table["sBTC"]) == [11.0, 11.0, 11.0, 12.0]
    assert list(table.columns) == list(ASSETS)


def test_load_prices_uses_a_close_from_before_the_start(tmp_path):
    _write_all(tmp_path, [("2024-10-03", 10.0), ("2024-10-07", 12.0)])
    table = load_prices(tmp_path, dt.date(2024, 10, 5), dt.date(2024, 10, 6))
    assert list(table["sETH"]) == [10.0, 10.0]


def test_load_prices_refuses_a_start_with_no_price(tmp_path):
    _write_all(tmp_path, [("2024-10-07", 12.0)])
    with pytest.raises(ValueError, match="no price on or before"):
        load_prices(tmp_path, dt.date(2024, 10, 1), dt.date(2024, 10, 7))
```

- [ ] **Step 8: 跑測試確認失敗**

Run: `pytest tests/test_prices.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'herolab.prices'`

- [ ] **Step 9: 實作價格模組**

`heroes/herolab/prices.py`：

```python
from __future__ import annotations

import datetime as dt
from pathlib import Path

import pandas as pd

from .assets import ASSETS


def parse_yahoo_chart(payload: dict) -> pd.Series:
    """Yahoo v8 chart 回應 → 以 UTC 日期為索引的收盤價。收盤價為 null 的日子丟掉。"""
    result = payload["chart"]["result"][0]
    rows = {
        dt.datetime.fromtimestamp(ts, dt.timezone.utc).date(): float(close)
        for ts, close in zip(result["timestamp"], result["indicators"]["quote"][0]["close"])
        if close is not None
    }
    return pd.Series(rows, name="close").sort_index()


def load_prices(directory: Path, start: dt.date, end: dt.date) -> pd.DataFrame:
    """[start, end] 每個日曆日一列、每個資產一欄；非交易日沿用前一個收盤價。"""
    days = list(pd.date_range(start, end, freq="D").date)
    table = pd.DataFrame(index=days)
    for asset in ASSETS:
        raw = pd.read_csv(directory / f"{asset}.csv", parse_dates=["date"])
        series = pd.Series(raw["close"].to_numpy(), index=raw["date"].dt.date)
        # 先在聯集上補值，start 之前的收盤價才帶得進來
        union = sorted(set(series.index) | set(days))
        table[asset] = series.reindex(union).ffill().reindex(days).to_numpy()
    missing = [a for a in ASSETS if pd.isna(table[a].iloc[0])]
    if missing:
        raise ValueError(f"no price on or before {start} for: {missing}")
    return table
```

- [ ] **Step 10: 跑測試確認通過**

Run: `pytest tests/test_prices.py -v`
Expected: 4 passed

- [ ] **Step 11: 寫抓價 CLI 並抓真實資料**

`heroes/fetch_prices.py`：

```python
"""抓 11 個資產的日線收盤價寫進 heroes/prices/。用法：python fetch_prices.py"""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

from herolab.assets import YAHOO_SYMBOL
from herolab.prices import parse_yahoo_chart

OUT = Path(__file__).parent / "prices"
FIRST = dt.date(2024, 4, 1)  # 回放從 2024-10-01 開始；多抓半年給策略規則當回看期


def _epoch(day: dt.date) -> int:
    return int(dt.datetime(day.year, day.month, day.day, tzinfo=dt.timezone.utc).timestamp())


def fetch(symbol: str, first: dt.date, last: dt.date) -> dict:
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        + urllib.parse.quote(symbol)
        + f"?interval=1d&period1={_epoch(first)}&period2={_epoch(last) + 86400}"
    )
    # 沒有瀏覽器 User-Agent 會回 401（同 agent/keeper/feeds.ts）
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def main() -> int:
    last = dt.date.today() - dt.timedelta(days=1)  # 今天的 K 棒還沒收
    OUT.mkdir(exist_ok=True)
    for asset, symbol in YAHOO_SYMBOL.items():
        series = parse_yahoo_chart(fetch(symbol, FIRST, last))
        series = series[series.index <= last]
        if len(series) < 100:
            print(f"{asset}: only {len(series)} closes from {symbol}", file=sys.stderr)
            return 1
        series.to_csv(OUT / f"{asset}.csv", header=["close"], index_label="date")
        print(f"{asset}: {len(series)} closes, {series.index[0]} .. {series.index[-1]}")
        time.sleep(1)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Run: `python fetch_prices.py`
Expected: 11 行輸出，每行約 400–930 筆收盤價（加密貨幣每天都有，股票只有交易日），起日在 2024-04-01 附近。

- [ ] **Step 12: 確認真實資料讀得進來**

Run:

```bash
python -c "
import datetime as dt; from pathlib import Path
from herolab.prices import load_prices
t = load_prices(Path('prices'), dt.date(2024, 10, 1), dt.date(2024, 10, 31))
print(t.shape); print(t.iloc[0].round(2).to_dict())"
```

Expected: `(31, 11)`，第一列是 2024-10-01 各資產的真實收盤價（sBTC 約六萬多、sBOND 約 48）。

- [ ] **Step 13: Commit**

```bash
git add heroes/.gitignore heroes/requirements.txt heroes/pytest.ini heroes/herolab heroes/fetch_prices.py heroes/prices heroes/tests
git commit -m "feat(heroes): 資產表與真實歷史日線價格（#309）"
```

---

### Task A2: 策略的資料型別、驗證與權重正規化

**Files:**
- Create: `heroes/herolab/model.py`, `heroes/herolab/weights.py`
- Test: `heroes/tests/test_model.py`, `heroes/tests/test_weights.py`

**Interfaces:**
- Consumes: `herolab.assets.ASSETS`、`max_leverage`
- Produces: `Leg(asset: str, weight_bps: int, is_long: bool, leverage: int)`、`Rebalance(date: datetime.date, legs: tuple[Leg, ...])`、`InvalidStrategy(ValueError)`、`validate(r: Rebalance) -> None`；`to_bps(raw: dict[str, float]) -> dict[str, int]`（每檔 1000–5000 bps、合計 10000）。

- [ ] **Step 1: 寫驗證的失敗測試**

`heroes/tests/test_model.py`：

```python
import datetime as dt

import pytest

from herolab.model import InvalidStrategy, Leg, Rebalance, validate

DAY = dt.date(2024, 10, 1)


def reb(*legs):
    return Rebalance(DAY, tuple(legs))


def test_a_diversified_strategy_passes():
    validate(reb(Leg("sETH", 5000, True, 5), Leg("sBOND", 3000, True, 1), Leg("sESGU", 2000, False, 2)))


@pytest.mark.parametrize(
    "legs, message",
    [
        ((Leg("sETH", 5000, True, 1), Leg("sBOND", 5000, True, 1)), "at least 3"),
        ((Leg("sETH", 6000, True, 1), Leg("sBOND", 2000, True, 1), Leg("sAAPL", 2000, True, 1)), "exceeds 5000"),
        ((Leg("sETH", 4000, True, 1), Leg("sBOND", 3000, True, 1), Leg("sAAPL", 2000, True, 1)), "sum to 10000"),
        ((Leg("sETH", 4000, True, 1), Leg("sETH", 3000, True, 1), Leg("sAAPL", 3000, True, 1)), "duplicate"),
        ((Leg("sETH", 4000, True, 3), Leg("sBOND", 3000, True, 1), Leg("sAAPL", 3000, True, 1)), "leverage"),
        # sBTC 是最高碳分級：槓桿上限 1
        ((Leg("sBTC", 4000, True, 2), Leg("sBOND", 3000, True, 1), Leg("sAAPL", 3000, True, 1)), "carbon ceiling"),
        ((Leg("sXYZ", 4000, True, 1), Leg("sBOND", 3000, True, 1), Leg("sAAPL", 3000, True, 1)), "unknown asset"),
        ((Leg("sETH", 0, True, 1), Leg("sBOND", 5000, True, 1), Leg("sAAPL", 5000, True, 1)), "zero weight"),
    ],
)
def test_what_the_registry_would_reject_is_rejected_here(legs, message):
    with pytest.raises(InvalidStrategy, match=message):
        validate(reb(*legs))
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pytest tests/test_model.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'herolab.model'`

- [ ] **Step 3: 實作型別與驗證**

`heroes/herolab/model.py`：

```python
"""策略的資料型別，以及與 StrategyRegistry.publishStrategy 相同的驗證。"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from .assets import ASSETS, max_leverage

MIN_ASSETS = 3
MAX_WEIGHT_BPS = 5_000
WHOLE_BPS = 10_000
ALLOWED_LEVERAGE = (1, 2, 5)


@dataclass(frozen=True)
class Leg:
    asset: str
    weight_bps: int
    is_long: bool
    leverage: int


@dataclass(frozen=True)
class Rebalance:
    """某一天發布的一版策略。交易者當天會平掉全部部位，再照這版開新部位。"""

    date: dt.date
    legs: tuple[Leg, ...]


class InvalidStrategy(ValueError):
    pass


def validate(r: Rebalance) -> None:
    if len(r.legs) < MIN_ASSETS:
        raise InvalidStrategy(f"{r.date}: needs at least 3 assets, got {len(r.legs)}")
    seen: set[str] = set()
    for leg in r.legs:
        if leg.asset not in ASSETS:
            raise InvalidStrategy(f"{r.date}: unknown asset {leg.asset}")
        if leg.asset in seen:
            raise InvalidStrategy(f"{r.date}: duplicate asset {leg.asset}")
        seen.add(leg.asset)
        if leg.weight_bps <= 0:
            raise InvalidStrategy(f"{r.date}: zero weight on {leg.asset}")
        if leg.weight_bps > MAX_WEIGHT_BPS:
            raise InvalidStrategy(f"{r.date}: {leg.asset} weight {leg.weight_bps} exceeds 5000")
        if leg.leverage not in ALLOWED_LEVERAGE:
            raise InvalidStrategy(f"{r.date}: {leg.asset} leverage {leg.leverage} not in (1, 2, 5)")
        if leg.leverage > max_leverage(leg.asset):
            raise InvalidStrategy(
                f"{r.date}: {leg.asset} leverage {leg.leverage} above its carbon ceiling {max_leverage(leg.asset)}"
            )
    total = sum(leg.weight_bps for leg in r.legs)
    if total != WHOLE_BPS:
        raise InvalidStrategy(f"{r.date}: weights must sum to 10000, got {total}")
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pytest tests/test_model.py -v`
Expected: 9 passed

- [ ] **Step 5: 寫權重正規化的失敗測試**

`heroes/tests/test_weights.py`：

```python
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
```

- [ ] **Step 6: 跑測試確認失敗**

Run: `pytest tests/test_weights.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'herolab.weights'`

- [ ] **Step 7: 實作正規化**

`heroes/herolab/weights.py`：

```python
"""把任意非負權重變成可以發布的 bps。

上限 50% 是登錄合約的規則。下限 10% 是我們自己的：跟隨者的金額照權重拆給每一檔，
太小的一檔會低於交易所的最低保證金而整筆跟單失敗。
"""
from __future__ import annotations

FLOOR = 0.10
CAP = 0.50
STEP_BPS = 100


def to_bps(raw: dict[str, float]) -> dict[str, int]:
    if len(raw) < 3:
        raise ValueError(f"needs at least 3 assets, got {len(raw)}")
    if len(raw) > 10:
        raise ValueError(f"at most 10 assets fit a 10% floor, got {len(raw)}")
    positive = {k: max(float(v), 0.0) for k, v in raw.items()}
    total = sum(positive.values())
    w = {k: (v / total if total > 0 else 1.0 / len(positive)) for k, v in positive.items()}

    # 夾住上下限，再把差額平均分給還沒碰到邊界的那幾檔，直到合計為 1
    for _ in range(50):
        w = {k: min(max(v, FLOOR), CAP) for k, v in w.items()}
        gap = 1.0 - sum(w.values())
        if abs(gap) < 1e-12:
            break
        room = [k for k, v in w.items() if (v < CAP if gap > 0 else v > FLOOR)]
        for k in room:
            w[k] += gap / len(room)
    w = {k: min(max(v, FLOOR), CAP) for k, v in w.items()}  # 迴圈用完次數時，最後一次分配還沒夾過

    bps = {k: int(round(v * 10_000 / STEP_BPS)) * STEP_BPS for k, v in w.items()}
    # 四捨五入的零頭一次 100 bps 地還給還有空間的那一檔
    remainder = 10_000 - sum(bps.values())
    step = STEP_BPS if remainder > 0 else -STEP_BPS
    while remainder != 0:
        candidates = [k for k in sorted(bps) if 1000 <= bps[k] + step <= 5000]
        target = max(candidates, key=lambda k: w[k] * 10_000 - bps[k]) if step > 0 else min(
            candidates, key=lambda k: w[k] * 10_000 - bps[k]
        )
        bps[target] += step
        remainder -= step
    return bps
```

- [ ] **Step 8: 跑測試確認通過**

Run: `pytest tests/test_weights.py -v`
Expected: 5 passed

- [ ] **Step 9: Commit**

```bash
git add heroes/herolab/model.py heroes/herolab/weights.py heroes/tests/test_model.py heroes/tests/test_weights.py
git commit -m "feat(heroes): 策略型別、發布規則驗證與權重正規化（#309）"
```

---

### Task A3: 策略規則

**Files:**
- Create: `heroes/herolab/rules.py`
- Test: `heroes/tests/test_rules.py`

**Interfaces:**
- Consumes: `Leg`、`Rebalance`、`validate`（Task A2）；`to_bps`（Task A2）；`ASSETS`、`esg_composite`、`max_leverage`（Task A1）
- Produces: `RULES: dict[str, Callable[[pd.DataFrame, dict, int], list[Rebalance]]]`，鍵為 `buy_hold`、`fixed_mix`、`trend`、`momentum`、`mean_reversion`、`risk_parity`、`esg_tilt`、`long_short`。每條規則是純函式 `(prices, params, seed) -> list[Rebalance]`。共用參數：`start`（ISO 日期字串，必填）、`every_days`（調整間隔）。第一筆 `Rebalance` 一定落在 `start` 當天。

- [ ] **Step 1: 寫失敗測試**

`heroes/tests/test_rules.py`：

```python
import datetime as dt

import pandas as pd
import pytest

from herolab.assets import ASSETS
from herolab.model import validate
from herolab.rules import RULES

START = dt.date(2024, 10, 1)


def make_prices(days=240, first=dt.date(2024, 4, 1)):
    """每個資產一條固定漂移的價格：sBTC 跌最快，sBOND 持平，sESGU 漲最快。"""
    index = [first + dt.timedelta(days=i) for i in range(days)]
    drift = {a: 0.002 * (i - 5) for i, a in enumerate(ASSETS)}
    return pd.DataFrame({a: [100.0 * (1 + drift[a]) ** t for t in range(days)] for a in ASSETS}, index=index)


PRICES = make_prices()
BASE = {"start": START.isoformat(), "every_days": 14}
MIX = {"weights": {"sBTC": 0.5, "sETH": 0.3, "sGOLD": 0.2}}
CASES = [
    ("buy_hold", MIX),
    ("fixed_mix", MIX),
    ("trend", {"universe": ["sBTC", "sETH", "sGOLD", "sNVDA"], "window": 30}),
    ("momentum", {"top_k": 3, "lookback": 60}),
    ("mean_reversion", {"top_k": 3, "lookback": 60}),
    ("risk_parity", {"universe": ["sGOLD", "sBOND", "sBTC", "sESGU"], "lookback": 30}),
    ("esg_tilt", {"top_k": 4}),
    ("long_short", {"lookback": 60, "long_k": 2, "short_k": 1}),
]


@pytest.mark.parametrize("name, extra", CASES)
def test_every_rule_starts_on_day_one_and_only_emits_publishable_strategies(name, extra):
    rebalances = RULES[name](PRICES, {**BASE, **extra}, 1)
    assert rebalances and rebalances[0].date == START
    assert [r.date for r in rebalances] == sorted({r.date for r in rebalances})
    for r in rebalances:
        validate(r)


@pytest.mark.parametrize("name, extra", CASES)
def test_same_inputs_same_output(name, extra):
    assert RULES[name](PRICES, {**BASE, **extra}, 7) == RULES[name](PRICES, {**BASE, **extra}, 7)


def test_buy_hold_never_rebalances():
    assert len(RULES["buy_hold"](PRICES, {**BASE, **MIX}, 1)) == 1


def test_fixed_mix_rebalances_on_schedule():
    assert len(RULES["fixed_mix"](PRICES, {**BASE, **MIX}, 1)) >= 4  # 57 天 / 14 天


def test_momentum_holds_the_strongest_assets():
    first = RULES["momentum"](PRICES, {**BASE, "top_k": 3, "lookback": 60}, 1)[0]
    assert {leg.asset for leg in first.legs} == {"sESGU", "sICLN", "sGOOGL"}
    assert all(leg.is_long for leg in first.legs)


def test_mean_reversion_holds_the_weakest_assets():
    first = RULES["mean_reversion"](PRICES, {**BASE, "top_k": 3, "lookback": 60}, 1)[0]
    assert {leg.asset for leg in first.legs} == {"sBTC", "sETH", "sAAPL"}


def test_trend_shorts_what_is_below_its_average():
    first = RULES["trend"](PRICES, {**BASE, "universe": ["sBTC", "sETH", "sNVDA", "sESGU"], "window": 30}, 1)[0]
    side = {leg.asset: leg.is_long for leg in first.legs}
    assert side == {"sBTC": False, "sETH": False, "sNVDA": True, "sESGU": True}


def test_long_short_shorts_the_weakest():
    first = RULES["long_short"](PRICES, {**BASE, "lookback": 60, "long_k": 2, "short_k": 1}, 1)[0]
    side = {leg.asset: leg.is_long for leg in first.legs}
    assert side == {"sESGU": True, "sICLN": True, "sBTC": False}


def test_requested_leverage_is_clipped_to_each_assets_carbon_ceiling():
    first = RULES["momentum"](PRICES, {**BASE, "top_k": 3, "lookback": 60, "leverage": 5}, 1)[0]
    assert {leg.asset: leg.leverage for leg in first.legs} == {"sESGU": 2, "sICLN": 5, "sGOOGL": 1}


def test_a_signal_rule_does_not_republish_an_unchanged_strategy():
    # 漂移固定，動量前三名永遠相同：只有第一天發布一次
    assert len(RULES["momentum"](PRICES, {**BASE, "top_k": 3, "lookback": 60}, 1)) == 1
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pytest tests/test_rules.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'herolab.rules'`

- [ ] **Step 3: 實作規則**

`heroes/herolab/rules.py`：

```python
"""策略規則：純函式 (prices, params, seed) -> 依日期排序的 Rebalance 清單。

prices 的 index 是 datetime.date，要包含 params["start"] 之前足夠的回看期。
"""
from __future__ import annotations

import datetime as dt
import random
from typing import Callable

import pandas as pd

from .assets import ASSETS, esg_composite, max_leverage
from .model import Leg, Rebalance
from .weights import to_bps

Rule = Callable[[pd.DataFrame, dict, int], list[Rebalance]]


def _dates(prices: pd.DataFrame, params: dict, seed: int) -> list[dt.date]:
    """start 當天一定調整一次；之後每 every_days 天一次，起點用種子錯開，
    讓同一條規則的幾位交易者不會全擠在同一天。"""
    start = dt.date.fromisoformat(params["start"])
    days = [d for d in prices.index if d >= start]
    if not days:
        return []
    every = int(params.get("every_days", 0))
    if every <= 0:
        return [days[0]]
    offset = random.Random(seed).randrange(every)
    return [days[0]] + days[1 + offset :: every]


def _legs(weights: dict[str, float], shorts: frozenset[str] = frozenset(), leverage: int = 1) -> tuple[Leg, ...]:
    bps = to_bps(weights)
    return tuple(Leg(a, bps[a], a not in shorts, min(leverage, max_leverage(a))) for a in sorted(bps))


def _history(prices: pd.DataFrame, day: dt.date, lookback: int, universe) -> pd.DataFrame:
    return prices.loc[:day, list(universe)].iloc[-(lookback + 1) :]


def _returns(prices: pd.DataFrame, day: dt.date, lookback: int, universe) -> pd.Series:
    window = _history(prices, day, lookback, universe)
    return window.iloc[-1] / window.iloc[0] - 1.0


def _ranked(scores: pd.Series, k: int, largest: bool) -> list[str]:
    # 同分用名稱排，兩次執行的順序才會一樣
    return sorted(scores.index, key=lambda a: (-scores[a] if largest else scores[a], a))[:k]


def _changed(rebalances: list[Rebalance]) -> list[Rebalance]:
    """訊號沒變就不重新發布：平倉再開一樣的部位只是白付手續費。"""
    kept: list[Rebalance] = []
    for r in rebalances:
        if not kept or kept[-1].legs != r.legs:
            kept.append(r)
    return kept


def buy_hold(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]:
    return [Rebalance(d, _legs(params["weights"])) for d in _dates(prices, {**params, "every_days": 0}, seed)]


def fixed_mix(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]:
    # 刻意不去重：定期把漂掉的比例拉回目標，正是這條規則在做的事
    return [Rebalance(d, _legs(params["weights"])) for d in _dates(prices, params, seed)]


def trend(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]:
    universe = params["universe"]
    window = int(params.get("window", 50))
    leverage = int(params.get("leverage", 1))
    out = []
    for d in _dates(prices, params, seed):
        h = _history(prices, d, window, universe)
        shorts = frozenset(a for a in universe if h[a].iloc[-1] < h[a].mean())
        out.append(Rebalance(d, _legs({a: 1.0 for a in universe}, shorts, leverage)))
    return _changed(out)


def _pick(prices: pd.DataFrame, params: dict, seed: int, largest: bool) -> list[Rebalance]:
    universe = params.get("universe", ASSETS)
    k = int(params.get("top_k", 3))
    lookback = int(params.get("lookback", 90))
    leverage = int(params.get("leverage", 1))
    out = []
    for d in _dates(prices, params, seed):
        picks = _ranked(_returns(prices, d, lookback, universe), k, largest)
        out.append(Rebalance(d, _legs({a: 1.0 for a in picks}, leverage=leverage)))
    return _changed(out)


def momentum(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]:
    return _pick(prices, params, seed, largest=True)


def mean_reversion(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]:
    return _pick(prices, params, seed, largest=False)


def risk_parity(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]:
    universe = params["universe"]
    lookback = int(params.get("lookback", 60))
    out = []
    for d in _dates(prices, params, seed):
        volatility = _history(prices, d, lookback, universe).pct_change().dropna().std()
        out.append(Rebalance(d, _legs({a: 1.0 / max(float(volatility[a]), 1e-9) for a in universe})))
    return _changed(out)


def esg_tilt(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]:
    k = int(params.get("top_k", 4))
    picks = sorted(ASSETS, key=lambda a: (-esg_composite(a), a))[:k]
    weights = {a: float(esg_composite(a)) for a in picks}
    return [Rebalance(d, _legs(weights)) for d in _dates(prices, params, seed)]


def long_short(prices: pd.DataFrame, params: dict, seed: int) -> list[Rebalance]:
    universe = params.get("universe", ASSETS)
    lookback = int(params.get("lookback", 60))
    long_k = int(params.get("long_k", 2))
    short_k = int(params.get("short_k", 1))
    out = []
    for d in _dates(prices, params, seed):
        scores = _returns(prices, d, lookback, universe)
        longs = _ranked(scores, long_k, largest=True)
        shorts = [a for a in _ranked(scores, short_k, largest=False) if a not in longs]
        out.append(Rebalance(d, _legs({a: 1.0 for a in longs + shorts}, frozenset(shorts))))
    return _changed(out)


RULES: dict[str, Rule] = {
    "buy_hold": buy_hold,
    "fixed_mix": fixed_mix,
    "trend": trend,
    "momentum": momentum,
    "mean_reversion": mean_reversion,
    "risk_parity": risk_parity,
    "esg_tilt": esg_tilt,
    "long_short": long_short,
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pytest tests/test_rules.py -v`
Expected: 24 passed

- [ ] **Step 5: 用真實價格跑一遍，確認沒有規則產生不合規的策略**

Run:

```bash
python -c "
import datetime as dt; from pathlib import Path
from herolab.prices import load_prices; from herolab.rules import RULES; from herolab.model import validate
p = load_prices(Path('prices'), dt.date(2024, 4, 1), dt.date(2025, 9, 30))
base = {'start': '2024-10-01', 'every_days': 30}
mix = {'weights': {'sBTC': .5, 'sETH': .3, 'sGOLD': .2}}
for name, extra in [('buy_hold', mix), ('fixed_mix', mix), ('trend', {'universe': ['sBTC','sETH','sGOLD','sNVDA']}),
                    ('momentum', {}), ('mean_reversion', {}), ('risk_parity', {'universe': ['sGOLD','sBOND','sBTC','sESGU']}),
                    ('esg_tilt', {}), ('long_short', {})]:
    rs = RULES[name](p, {**base, **extra}, 1); [validate(r) for r in rs]; print(name, len(rs))"
```

Expected: 8 行，每條規則印出調整次數（`buy_hold` 為 1，`fixed_mix` 約 13），沒有例外。

- [ ] **Step 6: Commit**

```bash
git add heroes/herolab/rules.py heroes/tests/test_rules.py
git commit -m "feat(heroes): 八條策略規則（#309）"
```

---

### Task A4: 交易者名冊、虛擬跟隨者與回放排程

**Files:**
- Create: `heroes/herolab/roster.py`, `heroes/herolab/schedule.py`, `heroes/build_schedule.py`, `heroes/tests/fixtures/schedule_smoke.json`
- Test: `heroes/tests/test_schedule.py`

**Interfaces:**
- Consumes: `RULES`（Task A3）、`validate`（Task A2）、`load_prices`、`ASSETS`（Task A1）
- Produces: `schedule.json`（介面二），Task A6 的回放程式讀它：

```jsonc
{
  "schemaVersion": 1,
  "start": "2024-10-01", "end": "2024-10-30",
  "assets": ["sBTC", "..."],
  "days": [{ "date": "2024-10-01", "timestamp": 1727816400, "prices": { "sBTC": "6083011000000" } }],
  "traders": [{
    "index": 10, "name": "Whale Alpha", "rule": "buy_hold", "capitalUsd": 10000, "stakeUsd": 600,
    "rebalances": [{ "date": "2024-10-01",
      "legs": [{ "asset": "sBTC", "weightBps": 5000, "isLong": true, "leverage": 1 }] }]
  }],
  "followers": [{ "index": 40, "actions": [
    { "date": "2024-10-09", "type": "follow", "traderIndex": 10, "amountUsd": 1000 },
    { "date": "2024-10-20", "type": "unfollow", "traderIndex": 10 }
  ] }]
}
```

`timestamp` 是當日 21:00 UTC 的 Unix 秒。`prices` 的值是 8 位小數的整數字串（預言機的格式）。`index` 是 Anvil 預設助記詞的推導索引：交易者用 10–33，虛擬跟隨者用 40 起。

- [ ] **Step 1: 寫失敗測試**

`heroes/tests/test_schedule.py`：

```python
import datetime as dt

import pandas as pd

from herolab.assets import ASSETS
from herolab.roster import TRADERS, follower_actions
from herolab.schedule import build_schedule, day_timestamp

FIRST = dt.date(2024, 4, 1)
START, END = dt.date(2024, 10, 1), dt.date(2024, 10, 30)


def make_prices(days=240):
    index = [FIRST + dt.timedelta(days=i) for i in range(days)]
    drift = {a: 0.002 * (i - 5) for i, a in enumerate(ASSETS)}
    return pd.DataFrame({a: [100.0 * (1 + drift[a]) ** t for t in range(days)] for a in ASSETS}, index=index)


PRICES = make_prices()


def test_roster_has_24_traders_on_distinct_wallet_indices():
    assert len(TRADERS) == 24
    assert sorted(t.index for t in TRADERS) == list(range(10, 34))
    assert len({t.name for t in TRADERS}) == 24


def test_day_timestamp_is_2100_utc():
    assert day_timestamp(dt.date(2024, 10, 1)) == 1727816400


def test_schedule_has_one_day_per_calendar_day_with_integer_prices():
    doc = build_schedule(PRICES, TRADERS[:3], START, END, n_followers=4)
    assert [d["date"] for d in doc["days"]][:2] == ["2024-10-01", "2024-10-02"]
    assert len(doc["days"]) == 30
    assert doc["days"][0]["timestamp"] == 1727816400
    price = doc["days"][0]["prices"]["sBOND"]
    assert isinstance(price, str) and int(price) == round(float(PRICES.at[START, "sBOND"]) * 1e8)


def test_every_trader_opens_on_the_first_day():
    doc = build_schedule(PRICES, TRADERS, START, END, n_followers=0)
    assert len(doc["traders"]) == 24
    for trader in doc["traders"]:
        assert trader["rebalances"][0]["date"] == "2024-10-01"
        assert all(START.isoformat() <= r["date"] <= END.isoformat() for r in trader["rebalances"])


def test_followers_follow_before_they_unfollow_and_only_once_per_trader():
    days = [START + dt.timedelta(days=i) for i in range(30)]
    actions = follower_actions(days, TRADERS, n_followers=20, seed=7)
    assert actions
    seen = {}
    for a in sorted(actions, key=lambda a: (a.date, a.kind != "follow")):
        key = (a.follower_index, a.trader_index)
        if a.kind == "follow":
            assert key not in seen and a.date > days[0] and a.amount_usd >= 500
            seen[key] = a.date
        else:
            assert key in seen and a.date > seen[key]


def test_same_inputs_same_schedule():
    assert build_schedule(PRICES, TRADERS[:3], START, END, 4) == build_schedule(PRICES, TRADERS[:3], START, END, 4)
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pytest tests/test_schedule.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'herolab.roster'`

- [ ] **Step 3: 實作名冊與跟隨者**

`heroes/herolab/roster.py`：

```python
"""24 位模擬交易者，以及虛擬跟隨者何時跟隨、何時取消。

index 是 Anvil 預設助記詞的推導索引（m/44'/60'/0'/0/<index>）。0 是部署者、9 是展示帳號，
交易者用 10–33，虛擬跟隨者從 40 起。
"""
from __future__ import annotations

import datetime as dt
import random
from dataclasses import dataclass, field

LOW_CARBON = ["sETH", "sAAPL", "sBOND", "sNVDA", "sICLN"]
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
    TraderSpec(12, "ESG Master", "esg_tilt", {"top_k": 4, "every_days": 60}, 12, stake_usd=3000),
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
    TraderSpec(31, "Low Carbon Lev", "momentum", {"universe": LOW_CARBON + ["sESGU"], "top_k": 3, "lookback": 30, "every_days": 7, "leverage": 2}, 31, stake_usd=3000),
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
```

- [ ] **Step 4: 實作排程**

`heroes/herolab/schedule.py`：

```python
from __future__ import annotations

import datetime as dt

import pandas as pd

from .assets import ASSETS
from .model import validate
from .roster import follower_actions
from .rules import RULES

SCHEMA_VERSION = 1


def day_timestamp(day: dt.date) -> int:
    """當日 21:00 UTC：美股收盤之後。"""
    return int(dt.datetime(day.year, day.month, day.day, 21, tzinfo=dt.timezone.utc).timestamp())


def _price(prices: pd.DataFrame, day: dt.date, asset: str) -> str:
    return str(round(float(prices.at[day, asset]) * 1e8))  # 預言機用 8 位小數


def build_schedule(prices: pd.DataFrame, traders, start: dt.date, end: dt.date,
                   n_followers: int = 60, follower_seed: int = 7) -> dict:
    days = [d for d in prices.index if start <= d <= end]
    visible = prices.loc[:end]  # 規則看不到 end 之後的價格
    trader_docs = []
    for spec in traders:
        rebalances = RULES[spec.rule](visible, {**spec.params, "start": start.isoformat()}, spec.seed)
        for r in rebalances:
            validate(r)
        trader_docs.append({
            "index": spec.index, "name": spec.name, "rule": spec.rule,
            "capitalUsd": spec.capital_usd, "stakeUsd": spec.stake_usd,
            "rebalances": [{
                "date": r.date.isoformat(),
                "legs": [{"asset": l.asset, "weightBps": l.weight_bps, "isLong": l.is_long, "leverage": l.leverage}
                         for l in r.legs],
            } for r in rebalances],
        })
    by_follower: dict[int, list[dict]] = {}
    for a in sorted(follower_actions(days, list(traders), n_followers, follower_seed), key=lambda a: a.date):
        action = {"date": a.date.isoformat(), "type": a.kind, "traderIndex": a.trader_index}
        if a.kind == "follow":
            action["amountUsd"] = a.amount_usd
        by_follower.setdefault(a.follower_index, []).append(action)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "start": start.isoformat(), "end": end.isoformat(),
        "assets": list(ASSETS),
        "days": [{"date": d.isoformat(), "timestamp": day_timestamp(d),
                  "prices": {a: _price(prices, d, a) for a in ASSETS}} for d in days],
        "traders": trader_docs,
        "followers": [{"index": i, "actions": acts} for i, acts in sorted(by_follower.items())],
    }
```

- [ ] **Step 5: 跑測試確認通過**

Run: `pytest tests/test_schedule.py -v`
Expected: 6 passed

- [ ] **Step 6: 寫 CLI**

`heroes/build_schedule.py`：

```python
"""產生回放排程。
  python build_schedule.py                          # 全部 24 位、2024-10-01 到價格檔最後一天
  python build_schedule.py --end 2024-10-30 --indices 10,13,31 --followers 4 --out tests/fixtures/schedule_smoke.json
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

import pandas as pd

from herolab.prices import load_prices
from herolab.roster import TRADERS
from herolab.schedule import build_schedule

HERE = Path(__file__).parent
FIRST = dt.date(2024, 4, 1)


def last_common_close(directory: Path) -> dt.date:
    """每個資產最後一筆收盤價的日期，取最早的那個：之後的日子有資產還沒有價格。"""
    return min(pd.read_csv(p, parse_dates=["date"])["date"].max().date() for p in directory.glob("*.csv"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2024-10-01")
    parser.add_argument("--end", default=None)
    parser.add_argument("--indices", default=None, help="逗號分隔的交易者 index；預設全部")
    parser.add_argument("--followers", type=int, default=60)
    parser.add_argument("--out", default=str(HERE / "out" / "schedule.json"))
    args = parser.parse_args()

    start = dt.date.fromisoformat(args.start)
    end = dt.date.fromisoformat(args.end) if args.end else last_common_close(HERE / "prices")
    wanted = {int(i) for i in args.indices.split(",")} if args.indices else None
    traders = [t for t in TRADERS if wanted is None or t.index in wanted]

    doc = build_schedule(load_prices(HERE / "prices", FIRST, end), traders, start, end, args.followers)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1) + "\n")
    rebalances = sum(len(t["rebalances"]) for t in doc["traders"])
    print(f"{out}: {len(doc['days'])} days, {len(doc['traders'])} traders, "
          f"{rebalances} rebalances, {len(doc['followers'])} followers")


if __name__ == "__main__":
    main()
```

- [ ] **Step 7: 產生進版控的小規模排程**

Run:

```bash
python build_schedule.py --end 2024-10-30 --indices 10,13,31 --followers 4 --out tests/fixtures/schedule_smoke.json
```

Expected: `tests/fixtures/schedule_smoke.json: 30 days, 3 traders, N rebalances, M followers`，其中 N ≥ 5（兩位每 7 天調整的動量交易者）、M ≥ 1。若 M 為 0，把 `--followers` 加到 8 再跑。

- [ ] **Step 8: 產生完整排程確認規模**

Run: `python build_schedule.py`
Expected: 約 740 天、24 位交易者、數百次調整、約 60 位跟隨者。記下調整次數——回放的交易筆數大約是它的 8 倍再加上每天 11 筆價格更新。

- [ ] **Step 9: Commit**

```bash
git add heroes/herolab/roster.py heroes/herolab/schedule.py heroes/build_schedule.py heroes/tests/test_schedule.py heroes/tests/fixtures/schedule_smoke.json
git commit -m "feat(heroes): 交易者名冊、虛擬跟隨者與回放排程（#309）"
```

---

### Task A5: 回放的純函式與 ABI

**Files:**
- Create: `agent/heroes/abi.ts`, `agent/heroes/plan.ts`
- Test: `agent/heroes/plan.test.ts`
- Modify: `agent/package.json`（`scripts.test` 與新增 `test:heroes`）

**Interfaces:**
- Produces: `planOpens(free: bigint, legs: LegPlan[], feeBps: Record<string, bigint>): OpenOrder[]`、`shouldLiquidate(value: bigint, margin: bigint, leverage: bigint, maintenanceBps: bigint): boolean`、`MIN_MARGIN: bigint`；型別 `LegPlan { asset: string; weightBps: number; isLong: boolean; leverage: number }`、`OpenOrder extends LegPlan { margin: bigint }`；`abi.ts` 匯出 `EXCHANGE_ABI`、`REGISTRY_ABI`、`COPY_ABI`、`STAKE_ABI`、`USDC_ABI`、`ORACLE_ABI`、`KYC_ABI`。

- [ ] **Step 1: 寫失敗測試**

`agent/heroes/plan.test.ts`：

```ts
// 純函式測試：回放怎麼把可用保證金拆給每一檔、什麼時候該清算。
//   cd agent && npx tsx heroes/plan.test.ts
import assert from "node:assert";
import { planOpens, shouldLiquidate, MIN_MARGIN, type LegPlan } from "./plan.ts";

const E18 = 10n ** 18n;
const FEES = { sBTC: 100n, sETH: 10n, sESGU: 40n };

// ── planOpens：保證金加開倉手續費不能超過可用保證金 ───────────────────────
const legs: LegPlan[] = [
  { asset: "sBTC", weightBps: 5000, isLong: true, leverage: 1 },
  { asset: "sETH", weightBps: 3000, isLong: true, leverage: 5 },
  { asset: "sESGU", weightBps: 2000, isLong: false, leverage: 2 },
];
const free = 10_000n * E18;
const orders = planOpens(free, legs, FEES);
assert.equal(orders.length, 3);

const cost = orders.reduce(
  (sum, o) => sum + o.margin + (o.margin * BigInt(o.leverage) * FEES[o.asset as keyof typeof FEES]) / 10_000n,
  0n,
);
assert.ok(cost <= free, "保證金 + 手續費超過可用保證金");
assert.ok(cost >= (free * 995n) / 1000n, "留下的閒置保證金超過 0.5%");

// 各檔的比例就是權重（逐檔整數除法各自捨去，容許幾 wei 的差）
const near = (a: bigint, b: bigint) => (a > b ? a - b : b - a) < 10n;
assert.ok(near(orders[0].margin * 3n, orders[1].margin * 5n));
assert.ok(near(orders[0].margin * 2n, orders[2].margin * 5n));

// 方向與槓桿原樣帶過去
assert.deepEqual(
  orders.map((o) => [o.asset, o.isLong, o.leverage]),
  [["sBTC", true, 1], ["sETH", true, 5], ["sESGU", false, 2]],
);

// 分到的保證金低於交易所下限的那一檔不開（開了會 revert MarginTooLow）
const tiny = planOpens(60n * E18, legs, FEES);
assert.ok(tiny.every((o) => o.margin >= MIN_MARGIN));
assert.deepEqual(tiny.map((o) => o.asset), ["sBTC", "sETH", "sESGU"]);
assert.deepEqual(planOpens(30n * E18, legs, FEES).map((o) => o.asset), ["sBTC"]);
assert.deepEqual(planOpens(0n, legs, FEES), []);

// ── shouldLiquidate：部位價值 <= 維持保證金（名目 × bps）才清算 ──────────────
const margin = 1_000n * E18;
// 5 倍、維持保證金 5%：名目 5000，門檻 250
assert.equal(shouldLiquidate(250n * E18, margin, 5n, 500n), true);
assert.equal(shouldLiquidate(250n * E18 + 1n, margin, 5n, 500n), false);
assert.equal(shouldLiquidate(0n, margin, 1n, 500n), true);
assert.equal(shouldLiquidate(900n * E18, margin, 1n, 500n), false);

console.log("plan.test.ts ✓");
```

- [ ] **Step 2: 跑測試確認失敗**

Run（在 `agent/` 內）: `npx tsx heroes/plan.test.ts`
Expected: FAIL，`Cannot find module './plan.ts'`

- [ ] **Step 3: 實作純函式**

`agent/heroes/plan.ts`：

```ts
// 回放裡不碰鏈的決策：怎麼拆保證金、什麼時候清算。

export interface LegPlan {
  asset: string;
  weightBps: number;
  isLong: boolean;
  leverage: number;
}

export interface OpenOrder extends LegPlan {
  margin: bigint;
}

/** PerpetualExchange.MIN_MARGIN。 */
export const MIN_MARGIN = 10n * 10n ** 18n;

const BPS = 10_000n;

/**
 * 把可用保證金照權重拆給每一檔，並預留開倉手續費。
 *
 * 交易所開倉時扣 margin + margin × leverage × feeBps / 10000。設總保證金為 B，
 * 第 i 檔的保證金是 B × w_i / 10000，所以
 *   B × (1 + Σ w_i × lev_i × fee_i / 1e8) <= free
 * 再留千分之一，吸收逐檔整數除法的捨入。
 */
export function planOpens(free: bigint, legs: LegPlan[], feeBps: Record<string, bigint>): OpenOrder[] {
  if (free <= 0n) return [];
  const scale = BPS * BPS;
  let load = 0n;
  for (const leg of legs) load += BigInt(leg.weightBps) * BigInt(leg.leverage) * feeBps[leg.asset];
  const budget = (((free * scale) / (scale + load)) * 999n) / 1000n;
  return legs
    .map((leg) => ({ ...leg, margin: (budget * BigInt(leg.weightBps)) / BPS }))
    .filter((order) => order.margin >= MIN_MARGIN);
}

/** 與 liquidatePosition 的閘門相同：平倉能拿回的金額 <= 名目 × 維持保證金率。 */
export function shouldLiquidate(value: bigint, margin: bigint, leverage: bigint, maintenanceBps: bigint): boolean {
  return value <= (margin * leverage * maintenanceBps) / BPS;
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `npx tsx heroes/plan.test.ts`
Expected: `plan.test.ts ✓`

- [ ] **Step 5: 寫 ABI 片段**

`agent/heroes/abi.ts`：

```ts
// 回放與價格寫入用到的 ABI 片段（ethers 的 human-readable 格式）。
// 簽章對照 contracts/src；只列用到的，不是完整 ABI。

const ALLOCATION = "tuple(bytes32 asset, uint256 weight, bool isLong, uint256 leverage)";

export const EXCHANGE_ABI = [
  "event PositionOpened(uint256 indexed positionId, address indexed owner, bytes32 indexed asset, bool isLong, uint256 entryPrice, uint256 margin, uint256 leverage)",
  "event PositionClosed(uint256 indexed positionId, address indexed owner, int256 pnl, uint256 closeAmount)",
  "event PositionLiquidated(uint256 indexed positionId, address indexed owner, address indexed liquidator, int256 pnl)",
  "function executionFee() view returns (uint256)",
  "function freeMargin(address) view returns (uint256)",
  "function getUserPositions(address) view returns (uint256[])",
  "function getPositionValue(uint256) view returns (uint256)",
  "function tradingFeeBpsForAsset(bytes32) view returns (uint256)",
  "function maintenanceMarginBpsForAsset(bytes32) view returns (uint256)",
  "function depositMargin(uint256 amount)",
  "function openPosition(bytes32 asset, bool isLong, uint256 margin, uint256 leverage) payable returns (uint256)",
  "function closePosition(uint256 positionId)",
  "function liquidatePosition(uint256 positionId)",
];

export const REGISTRY_ABI = [
  "event StrategyPublished(address indexed trader, uint256 versionId, uint256 createdAt)",
  "function registerTrader(string displayName)",
  "function isEligibleTrader(address trader) view returns (bool)",
  `function publishStrategy(${ALLOCATION}[] allocations)`,
  `function getLatestStrategy(address trader) view returns (${ALLOCATION}[] allocations, uint256 versionId)`,
  `function getStrategyVersion(address trader, uint256 versionId) view returns (${ALLOCATION}[] allocations, uint256 createdAt)`,
];

export const COPY_ABI = [
  "event TraderFollowed(address indexed follower, address indexed trader, uint256 versionId, uint256 totalMargin)",
  "event TraderUnfollowed(address indexed follower, address indexed trader, uint256 recordIdx)",
  "event TraderSlashed(address indexed trader, address indexed follower, uint256 slashAmount)",
  "function followTrader(address trader, uint256 totalMargin) payable",
  "function unfollowAndCloseAll(uint256 recordIdx)",
  "function getCopyRecords(address follower) view returns (tuple(address trader, uint256 versionId, uint256 initialAmount, uint256[] positionIds, uint256 copiedAt, bool active, uint256 deployedAmount)[])",
  "function getFollowerCount(address trader) view returns (uint256)",
];

export const STAKE_ABI = ["function stake(uint256 amount)"];

export const USDC_ABI = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

export const ORACLE_ABI = [
  "function updatePrice(bytes32 assetId, uint256 newPrice)",
  "function getPrice(bytes32 assetId) view returns (uint256 price, uint256 updatedAt)",
];

export const KYC_ABI = ["function batchVerify(address[] users)"];
```

- [ ] **Step 6: 把測試接進 agent 的測試指令**

`agent/package.json`，在 `scripts` 裡 `test:issuer` 那一行後面加一行，並把 `test` 改成串上它：

```json
    "test": "npm run test:keeper && npm run test:core && npm run test:agent && npm run test:api && npm run test:signal-api && npm run test:sdk && npm run test:issuer && npm run test:heroes",
```

```json
    "test:heroes": "tsx heroes/plan.test.ts",
```

Run: `npm run test:heroes`
Expected: `plan.test.ts ✓`

- [ ] **Step 7: 型別檢查沒有被破壞**

Run: `npm run typecheck`
Expected: 與改動前相同的結果（`agent/heroes/` 不在任何 tsconfig 的 include 裡時，這一步不會檢查到它；那是預期的，tsx 執行時自己會轉譯）。

- [ ] **Step 8: Commit**

```bash
git add agent/heroes/abi.ts agent/heroes/plan.ts agent/heroes/plan.test.ts agent/package.json
git commit -m "feat(heroes): 回放的保證金拆分與清算判斷（#309）"
```

---

### Task A6: 回放程式與一鍵回放腳本

**Files:**
- Create: `agent/heroes/replay.ts`, `scripts/heroes-replay.sh`

**Interfaces:**
- Consumes: `planOpens`、`shouldLiquidate`、ABI（Task A5）；`schedule.json`（Task A4）；畫面線 Task B1 的 `contracts/script/DeployLocalDemo.s.sol` 與 Task B2 的 `agent/heroes/writeAddresses.ts`（執行後產生 `heroes/out/addresses.json`，鍵為 `MockUSDC`、`MockOracle`、`TraderStake`、`PerpetualExchange`、`StrategyRegistry`、`CopyTracker`、`KYCRegistry`…，值為位址）。
- Produces: `heroes/out/events.json`，Task A7 的分析讀它：

```jsonc
{
  "schemaVersion": 1, "chainId": 31337,
  "range": { "from": "2024-10-01", "to": "2024-10-30" },
  "stats": { "sent": 0, "failed": 0, "failures": [], "skipped": [] },
  "traders": [{ "index": 10, "name": "Whale Alpha", "rule": "buy_hold", "address": "0x…",
                "capitalUsd": 10000, "finalEquity": "10123450000000000000000", "followerCount": 2 }],
  "events": [{ "name": "PositionOpened", "block": 123, "logIndex": 0, "timestamp": 1727816412, "tx": "0x…",
               "args": { "positionId": "1", "owner": "0x…", "asset": "sBTC", "isLong": true,
                         "entryPrice": "60830110000000000000000", "margin": "4950…", "leverage": "1",
                         "tradingFeeBps": "100" } }]
}
```

`args` 裡的整數一律是十進位字串，`asset` 已換成資產代號。`PositionOpened` 多帶 `tradingFeeBps`；`StrategyPublished` 多帶 `legs`（從鏈上讀回的那一版）。事件名稱：`PositionOpened`、`PositionClosed`、`PositionLiquidated`、`StrategyPublished`、`TraderFollowed`、`TraderUnfollowed`、`TraderSlashed`。

**前置：** 畫面線的 Task B1 與 B2 已合併進這條分支（`git merge` 或 rebase）。

- [ ] **Step 1: 寫回放程式**

`agent/heroes/replay.ts`：

```ts
// 在本機 Anvil 上回放一份排程：逐日設定時間、寫入價格、清算、讓交易者重新發布策略並換倉、
// 讓虛擬跟隨者跟隨與取消。結束時把相關事件匯出成 events.json。
//   cd agent && npx tsx heroes/replay.ts <schedule.json> <addresses.json> <events.json>
import { readFileSync, writeFileSync } from "node:fs";
import { ethers } from "ethers";
import { COPY_ABI, EXCHANGE_ABI, KYC_ABI, ORACLE_ABI, REGISTRY_ABI, STAKE_ABI, USDC_ABI } from "./abi.ts";
import { planOpens, shouldLiquidate, type LegPlan } from "./plan.ts";

const RPC = process.env.HEROES_RPC_URL ?? "http://127.0.0.1:8545";
// Anvil 的預設助記詞。公開的測試金鑰，只能用在本機鏈。
const MNEMONIC = "test test test test test test test test test test test junk";
const DEMO_INDEX = 9;
const E18 = 10n ** 18n;

interface Rebalance { date: string; legs: LegPlan[] }
interface TraderDoc { index: number; name: string; rule: string; capitalUsd: number; stakeUsd: number; rebalances: Rebalance[] }
interface FollowerAction { date: string; type: "follow" | "unfollow"; traderIndex: number; amountUsd?: number }
interface Schedule {
  start: string; end: string; assets: string[];
  days: { date: string; timestamp: number; prices: Record<string, string> }[];
  traders: TraderDoc[];
  followers: { index: number; actions: FollowerAction[] }[];
}

const [schedulePath, addressesPath, outPath] = process.argv.slice(2);
if (!schedulePath || !addressesPath || !outPath) {
  console.error("usage: tsx heroes/replay.ts <schedule.json> <addresses.json> <events.json>");
  process.exit(2);
}
const schedule: Schedule = JSON.parse(readFileSync(schedulePath, "utf8"));
const A: Record<string, string> = JSON.parse(readFileSync(addressesPath, "utf8"));

// 固定網路、不批次、不快取：回放是幾萬筆依序送出的交易，預設的 10ms 批次等待會讓它慢上好幾倍。
const LOCAL = ethers.Network.from(31337);
const provider = new ethers.JsonRpcProvider(RPC, LOCAL, {
  staticNetwork: LOCAL, batchMaxCount: 1, cacheTimeout: -1, pollingInterval: 100,
});
const wallet = (index: number) =>
  ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, `m/44'/60'/0'/0/${index}`).connect(provider);
// 刻意不用 NonceManager：它在 estimateGas 失敗時也會把 nonce 往前推，之後每筆交易都卡住。
const deployer = wallet(0);

const exchange = new ethers.Contract(A.PerpetualExchange, EXCHANGE_ABI, provider);
const registry = new ethers.Contract(A.StrategyRegistry, REGISTRY_ABI, provider);
const copy = new ethers.Contract(A.CopyTracker, COPY_ABI, provider);
const stake = new ethers.Contract(A.TraderStake, STAKE_ABI, provider);
const usdc = new ethers.Contract(A.MockUSDC, USDC_ABI, provider);
const oracle = new ethers.Contract(A.MockOracle, ORACLE_ABI, provider);
const kyc = new ethers.Contract(A.KYCRegistry, KYC_ABI, provider);

const assetId = (symbol: string) => ethers.id(symbol);
const symbolOf = new Map(schedule.assets.map((s) => [assetId(s), s]));
const usd = (amount: number) => BigInt(amount) * E18;

const stats = { sent: 0, failed: 0, failures: [] as string[], skipped: [] as string[] };
type Receipt = ethers.ContractTransactionReceipt | null;

/** 送一筆交易並等它上鏈。失敗只記錄、不中斷——結束時由失敗比例決定這趟回放算不算數。 */
async function send(label: string, tx: () => Promise<ethers.ContractTransactionResponse>): Promise<Receipt> {
  stats.sent += 1;
  try {
    return await (await tx()).wait();
  } catch (e) {
    stats.failed += 1;
    if (stats.failures.length < 50) stats.failures.push(`${label}: ${(e as Error).message.slice(0, 160)}`);
    return null;
  }
}

// 目前開著的部位（交易者的與跟隨者的都算），清算檢查用。
const open = new Map<bigint, { asset: string; margin: bigint; leverage: bigint }>();

function track(receipt: Receipt): void {
  for (const log of receipt?.logs ?? []) {
    if (log.address.toLowerCase() !== A.PerpetualExchange.toLowerCase()) continue;
    const parsed = exchange.interface.parseLog(log);
    if (parsed?.name === "PositionOpened") {
      open.set(parsed.args.positionId, {
        asset: symbolOf.get(parsed.args.asset)!, margin: parsed.args.margin, leverage: parsed.args.leverage,
      });
    } else if (parsed?.name === "PositionClosed") {
      open.delete(parsed.args.positionId);
    }
  }
}

async function chunked<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

async function main(): Promise<void> {
  // provider 的網路是寫死的，所以直接問節點它到底是哪條鏈。
  const chainId = BigInt(await provider.send("eth_chainId", []));
  if (chainId !== 31337n) throw new Error(`refusing to replay on chainId ${chainId}: local Anvil (31337) only`);

  const traders = schedule.traders.map((t) => ({ ...t, wallet: wallet(t.index) }));
  const traderByIndex = new Map(traders.map((t) => [t.index, t]));
  const followers = schedule.followers.map((f) => ({ ...f, wallet: wallet(f.index) }));
  const demo = wallet(DEMO_INDEX);

  // ── 初始化 ────────────────────────────────────────────────────────────────
  // 每個區塊的時間戳固定 +1 秒，兩次回放才會逐筆相同。
  await provider.send("anvil_setBlockTimestampInterval", [1]);
  const everyone = [...traders.map((t) => t.wallet.address), ...followers.map((f) => f.wallet.address), demo.address];
  for (const address of everyone) await provider.send("anvil_setBalance", [address, ethers.toBeHex(1000n * E18)]);
  for (let i = 0; i < everyone.length; i += 50) {
    await send("kyc", () => kyc.connect(deployer).getFunction("batchVerify")(everyone.slice(i, i + 50)));
  }
  await send("mint demo", () => usdc.connect(deployer).getFunction("mint")(demo.address, usd(100_000)));

  // 第一天的時間與價格要先就位，交易者存入與開倉才不會遇到過期報價。
  const executionFee: bigint = await exchange.executionFee();
  const feeBps: Record<string, bigint> = {};
  const maintenanceBps: Record<string, bigint> = {};
  for (const symbol of schedule.assets) {
    feeBps[symbol] = await exchange.tradingFeeBpsForAsset(assetId(symbol));
    maintenanceBps[symbol] = await exchange.maintenanceMarginBpsForAsset(assetId(symbol));
  }

  for (const t of traders) {
    const w = t.wallet;
    await send(`mint ${t.name}`, () => usdc.connect(deployer).getFunction("mint")(w.address, usd(t.capitalUsd + t.stakeUsd)));
    await send(`approve stake ${t.name}`, () => usdc.connect(w).getFunction("approve")(A.TraderStake, usd(t.stakeUsd)));
    await send(`stake ${t.name}`, () => stake.connect(w).getFunction("stake")(usd(t.stakeUsd)));
    await send(`register ${t.name}`, () => registry.connect(w).getFunction("registerTrader")(t.name));
    await send(`approve margin ${t.name}`, () => usdc.connect(w).getFunction("approve")(A.PerpetualExchange, usd(t.capitalUsd)));
    await send(`deposit ${t.name}`, () => exchange.connect(w).getFunction("depositMargin")(usd(t.capitalUsd)));
  }
  for (const f of followers) {
    const total = f.actions.reduce((sum, a) => sum + (a.amountUsd ?? 0), 0);
    if (total > 0) await send(`mint follower ${f.index}`, () => usdc.connect(deployer).getFunction("mint")(f.wallet.address, usd(total)));
  }

  // ── 逐日 ──────────────────────────────────────────────────────────────────
  for (const [n, day] of schedule.days.entries()) {
    await provider.send("evm_setNextBlockTimestamp", [day.timestamp]);
    for (const symbol of schedule.assets) {
      await send(`price ${symbol} ${day.date}`, () =>
        oracle.connect(deployer).getFunction("updatePrice")(assetId(symbol), BigInt(day.prices[symbol])));
    }

    // 清算不會自己發生：每天把不健康的部位清掉。
    const ids = [...open.keys()];
    const values = await chunked(ids, 50, (id) => exchange.getPositionValue(id) as Promise<bigint>);
    for (const [i, id] of ids.entries()) {
      const p = open.get(id)!;
      if (shouldLiquidate(values[i], p.margin, p.leverage, maintenanceBps[p.asset])) {
        track(await send(`liquidate ${id}`, () => exchange.connect(deployer).getFunction("liquidatePosition")(id)));
      }
    }

    for (const t of traders) {
      const rebalance = t.rebalances.find((r) => r.date === day.date);
      if (!rebalance) continue;
      const w = t.wallet;
      const held: bigint[] = await exchange.getUserPositions(w.address);
      for (const id of held) {
        track(await send(`close ${id}`, () => exchange.connect(w).getFunction("closePosition")(id)));
      }
      // 質押被罰沒到門檻以下的交易者不能再發布；他照樣換倉，只是鏈上的策略停在上一版。
      if (await registry.isEligibleTrader(w.address)) {
        await send(`publish ${t.name} ${day.date}`, () =>
          registry.connect(w).getFunction("publishStrategy")(rebalance.legs.map((l) => ({
            asset: assetId(l.asset), weight: l.weightBps, isLong: l.isLong, leverage: l.leverage,
          }))));
      } else {
        stats.skipped.push(`publish ${t.name} ${day.date}: stake below the minimum`);
      }
      const free: bigint = await exchange.freeMargin(w.address);
      for (const order of planOpens(free, rebalance.legs, feeBps)) {
        track(await send(`open ${t.name} ${order.asset}`, () =>
          exchange.connect(w).getFunction("openPosition")(
            assetId(order.asset), order.isLong, order.margin, order.leverage, { value: executionFee })));
      }
    }

    for (const f of followers) {
      for (const action of f.actions.filter((a) => a.date === day.date)) {
        const trader = traderByIndex.get(action.traderIndex)!.wallet.address;
        if (action.type === "follow") {
          if (!(await registry.isEligibleTrader(trader))) {
            stats.skipped.push(`follow ${f.index}->${action.traderIndex} ${day.date}: trader not eligible`);
            continue;
          }
          const amount = usd(action.amountUsd!);
          const [allocations] = await registry.getLatestStrategy(trader);
          await send(`approve follow ${f.index}`, () => usdc.connect(f.wallet).getFunction("approve")(A.CopyTracker, amount));
          track(await send(`follow ${f.index}->${action.traderIndex}`, () =>
            copy.connect(f.wallet).getFunction("followTrader")(trader, amount, { value: executionFee * BigInt(allocations.length) })));
        } else {
          const records: { trader: string; active: boolean }[] = await copy.getCopyRecords(f.wallet.address);
          const index = records.findIndex((r) => r.active && r.trader.toLowerCase() === trader.toLowerCase());
          if (index < 0) continue; // 跟隨那一步失敗過，沒有紀錄可取消
          track(await send(`unfollow ${f.index}->${action.traderIndex}`, () =>
            copy.connect(f.wallet).getFunction("unfollowAndCloseAll")(index)));
        }
      }
    }
    if (n % 30 === 0) console.log(`${day.date}  open=${open.size}  sent=${stats.sent}  failed=${stats.failed}`);
  }

  // ── 匯出 ──────────────────────────────────────────────────────────────────
  const traderDocs = [];
  for (const t of traders) {
    const held: bigint[] = await exchange.getUserPositions(t.wallet.address);
    let equity: bigint = await exchange.freeMargin(t.wallet.address);
    for (const id of held) equity += (await exchange.getPositionValue(id)) as bigint;
    traderDocs.push({
      index: t.index, name: t.name, rule: t.rule, address: t.wallet.address, capitalUsd: t.capitalUsd,
      finalEquity: equity.toString(), followerCount: Number(await copy.getFollowerCount(t.wallet.address)),
    });
  }

  const events = [];
  for (const contract of [exchange, registry, copy]) {
    const logs = await provider.getLogs({ address: await contract.getAddress(), fromBlock: 0, toBlock: "latest" });
    for (const log of logs) {
      const parsed = contract.interface.parseLog(log);
      if (!parsed) continue;
      const args: Record<string, unknown> = {};
      parsed.fragment.inputs.forEach((input, i) => {
        const value = parsed.args[i];
        args[input.name] = input.name === "asset" ? symbolOf.get(value)
          : typeof value === "bigint" ? value.toString() : value;
      });
      if (parsed.name === "PositionOpened") args.tradingFeeBps = feeBps[args.asset as string].toString();
      if (parsed.name === "StrategyPublished") {
        const [legs] = await registry.getStrategyVersion(parsed.args.trader, parsed.args.versionId);
        args.legs = legs.map((l: { asset: string; weight: bigint; isLong: boolean; leverage: bigint }) => ({
          asset: symbolOf.get(l.asset), weightBps: Number(l.weight), isLong: l.isLong, leverage: Number(l.leverage),
        }));
      }
      events.push({ name: parsed.name, block: log.blockNumber, logIndex: log.index, timestamp: 0, tx: log.transactionHash, args });
    }
  }
  events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  const blocks = [...new Set(events.map((e) => e.block))];
  const stamps = new Map(await chunked(blocks, 100, async (b) => [b, (await provider.getBlock(b))!.timestamp] as const));
  for (const e of events) e.timestamp = stamps.get(e.block)!;

  writeFileSync(outPath, JSON.stringify({
    schemaVersion: 1, chainId: 31337, range: { from: schedule.start, to: schedule.end },
    stats, traders: traderDocs, events,
  }) + "\n");

  const ratio = stats.sent === 0 ? 0 : stats.failed / stats.sent;
  console.log(`replayed ${schedule.days.length} days: ${stats.sent} tx, ${stats.failed} failed (${(ratio * 100).toFixed(2)}%), ${events.length} events -> ${outPath}`);
  for (const line of stats.failures.slice(0, 10)) console.log(`  failed: ${line}`);
  if (ratio > 0.01) {
    console.error("more than 1% of transactions failed: this replay does not count");
    process.exit(1);
  }
}

// 明確結束：provider 的連線會讓行程掛著不退出，後面的腳本就等不到它。
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: 寫一鍵回放腳本**

`scripts/heroes-replay.sh`：

```bash
#!/usr/bin/env bash
# 起一條乾淨的本機 Anvil → 部署 → 回放 → 關閉 Anvil（關閉時把鏈狀態存成 heroes/out/chain.json）。
#   scripts/heroes-replay.sh [schedule.json]          預設 heroes/out/schedule.json
# PATH 上要有 anvil／forge／cast。開啟 Smart App Control 的 Windows 機器請在 WSL 裡跑，
# 並先 export PATH="$HOME/.foundry/bin:$PATH"。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/heroes/out"
SCHEDULE="${1:-$OUT/schedule.json}"
PORT="${HEROES_PORT:-8545}"
RPC="http://127.0.0.1:$PORT"
# Anvil 預設帳號 0 的私鑰。公開的測試金鑰，只能用在本機鏈。
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

[ -f "$SCHEDULE" ] || { echo "找不到排程 $SCHEDULE（先跑 heroes/build_schedule.py）" >&2; exit 2; }
if cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "$RPC 已經有節點在回應。回放需要一條乾淨的鏈：先關掉它，或設 HEROES_PORT 換埠。" >&2
  exit 2
fi

mkdir -p "$OUT"
rm -f "$OUT/chain.json" "$OUT/events.json"

# 鏈的起始時間設在排程第一天的 12 小時前。不設的話，部署會把區塊時間推到「現在」，
# 之後就無法把時間設回 2024 年（區塊時間只能往前）。
GENESIS="$(node -e "const s = JSON.parse(require(fs).readFileSync(process.argv[1], utf8)); console.log(s.days[0].timestamp - 43200)" "$SCHEDULE")"

anvil --port "$PORT" --host 0.0.0.0 --timestamp "$GENESIS" --dump-state "$OUT/chain.json" --silent &
ANVIL_PID=$!
# SIGINT 讓 Anvil 在結束前寫出鏈狀態；不論成功失敗都要收掉它。
trap 'kill -INT "$ANVIL_PID" 2>/dev/null || true; wait "$ANVIL_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 100); do
  cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 0.1
done
[ "$(cast chain-id --rpc-url "$RPC")" = "31337" ] || { echo "不是本機鏈，中止" >&2; exit 1; }

(cd "$ROOT/contracts" && forge script script/DeployLocalDemo.s.sol:DeployLocalDemo \
  --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast)
(cd "$ROOT/agent" && npx tsx heroes/writeAddresses.ts)
(cd "$ROOT/agent" && HEROES_RPC_URL="$RPC" npx tsx heroes/replay.ts "$SCHEDULE" "$OUT/addresses.json" "$OUT/events.json")

echo "回放完成。Anvil 關閉後鏈狀態會寫到 $OUT/chain.json"
```

Run: `chmod +x scripts/heroes-replay.sh`

- [ ] **Step 3: 跑小規模回放**

Run（repo 根目錄；SAC 機器在 WSL 內，先 `export PATH="$HOME/.foundry/bin:$PATH"`）:

```bash
scripts/heroes-replay.sh heroes/tests/fixtures/schedule_smoke.json
```

Expected: 最後印出 `replayed 30 days: N tx, 0 failed (0.00%), M events -> …/events.json`，腳本以 0 結束，`heroes/out/chain.json` 存在且非空。

若有失敗的交易，逐條看 `failed:` 後面的訊息並修正原因再重跑——不要調高 1% 的門檻。常見原因與處置：
- `InsufficientFreeMargin`：`planOpens` 預留不足 → 回 Task A5 補測試再修。
- `InvalidLeverage`：某資產鏈上的槓桿上限與 `heroes/herolab/assets.py` 的 `CARBON_TIER` 不一致 → 對照 `contracts/script/CarbonAttestations.sol` 修正 Python 那一邊。
- `NotKycVerified`：該位址沒進 `batchVerify` 的清單。
- `StalePrice`：當天的價格更新在開倉之後才送。

- [ ] **Step 4: 確認鏈狀態檔載得回來，而且歷史查得到**

Run:

```bash
anvil --port 8546 --load-state heroes/out/chain.json --silent &
PID=$!; sleep 2
TX=$(python3 -c "import json; print(next(e['tx'] for e in json.load(open('heroes/out/events.json'))['events'] if e['name'] == 'PositionOpened'))")
cast receipt "$TX" --rpc-url http://127.0.0.1:8546 | head -5
cast logs --from-block 0 --address "$(python3 -c "import json; print(json.load(open('heroes/out/addresses.json'))['PerpetualExchange'])")" --rpc-url http://127.0.0.1:8546 | grep -c transactionHash
kill -INT $PID
```

Expected: `cast receipt` 印出該交易的收據（`status 1`），`cast logs` 的筆數大於 0。

這一步是「交易證明可以從鏈上讀回」的前提。若載入後收據為空或事件為 0：**停下來回報**，不要繼續——那代表這個 Anvil 版本的狀態檔不含歷史區塊，展示時的鏈上讀回要改成由回放當場重跑，而這是要跟人確認的設計變更。

- [ ] **Step 5: 確認兩次回放的結果相同**

Run:

```bash
cp heroes/out/events.json /tmp/events_first.json
scripts/heroes-replay.sh heroes/tests/fixtures/schedule_smoke.json
python3 -c "
import json
a, b = (json.load(open(p)) for p in ('/tmp/events_first.json', 'heroes/out/events.json'))
assert a['traders'] == b['traders'], 'final equity differs between runs'
assert [(e['name'], e['tx']) for e in a['events']] == [(e['name'], e['tx']) for e in b['events']], 'events differ'
print('identical:', len(a['events']), 'events')"
```

Expected: `identical: N events`

- [ ] **Step 6: Commit**

```bash
git add agent/heroes/replay.ts scripts/heroes-replay.sh
git commit -m "feat(heroes): 本機鏈回放與事件匯出（#309）"
```

---

### Task A7: 績效分析與整條管線的對帳

**Files:**
- Create: `heroes/herolab/analytics.py`, `heroes/build_analytics.py`, `heroes/check_pipeline.py`
- Test: `heroes/tests/test_analytics.py`
- Create（產出，進版控）: `frontend/public/data/heroes/index.json`, `frontend/public/data/heroes/<address>.json`

**Interfaces:**
- Consumes: `events.json`（Task A6）、`load_prices`、`esg_composite`（Task A1）
- Produces: 績效資料（介面三），畫面線 Task B3 讀它。

`frontend/public/data/heroes/index.json`：

```jsonc
{
  "schemaVersion": 1, "chainId": 31337,
  "range": { "from": "2024-10-01", "to": "2026-10-09" },
  "traders": [{
    "address": "0x…", "name": "Whale Alpha", "rule": "buy_hold",
    "totalReturnPct": 12.34, "maxDrawdownPct": 8.9, "sharpe": 1.21,
    "winRatePct": 62.5, "closedTrades": 8, "esgScore": 49,
    "window7d":  { "pnlUsd": 0, "marginUsd": 0, "volumeUsd": 0, "wins": 0, "trades": 0 },
    "window30d": { "pnlUsd": 0, "marginUsd": 0, "volumeUsd": 0, "wins": 0, "trades": 0 },
    "sparkline": [10000, 10012.5]
  }]
}
```

`frontend/public/data/heroes/<address 小寫>.json`：上面那位交易者的所有欄位，另加

```jsonc
{
  "equityCurve": [{ "date": "2024-10-01", "equity": 9950.5 }],
  "monthlyReturns": [{ "month": "2024-10", "returnPct": 1.2 }],
  "exposure": [{ "asset": "sBTC", "weightPct": 50, "isLong": true, "leverage": 1 }],
  "esgCorrelation": 0.41,
  "avgHoldDays": 23.5,
  "strategies": [{ "date": "2024-10-01", "versionId": 0, "tx": "0x…",
                   "legs": [{ "asset": "sBTC", "weightBps": 5000, "isLong": true, "leverage": 1 }] }],
  "trades": [{ "positionId": 1, "asset": "sBTC", "isLong": true, "leverage": 1, "marginUsd": 4950.0,
               "openTx": "0x…", "openTime": 1727816412, "openPrice": 60830.11,
               "closeTx": "0x…", "closeTime": 1730408412, "closePrice": 70215.0,
               "pnlUsd": 612.3, "grossPnlUsd": 763.1, "liquidated": false }]
}
```

金額是美元浮點數、百分比是 0–100 的數字、時間是 Unix 秒。`winRatePct`、`esgScore`、`esgCorrelation` 算不出來時是 `null`。未平倉的部位，`closeTx`／`closeTime`／`closePrice`／`pnlUsd`／`grossPnlUsd` 是 `null`。視窗以 `range.to` 那天結束時往回算。`pnlUsd` 是淨額（平倉取回金額 − 保證金 − 開倉手續費），`grossPnlUsd` 是事件裡的價差損益。

- [ ] **Step 1: 寫失敗測試**

`heroes/tests/test_analytics.py`：

```python
import datetime as dt
from fractions import Fraction

import pandas as pd
import pytest

from herolab.analytics import (
    build_outputs, build_trades, equity_curve, max_drawdown_pct, monthly_returns, net_pnl, sharpe, window_stats,
)
from herolab.assets import ASSETS

E18 = 10**18
OWNER = "0x00000000000000000000000000000000000000AA"
D0 = 1727816400  # 2024-10-01 21:00 UTC
DAYS = [dt.date(2024, 10, 1) + dt.timedelta(days=i) for i in range(3)]


def wei(x):
    # 用分數算，避免 604.5 × 1e18 在浮點數裡差幾萬 wei
    return str(int(Fraction(str(x)) * E18))


def opened(pid, ts, asset="sETH", is_long=True, margin=500.0, leverage=1, entry=100.0, fee_bps=10, owner=OWNER):
    return {"name": "PositionOpened", "block": pid, "logIndex": 0, "timestamp": ts, "tx": f"0xopen{pid}",
            "args": {"positionId": str(pid), "owner": owner, "asset": asset, "isLong": is_long,
                     "entryPrice": wei(entry), "margin": wei(margin), "leverage": str(leverage),
                     "tradingFeeBps": str(fee_bps)}}


def closed(pid, ts, gross, close_amount, owner=OWNER):
    return {"name": "PositionClosed", "block": 1000 + pid, "logIndex": 0, "timestamp": ts, "tx": f"0xclose{pid}",
            "args": {"positionId": str(pid), "owner": owner, "pnl": wei(gross), "closeAmount": wei(close_amount)}}


def prices(eth):
    table = pd.DataFrame({a: [100.0] * len(DAYS) for a in ASSETS}, index=DAYS)
    table["sETH"] = eth
    return table


# 手算案例：本金 1000，第 0 天以 100 開 1 倍多單、保證金 500、手續費 10 bps（0.5）；
# 價格 100 → 110 → 121；第 2 天平倉，價差損益 105，再扣平倉手續費 0.5，取回 604.5。
EVENTS = [opened(1, D0), closed(1, D0 + 2 * 86400, gross=105.0, close_amount=604.5)]
PRICES = prices([100.0, 110.0, 121.0])


def test_trades_pair_an_open_with_its_close_and_ignore_other_owners():
    other = opened(2, D0, owner="0x00000000000000000000000000000000000000BB")
    trades = build_trades(EVENTS + [other], OWNER.lower())
    assert len(trades) == 1
    t = trades[0]
    assert (t.asset, t.margin, t.entry_price, t.open_fee) == ("sETH", 500.0, 100.0, 0.5)
    assert (t.close_amount, t.gross_pnl, t.liquidated) == (604.5, 105.0, False)
    assert net_pnl(t) == pytest.approx(104.0)


def test_equity_marks_open_positions_to_the_days_price_and_books_fees():
    equity = equity_curve(1000.0, build_trades(EVENTS, OWNER), PRICES, DAYS)
    assert list(equity.round(4)) == [999.5, 1049.5, 1104.0]


def test_a_short_gains_when_the_price_falls_and_leverage_multiplies_it():
    events = [opened(1, D0, is_long=False, leverage=2, fee_bps=0)]
    equity = equity_curve(1000.0, build_trades(events, OWNER), prices([100.0, 90.0, 80.0]), DAYS)
    # 第 1 天：500 × (1 + 2 × 0.10) = 600；第 2 天：500 × (1 + 2 × 0.20) = 700
    assert list(equity.round(4)) == [1000.0, 1100.0, 1200.0]


def test_a_position_cannot_be_worth_less_than_nothing():
    events = [opened(1, D0, leverage=5, fee_bps=0)]
    equity = equity_curve(1000.0, build_trades(events, OWNER), prices([100.0, 50.0, 50.0]), DAYS)
    assert equity.iloc[1] == 500.0  # 剩下沒投入的 500；部位歸零而不是 -750


def test_liquidation_is_flagged():
    events = EVENTS + [{"name": "PositionLiquidated", "block": 1001, "logIndex": 1, "timestamp": D0 + 2 * 86400,
                        "tx": "0xclose1", "args": {"positionId": "1", "owner": OWNER}}]
    assert build_trades(events, OWNER)[0].liquidated is True


def test_drawdown_sharpe_and_monthly_returns():
    equity = pd.Series([100.0, 120.0, 90.0, 108.0],
                       index=[dt.date(2024, 10, 30), dt.date(2024, 10, 31), dt.date(2024, 11, 1), dt.date(2024, 11, 2)])
    assert max_drawdown_pct(equity) == pytest.approx(25.0)  # 120 → 90
    assert sharpe(pd.Series([100.0, 100.0, 100.0], index=DAYS)) == 0.0
    assert sharpe(equity) != 0.0
    assert monthly_returns(equity, capital=100.0) == [
        {"month": "2024-10", "returnPct": 20.0}, {"month": "2024-11", "returnPct": -10.0},
    ]


def test_window_counts_only_what_happened_inside_it():
    trades = build_trades(EVENTS, OWNER)
    end = D0 + 3 * 86400
    assert window_stats(trades, end, days=7) == {"pnlUsd": 104.0, "marginUsd": 500.0, "volumeUsd": 500.0, "wins": 1, "trades": 1}
    assert window_stats(trades, end + 30 * 86400, days=7) == {"pnlUsd": 0.0, "marginUsd": 0.0, "volumeUsd": 0.0, "wins": 0, "trades": 0}


def test_outputs_follow_the_published_schema():
    doc = {
        "schemaVersion": 1, "chainId": 31337, "range": {"from": "2024-10-01", "to": "2024-10-03"},
        "traders": [{"index": 10, "name": "Solo", "rule": "buy_hold", "address": OWNER, "capitalUsd": 1000,
                     "finalEquity": wei(1104.0), "followerCount": 0}],
        "events": EVENTS + [{"name": "StrategyPublished", "block": 0, "logIndex": 0, "timestamp": D0, "tx": "0xpub",
                             "args": {"trader": OWNER, "versionId": "0", "legs": [
                                 {"asset": "sETH", "weightBps": 5000, "isLong": True, "leverage": 1},
                                 {"asset": "sBOND", "weightBps": 3000, "isLong": True, "leverage": 1},
                                 {"asset": "sICLN", "weightBps": 2000, "isLong": True, "leverage": 1}]}}],
    }
    index, details = build_outputs(doc, PRICES)
    assert (index["schemaVersion"], index["chainId"], index["range"]) == (1, 31337, doc["range"])
    summary = index["traders"][0]
    assert summary["address"] == OWNER and summary["totalReturnPct"] == 10.4
    assert summary["winRatePct"] == 100.0 and summary["closedTrades"] == 1
    # ESG：(53 × 5000 + 80 × 3000 + 81 × 2000) / 10000 = 66.7 → 67
    assert summary["esgScore"] == 67
    assert summary["sparkline"] == [999.5, 1049.5, 1104.0]
    detail = details[OWNER.lower()]
    assert detail["trades"][0]["pnlUsd"] == 104.0 and detail["trades"][0]["closePrice"] == 121.0
    assert detail["strategies"][0]["tx"] == "0xpub"
    assert detail["exposure"][0] == {"asset": "sETH", "weightPct": 50.0, "isLong": True, "leverage": 1}
    assert [p["equity"] for p in detail["equityCurve"]] == [999.5, 1049.5, 1104.0]
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `pytest tests/test_analytics.py -v`
Expected: FAIL，`ModuleNotFoundError: No module named 'herolab.analytics'`

- [ ] **Step 3: 實作分析**

`heroes/herolab/analytics.py`：

```python
"""鏈上事件 → 每位交易者的績效資料。

一律從事件算，不從排程算：每個數字都要追溯得到一筆鏈上交易。
淨值在部位未平倉期間只反映價格變動；借款費與資金費率在平倉時才實現（併入取回金額）。
"""
from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from .assets import esg_composite

E18 = 10**18
DAY = 86_400
SCHEMA_VERSION = 1


@dataclass
class Trade:
    position_id: int
    asset: str
    is_long: bool
    leverage: int
    margin: float
    entry_price: float
    open_ts: int
    open_tx: str
    open_fee: float
    close_ts: int | None = None
    close_tx: str | None = None
    close_amount: float | None = None
    gross_pnl: float | None = None
    liquidated: bool = False


def _usd(wei: str) -> float:
    return int(wei) / E18


def _date(ts: int) -> dt.date:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).date()


def build_trades(events: list[dict], owner: str) -> list[Trade]:
    owner = owner.lower()
    trades: dict[str, Trade] = {}
    for e in events:
        a = e["args"]
        if e["name"] == "PositionOpened" and a["owner"].lower() == owner:
            margin, leverage = _usd(a["margin"]), int(a["leverage"])
            trades[a["positionId"]] = Trade(
                position_id=int(a["positionId"]), asset=a["asset"], is_long=bool(a["isLong"]), leverage=leverage,
                margin=margin, entry_price=_usd(a["entryPrice"]), open_ts=e["timestamp"], open_tx=e["tx"],
                open_fee=margin * leverage * int(a["tradingFeeBps"]) / 10_000,
            )
        elif e["name"] == "PositionClosed" and a["positionId"] in trades:
            t = trades[a["positionId"]]
            t.close_ts, t.close_tx = e["timestamp"], e["tx"]
            t.close_amount, t.gross_pnl = _usd(a["closeAmount"]), _usd(a["pnl"])
        elif e["name"] == "PositionLiquidated" and a["positionId"] in trades:
            trades[a["positionId"]].liquidated = True
    return sorted(trades.values(), key=lambda t: t.position_id)


def net_pnl(t: Trade) -> float:
    """實際落袋：平倉取回 − 保證金 − 開倉手續費（平倉手續費、借款費、資金費率已含在取回金額裡）。"""
    return t.close_amount - t.margin - t.open_fee


def equity_curve(capital: float, trades: list[Trade], prices: pd.DataFrame, days: list[dt.date]) -> pd.Series:
    values = []
    for day in days:
        cash, marks = capital, 0.0
        for t in trades:
            if _date(t.open_ts) > day:
                continue
            cash -= t.margin + t.open_fee
            if t.close_ts is not None and _date(t.close_ts) <= day:
                cash += t.close_amount
            else:
                move = float(prices.at[day, t.asset]) / t.entry_price - 1.0
                marks += max(t.margin * (1.0 + t.leverage * (move if t.is_long else -move)), 0.0)
        values.append(cash + marks)
    return pd.Series(values, index=days)


def max_drawdown_pct(equity: pd.Series) -> float:
    peak = equity.cummax()
    return float(((peak - equity) / peak).max() * 100)


def sharpe(equity: pd.Series) -> float:
    """日報酬的平均 / 標準差，以 365 天年化（淨值每個日曆日都有一筆）。"""
    returns = equity.pct_change().dropna()
    deviation = returns.std()
    if len(returns) < 2 or not deviation or math.isnan(deviation):
        return 0.0
    return float(returns.mean() / deviation * math.sqrt(365))


def monthly_returns(equity: pd.Series, capital: float) -> list[dict]:
    out, previous = [], capital
    month_end = equity.groupby([d.strftime("%Y-%m") for d in equity.index]).last()
    for month, value in month_end.items():
        out.append({"month": month, "returnPct": round((value / previous - 1) * 100, 2)})
        previous = value
    return out


def window_stats(trades: list[Trade], end_ts: int, days: int) -> dict:
    since = end_ts - days * DAY
    closed = [t for t in trades if t.close_ts is not None and since < t.close_ts <= end_ts]
    opened = [t for t in trades if since < t.open_ts <= end_ts]
    return {
        "pnlUsd": round(sum(net_pnl(t) for t in closed), 2),
        "marginUsd": round(sum(t.margin for t in opened), 2),
        "volumeUsd": round(sum(t.margin * t.leverage for t in opened), 2),
        "wins": sum(1 for t in closed if net_pnl(t) > 0),
        "trades": len(closed),
    }


def _esg_score(legs: list[dict]) -> int | None:
    total = sum(l["weightBps"] for l in legs)
    if total == 0:
        return None
    # 與前端 MarketplacePage.getEsgComposite 相同：Math.round(加權平均)
    return int(sum(esg_composite(l["asset"]) * l["weightBps"] for l in legs) / total + 0.5)


def _correlation(equity: pd.Series, benchmark: pd.Series) -> float | None:
    value = equity.pct_change().corr(benchmark.pct_change())
    return None if value is None or math.isnan(value) else round(float(value), 3)


def _sparkline(equity: pd.Series, points: int = 60) -> list[float]:
    picks = np.linspace(0, len(equity) - 1, min(points, len(equity))).round().astype(int)
    return [round(float(equity.iloc[i]), 2) for i in picks]


def build_outputs(doc: dict, prices: pd.DataFrame) -> tuple[dict, dict[str, dict]]:
    start, end = (dt.date.fromisoformat(doc["range"][k]) for k in ("from", "to"))
    days = [d for d in prices.index if start <= d <= end]
    end_ts = int(dt.datetime(end.year, end.month, end.day, tzinfo=dt.timezone.utc).timestamp()) + DAY
    summaries, details = [], {}
    for trader in doc["traders"]:
        address, capital = trader["address"], float(trader["capitalUsd"])
        trades = build_trades(doc["events"], address)
        closed = [t for t in trades if t.close_ts is not None]
        equity = equity_curve(capital, trades, prices, days)
        strategies = [
            {"date": _date(e["timestamp"]).isoformat(), "versionId": int(e["args"]["versionId"]),
             "tx": e["tx"], "legs": e["args"]["legs"]}
            for e in doc["events"]
            if e["name"] == "StrategyPublished" and e["args"]["trader"].lower() == address.lower()
        ]
        latest = strategies[-1]["legs"] if strategies else []
        summary = {
            "address": address, "name": trader["name"], "rule": trader["rule"],
            "totalReturnPct": round((float(equity.iloc[-1]) / capital - 1) * 100, 2),
            "maxDrawdownPct": round(max_drawdown_pct(equity), 2),
            "sharpe": round(sharpe(equity), 2),
            "winRatePct": round(sum(1 for t in closed if net_pnl(t) > 0) / len(closed) * 100, 1) if closed else None,
            "closedTrades": len(closed),
            "esgScore": _esg_score(latest),
            "window7d": window_stats(trades, end_ts, 7),
            "window30d": window_stats(trades, end_ts, 30),
            "sparkline": _sparkline(equity),
        }
        summaries.append(summary)
        details[address.lower()] = {
            **summary,
            "equityCurve": [{"date": d.isoformat(), "equity": round(float(v), 2)} for d, v in equity.items()],
            "monthlyReturns": monthly_returns(equity, capital),
            "exposure": [{"asset": l["asset"], "weightPct": l["weightBps"] / 100, "isLong": l["isLong"],
                          "leverage": l["leverage"]} for l in latest],
            "esgCorrelation": _correlation(equity, prices.loc[days, "sESGU"]),
            "avgHoldDays": round(sum(t.close_ts - t.open_ts for t in closed) / len(closed) / DAY, 1) if closed else None,
            "strategies": strategies,
            "trades": [{
                "positionId": t.position_id, "asset": t.asset, "isLong": t.is_long, "leverage": t.leverage,
                "marginUsd": round(t.margin, 2),
                "openTx": t.open_tx, "openTime": t.open_ts, "openPrice": round(t.entry_price, 4),
                "closeTx": t.close_tx, "closeTime": t.close_ts,
                "closePrice": round(float(prices.at[_date(t.close_ts), t.asset]), 4) if t.close_ts else None,
                "pnlUsd": round(net_pnl(t), 2) if t.close_ts else None,
                "grossPnlUsd": round(t.gross_pnl, 2) if t.close_ts else None,
                "liquidated": t.liquidated,
            } for t in trades],
        }
    index = {"schemaVersion": SCHEMA_VERSION, "chainId": doc["chainId"], "range": doc["range"], "traders": summaries}
    return index, details
```

- [ ] **Step 4: 跑測試確認通過**

Run: `pytest tests/test_analytics.py -v`
Expected: 8 passed

- [ ] **Step 5: 寫產出 CLI**

`heroes/build_analytics.py`：

```python
"""events.json → frontend/public/data/heroes/。用法：python build_analytics.py [events.json]"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

from herolab.analytics import build_outputs
from herolab.prices import load_prices

HERE = Path(__file__).parent
OUT = HERE.parent / "frontend" / "public" / "data" / "heroes"


def main() -> None:
    events_path = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "out" / "events.json"
    doc = json.loads(events_path.read_text())
    start, end = (dt.date.fromisoformat(doc["range"][k]) for k in ("from", "to"))
    index, details = build_outputs(doc, load_prices(HERE / "prices", start, end))
    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("*.json"):  # 上一次回放留下、這次已不存在的交易者
        stale.unlink()
    (OUT / "index.json").write_text(json.dumps(index, indent=1) + "\n")
    for address, detail in details.items():
        (OUT / f"{address}.json").write_text(json.dumps(detail) + "\n")
    print(f"{OUT}: index.json + {len(details)} traders, {doc['range']['from']} .. {doc['range']['to']}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: 寫整條管線的對帳檢查**

`heroes/check_pipeline.py`：

```python
"""整條管線的對帳：回放的結果（events.json）和算出來的績效資料必須對得上。
  python check_pipeline.py [events.json]
任何一項不符就以非零結束。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
DATA = HERE.parent / "frontend" / "public" / "data" / "heroes"
E18 = 10**18
# 未平倉部位的淨值只算價格變動，不含尚未實現的借款費與資金費率，所以容許本金 2% 的差距
EQUITY_TOLERANCE = 0.02


def main() -> int:
    events_path = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "out" / "events.json"
    doc = json.loads(events_path.read_text())
    index = json.loads((DATA / "index.json").read_text())
    problems: list[str] = []

    if doc["stats"]["failed"] != 0:
        problems.append(f"{doc['stats']['failed']} of {doc['stats']['sent']} transactions failed: {doc['stats']['failures'][:3]}")
    if (index["chainId"], index["range"]) != (doc["chainId"], doc["range"]):
        problems.append("index.json is from a different replay (chainId or range differs)")

    summaries = {t["address"].lower(): t for t in index["traders"]}
    for trader in doc["traders"]:
        address = trader["address"].lower()
        detail = json.loads((DATA / f"{address}.json").read_text())
        closes_on_chain = sum(1 for e in doc["events"]
                              if e["name"] == "PositionClosed" and e["args"]["owner"].lower() == address)
        if summaries[address]["closedTrades"] != closes_on_chain:
            problems.append(f"{trader['name']}: {summaries[address]['closedTrades']} closed trades in the data, {closes_on_chain} on chain")
        on_chain = int(trader["finalEquity"]) / E18
        computed = detail["equityCurve"][-1]["equity"]
        if abs(computed - on_chain) > trader["capitalUsd"] * EQUITY_TOLERANCE:
            problems.append(f"{trader['name']}: final equity {computed:.2f} in the data, {on_chain:.2f} on chain")
        follows = sum(1 for e in doc["events"]
                      if e["name"] == "TraderFollowed" and e["args"]["trader"].lower() == address)
        if trader["followerCount"] != follows:
            problems.append(f"{trader['name']}: follower count {trader['followerCount']} on chain, {follows} follow events")

    for line in problems:
        print("MISMATCH:", line)
    if not problems:
        closes = sum(t["closedTrades"] for t in index["traders"])
        print(f"pipeline ok: {len(doc['traders'])} traders, {closes} closed trades, {doc['stats']['sent']} tx, 0 failed")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 7: 對小規模回放跑整條管線**

Run（repo 根目錄）:

```bash
scripts/heroes-replay.sh heroes/tests/fixtures/schedule_smoke.json
(cd heroes && . .venv/bin/activate && python build_analytics.py && python check_pipeline.py)
```

Expected: `pipeline ok: 3 traders, N closed trades, M tx, 0 failed`

若出現 `MISMATCH: … final equity …`：先確認差距的方向。算出來的比鏈上高，通常是槓桿部位的借款費（每小時計）還沒實現；把該交易者的未平倉部位、槓桿與持有天數列出來，確認差距約等於「保證金 ×（槓桿 − 1）× 每小時費率 × 小時數」。確認是這個原因且超過 2% 時，在 `equity_curve` 的未平倉估值裡扣掉應計借款費（費率由 `tradingFeeBps` 推不出來，需在 Task A6 的匯出多帶 `borrowFeeBpsPerHour`），補一個測試再修——不要直接放寬容許值。

- [ ] **Step 8: 提交小規模的真實績效資料，讓畫面線可以接**

```bash
git add heroes/herolab/analytics.py heroes/build_analytics.py heroes/check_pipeline.py heroes/tests/test_analytics.py frontend/public/data/heroes
git commit -m "feat(heroes): 績效分析、管線對帳與小規模績效資料（#309）"
```

提交後通知畫面線：`frontend/public/data/heroes/` 已有 3 位交易者 × 30 天的真實資料；他們自己跑 `scripts/heroes-replay.sh heroes/tests/fixtures/schedule_smoke.json` 就能得到位址相符的本機鏈。

---

### Task A8: 完整回放、展示用價格寫入與說明文件

**Files:**
- Create: `agent/heroes/priceTick.ts`, `heroes/README.md`
- Modify（重新產生，進版控）: `frontend/public/data/heroes/*.json`

**Interfaces:**
- Consumes: `fetchPrice`、`SOURCES`（`agent/keeper/feeds.ts` 既有匯出：`fetchPrice(symbol)` 回傳 `{ value: number | null, reason?: string, source: string }`）；`ORACLE_ABI`（Task A5）；`heroes/out/addresses.json`
- Produces: `npx tsx heroes/priceTick.ts`——畫面線 Task B7 的展示啟動腳本會呼叫它。

- [ ] **Step 1: 跑完整回放**

Run（repo 根目錄）:

```bash
(cd heroes && . .venv/bin/activate && python fetch_prices.py && python build_schedule.py)
time scripts/heroes-replay.sh
(cd heroes && . .venv/bin/activate && python build_analytics.py && python check_pipeline.py)
ls -la heroes/out/chain.json
```

Expected: 回放以 0 結束且失敗比例 ≤ 1%；`pipeline ok: 24 traders, …`；記下回放耗時與 `chain.json` 的大小。

`check_pipeline.py` 要求 0 筆失敗。完整回放若有少數失敗（≤ 1%），逐條看原因：屬於可以修的（見 Task A6 Step 3 的清單）就修掉重跑；屬於排程本身的邊界（例如交易者被清算到剩下的保證金開不出任何一檔）就在 `heroes/README.md` 的「已知行為」記下是哪幾位、哪一天，並把 `check_pipeline.py` 的那一項改成「失敗比例 ≤ 1%」——這個放寬要在提交訊息裡寫明原因。

- [ ] **Step 2: 看數字合不合理**

Run:

```bash
python3 -c "
import json
idx = json.load(open('frontend/public/data/heroes/index.json'))
print(idx['range'])
for t in sorted(idx['traders'], key=lambda t: -t['totalReturnPct']):
    print(f\"{t['name']:18} {t['rule']:14} ret {t['totalReturnPct']:8.1f}%  dd {t['maxDrawdownPct']:5.1f}%  sharpe {t['sharpe']:5.2f}  closes {t['closedTrades']:4}  esg {t['esgScore']}\")"
```

Expected: 24 列。逐項檢查並把結果貼進 PR 描述：
- 累積報酬有正有負，不是全部為負。若超過三分之二為負，把 `roster.py` 裡每 7／14 天調整的交易者改成 30 天（高碳資產單邊手續費 1%，頻繁換倉會被費用吃掉），重跑 Step 1。
- 買入持有類（`buy_hold`）的報酬大致等於其資產的加權漲跌幅減去約 1–2% 的進出費用。
- 使用槓桿的兩位（Crypto Degen、Low Carbon Lev）預期大幅虧損或被清算——槓桿借來的部分每小時收借款費，這是合約的費率造成的，不是 bug。

- [ ] **Step 3: 寫展示用的價格寫入程序**

`agent/heroes/priceTick.ts`：

```ts
// 展示用：定時把即時價格寫進本機鏈的預言機，報價才不會過期。
// 價格來源與 keeper 相同（CoinGecko／Yahoo）；抓不到的資產把目前的價格原樣重寫一次，只更新時間。
//   cd agent && npx tsx heroes/priceTick.ts [addresses.json]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { fetchPrice, SOURCES } from "../keeper/feeds.ts";
import { ORACLE_ABI } from "./abi.ts";

const RPC = process.env.HEROES_RPC_URL ?? "http://127.0.0.1:8545";
const EVERY_SEC = Number(process.env.HEROES_TICK_SEC ?? 60);
// Anvil 的預設助記詞；索引 0 是本機鏈預言機的 owner。公開的測試金鑰，只能用在本機鏈。
const MNEMONIC = "test test test test test test test test test test test junk";
const addressesPath = process.argv[2] ?? fileURLToPath(new URL("../../heroes/out/addresses.json", import.meta.url));

async function main(): Promise<void> {
  const provider = new ethers.JsonRpcProvider(RPC);
  const chainId = BigInt(await provider.send("eth_chainId", []));
  if (chainId !== 31337n) throw new Error(`refusing to write prices on chainId ${chainId}: local Anvil (31337) only`);
  const owner = ethers.HDNodeWallet.fromPhrase(MNEMONIC, undefined, "m/44'/60'/0'/0/0").connect(provider);
  const { MockOracle } = JSON.parse(readFileSync(addressesPath, "utf8"));
  const oracle = new ethers.Contract(MockOracle, ORACLE_ABI, owner);

  for (;;) {
    let live = 0;
    for (const symbol of Object.keys(SOURCES)) {
      const id = ethers.id(symbol);
      const quote = await fetchPrice(symbol);
      const [current] = (await oracle.getPrice(id)) as [bigint, bigint];
      const next = quote.value !== null && quote.value > 0 ? BigInt(Math.round(quote.value * 1e8)) : current;
      if (next !== current) live += 1;
      await (await oracle.updatePrice(id, next)).wait();
    }
    console.log(`${new Date().toISOString()} wrote ${Object.keys(SOURCES).length} prices (${live} changed)`);
    await new Promise((resolve) => setTimeout(resolve, EVERY_SEC * 1000));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: 對載入的鏈狀態試跑**

Run:

```bash
anvil --host 0.0.0.0 --load-state heroes/out/chain.json --silent &
PID=$!; sleep 2
# 把鏈的時間對到現在：載入的狀態停在回放的最後一天
cast rpc evm_setNextBlockTimestamp "$(date +%s)" --rpc-url http://127.0.0.1:8545
(cd agent && timeout 40 env HEROES_TICK_SEC=600 npx tsx heroes/priceTick.ts) || true
ORACLE=$(python3 -c "import json; print(json.load(open('heroes/out/addresses.json'))['MockOracle'])")
cast call "$ORACLE" "getPrice(bytes32)(uint256,uint256)" "$(cast keccak sBTC)" --rpc-url http://127.0.0.1:8545
date +%s
kill -INT $PID
```

Expected: 印出一行 `wrote 11 prices (N changed)`；`getPrice` 回傳的第二個值（更新時間）與 `date +%s` 相差在一兩分鐘內。

- [ ] **Step 5: 寫說明文件**

`heroes/README.md`：

````markdown
# heroes — 模擬交易者的資料管線

交易者排行榜上的「模擬交易者」從這裡來：真實歷史價格 → 策略排程 → 在本機 Anvil 上以真合約回放 →
由鏈上事件算出績效資料。spec 見 GitHub issue #309。

只在本機鏈（chainId 31337）運作。所有腳本連到別的鏈都會直接中止。

## 一次跑完

```bash
# 第一次：建立 Python 環境
cd heroes && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt && cd ..

# 每次要更新資料（展示前跑一次，把資料推到最新收盤日）
(cd heroes && . .venv/bin/activate && python fetch_prices.py && python build_schedule.py)
scripts/heroes-replay.sh
(cd heroes && . .venv/bin/activate && python build_analytics.py && python check_pipeline.py)
```

需要 PATH 上有 `anvil`／`forge`／`cast`。開啟 Smart App Control 的 Windows 機器請在 WSL 裡執行，
並先 `export PATH="$HOME/.foundry/bin:$PATH"`（見 `docs/agents/environment.md`）。

改完程式想快速驗證，用進版控的小規模排程（3 位交易者 × 30 天，幾秒跑完）：

```bash
scripts/heroes-replay.sh heroes/tests/fixtures/schedule_smoke.json
```

## 產出

| 檔案 | 進版控 | 用途 |
|---|---|---|
| `prices/<asset>.csv` | 是 | 真實歷史日線收盤價；回放的唯一價格來源 |
| `out/schedule.json` | 否 | 逐日價格、每位交易者的策略、虛擬跟隨者的動作 |
| `out/addresses.json` | 否 | 本機鏈上各合約的位址 |
| `out/events.json` | 否 | 回放後從鏈上匯出的事件 |
| `out/chain.json` | 否 | 鏈狀態；展示時用 `anvil --load-state` 載入 |
| `../frontend/public/data/heroes/*.json` | 是 | 前端讀取的績效資料 |

## 測試

```bash
cd heroes && . .venv/bin/activate && pytest          # 策略規則、排程、績效指標
cd agent && npm run test:heroes                      # 保證金拆分、清算判斷
python heroes/check_pipeline.py                      # 整條管線對帳（要先跑過回放與分析）
```

## 新增一條策略規則

在 `herolab/rules.py` 寫一個純函式 `(prices, params, seed) -> list[Rebalance]`，加進 `RULES`，
在 `tests/test_rules.py` 的 `CASES` 加一筆。輸出必須通過 `herolab.model.validate`（與鏈上發布規則相同：
至少 3 個資產、單一資產 ≤ 50%、槓桿 1／2／5 且不超過該資產碳分級的上限）。

逐筆策略（馬丁式加倉、網格）不能用這個介面表達：鏈上發布的是一籃子部位，不是下單指令。

## 已知行為

- 使用槓桿的交易者會大幅虧損：槓桿借來的部分每小時收借款費（最低級距 0.01%／時），這是合約的費率。
- 績效資料是鏈下檔案，由鏈上事件算出；每個數字都能用 `events.json` 重算。
- 回放結束到展示當天之間，模擬交易者沒有新的交易。展示前重跑一次可以縮短這段空窗。
````

- [ ] **Step 6: Commit**

```bash
git add agent/heroes/priceTick.ts heroes/README.md heroes/prices frontend/public/data/heroes
git commit -m "feat(heroes): 完整回放的績效資料、展示用價格寫入與說明文件（#309）"
```
