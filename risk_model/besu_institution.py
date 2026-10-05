"""機構角度的風險：整本帳簿（多資產、相關性）的 VaR／ES 與歷史壓力情境（Phase 3）。

在 Besu 部署裡，交易所的對手方是**機構本身**（公鏈版是 exchange 合約裡的 USDC 池）。機構每日的損失：

    機構損失 = Σ_資產 OI 權重 × (交易者當日損益 + 交易者付不出來的部分)

- 交易者當日損益：所有倉位從今日開盤（S_now）到「被清算時的價格」或「期末價格」的損益，多空相抵；
- 付不出來的部分：壞帳＋期末未實現虧空（與 gap_risk 的 bad_debt_total 相同），由保險庫先付。
保險庫若由機構自己出資，兩者合計就是機構的損失；保險庫若有外部 LP，後者先由 LP 承擔（文件說明）。
手續費、借貸費、清算罰金收入不計（保守）。

市場資料：
- 相關係數由日報酬估計（Binance 1d：BTCUSDT、ETHUSDT；Yahoo 1d：AAPL、TSLA）；
- 壓力情境的衝擊幅度由同一批日資料在指定日期區間計算（收盤對收盤、區間最低價對前收、開盤跳空）。
原始價格不進版控（資料條款未明確允許再散布），只把**相關係數矩陣與衝擊幅度**寫進
`risk_model/data/besu_market_stats.json`。預設讀這個檔，只有 `run_besu.py --refresh-market` 才連網重算。
"""
from __future__ import annotations

import datetime as _dt
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import besu as bz
from .calibration import _get_json
from .gap_risk import make_book, var_es
from .processes import MertonParams

DATA_DIR = Path(__file__).resolve().parent / "data"
MARKET_STATS = DATA_DIR / "besu_market_stats.json"
ASSETS = ("BTC", "ETH", "AAPL", "TSLA")
CRYPTO = ("BTC", "ETH")

# 歷史壓力情境：日期區間（UTC 日期，含頭尾）與說明。衝擊幅度由資料計算，不手填。
# base：基準收盤日；window：之後的區間（區間最低價、區間最後收盤）。
STRESS_EVENTS = [
    {"id": "S1", "name": "2020-03-12 新冠崩跌（加密「黑色星期四」）", "base": "2020-03-11",
     "crypto_window": ("2020-03-12", "2020-03-13"), "equity_window": ("2020-03-12", "2020-03-12"),
     "hours": 36.0, "kind": "macro"},
    {"id": "S2", "name": "2022-05 Terra／LUNA 崩盤", "base": "2022-05-04",
     "crypto_window": ("2022-05-05", "2022-05-12"), "equity_window": ("2022-05-05", "2022-05-12"),
     "hours": 192.0, "kind": "macro"},
    {"id": "S3", "name": "2022-11 FTX 倒閉", "base": "2022-11-07",
     "crypto_window": ("2022-11-08", "2022-11-09"), "equity_window": ("2022-11-08", "2022-11-09"),
     "hours": 48.0, "kind": "macro"},
    {"id": "S4", "name": "AAPL 2019-01-03 營收指引下修（隔夜跳空）", "asset": "AAPL", "date": "2019-01-03",
     "kind": "gap"},
    {"id": "S5", "name": "AAPL 2024-05-03 財報（隔夜跳空）", "asset": "AAPL", "date": "2024-05-03", "kind": "gap"},
    {"id": "S6", "name": "TSLA 2024-07-24 財報（隔夜跳空）", "asset": "TSLA", "date": "2024-07-24", "kind": "gap"},
    {"id": "S7", "name": "TSLA 2024-10-24 財報（隔夜跳空）", "asset": "TSLA", "date": "2024-10-24", "kind": "gap"},
]

# 機構帳簿的假設（可在 run_besu.py 以參數覆寫）
DEFAULT_OI_WEIGHTS = {"BTC": 0.35, "ETH": 0.30, "AAPL": 0.20, "TSLA": 0.15}


# ── 資料抓取（只有 --refresh-market 才執行） ───────────────────────────────────

def _ts(d: str) -> int:
    return int(_dt.datetime.fromisoformat(d).replace(tzinfo=_dt.timezone.utc).timestamp())


