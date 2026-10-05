"""Besu（QBFT 許可鏈）特性下的風險模型重新校準（Phase 3）。

和公鏈版（gap_risk.py）的差別只在「檢查點怎麼產生」：

1. **最終性**：QBFT 區塊一產生就是最終的，不會重組。所以鏈上看到的價格與清算結果不會被「倒帶」，
   模型不需要重組情境（公鏈版也沒有模擬重組，這裡只是說明不必補）。
2. **Δ = max(出塊間隔, 推價間隔)**：推價交易只能落在區塊裡，推價間隔小於出塊間隔沒有意義。gas 免費，
   所以每個區塊都推價（Δ = 出塊間隔 2 秒）在成本上可行。
3. **Oracle 風險改為延遲與失效**：許可鏈上只有白名單帳戶能寫價（沒有公開的操縱面），主要風險是
   推價程式或來源停擺。停擺期間鏈上價格凍結：價格年齡超過 maxPriceAge 後開倉、平倉、清算都 revert；
   恢復推價時，價格一次跳到停擺期間累積的市價變動（跳空）。
4. **清算人改為許可制 keeper**：不再是「隨機到達的公開清算人」（公鏈版的 Poisson 到達、平均間隔 ρ），
   而是機構自營的 keeper，用「延遲分布＋停擺」描述服務水準（SLA）：
   - 延遲 D：從「鏈上價格已達清算價」到「清算交易被打包」的時間，對數常態，以中位數與 p99 指定；
   - 停擺：每日以 Poisson 發生，期間 keeper 不送任何交易，恢復後才處理。

模型的其他部分（代表性帳簿、清算價與破產價、壞帳與未實現虧空、重要性抽樣、保險庫打穿所需規模）
全部重用 Phase 1 的函式（gap_risk.make_book、liquidation、insurance、inverse.summarize）。

共同亂數（common random numbers）：simulate_besu_multi 讓多個「變體」（不同 Δ、SLA、停擺、槓桿與 MMR）
看到**同一批市價路徑與帳簿**、同一組延遲與停擺的標準化亂數，所以變體之間的差異只來自參數本身。
延遲與停擺時長都用「同一個標準常態 z、只改尺度」產生，提高 p99 時每一筆延遲都只會變長，
這是 keeper SLA 單調性測試的基礎。

記憶體：以 2 秒格點模擬一日（43,200 格）時，每批 n 條路徑約佔 n × 43,200 × 8 B；預設每批 32 條
（約 11 MB／陣列），峰值遠低於 500 MB。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy import stats

from .gap_risk import Book
from .liquidation import LONG
from .processes import MertonParams

Z99 = float(stats.norm.ppf(0.99))   # 2.326：對數常態的 p99 = 中位數 × exp(σ·Z99)
SECONDS_PER_HOUR = 3600.0


# ── 參數 ───────────────────────────────────────────────────────────────────────

def effective_delta_s(block_s: float, push_s: float) -> float:
    """檢查點間隔 Δ = max(出塊間隔, 推價間隔)（秒）。推價只能落在區塊裡。"""
    return max(float(block_s), float(push_s))


def lognormal_sigma(median: float, p99: float) -> float:
    """由中位數與 p99 反推對數常態的 σ：p99 = median·exp(σ·2.326)。p99 ≤ median 時 σ = 0（固定值）。"""
    if p99 <= median or median <= 0:
        return 0.0
    return math.log(p99 / median) / Z99


@dataclass(frozen=True)
class KeeperSLA:
    """許可制 keeper 的服務水準。

    median_s／p99_s：清算延遲 D 的中位數與 p99（秒）；D 至少一個區塊。
    outage_per_day：keeper 停擺事件的發生率（次/日）；停擺時長為對數常態（中位數、p99，分鐘）。
    """

    median_s: float = 2.0
    p99_s: float = 10.0
    outage_per_day: float = 0.0
    outage_median_min: float = 10.0
    outage_p99_min: float = 120.0
    label: str = ""


@dataclass(frozen=True)
class OracleOutage:
    """推價停擺。rate_per_day：每日發生率；時長對數常態（中位數、p99，分鐘）。

    fixed_min 不是 None 時改為「條件情境」：每個模擬日**恰好**發生一次、時長固定為 fixed_min 分鐘，
    開始時間在當日均勻分布（用來畫「壞帳 vs 停擺時長」）。
    """

    rate_per_day: float = 0.0
    median_min: float = 5.0
    p99_min: float = 60.0
    fixed_min: float | None = None


@dataclass(frozen=True)
class BesuScenario:
    """一組 Besu 基礎設施設定。push_s 必須是模擬格點 grid_s 的整數倍。"""

    name: str
    block_s: float = 2.0
    push_s: float = 2.0
    max_price_age_s: float = 60.0
    keeper: KeeperSLA = field(default_factory=KeeperSLA)
    oracle: OracleOutage = field(default_factory=OracleOutage)

    @property
    def delta_s(self) -> float:
        return effective_delta_s(self.block_s, self.push_s)


# 基準情境（假設值，docs/BESU_CALIBRATION.md §0.2 說明依據；全部可調）
BESU_BASELINE = BesuScenario(
    name="besu",
    block_s=2.0,
    push_s=2.0,
    max_price_age_s=60.0,
    keeper=KeeperSLA(median_s=2.0, p99_s=10.0, outage_per_day=0.01, outage_median_min=10.0, outage_p99_min=120.0,
                     label="SLA 目標：p99 10 秒、每年約 3.7 次停擺（中位 10 分）"),
    oracle=OracleOutage(rate_per_day=0.02, median_min=5.0, p99_min=60.0),
)
# 理想上限：每區塊推價、keeper 下一個區塊就清算、沒有任何停擺
BESU_IDEAL = BesuScenario(name="ideal", keeper=KeeperSLA(median_s=2.0, p99_s=2.0))


@dataclass
class Variant:
    """simulate_besu_multi 的一個變體：名稱、帳簿產生函式（book_fn(rng) → Book）、基礎設施情境。"""

    name: str
    book_fn: object
    scen: BesuScenario


@dataclass
class BesuResult:
    """與 gap_risk.GapResult 相同的欄位（可直接交給 inverse.summarize），另加 trader_pnl。

    trader_pnl：當日交易者的損益合計（多空、含已清算倉位到清算價為止），單位同 bad_debt。
    機構（對手方）的當日損失 = trader_pnl + bad_debt_total（交易者付不出來的部分）。
    """

    bad_debt: np.ndarray
    bad_debt_total: np.ndarray
    liq_equity: np.ndarray
    vault_income: np.ndarray
    liquidator_income: np.ndarray
    adl_capacity: np.ndarray
    n_liquidations: np.ndarray
    n_bad: np.ndarray
    weight: np.ndarray
    trader_pnl: np.ndarray


# ── 市價路徑（稀疏跳躍） ───────────────────────────────────────────────────────

def merton_grid(p: MertonParams, dt_y: float, n: int, K: int, rng: np.random.Generator,
                lam_scale: float = 1.0, crash_scale: float = 1.0):
    """等距格點上的對數價格增量 (n, K)，回傳 (inc, 每列一般跳躍數, 每列崩盤跳躍數)。

    與 processes.merton_increments 同分布：每格的跳躍數是 Poisson(λ dt)，等價於「每列總跳躍數
    ~ Poisson(λ K dt)、位置在 K 格中均勻」。格點很細（2 秒）時絕大多數格子沒有跳躍，用稀疏寫法
    只對有跳躍的格子加跳幅，省下逐格抽 Poisson 的時間與記憶體。
    """
    inc = p.nu * dt_y + p.sigma * math.sqrt(dt_y) * rng.standard_normal((n, K))
    counts = []
    for lam, mu, sig, scale in ((p.lam, p.mu_j, p.sigma_j, lam_scale),
                                (p.crash_lam, p.crash_mu, p.crash_sigma, crash_scale)):
        if lam <= 0:
            counts.append(np.zeros(n, dtype=np.int64))
            continue
        N = rng.poisson(lam * scale * K * dt_y, size=n)
        tot = int(N.sum())
        if tot:
            rows = np.repeat(np.arange(n), N)
            cols = rng.integers(0, K, tot)
            np.add.at(inc, (rows, cols), mu + sig * rng.standard_normal(tot))
        counts.append(N)
    return inc, counts[0], counts[1]


def is_log_weight(p: MertonParams, n_reg: np.ndarray, n_cr: np.ndarray, T_y: float,
                  lam_scale: float, crash_scale: float) -> np.ndarray:
    """重要性抽樣的對數概似比（與 gap_risk.simulate_gap 相同的公式）。"""
    logw = np.zeros(n_reg.shape[0])
    if p.lam > 0 and lam_scale != 1.0:
        logw += n_reg * math.log(1.0 / lam_scale) + p.lam * (lam_scale - 1.0) * T_y
    if p.crash_lam > 0 and crash_scale != 1.0:
        logw += n_cr * math.log(1.0 / crash_scale) + p.crash_lam * (crash_scale - 1.0) * T_y
    return logw


# ── 停擺與延遲 ─────────────────────────────────────────────────────────────────

MAX_EVENTS = 3      # 每個模擬日最多幾次停擺（發生率 ≤ 0.1/日時，第 4 次的機率 < 4×10⁻⁶）
MAX_ATTEMPTS = 6    # 每個倉位最多嘗試清算幾次（價格回升、價格過期都會讓一次嘗試落空）


@dataclass
class ChunkNoise:
    """一批路徑共用的標準化亂數（所有變體共用 → 共同亂數）。"""

    delay_z: np.ndarray       # (n, P, MAX_ATTEMPTS) 標準常態：keeper 延遲
    k_u_count: np.ndarray     # (n,) 均勻：keeper 停擺次數（Poisson 反函數）
    k_u_start: np.ndarray     # (n, MAX_EVENTS) 均勻：停擺開始時間
    k_z_dur: np.ndarray       # (n, MAX_EVENTS) 標準常態：停擺時長
    o_u_count: np.ndarray
    o_u_start: np.ndarray
    o_z_dur: np.ndarray


def draw_noise(n: int, n_pos: int, rng: np.random.Generator) -> ChunkNoise:
    return ChunkNoise(delay_z=rng.standard_normal((n, n_pos, MAX_ATTEMPTS)),
                      k_u_count=rng.random(n), k_u_start=rng.random((n, MAX_EVENTS)),
                      k_z_dur=rng.standard_normal((n, MAX_EVENTS)),
                      o_u_count=rng.random(n), o_u_start=rng.random((n, MAX_EVENTS)),
                      o_z_dur=rng.standard_normal((n, MAX_EVENTS)))


def _poisson_count(u: np.ndarray, mean: float) -> np.ndarray:
    """以反函數把均勻亂數轉成 Poisson 次數（同一個 u，發生率越高次數越多 → 共同亂數下單調）。"""
    if mean <= 0:
        return np.zeros(u.shape, dtype=int)
    return np.minimum(stats.poisson.ppf(u, mean).astype(int), MAX_EVENTS)


def outage_windows(rate_per_day: float, median_min: float, p99_min: float, horizon_s: float, day_s: float,
                   u_count: np.ndarray, u_start: np.ndarray, z_dur: np.ndarray,
                   fixed_min: float | None = None) -> np.ndarray:
    """停擺時間窗 (n, MAX_EVENTS, 2)：[開始, 結束)（秒）；沒有發生的事件填 +inf。

    day_s：一個「模擬日」有幾秒（加密 86,400、股票交易日 23,400），發生率以「每模擬日」計。
    """
    n = u_count.shape[0]
    win = np.full((n, MAX_EVENTS, 2), np.inf)
    if fixed_min is not None:
        dur = fixed_min * 60.0
        start = u_start[:, 0] * max(horizon_s - dur, 0.0)
        win[:, 0, 0] = start
        win[:, 0, 1] = start + dur
        return win
    cnt = _poisson_count(u_count, rate_per_day * horizon_s / day_s)
    sig = lognormal_sigma(median_min, p99_min)
    dur = median_min * 60.0 * np.exp(sig * z_dur)
    start = u_start * horizon_s
    on = np.arange(MAX_EVENTS)[None, :] < cnt[:, None]
    win[..., 0] = np.where(on, start, np.inf)
    win[..., 1] = np.where(on, start + dur, np.inf)
    return win


def keeper_delays(k: KeeperSLA, block_s: float, z: np.ndarray) -> np.ndarray:
    """清算延遲 D（秒）＝ max(一個區塊, 對數常態)。同一個 z、p99 越大 → 每一筆 D 都不會變短。"""
    sig = lognormal_sigma(k.median_s, k.p99_s)
    return np.maximum(block_s, k.median_s * np.exp(sig * z))


# ── 給定路徑的帳簿損益 ─────────────────────────────────────────────────────────

def push_valid_mask(t_s: np.ndarray, oracle_win: np.ndarray) -> np.ndarray:
    """推價停擺期間的推價不存在：valid[s, k] = t_k 不落在任何停擺窗內。"""
    valid = np.ones((oracle_win.shape[0], t_s.size), dtype=bool)
    for e in range(oracle_win.shape[1]):
        st = oracle_win[:, e, 0][:, None]
        en = oracle_win[:, e, 1][:, None]
        valid &= ~((t_s[None, :] > st) & (t_s[None, :] <= en))
    return valid


def running_extremes(Y: np.ndarray, valid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """鏈上可見價格（只在有效推價時點）的累積最小值與最大值，用來找第一次觸及清算價的時點。"""
    runmin = np.minimum.accumulate(np.where(valid, Y, np.inf), axis=1)
    runmax = np.maximum.accumulate(np.where(valid, Y, -np.inf), axis=1)
    return runmin, runmax


def _shift_out_of_outage(te: float, win: np.ndarray, block_s: float) -> float:
    """執行時點落在 keeper 停擺窗內時，延到停擺結束後的下一個區塊。窗可能相鄰，所以重複檢查。"""
    for _ in range(MAX_EVENTS + 1):
        hit = (win[:, 0] <= te) & (te < win[:, 1])
        if not hit.any():
            return te
        te = float(win[hit, 1].max()) + block_s
    return te


def _liquidate_one(tv: np.ndarray, yv: np.ndarray, theta: float, is_long: bool, delays: np.ndarray,
                   kwin: np.ndarray, max_age_s: float, block_s: float, horizon_s: float) -> int:
    """單一倉位：回傳被清算時所用推價在 (tv, yv) 中的索引；當日沒有被清算回傳 −1。

    流程（每次嘗試用下一筆延遲）：
      1. 第一次鏈上價格達清算價的推價 c；keeper 在 t_c + D 送出清算（停擺時延到恢復後）；
      2. 執行當下鏈上價格＝最後一次推價 j 的價格；價格年齡 > maxPriceAge → revert，
         等下一次「已達清算價」的推價再試；
      3. 價格 j 仍達清算價 → 以 yv[j] 清算；已回升 → revert，等下一次觸及。
    """
    cross = np.flatnonzero(yv <= theta) if is_long else np.flatnonzero(yv >= theta)
    if cross.size == 0:
        return -1
    c = int(cross[0])
    for a in range(MAX_ATTEMPTS):
        te = _shift_out_of_outage(float(tv[c]) + float(delays[a]), kwin, block_s)
        if te > horizon_s:
            return -1
        j = int(np.searchsorted(tv, te, side="right")) - 1
        if te - tv[j] > max_age_s:
            nxt = int(np.searchsorted(cross, j + 1))
        elif (yv[j] <= theta) if is_long else (yv[j] >= theta):
            return j
        else:
            nxt = int(np.searchsorted(cross, j + 1))
        if nxt >= cross.size:
            return -1
        c = int(cross[nxt])
    return -1


def evaluate_paths(book: Book, t_s: np.ndarray, Y: np.ndarray, valid: np.ndarray, delays: np.ndarray,
                   keeper_win: np.ndarray, *, max_price_age_s: float, block_s: float, horizon_s: float,
                   vault_share: float = 0.20, liquidator_share: float = 0.05, adl_scan_fraction: float = 0.25,
                   run: tuple[np.ndarray, np.ndarray] | None = None) -> dict:
    """給定推價時點 t_s (K,)、該時點的對數價格 Y (n, K)＝ln(P/S_now)、有效推價遮罩 valid、
    keeper 延遲 delays (n, P, MAX_ATTEMPTS) 與 keeper 停擺窗，計算每個情境的帳簿損益（每單位 OI）。

    損失的定義與 gap_risk 相同：清算當下權益為負的部分是壞帳（bad_debt）；期末仍未清算、
    以最後一次有效推價計算權益為負的部分計入未實現虧空（bad_debt_total 含兩者）。
    """
    n, K = Y.shape
    longs = book.side == LONG
    theta = book.theta
    runmin, runmax = run if run is not None else running_extremes(Y, valid)
    any_valid = valid.any(axis=1)
    last_idx = K - 1 - np.argmax(valid[:, ::-1], axis=1)
    y_last = np.where(any_valid, Y[np.arange(n), last_idx], 0.0)

    sgn = np.where(longs, 1.0, -1.0)
    ex = np.exp(-book.x)

    def equity(y, idx=slice(None)):
        e = np.exp(y - book.x[idx])
        return np.where(longs[idx], e - book.bk[idx], book.bk[idx] - e)

    # 先以「沒有任何清算」計算期末未實現虧空與交易者損益（向量化），有清算的情境再逐一覆寫
    eq_end = np.where(longs[None, :], np.exp(y_last[:, None] - book.x[None, :]) - book.bk[None, :],
                      book.bk[None, :] - np.exp(y_last[:, None] - book.x[None, :]))
    bad_tot = (np.maximum(-eq_end, 0) * book.w[None, :]).sum(axis=1)
    pnl = (sgn * book.w * ex)[None, :] * np.expm1(y_last)[:, None]
    trader = pnl.sum(axis=1)

    out = {k: np.zeros(n) for k in ("bad_debt", "liq_equity", "vault_income", "liquidator_income",
                                     "adl_capacity", "n_liquidations", "n_bad")}
    th_l = theta[longs]
    th_s = theta[~longs]
    max_th_l = th_l.max() if th_l.size else -np.inf
    min_th_s = th_s.min() if th_s.size else np.inf
    active = (runmin[:, -1] <= max_th_l) | (runmax[:, -1] >= min_th_s)
    for s in np.flatnonzero(active):
        vi = np.flatnonzero(valid[s])
        tv = t_s[vi]
        yv = Y[s, vi]
        cand = np.flatnonzero(np.where(longs, runmin[s, -1] <= theta, runmax[s, -1] >= theta))
        hit = np.zeros(book.side.size, dtype=bool)
        y_exit = np.full(book.side.size, y_last[s])
        for i in cand:
            j = _liquidate_one(tv, yv, float(theta[i]), bool(longs[i]), delays[s, i], keeper_win[s],
                               max_price_age_s, block_s, horizon_s)
            if j >= 0:
                hit[i] = True
                y_exit[i] = yv[j]
        if not hit.any():
            continue
        eq = equity(y_exit)
        cash = eq * book.w
        liq_cash = np.where(hit, cash, 0.0)
        pos = np.maximum(liq_cash, 0.0).sum()
        neg = np.maximum(-liq_cash, 0.0).sum()
        out["bad_debt"][s] = neg
        out["liq_equity"][s] = pos
        out["vault_income"][s] = vault_share * pos
        out["liquidator_income"][s] = liquidator_share * pos
        out["n_liquidations"][s] = hit.sum()
        out["n_bad"][s] = (liq_cash < 0).sum()
        bad_tot[s] = neg + (np.maximum(-cash, 0.0) * (~hit)).sum()
        trader[s] = (sgn * book.w * ex * np.expm1(y_exit)).sum()
        if neg > 0:
            # ADL 可吸收量（保守，與 gap_risk 相同）：最大一筆壞帳發生時，反方向、仍未平倉倉位的獲利 × 被掃到的比例
            worst = int(np.argmin(np.where(hit, liq_cash, np.inf)))
            y_ev = y_exit[worst]
            opp = (~hit) & (book.side != book.side[worst])
            prof = np.where(longs, np.exp(y_ev - book.x) - 1.0, 1.0 - np.exp(y_ev - book.x)) * book.w * opp
            out["adl_capacity"][s] = min(neg, adl_scan_fraction * np.maximum(prof, 0.0).sum())
    out["bad_debt_total"] = bad_tot
    out["trader_pnl"] = trader
    return out


# ── 多變體模擬（共同亂數） ─────────────────────────────────────────────────────

def simulate_besu_multi(p: MertonParams, variants: list[Variant], horizon_h: float, n_scen: int,
                        rng: np.random.Generator, *, grid_s: float = 2.0, day_hours: float = 24.0,
                        year_days: float = 365.0, n_pos: int = 60, vault_share: float = 0.20,
                        liquidator_share: float = 0.05, adl_scan_fraction: float = 0.25, chunk: int = 32,
                        is_jump: float = 1.0, is_crash: float = 1.0) -> dict[str, BesuResult]:
    """在 grid_s 秒的細格點上模擬市價，每個變體依自己的推價間隔取樣（push_s 必須是 grid_s 的整數倍）。

    每一批：一組市價路徑、一組延遲與停擺的標準化亂數、一個帳簿種子，所有變體共用。
    帳簿以同一個種子各自產生（不同 L、m 的帳簿有相同的開倉時間與開倉價亂數）。
    day_hours／year_days：一個模擬日的小時數與每年日數（加密 24／365、股票 6.5／252）。
    """
    horizon_s = horizon_h * SECONDS_PER_HOUR
    day_s = day_hours * SECONDS_PER_HOUR
    K = int(round(horizon_s / grid_s))
    dt_y = grid_s / SECONDS_PER_HOUR / day_hours / year_days
    t_full = grid_s * np.arange(1, K + 1)
    out = {v.name: {k: [] for k in BesuResult.__dataclass_fields__} for v in variants}
    done = 0
    while done < n_scen:
        n = min(chunk, n_scen - done)
        inc, n_reg, n_cr = merton_grid(p, dt_y, n, K, rng, is_jump, is_crash)
        Yf = np.cumsum(inc, axis=1)
        del inc
        weight = np.exp(is_log_weight(p, n_reg, n_cr, K * dt_y, is_jump, is_crash))
        noise = draw_noise(n, n_pos, rng)
        book_seed = int(rng.integers(0, 2**63 - 1))
        cache: dict[tuple, tuple] = {}
        for v in variants:
            sc = v.scen
            step = int(round(sc.delta_s / grid_s))
            if step < 1 or abs(step * grid_s - sc.delta_s) > 1e-9:
                raise ValueError(f"{v.name}：Δ = {sc.delta_s} 秒不是格點 {grid_s} 秒的整數倍")
            key = (step, sc.oracle)
            if key not in cache:
                t_s = t_full[step - 1::step]
                Y = Yf[:, step - 1::step]
                ow = outage_windows(sc.oracle.rate_per_day, sc.oracle.median_min, sc.oracle.p99_min, horizon_s,
                                    day_s, noise.o_u_count, noise.o_u_start, noise.o_z_dur, sc.oracle.fixed_min)
                valid = push_valid_mask(t_s, ow)
                cache[key] = (t_s, Y, valid, running_extremes(Y, valid))
            t_s, Y, valid, run = cache[key]
            kw = outage_windows(sc.keeper.outage_per_day, sc.keeper.outage_median_min, sc.keeper.outage_p99_min,
                                horizon_s, day_s, noise.k_u_count, noise.k_u_start, noise.k_z_dur)
            delays = keeper_delays(sc.keeper, sc.block_s, noise.delay_z)
            book = v.book_fn(np.random.default_rng(book_seed))
            if book.side.size != n_pos:
                raise ValueError(f"{v.name}：帳簿倉位數 {book.side.size} ≠ n_pos {n_pos}")
            res = evaluate_paths(book, t_s, Y, valid, delays, kw, max_price_age_s=sc.max_price_age_s,
                                 block_s=sc.block_s, horizon_s=horizon_s, vault_share=vault_share,
                                 liquidator_share=liquidator_share, adl_scan_fraction=adl_scan_fraction, run=run)
            res["weight"] = weight
            for k2, val in res.items():
                out[v.name][k2].append(val)
        del Yf, cache
        done += n
    return {name: BesuResult(**{k: np.concatenate(v) for k, v in d.items()}) for name, d in out.items()}


# ── maxPriceAge：誤擋與價格時效暴露 ───────────────────────────────────────────

def lognormal_excess_mean(median: float, p99: float, a: float) -> float:
    """E[(U − a)⁺]，U 對數常態（中位數 median、p99）。用來算「停擺超過 a 的時間」的期望值。

    令 U = m·e^{σZ}：E[(U − a)⁺] = m·e^{σ²/2}·Φ(σ − d) − a·Φ(−d)，d = ln(a/m)/σ（與選擇權公式同型）。
    """
    sig = lognormal_sigma(median, p99)
    if sig == 0:
        return max(median - a, 0.0)
    if a <= 0:
        return median * math.exp(sig**2 / 2)
    d = math.log(a / median) / sig
    return median * math.exp(sig**2 / 2) * stats.norm.cdf(sig - d) - a * stats.norm.cdf(-d)


def blocked_time_fraction(max_age_s: float, delta_s: float, outages: list[OracleOutage]) -> float:
    """價格年齡 > maxPriceAge 的時間比例（開倉、平倉、清算都會 revert 的時間）。

    正常運作時價格年齡 ≤ Δ；Δ > maxPriceAge 時，每個推價區間有 Δ − maxPriceAge 秒過期。
    停擺 U 秒時，過期時間約 (U + Δ − maxPriceAge)⁺（停擺前最後一次推價的年齡從 0 起算，保守取 Δ）。
    """
    frac = max(delta_s - max_age_s, 0.0) / delta_s
    for o in outages:
        a = max(max_age_s - delta_s, 0.0) / 60.0
        frac += o.rate_per_day * lognormal_excess_mean(o.median_min, o.p99_min, a) * 60.0 / 86_400.0
    return float(frac)


def stale_exposure(max_age_s: float, delta_s: float, outages: list[OracleOutage], n_grid: int = 4000) -> dict:
    """開倉可用價格的時效暴露（相對量，純擴散近似：開倉價偏離的期望 E|x| ∝ √價格年齡）。

    回傳（單位都是 √秒，呼叫端再除以公鏈現況的同一個量，得到相對刻度）：
      worst：可被接受的最大價格年齡的平方根 √maxPriceAge；
      mean：「可以開倉的時間」上的時間平均 E[√年齡]。
        - 正常運作：年齡在 [0, Δ] 間均勻增加，∫₀^Δ √a da / Δ = (2/3)√Δ；
        - 停擺 U 秒：年齡從 0 增加到 min(U, A) 為止可以開倉（貢獻 ∫√a da = (2/3)·min(U, A)^{3/2}），
          之後 U − min(U, A) 秒全部 revert，不計入可開倉時間。
        每秒的停擺發生率 r = rate_per_day / 86,400，時間平均是
          [(1 − r·E[U])·(2/3)√Δ + r·E[(2/3)min(U,A)^{3/2}]] / [1 − r·E[U] + r·E[min(U, A)]]。
    """
    A = float(max_age_s)
    b = (2.0 / 3.0) * math.sqrt(min(delta_s, A))
    num, den = b, 1.0
    for o in outages:
        sig = lognormal_sigma(o.median_min, o.p99_min)
        q = (np.arange(n_grid) + 0.5) / n_grid
        U = o.median_min * 60.0 * np.exp(sig * stats.norm.ppf(q))
        cap = np.minimum(U, A)
        r = o.rate_per_day / 86_400.0
        num += -r * float(U.mean()) * b + r * float(np.mean((2.0 / 3.0) * cap**1.5))
        den += -r * float(U.mean()) + r * float(cap.mean())
    return {"worst": math.sqrt(A), "mean": num / max(den, 1e-12)}


# ── 資金費：累積間隔 ───────────────────────────────────────────────────────────

FUNDING_BASE_INTERVAL_H = 8.0
FUNDING_BASE_CAP_BPS = 75
CATCHUP_INTERVALS = 21


def funding_interval_row(interval_h: float, cap_bps: int | None = None) -> dict:
    """把累積間隔從 8h 改成 interval_h，且每區間上限按比例縮放（年化上限不變）時的整數 bps 效應。

    程式費率 rate = trunc(trunc(1e18·X)·cap/1e18)（整數 bps），所以
      - 死區：|X| < 1/cap 時費率為 0；
      - 每單位 X 的費率解析度是 1 bps／區間（相對誤差最多 1/(cap·|X|)）；
      - 實際最高 cap − 1（兩邊 OI 都 > 0）。
    cap_bps 省略時取 round(75 × interval_h / 8)；cap < 1 代表費率永遠是 0。
    補算上限：一次最多補 21 個區間 → 21 × interval_h 內一定要有人觸發 `_pokeFunding`，否則超出部分雙方都免除。
    """
    ideal = FUNDING_BASE_CAP_BPS * interval_h / FUNDING_BASE_INTERVAL_H
    cap = int(round(ideal)) if cap_bps is None else int(cap_bps)
    per8h = (cap - 1) * FUNDING_BASE_INTERVAL_H / interval_h if cap >= 1 else 0.0
    return {"interval_h": interval_h, "cap_ideal_bps": ideal, "cap_bps": cap,
            "dead_zone": (1.0 / cap) if cap >= 1 else 1.0,
            "max_per_8h_bps": per8h,
            "catchup_window_h": CATCHUP_INTERVALS * interval_h}


def snapshot_error_bound(interval_h: float, holding_h: float) -> float:
    """快照制（只算結算當下還開著的倉位）相對於按持有時間累積的誤差上限：
    一個倉位最多多收／少收一個區間的資金費，相對誤差 ≤ interval_h / holding_h。"""
    return interval_h / holding_h


def snapshot_misallocation(interval_h: float, hold_median_h: float, hold_sigma: float, n: int = 20_000) -> float:
    """快照制的「錯配比例」E|P − Q| / E[Q]（名目加權，同一費率）。

    P：快照制收付的區間數 N（持有 h、開倉時點相對區間邊界均勻）；Q：按持有時間 h/I。
    令 h/I = k + φ（k 整數、0 ≤ φ < 1）：N = k + 1 的機率是 φ、否則是 k，
    所以 E|N − h/I| = φ(1 − φ) + (1 − φ)φ = 2φ(1 − φ)。對持有時間分布積分：
        錯配比例 = E_h[2φ(1 − φ)] / E_h[h/I]
    I ≪ h 時 φ 近似均勻、E[2φ(1−φ)] = 1/3，錯配比例 ≈ I/(3·E[h])，與 I 成正比；
    I ≫ h 時 φ = h/I、錯配比例 → 2(1 − h/I) → 接近 2（完全是抽籤）。
    持有時間取對數常態（中位數 hold_median_h、對數標準差 hold_sigma），以分位數格點積分。
    """
    q = (np.arange(n) + 0.5) / n
    h = hold_median_h * np.exp(hold_sigma * stats.norm.ppf(q))
    r = h / interval_h
    phi = r - np.floor(r)
    return float(np.mean(2 * phi * (1 - phi)) / np.mean(r))


def catchup_miss_per_year(interval_h: float, keeper: KeeperSLA, poke_every_s: float = 2.0) -> float:
    """keeper 停擺讓「超過 21 個區間沒有人觸發 `_pokeFunding`」的期望次數（每年）。

    只考慮 keeper（閒置資產沒有開平倉時，只有 keeper 會觸發）。停擺時長 U ＋ 正常觸發間隔 > 21·I 就會
    有資金費被免除（付方與收方同時免除，守恆不受影響，但那段時間的回復力消失）。
    """
    win_s = CATCHUP_INTERVALS * interval_h * SECONDS_PER_HOUR - poke_every_s
    if keeper.outage_per_day <= 0:
        return 0.0
    if win_s <= 0:
        return keeper.outage_per_day * 365.0
    sig = lognormal_sigma(keeper.outage_median_min, keeper.outage_p99_min)
    med = keeper.outage_median_min * 60.0
    if sig == 0:
        p = 1.0 if med > win_s else 0.0
    else:
        p = float(stats.norm.sf(math.log(win_s / med) / sig))
    return keeper.outage_per_day * 365.0 * p
