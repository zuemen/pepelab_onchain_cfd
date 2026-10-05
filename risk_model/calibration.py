"""歷史資料抓取、快取與參數校準。

資料來源（皆為公開、免金鑰的 API）：
- 加密資產：Binance 公開 klines（`data-api.binance.vision`，失敗再試 `api.binance.com`），1 小時 K 線收盤價。
- 股票：Yahoo Finance chart API（`query1.finance.yahoo.com/v8/finance/chart`），日 K 收盤價（已含除權息調整前的收盤）。
抓到的資料快取成 `risk_model/data/<代號>_<頻率>.csv`（檔頭以 `#` 註明來源與抓取日期）。
**原始價格不進版控**（資料提供者的使用條款未明確允許再散布），只 commit 校準後的參數
`risk_model/data/calibrated_params.json`（摘要統計量）。為了可重現：
  - **預設**一律讀 `calibrated_params.json`，不連網、不改參數檔；
  - 只有明確 `refresh=True`（`run_all.py --refresh-data`）才下載當天資料、重新校準並更新參數檔
    （同時加 `--offline` 時不下載，改用本機快取 CSV 重新校準）；
  - 參數檔不存在時，用本機快取 CSV 校準；連快取都沒有，才退回 `DEFAULTS` 的文獻／保守預設並註明。

校準方法：
1. GBM：σ̂ = 樣本標準差/√dt，μ̂ = 平均/dt + σ̂²/2。
2. 門檻法（threshold）跳躍偵測：以 bipower variation 估計「不受跳躍影響」的擴散變異數，
   |r − 中位數| > k·σ̂_c√dt（k = 4）的報酬判為跳躍；λ̂ = 跳躍數 / 樣本年數。
3. 最大概似（MLE）：以 Poisson 混合常態的完整密度，從門檻法的估計值出發做數值最佳化。
風險模擬的主參數用門檻法（理由見 JUMP_MIN_RATIO 的說明），MLE 當對照。
"""
from __future__ import annotations

import datetime as _dt
import json
import math
import time
import urllib.request
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import optimize

from .params import HOURS_PER_YEAR, TRADING_DAYS_PER_YEAR
from .processes import MertonParams, merton_logpdf

DATA_DIR = Path(__file__).resolve().parent / "data"
SNAPSHOT = DATA_DIR / "calibrated_params.json"

# MLE 的可辨識性限制：跳幅標準差至少是單期擴散的 JUMP_MIN_RATIO 倍；每期跳躍機率 λdt 不超過上限。
# 實測在小時（加密）與日（股票）資料上，λdt 一律頂到上限：資料偏好「很多小跳」，
# 這其實是波動群聚（隨機波動度）被混合常態吸收，不是真正的跳空。所以風險模擬的主參數
# 採門檻法（只把 4σ 以上的報酬當跳躍，直接對應「跳空」），MLE 結果列為厚尾對照情境。
JUMP_MIN_RATIO = 2.0
MAX_JUMP_PROB_PER_STEP = 0.25
UA = {"User-Agent": "Mozilla/5.0 (pepelab-risk-model; research)"}

# 每個資產：(來源, 代號, 頻率, 每年期數)
ASSETS = {
    "BTC": ("binance", "BTCUSDT", "1h", HOURS_PER_YEAR),
    "ETH": ("binance", "ETHUSDT", "1h", HOURS_PER_YEAR),
    "AAPL": ("yahoo", "AAPL", "1d", TRADING_DAYS_PER_YEAR),
    "TSLA": ("yahoo", "TSLA", "1d", TRADING_DAYS_PER_YEAR),
}

# 無網路且沒有快取時的預設值（年化）。加密資產取近年公開研究常見範圍的保守端
# （BTC 年化波動 50–70%、ETH 70–90%）；股票跳躍參數參考 Andersen, Benzoni & Lund (2002)
# 一類 SV-J 研究「每年數次、幅度數 %」的量級，個股取較大的跳幅。
DEFAULTS = {
    "BTC": MertonParams(sigma=0.45, lam=60.0, mu_j=0.0, sigma_j=0.03, name="BTC（預設）"),
    "ETH": MertonParams(sigma=0.60, lam=60.0, mu_j=0.0, sigma_j=0.04, name="ETH（預設）"),
    "AAPL": MertonParams(sigma=0.22, lam=4.0, mu_j=-0.01, sigma_j=0.05, name="AAPL（預設）"),
    "TSLA": MertonParams(sigma=0.50, lam=6.0, mu_j=0.0, sigma_j=0.09, name="TSLA（預設）"),
}