def fetch_binance_daily(symbol: str, start: str, end: str) -> dict[str, tuple[float, float, float, float]]:
    """{UTC 日期: (open, high, low, close)}，日 K 線的日期是 UTC 00:00 開盤的那一天。"""
    out: dict[str, tuple[float, float, float, float]] = {}
    cur = _ts(start) * 1000
    end_ms = _ts(end) * 1000
    while cur < end_ms:
        data = _get_json(f"https://data-api.binance.vision/api/v3/klines?symbol={symbol}&interval=1d"
                         f"&startTime={cur}&endTime={end_ms}&limit=1000")
        if not data:
            break
        for k in data:
            d = _dt.datetime.fromtimestamp(k[0] / 1000, _dt.timezone.utc).date().isoformat()
            out[d] = (float(k[1]), float(k[2]), float(k[3]), float(k[4]))
        cur = int(data[-1][0]) + 86_400_000
        if len(data) < 1000:
            break
    return out


def fetch_yahoo_daily_ohlc(symbol: str, start: str, end: str) -> dict[str, tuple[float, float, float, float]]:
    j = _get_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1={_ts(start)}"
                  f"&period2={_ts(end)}&interval=1d")
    res = j["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    out = {}
    for t, o, h, lo, c in zip(res["timestamp"], q["open"], q["high"], q["low"], q["close"]):
        if None in (o, h, lo, c):
            continue
        out[_dt.datetime.fromtimestamp(t, _dt.timezone.utc).date().isoformat()] = (float(o), float(h), float(lo), float(c))
    return out


def _window(series: dict, a: str, b: str):
    return [series[d] for d in sorted(series) if a <= d <= b]


def compute_market_stats(start: str = "2019-01-01", end: str | None = None, corr_years: float = 5.0) -> dict:
    """抓日資料，算相關係數矩陣與壓力情境的衝擊幅度（只回傳摘要統計量）。"""
    end = end or _dt.date.today().isoformat()
    raw = {"BTC": fetch_binance_daily("BTCUSDT", start, end), "ETH": fetch_binance_daily("ETHUSDT", start, end),
           "AAPL": fetch_yahoo_daily_ohlc("AAPL", start, end), "TSLA": fetch_yahoo_daily_ohlc("TSLA", start, end)}
    # 相關係數：以股票交易日為準，加密取同一 UTC 日期的日 K 收盤（UTC 24:00，比美股收盤晚約 4 小時）
    corr_start = (_dt.date.fromisoformat(end) - _dt.timedelta(days=int(365.25 * corr_years))).isoformat()
    days = [d for d in sorted(raw["AAPL"]) if d >= corr_start and d in raw["TSLA"] and d in raw["BTC"]
            and d in raw["ETH"]]
    px = np.array([[raw[a][d][3] for a in ASSETS] for d in days])
    r = np.diff(np.log(px), axis=0)
    pearson = np.corrcoef(r.T)
    z = (r - np.median(r, axis=0)) / (1.4826 * np.median(np.abs(r - np.median(r, axis=0)), axis=0))
    keep = (np.abs(z) < 4).all(axis=1)
    robust = np.corrcoef(r[keep].T)

    events = []
    for ev in STRESS_EVENTS:
        e = {k: v for k, v in ev.items()}
        shocks = {}
        if ev["kind"] == "macro":
            for a in ASSETS:
                s = raw[a]
                base_c = s[ev["base"]][3]
                w = ev["crypto_window"] if a in CRYPTO else ev["equity_window"]
                rows = _window(s, *w)
                shocks[a] = {"close_to_close": rows[-1][3] / base_c - 1.0,
                             "trough": min(x[2] for x in rows) / base_c - 1.0,
                             "first_open_gap": rows[0][0] / base_c - 1.0 if a not in CRYPTO else 0.0}
        else:
            s = raw[ev["asset"]]
            ds = sorted(s)
            i = ds.index(ev["date"])
            prev_c = s[ds[i - 1]][3]
            o, _, lo, c = s[ev["date"]]
            shocks[ev["asset"]] = {"close_to_close": c / prev_c - 1.0, "trough": lo / prev_c - 1.0,
                                   "first_open_gap": o / prev_c - 1.0}
        e["shocks"] = shocks
        events.append(e)
    return {"note": "risk_model/besu_institution.py 由公開日資料計算的摘要統計量；原始價格不進版控。",
            "fetched_utc": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d"),
            "sources": {"BTC": "Binance 公開 klines BTCUSDT 1d（data-api.binance.vision）",
                        "ETH": "Binance 公開 klines ETHUSDT 1d（data-api.binance.vision）",
                        "AAPL": "Yahoo Finance chart API AAPL 1d（query1.finance.yahoo.com）",
                        "TSLA": "Yahoo Finance chart API TSLA 1d（query1.finance.yahoo.com）"},
            "correlation": {"assets": list(ASSETS), "period": [days[0], days[-1]], "n_returns": int(r.shape[0]),
                            "n_robust": int(keep.sum()),
                            "method": "股票交易日對齊；加密取同一 UTC 日期的日 K 收盤；robust＝剔除任一資產 |MAD z| ≥ 4 的日子",
                            "pearson": np.round(pearson, 4).tolist(), "robust": np.round(robust, 4).tolist()},
            "stress": events}


def load_market_stats(refresh: bool = False) -> dict:
    if refresh or not MARKET_STATS.exists():
        stats = compute_market_stats()
        MARKET_STATS.write_text(json.dumps(stats, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        return stats
    return json.loads(MARKET_STATS.read_text(encoding="utf-8"))


# ── 聯合模擬 ───────────────────────────────────────────────────────────────────

@dataclass
class AssetBook:
    """機構帳簿中的一個資產：價格過程、一個模擬日的長度、帳簿參數。"""

    name: str
    proc: MertonParams
    day_hours: float
    year_days: float
    L: int
    m: float
    f: float
    r: float
    oi_weight: float


def _nearest_psd(c: np.ndarray) -> np.ndarray:
    w, v = np.linalg.eigh((c + c.T) / 2)
    w = np.maximum(w, 1e-8)
    a = v @ np.diag(w) @ v.T
    d = np.sqrt(np.diag(a))
    return a / np.outer(d, d)


def joint_increments(books: list[AssetBook], corr: np.ndarray, K: int, n: int, rng: np.random.Generator,
                     common_crash: bool = True):
    """K 格的聯合對數價格增量，回傳 list[(n, K)]（與 books 同順序）。

    - 擴散：每格的標準常態以相關係數矩陣的 Cholesky 因子相乘。股票的一格是「交易日的 1/K」、
      加密是「日曆日的 1/K」，所以兩者以「一日之中的同一比例時點」對齊，日報酬的相關係數與 corr 一致
      （假設：盤中的時序對齊方式不影響日的結果）。
    - 一般跳躍：各資產獨立（稀疏抽樣，同 besu.merton_grid）。
    - 加密崩盤成分：common_crash=True 時 BTC 與 ETH **同時**發生、跳幅用同一個標準常態（完全相關），
      發生率取兩者崩盤強度的最大值（壓力假設，文件說明）。
    """
    A = len(books)
    Lc = np.linalg.cholesky(_nearest_psd(corr))
    Z = rng.standard_normal((n, K, A)) @ Lc.T
    out = []
    for a, b in enumerate(books):
        dt = 1.0 / b.year_days / K
        p = b.proc
        inc = p.nu * dt + p.sigma * math.sqrt(dt) * Z[:, :, a]
        if p.lam > 0:
            N = rng.poisson(p.lam * K * dt, size=n)
            tot = int(N.sum())
            if tot:
                np.add.at(inc, (np.repeat(np.arange(n), N), rng.integers(0, K, tot)),
                          p.mu_j + p.sigma_j * rng.standard_normal(tot))
        out.append(inc)
    del Z
    crash = [i for i, b in enumerate(books) if b.proc.crash_lam > 0]
    if crash:
        if common_crash:
            lam = max(books[i].proc.crash_lam for i in crash)
            dt = 1.0 / books[crash[0]].year_days / K
            N = rng.poisson(lam * K * dt, size=n)
            tot = int(N.sum())
            if tot:
                rows = np.repeat(np.arange(n), N)
                cols = rng.integers(0, K, tot)
                zc = rng.standard_normal(tot)
                for i in crash:
                    p = books[i].proc
                    np.add.at(out[i], (rows, cols), p.crash_mu + p.crash_sigma * zc)
        else:
            for i in crash:
                p = books[i].proc
                dt = 1.0 / books[i].year_days / K
                N = rng.poisson(p.crash_lam * K * dt, size=n)
                tot = int(N.sum())
                if tot:
                    np.add.at(out[i], (np.repeat(np.arange(n), N), rng.integers(0, K, tot)),
                              p.crash_mu + p.crash_sigma * rng.standard_normal(tot))
    return out


def simulate_institution(books: list[AssetBook], corr: np.ndarray, scen: bz.BesuScenario, n_days: int,
                         rng: np.random.Generator, *, K: int = 1440, skew: float = 0.0, n_pos: int = 60,
                         chunk: int = 500, common_crash: bool = True) -> dict:
    """機構每日損失的聯合模擬（每單位「全部資產 OI 合計」）。

    skew：每個資產的正規化 OI 失衡 X = (OI_L − OI_S)/(OI_L + OI_S)（多方擁擠為正）。
    推價格點 = K 格（預設 1 分鐘）；keeper 延遲、停擺、maxPriceAge 依 scen（Δ 取格點與 scen.delta_s 的較大者，
    由 Phase 3 §1 的收斂結果，1 分鐘以下的差異在抽樣誤差內）。
    回傳 dict：每個資產的 trader_pnl、bad_debt_total（已乘 OI 權重）與合計 loss。
    """
    long_frac = (1.0 + skew) / 2.0
    comp = {b.name: {"trader": [], "bad": []} for b in books}
    done = 0
    while done < n_days:
        n = min(chunk, n_days - done)
        incs = joint_increments(books, corr, K, n, rng, common_crash)
        noise = bz.draw_noise(n, n_pos, rng)
        for b, inc in zip(books, incs):
            day_s = b.day_hours * 3600.0
            t_s = day_s / K * np.arange(1, K + 1)
            Y = np.cumsum(inc, axis=1)
            ow = bz.outage_windows(scen.oracle.rate_per_day, scen.oracle.median_min, scen.oracle.p99_min, day_s, day_s,
                                   noise.o_u_count, noise.o_u_start, noise.o_z_dur, scen.oracle.fixed_min)
            valid = bz.push_valid_mask(t_s, ow)
            kw = bz.outage_windows(scen.keeper.outage_per_day, scen.keeper.outage_median_min,
                                   scen.keeper.outage_p99_min, day_s, day_s, noise.k_u_count, noise.k_u_start,
                                   noise.k_z_dur)
            delays = bz.keeper_delays(scen.keeper, scen.block_s, noise.delay_z)
            book = make_book(b.proc, b.L, b.f, b.r, b.m, n_pos, rng, long_frac=long_frac, year_days=b.year_days)
            res = bz.evaluate_paths(book, t_s, Y, valid, delays, kw, max_price_age_s=max(scen.max_price_age_s, day_s / K),
                                    block_s=scen.block_s, horizon_s=day_s)
            comp[b.name]["trader"].append(b.oi_weight * res["trader_pnl"])
            comp[b.name]["bad"].append(b.oi_weight * res["bad_debt_total"])
        done += n
    out = {a: {k: np.concatenate(v) for k, v in d.items()} for a, d in comp.items()}
    loss = sum(d["trader"] + d["bad"] for d in out.values())
    return {"components": out, "loss": loss, "bad": sum(d["bad"] for d in out.values()),
            "directional": sum(d["trader"] for d in out.values())}


def risk_measures(loss: np.ndarray) -> dict:
    """VaR_99、ES_97.5、ES_99（1 日）與 10 日（由日樣本獨立抽 10 天加總，帳簿不變的假設）。"""
    v99, e99 = var_es(loss, 0.99)
    _, e975 = var_es(loss, 0.975)
    v999, e999 = var_es(loss, 0.999)
    return {"mean": float(loss.mean()), "var99": v99, "es975": e975, "es99": e99, "var999": v999, "es999": e999}


def ten_day(loss: np.ndarray, rng: np.random.Generator, n: int = 200_000) -> dict:
    idx = rng.integers(0, loss.size, (n, 10))
    tot = loss[idx].sum(axis=1)
    v99, e99 = var_es(tot, 0.99)
    _, e975 = var_es(tot, 0.975)
    return {"var99_10d": v99, "es975_10d": e975, "es99_10d": e99}


def component_es(sim: dict, q: float = 0.975) -> dict:
    """Euler 分配：各資產（方向性、壞帳）對 ES_q 的貢獻 = E[該成分 | 合計損失 ≥ VaR_q]。"""
    loss = sim["loss"]
    var, _ = var_es(loss, q)
    tail = loss >= var
    out = {}
    for a, d in sim["components"].items():
        out[a] = {"directional": float(d["trader"][tail].mean()), "bad_debt": float(d["bad"][tail].mean())}
    return out


# ── 壓力情境 ───────────────────────────────────────────────────────────────────

def stress_book_loss(b: AssetBook, shock: float, mode: str, scen: bz.BesuScenario, rng: np.random.Generator, *,
                     hours: float = 24.0, skew: float = 0.0, n_books: int = 200, n_pos: int = 60,
                     K: int = 1440) -> dict:
    """單一資產在確定性衝擊下的帳簿損益（每單位該資產 OI，取 n_books 本隨機帳簿的平均與第 95 百分位）。

    mode="gap"：整個衝擊在第一次推價一次到位（跳空、或停擺期間累積的變動，壞帳的上限情境）；
    mode="path"：衝擊在 hours 小時內以對數價格線性完成（keeper 沿途清算，壞帳的下限情境）。
    shock 是簡單報酬（例：−0.39），換成對數 ln(1 + shock)。
    """
    y = math.log1p(shock)
    horizon_s = max(hours, 1e-9) * 3600.0 if mode == "path" else 3600.0
    t_s = horizon_s / K * np.arange(1, K + 1)
    if mode == "gap":
        Y = np.full((1, K), y)
    else:
        Y = (y * np.minimum(1.0, t_s / (hours * 3600.0)))[None, :]
    valid = np.ones_like(Y, dtype=bool)
    kw = np.full((1, bz.MAX_EVENTS, 2), np.inf)
    delays = np.full((1, n_pos, bz.MAX_ATTEMPTS), max(scen.block_s, scen.keeper.median_s))
    long_frac = (1.0 + skew) / 2.0
    trader, bad = [], []
    run = bz.running_extremes(Y, valid)
    for _ in range(n_books):
        book = make_book(b.proc, b.L, b.f, b.r, b.m, n_pos, rng, long_frac=long_frac, year_days=b.year_days)
        res = bz.evaluate_paths(book, t_s, Y, valid, delays, kw, max_price_age_s=max(scen.max_price_age_s, horizon_s / K),
                                block_s=scen.block_s, horizon_s=horizon_s, run=run)
        trader.append(float(res["trader_pnl"][0]))
        bad.append(float(res["bad_debt_total"][0]))
    trader, bad = np.array(trader), np.array(bad)
    tot = trader + bad
    return {"trader": float(trader.mean()), "bad": float(bad.mean()), "loss": float(tot.mean()),
            "loss_p95": float(np.quantile(tot, 0.95)), "bad_p95": float(np.quantile(bad, 0.95))}


def event_shocks(ev: dict, mode: str) -> dict[str, float]:
    """壓力情境對每個資產的衝擊（簡單報酬）。

    加密（24/7，沒有休市）：兩種模式都取區間最低價對基準收盤（最壞點）；差別只在「一次跳到」或「區間內線性走到」。
    股票：path 取區間最後收盤對基準收盤；gap 取開盤跳空（休市期間的變動，盤中無法清算）與收盤對收盤中
    幅度較大者（同方向，保守）。"""
    out = {}
    for a, s in ev["shocks"].items():
        if a in CRYPTO:
            out[a] = s["trough"]
        elif mode == "path":
            out[a] = s["close_to_close"]
        else:
            # 股票：跳空是開盤價；壓力取「開盤跳空」與「收盤對收盤」中幅度較大者（同方向）
            g, c = s["first_open_gap"], s["close_to_close"]
            out[a] = g if abs(g) >= abs(c) else c
    return out
