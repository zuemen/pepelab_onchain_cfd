"""跳空壞帳：清算只在「有新價格、而且有人來清算」的檢查點發生。

程式實際（見 docs/PARAMS_INVENTORY.md §3.4、§4）：
- exchange 看到的價格是 keeper 寫進 MockOracle 的值，兩次推價之間是常數（階梯函數）；
- 清算要有人呼叫 `liquidatePosition`，repo 內**沒有清算 bot**；
- 清算前 `_requireFresh`：價格年齡 > maxPriceAge 時 revert（連平倉也不行）。
因此清算檢查點由兩件事決定，模型分開參數化：
  1. 推價時間 t_k（固定間隔，或依實測 68–169 分鐘、平均約 90 分鐘的分布）；
  2. 清算人到達：Poisson 過程，平均間隔 ρ（ρ = 0 代表常駐 bot，價格一更新就清算）。
在第 k 次推價後的「可清算時間窗」w_k = min(t_{k+1}, t_k + maxPriceAge, T) − t_k 內，
至少有一位清算人到達的機率是 q_k = 1 − exp(−w_k/ρ)。
第一個「價格已達清算價、而且有人到達」的推價 k，以該次推價的價格 P_k 清算：
  closeAmount/(M·L) = P_k/S_0 − S_b/S_0（多單）；為負時就是壞帳（由保險庫 bailout）。
maxPriceAge 不會縮小跳空：它只會在推價間隔 > maxPriceAge 時把可清算時間窗切短，
跳空的大小仍由推價間隔決定（價格在下一次推價時一次跳到位）。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .liquidation import LONG, SHORT, bankrupt_ratio_program, liq_ratio_program
from .params import KEEPER, InfraScenario
from .processes import MertonParams, merton_increments


# ── 推價時間 ───────────────────────────────────────────────────────────────────

def push_schedule(infra: InfraScenario, horizon_h: float, n: int, rng: np.random.Generator):
    """回傳 (times_h, valid)，形狀 (n, K)。times_h 是每次推價距離起點的小時數，超出 horizon 的格子 valid=False。

    observed 模式：間隔 = 68 分 + 截斷指數分布（平均 22 分，截在 169 分），整體平均約 90 分。
    起點 t = 0 視為剛推過價（oracle = 市價）。
    """
    if infra.push_mode == "fixed":
        d = infra.push_interval_h
        K = int(math.ceil(horizon_h / d - 1e-9))
        t = np.broadcast_to(d * np.arange(1, K + 1), (n, K)).copy()
        t[t > horizon_h + 1e-9] = horizon_h
        return t, np.ones((n, K), dtype=bool)
    if infra.push_mode == "observed":
        lo = KEEPER.observed_min_min / 60.0
        hi = KEEPER.observed_max_min / 60.0
        mean_extra = (KEEPER.observed_mean_min - KEEPER.observed_min_min) / 60.0
        if infra.extra.get("outage_h"):
            hi = max(hi, infra.extra["outage_h"])
        K = int(math.ceil(horizon_h / lo)) + 1
        # 截斷指數分布的反函數抽樣
        u = rng.random((n, K))
        cap = 1 - math.exp(-(hi - lo) / mean_extra)
        gaps = lo - mean_extra * np.log1p(-u * cap)
        if infra.extra.get("outage_h"):
            # 每次推價有 outage_p 機率變成一次長時間停擺（例：2026-09-30 的 4.5 小時）
            o = rng.random((n, K)) < infra.extra.get("outage_p", 0.01)
            gaps = np.where(o, infra.extra["outage_h"], gaps)
        t = np.cumsum(gaps, axis=1)
        valid = t <= horizon_h + 1e-9
        return t, valid
    raise ValueError(f"未知的 push_mode：{infra.push_mode}")


def catch_mask(times_h: np.ndarray, valid: np.ndarray, infra: InfraScenario, horizon_h: float,
               rng: np.random.Generator) -> np.ndarray:
    """每次推價之後的時間窗內，是否至少有一位清算人到達（且價格仍新鮮）。"""
    nxt = np.concatenate([times_h[:, 1:], np.full((times_h.shape[0], 1), np.inf)], axis=1)
    nxt = np.where(np.concatenate([valid[:, 1:], np.zeros((valid.shape[0], 1), bool)], axis=1), nxt, horizon_h)
    w = np.minimum(np.minimum(nxt, times_h + infra.max_price_age_h), horizon_h) - times_h
    w = np.maximum(w, 0.0)
    if infra.liquidator_mean_h <= 0:
        caught = w > 0
    else:
        q = 1 - np.exp(-w / infra.liquidator_mean_h)
        caught = rng.random(w.shape) < q
    return caught & valid


# ── 帳簿 ───────────────────────────────────────────────────────────────────────

@dataclass
class Book:
    """一個資產的未平倉帳簿（每單位 OI）。所有倉位面對同一條價格路徑。

    side：+1 多／−1 空；w：開倉名目權重（總和 = 1，即損失以「佔 OI 的比例」表示）；
    x：ln(S_0,i / S_now)，開倉價相對現價；liq、bk：清算價、破產價相對 S_0,i 的比值。
    """

    side: np.ndarray
    w: np.ndarray
    x: np.ndarray
    liq: np.ndarray
    bk: np.ndarray
    L: np.ndarray

    @property
    def theta(self) -> np.ndarray:
        """以 ln(P/S_now) 表示的清算門檻。"""
        return self.x + np.log(np.maximum(self.liq, 1e-300))


def make_book(p: MertonParams, L: int, f: float, r: float, m: float, n_pos: int, rng: np.random.Generator,
              long_frac: float = 0.5, max_age_days: float = 7.0, year_days: float = 365.0) -> Book:
    """產生代表性帳簿：倉位在過去 max_age_days 天內均勻開倉，開倉價相對現價為 N(0, σ_tot²·age)。

    已經達到清算價的倉位視為已被清算、不在帳上（重抽）。借貸費以年齡（小時）＋12 小時計入 β。
    """
    n_long = int(round(n_pos * long_frac))
    side = np.where(np.arange(n_pos) < n_long, LONG, SHORT)
    sd = math.sqrt(p.total_var_per_year)
    age_d = rng.uniform(0, max_age_days, n_pos)
    x = rng.standard_normal(n_pos) * sd * np.sqrt(age_d / year_days)
    beta = r * np.floor(age_d * 24 + 12) * (L - 1) / L
    liq = np.where(side == LONG, liq_ratio_program(L, m, f, LONG, beta), liq_ratio_program(L, m, f, SHORT, beta))
    bk = np.where(side == LONG, bankrupt_ratio_program(L, f, LONG, beta), bankrupt_ratio_program(L, f, SHORT, beta))
    for _ in range(50):
        th = x + np.log(np.maximum(liq, 1e-300))
        bad = np.where(side == LONG, th >= 0, th <= 0)
        if not bad.any():
            break
        x[bad] = rng.standard_normal(bad.sum()) * sd * np.sqrt(age_d[bad] / year_days)
    th = x + np.log(np.maximum(liq, 1e-300))
    bad = np.where(side == LONG, th >= 0, th <= 0)
    x[bad] = 0.0
    w_long = long_frac / max(n_long, 1)
    w_short = (1 - long_frac) / max(n_pos - n_long, 1)
    w = np.where(side == LONG, w_long, w_short)
    return Book(side=side, w=w, x=x, liq=liq, bk=bk, L=np.full(n_pos, float(L)))


def single_position_book(L: int, f: float, m: float, side=LONG, beta: float = 0.0, phi: float = 0.0) -> Book:
    """剛開倉的單一倉位（x = 0），權重 1。"""
    return Book(side=np.array([side]), w=np.array([1.0]), x=np.array([0.0]),
                liq=np.array([float(liq_ratio_program(L, m, f, side, beta, phi))]),
                bk=np.array([float(bankrupt_ratio_program(L, f, side, beta, phi))]),
                L=np.array([float(L)]))


# ── 模擬 ───────────────────────────────────────────────────────────────────────

@dataclass
class GapResult:
    """每個情境（scenario）一筆：壞帳（已實現／含期末未實現）、清算時的正權益 closeAmount 加總、
    保險庫罰金收入、清算人獎勵、ADL 可吸收量。
    單位：帳簿模式為「佔 OI 的比例」；單一倉位模式為「佔開倉名目的比例」。"""

    bad_debt: np.ndarray
    bad_debt_total: np.ndarray
    liq_equity: np.ndarray
    vault_income: np.ndarray
    liquidator_income: np.ndarray
    adl_capacity: np.ndarray
    n_liquidations: np.ndarray
    n_bad: np.ndarray
    weight: np.ndarray   # 重要性抽樣的概似比權重（沒有用 IS 時全為 1）


def simulate_gap(p: MertonParams, book_fn, infra: InfraScenario, horizon_h: float, n_scen: int,
                 rng: np.random.Generator, day_hours: float = 24.0, year_days: float = 365.0,
                 vault_share: float = 0.20, liquidator_share: float = 0.05, adl_scan_fraction: float = 1.0,
                 chunk: int = 2000, books_per_run: int = 20, is_jump: float = 1.0, is_crash: float = 1.0,
                 fine_dt_h: float | None = None) -> GapResult:
    """模擬 n_scen 個情境的帳簿損益。

    book_fn(rng) → Book；每 chunk 個情境換一本帳簿（平均掉帳簿組成的隨機性）。
    day_hours／year_days：一個「日」有幾個交易小時、一年幾個日（加密 24／365，股票 6.5／252），
    用來把推價間隔（小時）換成年化時間 dt = Δ_h/day_hours/year_days。
    is_jump／is_crash：重要性抽樣倍數。以 λ' = λ·s 產生跳躍，每個情境的權重
        w = Π_成分 (λ/λ')^N · exp((λ' − λ)·T)
    （N 是該情境的跳躍次數、T 是情境長度）。加權後的期望值不偏，但極端日的樣本數多 s 倍以上，
    讓 0.1% 年破產機率（每日約 3e-6）這種尾端也有足夠樣本。
    fine_dt_h：固定推價間隔時，先在這個細格點上模擬市價、再於推價時點取樣。不同推價間隔只要用同一個
    亂數種子，就看到「同一批帳簿、同一批市價路徑」（common random numbers），差異只來自檢查點。
    """
    out = {k: [] for k in GapResult.__dataclass_fields__}
    # common random numbers：清算人到達另用一條子亂數流（spawn 不消耗主亂數流），
    # 讓不同 ρ 的格子看到同一批帳簿與市價路徑
    catch_rng = rng.spawn(1)[0] if fine_dt_h is not None else rng
    chunk = max(1, min(chunk, int(math.ceil(n_scen / max(books_per_run, 1)))))
    done = 0
    while done < n_scen:
        n = min(chunk, n_scen - done)
        book = book_fn(rng)
        res = _simulate_chunk(p, book, infra, horizon_h, n, rng, day_hours, year_days,
                              vault_share, liquidator_share, adl_scan_fraction, is_jump, is_crash, fine_dt_h,
                              catch_rng)
        for k, v in res.items():
            out[k].append(v)
        done += n
    return GapResult(**{k: np.concatenate(v) for k, v in out.items()})


def _simulate_chunk(p, book: Book, infra, horizon_h, n, rng, day_hours, year_days,
                    vault_share, liquidator_share, adl_scan_fraction, is_jump=1.0, is_crash=1.0, fine_dt_h=None,
                    catch_rng=None):
    t, valid = push_schedule(infra, horizon_h, n, rng)
    K = t.shape[1]
    if fine_dt_h is not None and infra.push_mode == "fixed":
        # 細格點市價路徑，再於推價時點取樣（推價間隔必須是細格點的整數倍）
        K_f = int(round(horizon_h / fine_dt_h))
        dt_f = fine_dt_h / day_hours / year_days
        inc, n_reg, n_cr = merton_increments(p, dt_f, rng, size=(n, K_f), lam_scale=is_jump,
                                             crash_scale=is_crash, return_counts=True)
        Yf = np.cumsum(inc, axis=1)
        idx = np.clip(np.round(t[0] / fine_dt_h).astype(int) - 1, 0, K_f - 1)
        Y = Yf[:, idx]
        T_y = np.full(n, K_f * dt_f)
        n_reg_tot = n_reg.sum(axis=1)
        n_cr_tot = n_cr.sum(axis=1)
    else:
        dt_h = np.diff(np.concatenate([np.zeros((n, 1)), t], axis=1), axis=1)
        dt_y = dt_h / day_hours / year_days
        inc, n_reg, n_cr = merton_increments(p, dt_y, rng, lam_scale=is_jump, crash_scale=is_crash,
                                             return_counts=True)
        Y = np.cumsum(inc, axis=1)          # ln(P_k / S_now)
        # 概似比權重：只計有效（horizon 內）的格子
        T_y = (dt_y * valid).sum(axis=1)
        n_reg_tot = (n_reg * valid).sum(axis=1)
        n_cr_tot = (n_cr * valid).sum(axis=1)
    logw = np.zeros(n)
    if p.lam > 0 and is_jump != 1.0:
        logw += n_reg_tot * math.log(1.0 / is_jump) + p.lam * (is_jump - 1.0) * T_y
    if p.crash_lam > 0 and is_crash != 1.0:
        logw += n_cr_tot * math.log(1.0 / is_crash) + p.crash_lam * (is_crash - 1.0) * T_y
    weight = np.exp(logw)
    caught = catch_mask(t, valid, infra, horizon_h, rng if catch_rng is None else catch_rng)

    # 期末（最後一次有效推價）的價格：未被清算的倉位以此計算未實現虧空
    last_idx = np.maximum(valid.sum(axis=1) - 1, 0)
    y_last = np.where(valid.any(axis=1), Y[np.arange(n), last_idx], 0.0)

    theta = book.theta
    longs = book.side == LONG
    shorts = ~longs
    yl = np.where(caught, Y, np.inf)
    ys = np.where(caught, Y, -np.inf)
    runmin = np.minimum.accumulate(yl, axis=1)
    runmax = np.maximum.accumulate(ys, axis=1)

    bad = np.zeros(n)
    bad_tot = np.zeros(n)
    leq = np.zeros(n)
    vinc = np.zeros(n)
    linc = np.zeros(n)
    adl = np.zeros(n)
    nliq = np.zeros(n)
    nbad = np.zeros(n)

    th_l, th_s = theta[longs], theta[shorts]
    max_th_l = th_l.max() if th_l.size else -np.inf
    min_th_s = th_s.min() if th_s.size else np.inf

    # 先算「沒有任何清算」時的期末未實現虧空（向量化），有清算的情境再逐一修正
    def unreal(y_end, mask_open_l, mask_open_s):
        eq_l = np.exp(y_end[:, None] - book.x[longs][None, :]) - book.bk[longs][None, :]
        eq_s = book.bk[shorts][None, :] - np.exp(y_end[:, None] - book.x[shorts][None, :])
        d = (np.maximum(-eq_l, 0) * book.w[longs] * mask_open_l).sum(axis=1)
        d += (np.maximum(-eq_s, 0) * book.w[shorts] * mask_open_s).sum(axis=1)
        return d

    active = (runmin[:, -1] <= max_th_l) | (runmax[:, -1] >= min_th_s)
    idle = ~active
    if idle.any():
        ones_l = np.ones((idle.sum(), longs.sum()))
        ones_s = np.ones((idle.sum(), shorts.sum()))
        bad_tot[idle] = unreal(y_last[idle], ones_l, ones_s)

    xl, xs = book.x[longs], book.x[shorts]
    bkl, bks = book.bk[longs], book.bk[shorts]
    wl, ws = book.w[longs], book.w[shorts]
    for s in np.flatnonzero(active):
        # 多單：第一個 runmin ≤ θ 的位置；runmin 單調遞減，所以可二分搜尋
        kl = np.searchsorted(-runmin[s], -th_l, side="left") if th_l.size else np.array([], int)
        ks = np.searchsorted(runmax[s], th_s, side="left") if th_s.size else np.array([], int)
        hit_l = kl < K
        hit_s = ks < K
        eq_l = np.full(th_l.size, np.nan)
        eq_s = np.full(th_s.size, np.nan)
        eq_l[hit_l] = np.exp(Y[s, kl[hit_l]] - xl[hit_l]) - bkl[hit_l]
        eq_s[hit_s] = bks[hit_s] - np.exp(Y[s, ks[hit_s]] - xs[hit_s])
        cash_l = np.where(hit_l, eq_l, 0.0) * wl
        cash_s = np.where(hit_s, eq_s, 0.0) * ws
        pos_l, pos_s = np.maximum(cash_l, 0), np.maximum(cash_s, 0)
        neg = np.maximum(-cash_l, 0).sum() + np.maximum(-cash_s, 0).sum()
        bad[s] = neg
        leq[s] = pos_l.sum() + pos_s.sum()
        vinc[s] = vault_share * (pos_l.sum() + pos_s.sum())
        linc[s] = liquidator_share * (pos_l.sum() + pos_s.sum())
        nliq[s] = hit_l.sum() + hit_s.sum()
        nbad[s] = (cash_l < 0).sum() + (cash_s < 0).sum()
        un = unreal(np.array([y_last[s]]), (~hit_l)[None, :], (~hit_s)[None, :])[0]
        bad_tot[s] = neg + un
        if neg > 0:
            # ADL 可吸收量（保守）：在最大一筆壞帳發生時的價格，反方向且仍未平倉倉位的獲利，
            # 乘上「被掃描到的比例」（MAX_ADL_SCAN = 128 是索引槽數，不是獲利倉位數）。
            worst_l = np.argmin(np.where(hit_l, cash_l, np.inf)) if hit_l.any() else None
            worst_s = np.argmin(np.where(hit_s, cash_s, np.inf)) if hit_s.any() else None
            cands = []
            if worst_l is not None and cash_l[worst_l] < 0:
                cands.append((cash_l[worst_l], Y[s, kl[worst_l]], LONG))
            if worst_s is not None and cash_s[worst_s] < 0:
                cands.append((cash_s[worst_s], Y[s, ks[worst_s]], SHORT))
            _, y_ev, loser = min(cands, key=lambda c: c[0])
            if loser == LONG:
                prof = (1 - np.exp(y_ev - xs)) * ws * (~hit_s)
            else:
                prof = (np.exp(y_ev - xl) - 1) * wl * (~hit_l)
            adl[s] = min(neg, adl_scan_fraction * np.maximum(prof, 0).sum())
    return {"bad_debt": bad, "bad_debt_total": bad_tot, "liq_equity": leq, "vault_income": vinc, "liquidator_income": linc,
            "adl_capacity": adl, "n_liquidations": nliq, "n_bad": nbad, "weight": weight}


# ── 統計量 ─────────────────────────────────────────────────────────────────────

def _norm_w(x, w):
    x = np.asarray(x, dtype=float)
    w = np.ones_like(x) if w is None else np.asarray(w, dtype=float)
    return x, w / w.sum()


def var_es(x: np.ndarray, q: float, w: np.ndarray | None = None) -> tuple[float, float]:
    """損失的 VaR_q（分位數）與 ES_q（超過 VaR 那 1−q 機率質量的條件平均；可加權）。"""
    x, w = _norm_w(x, w)
    o = np.argsort(x)
    xs, ws = x[o], w[o]
    cw = np.cumsum(ws)
    i = int(np.searchsorted(cw, q, side="left"))
    i = min(i, xs.size - 1)
    var = float(xs[i])
    # 尾端質量恰為 1−q：第 i 筆只取超過 q 的那一部分
    tail_w = ws[i + 1:].sum()
    part = max(float(cw[i] - q), 0.0)
    if part + tail_w <= 0:
        return var, var
    es = float((xs[i] * part + (xs[i + 1:] * ws[i + 1:]).sum()) / (part + tail_w))
    return var, es


def loss_metrics(x: np.ndarray, w: np.ndarray | None = None) -> dict:
    x, wn = _norm_w(x, w)
    v95, e95 = var_es(x, 0.95, wn)
    v99, e99 = var_es(x, 0.99, wn)
    p = float(wn[x > 0].sum())
    ess = 1.0 / float((wn**2).sum())   # 有效樣本數
    return {"mean": float((x * wn).sum()), "p_pos": p, "p_pos_se": math.sqrt(p * (1 - p) / ess),
            "var95": v95, "es95": e95, "var99": v99, "es99": e99, "n": int(x.size), "ess": ess}


# ── 價格陳舊的套利 ─────────────────────────────────────────────────────────────

def stale_arbitrage_edge(p: MertonParams, age_h: float, fee: float, rng: np.random.Generator,
                         n: int = 200_000, day_hours: float = 24.0, year_days: float = 365.0) -> dict:
    """價格陳舊 age_h 小時時，知道真實市價的交易者以舊價開倉、等下次推價後平倉的期望優勢（每單位名目）。

    優勢 = E[(|ln(S_now/P_old)| − 2f)^+]（開、平各收 f；持有不滿 1 小時沒有借貸費）。
    這筆錢由交易所池子（所有交易者的 freeMargin）支付，是「對手方被挑單」的成本。
    """
    dt = age_h / day_hours / year_days
    x = merton_increments(p, dt, rng, size=(n,))
    edge = np.maximum(np.abs(np.expm1(x)) - 2 * fee, 0.0)
    return {"edge": float(edge.mean()), "p_profitable": float((edge > 0).mean()),
            "mean_abs_move": float(np.abs(np.expm1(x)).mean())}


def breakeven_age_gbm(sigma: float, fee: float, day_hours: float = 24.0, year_days: float = 365.0) -> float:
    """純擴散近似下 E|ΔlnS| = σ√(2a/π) = 2f 的陳舊時間 a*（小時）：a* = (π/2)(2f/σ)²（年）。"""
    a_years = (math.pi / 2) * (2 * fee / sigma) ** 2
    return a_years * year_days * day_hours