# ── 資料抓取 ───────────────────────────────────────────────────────────────────

def _get_json(url: str, timeout: float = 20.0):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310（公開 https API）
        return json.loads(r.read().decode("utf-8"))


def fetch_binance_klines(symbol: str, interval: str = "1h", days: int = 365) -> pd.DataFrame:
    """抓 Binance 公開 K 線（每次最多 1000 根，往前翻頁）。回傳欄位 time（UTC 秒）、close。"""
    hosts = ["https://data-api.binance.vision", "https://api.binance.com"]
    end_ms = int(time.time() // 3600 * 3600 * 1000)  # 對齊到整點，最後一根未收完的不要
    start_ms = end_ms - days * 86_400_000
    rows: list[tuple[int, float]] = []
    cursor = start_ms
    last_err = None
    while cursor < end_ms:
        data = None
        for h in hosts:
            url = (f"{h}/api/v3/klines?symbol={symbol}&interval={interval}"
                   f"&startTime={cursor}&endTime={end_ms - 1}&limit=1000")
            try:
                data = _get_json(url)
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
        if data is None:
            raise RuntimeError(f"Binance 抓取失敗：{last_err}")
        if not data:
            break
        for k in data:
            close_time_ms = int(k[6])
            if close_time_ms < end_ms:
                rows.append((int(k[0]) // 1000, float(k[4])))
        cursor = int(data[-1][0]) + 1
        if len(data) < 1000:
            break
    df = pd.DataFrame(rows, columns=["time", "close"]).drop_duplicates("time").sort_values("time")
    return df.reset_index(drop=True)


def fetch_yahoo_daily(symbol: str, range_: str = "5y") -> pd.DataFrame:
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?range={range_}&interval=1d"
    j = _get_json(url)
    res = j["chart"]["result"][0]
    ts = res["timestamp"]
    close = res["indicators"]["quote"][0]["close"]
    df = pd.DataFrame({"time": ts, "close": close}).dropna()
    df["time"] = df["time"].astype(int)
    return df.reset_index(drop=True)


def cache_path(asset: str) -> Path:
    src, sym, freq, _ = ASSETS[asset]
    return DATA_DIR / f"{sym}_{freq}.csv"


def write_cache(asset: str, df: pd.DataFrame, source_desc: str) -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    p = cache_path(asset)
    today = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%d")
    t0 = _dt.datetime.fromtimestamp(int(df["time"].iloc[0]), _dt.timezone.utc).strftime("%Y-%m-%d %H:%M")
    t1 = _dt.datetime.fromtimestamp(int(df["time"].iloc[-1]), _dt.timezone.utc).strftime("%Y-%m-%d %H:%M")
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(f"# 來源：{source_desc}\n")
        f.write(f"# 抓取日期（UTC）：{today}；資料區間 {t0} ~ {t1} UTC；共 {len(df)} 筆\n")
        f.write("# 欄位：time = K 線開盤時間（UNIX 秒，UTC），close = 收盤價\n")
        f.write("time,close\n")
        for t, c in zip(df["time"].to_numpy(), df["close"].to_numpy()):
            f.write(f"{int(t)},{c:.6g}\n")
    return p


def read_cache(asset: str) -> tuple[pd.DataFrame, list[str]] | None:
    p = cache_path(asset)
    if not p.exists():
        return None
    header = []
    with open(p, encoding="utf-8") as f:
        for line in f:
            if line.startswith("#"):
                header.append(line[1:].strip())
            else:
                break
    df = pd.read_csv(p, comment="#")
    return df, header


def load_prices(asset: str, refresh: bool = False, offline: bool = False) -> tuple[pd.DataFrame | None, str]:
    """回傳 (價格表, 來源說明)。只有 refresh=True 且未 offline 時才連網重抓並覆寫快取；否則只讀本機快取。"""
    src, sym, freq, _ = ASSETS[asset]
    if not refresh or offline:
        c = read_cache(asset)
        if c is not None:
            return c[0], "；".join(c[1][:2])
        return None, "沒有本機快取（未要求重抓，不連網）"
    try:
        if src == "binance":
            df = fetch_binance_klines(sym, freq, days=365)
            desc = f"Binance 公開 klines {sym} {freq}（data-api.binance.vision/api/v3/klines）"
        else:
            df = fetch_yahoo_daily(sym, "5y")
            desc = f"Yahoo Finance chart API {sym} 1d（query1.finance.yahoo.com/v8/finance/chart）"
        if len(df) < 200:
            raise RuntimeError(f"資料筆數太少：{len(df)}")
        write_cache(asset, df, desc)
        c = read_cache(asset)
        return c[0], "；".join(c[1][:2])
    except Exception as e:  # noqa: BLE001
        c = read_cache(asset)
        if c is not None:
            return c[0], "；".join(c[1][:2]) + f"（重抓失敗：{e}）"
        return None, f"抓取失敗（{e}）：使用內建預設參數"


# ── 估計 ───────────────────────────────────────────────────────────────────────

@dataclass
class CalibrationResult:
    asset: str
    source: str
    n_obs: int
    years: float
    dt: float
    gbm_sigma: float
    gbm_mu: float
    thr_sigma: float
    thr_lam: float
    thr_mu_j: float
    thr_sigma_j: float
    thr_n_jumps: int
    mle_sigma: float
    mle_lam: float
    mle_mu_j: float
    mle_sigma_j: float
    mle_nu: float
    loglik_gbm: float
    loglik_merton: float
    lr_stat: float
    used_defaults: bool = False
    from_snapshot: bool = False

    def merton(self, mu: float = 0.0) -> MertonParams:
        """風險評估的主參數（門檻法）。μ 預設 0：一年樣本的漂移標準誤約 σ/√1 ≈ 40–60%，不拿來做風險假設。"""
        return MertonParams(sigma=self.thr_sigma, mu=mu, lam=self.thr_lam, mu_j=self.thr_mu_j,
                            sigma_j=self.thr_sigma_j, name=self.asset)

    def merton_mle(self, mu: float = 0.0) -> MertonParams:
        """MLE（厚尾混合）對照參數。"""
        return MertonParams(sigma=self.mle_sigma, mu=mu, lam=self.mle_lam, mu_j=self.mle_mu_j,
                            sigma_j=self.mle_sigma_j, name=self.asset + "（MLE）")

    def to_dict(self) -> dict:
        return asdict(self)


def log_returns(df: pd.DataFrame) -> np.ndarray:
    c = df["close"].to_numpy(dtype=float)
    r = np.diff(np.log(c))
    return r[np.isfinite(r)]


def threshold_jumps(r: np.ndarray, dt: float, k: float = 4.0) -> dict:
    """門檻法：bipower variation 估擴散變異數，超過 k 倍標準差的報酬判為跳躍。"""
    bv = (math.pi / 2) * np.mean(np.abs(r[1:]) * np.abs(r[:-1]))  # 每期擴散變異數
    sd_c = math.sqrt(bv)
    med = np.median(r)
    flag = np.abs(r - med) > k * sd_c
    J = r[flag]
    n = len(r)
    years = n * dt
    lam = len(J) / years
    if len(J) >= 2:
        mu_j = float(np.mean(J))
        var_j = max(float(np.var(J, ddof=1)) - bv, (0.5 * k * sd_c) ** 2)
        sigma_j = math.sqrt(var_j)
    else:
        mu_j, sigma_j = 0.0, 2 * k * sd_c
    return {"sigma": sd_c / math.sqrt(dt), "lam": lam, "mu_j": mu_j, "sigma_j": sigma_j, "n_jumps": int(len(J))}


def merton_mle(r: np.ndarray, dt: float, init: dict) -> tuple[MertonParams, float]:
    """以門檻法估計為起點，最大化 Merton 完整概似。

    參數化：σ、λ、σ_J 取對數保證為正；為了讓「跳躍」和「擴散」可辨識，
    限制 σ_J ≥ JUMP_MIN_RATIO·σ√dt，且 λdt ≤ MAX_JUMP_PROB_PER_STEP（見模組常數說明）。
    """
    sd0 = init["sigma"] * math.sqrt(dt)

    def unpack(th):
        nu, ls, ll, mj, ls_extra = th
        sigma = math.exp(ls)
        lam = math.exp(ll)
        sigma_j = sigma * math.sqrt(dt) * (JUMP_MIN_RATIO + math.exp(ls_extra))
        return nu, sigma, lam, mj, sigma_j

    def nll(th):
        nu, sigma, lam, mj, sj = unpack(th)
        if lam * dt > MAX_JUMP_PROB_PER_STEP:
            return 1e12
        # 直接用 ν 參數化：MertonParams 的 nu 由 mu 推得，這裡反解 mu 使 nu 等於 th[0]
        p = MertonParams(sigma=sigma, mu=0.0, lam=lam, mu_j=mj, sigma_j=sj)
        p = MertonParams(sigma=sigma, mu=nu - p.nu, lam=lam, mu_j=mj, sigma_j=sj)
        v = -np.sum(merton_logpdf(r, dt, p, n_max=6))
        return v if np.isfinite(v) else 1e12

    ratio0 = max(init["sigma_j"] / max(sd0, 1e-12) - JUMP_MIN_RATIO, 0.05)
    th0 = np.array([np.mean(r) / dt, math.log(init["sigma"]), math.log(max(init["lam"], 1e-3)),
                    init["mu_j"], math.log(ratio0)])
    best = None
    for jitter in (0.0, 0.5, -0.5):
        start = th0.copy()
        start[2] += jitter
        res = optimize.minimize(nll, start, method="Nelder-Mead",
                                options={"maxiter": 4000, "xatol": 1e-6, "fatol": 1e-6})
        if best is None or res.fun < best.fun:
            best = res
    nu, sigma, lam, mj, sj = unpack(best.x)
    p = MertonParams(sigma=sigma, mu=0.0, lam=lam, mu_j=mj, sigma_j=sj)
    p = MertonParams(sigma=sigma, mu=nu - p.nu, lam=lam, mu_j=mj, sigma_j=sj)
    return p, -float(best.fun)


def _from_snapshot(asset: str) -> CalibrationResult | None:
    if not SNAPSHOT.exists():
        return None
    snap = json.loads(SNAPSHOT.read_text(encoding="utf-8")).get("assets", {})
    if asset not in snap:
        return None
    d = dict(snap[asset])
    d["source"] = f"{d.get('source', '')}（讀 calibrated_params.json）"
    d["from_snapshot"] = True
    d["used_defaults"] = False
    return CalibrationResult(**d)


def calibrate(asset: str, refresh: bool = False, offline: bool = False) -> CalibrationResult:
    """預設讀參數檔（不連網）；refresh=True 才用（重抓或本機快取的）原始價格重新校準。"""
    src, sym, freq, per_year = ASSETS[asset]
    dt = 1.0 / per_year
    if not refresh:
        snap = _from_snapshot(asset)
        if snap is not None:
            return snap
    df, desc = load_prices(asset, refresh=refresh, offline=offline)
    if df is None:
        d = DEFAULTS[asset]
        return CalibrationResult(asset, desc, 0, 0.0, dt, d.sigma, 0.0, d.sigma, d.lam, d.mu_j, d.sigma_j, 0,
                                 d.sigma, d.lam, d.mu_j, d.sigma_j, d.nu, float("nan"), float("nan"),
                                 float("nan"), used_defaults=True)
    r = log_returns(df)
    n = len(r)
    sig = float(np.std(r, ddof=1) / math.sqrt(dt))
    mu = float(np.mean(r) / dt + 0.5 * sig**2)
    thr = threshold_jumps(r, dt)
    p, ll_m = merton_mle(r, dt, thr)
    ll_g = float(np.sum(merton_logpdf(r, dt, MertonParams(sigma=sig, mu=mu))))
    return CalibrationResult(
        asset=asset, source=desc, n_obs=n, years=n * dt, dt=dt,
        gbm_sigma=sig, gbm_mu=mu,
        thr_sigma=thr["sigma"], thr_lam=thr["lam"], thr_mu_j=thr["mu_j"], thr_sigma_j=thr["sigma_j"],
        thr_n_jumps=thr["n_jumps"],
        mle_sigma=p.sigma, mle_lam=p.lam, mle_mu_j=p.mu_j, mle_sigma_j=p.sigma_j, mle_nu=p.nu,
        loglik_gbm=ll_g, loglik_merton=ll_m, lr_stat=2 * (ll_m - ll_g),
    )


def calibrate_all(refresh: bool = False, offline: bool = False) -> dict[str, CalibrationResult]:
    out = {a: calibrate(a, refresh=refresh, offline=offline) for a in ASSETS}
    # 只有明確要求重新校準時才更新已進版控的參數檔
    if refresh and all(not (c.used_defaults or c.from_snapshot) for c in out.values()):
        write_snapshot(out)
    return out


def write_snapshot(cals: dict[str, CalibrationResult]) -> None:
    """把校準後的參數（不含原始價格）寫進 calibrated_params.json。"""
    data = {"note": "由 risk_model/calibration.py 以原始價格校準後的參數；原始價格不進版控。",
            "assets": {a: c.to_dict() for a, c in cals.items()}}
    text = json.dumps(data, ensure_ascii=False, indent=1) + chr(10)
    if not SNAPSHOT.exists() or SNAPSHOT.read_text(encoding="utf-8") != text:
        SNAPSHOT.write_text(text, encoding="utf-8")
