"""Phase 3：依 Besu（QBFT 許可鏈）特性重新校準——一鍵重現 docs/BESU_CALIBRATION.md 的數字與圖。

用法（在 repo 根目錄）：
    risk_model/.venv/Scripts/python.exe risk_model/run_besu.py            # 完整模式（本機約 16 分鐘）
    python3 risk_model/run_besu.py --quick                                # CI 用小樣本（約 1–2 分鐘）
    risk_model/.venv/Scripts/python.exe risk_model/run_besu.py --only delta,keeper
選項：--only 只跑部分段落（delta,keeper,oracle,maxage,inverse,liquidator,funding,institution,stress）；
      --refresh-market 重抓日資料、重算相關係數與壓力衝擊並更新 risk_model/data/besu_market_stats.json
      （預設只讀這個檔，不連網）；--vault-to-oi／--es-frac／--ruin-target／--seed 同 run_all.py。
價格過程參數一律讀 Phase 1 的 risk_model/data/calibrated_params.json（不連網）。
輸出（不進版控）：risk_model/output/besu/（--quick 為 output/besu_quick/）；完整模式另把圖複製到
      docs/figures/besu_calibration/。記憶體：每批 32 條 2 秒格點路徑，完整模式實測峰值約 400 MB（結束時印出）。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
from dataclasses import asdict, replace
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from risk_model import besu as bz  # noqa: E402
from risk_model import besu_institution as bi  # noqa: E402
from risk_model import calibration as cal  # noqa: E402
from risk_model import gap_risk as gr  # noqa: E402
from risk_model import inverse as inv  # noqa: E402
from risk_model.insurance import VaultIncomeParams  # noqa: E402
from risk_model.params import KEEPER, TIERS  # noqa: E402
from risk_model.plotting import INK_2, SERIES, save, setup_fonts  # noqa: E402
from risk_model.run_all import asset_setup  # noqa: E402

import matplotlib.pyplot as plt  # noqa: E402

OUT = HERE / "output" / "besu"
TABLES = OUT / "tables"
DOCS_FIG = ROOT / "docs" / "figures" / "besu_calibration"

# Besu 部署沒有接 esgRegistry（besu/scripts/deploy.sh 沿用 Deploy.s.sol，建構子第三個參數為 0），
# 所以所有資產都用全域費率：TRADING_FEE_BPS = 10、BORROW_FEE_BPS_PER_HOUR = 1（＝碳分級 Low 的數值），
# 槓桿上限是 MAX_LEVERAGE = 5。
BESU_FEE = TIERS["Low"]

SIZES = {
    "quick": dict(delta_days=48, keeper_days=48, oracle_days=48, inv_days=48, share_days=48, ruin_paths=2_000,
                  inst_days=400, stress_books=10, chunk=16),
    "full": dict(delta_days=12_000, keeper_days=8_000, oracle_days=8_000, inv_days=12_000, share_days=12_000,
                 ruin_paths=50_000, inst_days=20_000, stress_books=200, chunk=32),
}
SECTIONS = ("delta", "keeper", "oracle", "maxage", "inverse", "liquidator", "funding", "institution", "stress")

# 機構 VaR／壓力測試用的逐資產 (L, MMR)：Besu 版建議值（§5 反推結果；--only 不含 inverse 時用這組）
BESU_LM_DEFAULT = {"BTC": (5, 0.05), "ETH": (5, 0.05), "AAPL": (5, 0.15), "TSLA": (1, 0.05)}

# 推價短暫中斷（RPC 逾時、程式重啟）：只用在 maxPriceAge 的誤擋分析（假設值）
ORACLE_HICCUP = bz.OracleOutage(rate_per_day=24.0, median_min=0.2, p99_min=1.0)


def want(args, name):
    return args.only is None or name in args.only


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def rng_for(seed, k):
    return np.random.default_rng([seed, 3, k])


def peak_mem_mb() -> float:
    """本行程的記憶體峰值（MB）。Windows 用 GetProcessMemoryInfo，其他平台用 ru_maxrss。"""
    try:
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes

            class PMC(ctypes.Structure):
                _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
                            ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t),
                            ("PeakPagefileUsage", ctypes.c_size_t)]
            k32 = ctypes.WinDLL("kernel32")
            k32.GetCurrentProcess.restype = wintypes.HANDLE
            k32.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
            k32.K32GetProcessMemoryInfo.restype = wintypes.BOOL
            pmc = PMC()
            pmc.cb = ctypes.sizeof(PMC)
            if not k32.K32GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
                return float("nan")
            return pmc.PeakWorkingSetSize / 2**20
        import resource
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
    except Exception:  # noqa: BLE001
        return float("nan")


def book_fn(setup, L, m, n_pos=60, long_frac=0.5):
    return lambda g: gr.make_book(setup.proc, L, BESU_FEE.f, BESU_FEE.r, m, n_pos, g, long_frac=long_frac,
                                  year_days=setup.year_days)


def run_variants(setup, variants, n_days, rng, chunk, grid_s=2.0):
    return bz.simulate_besu_multi(setup.proc, variants, setup.day_hours, n_days, rng, grid_s=grid_s,
                                  day_hours=setup.day_hours, year_days=setup.year_days, chunk=chunk,
                                  is_jump=setup.is_jump, is_crash=setup.is_crash)


def summarize(setup, res, targets, tags, ruin_paths, ruin_seed, vault_share=0.20):
    inc = VaultIncomeParams(vault_share=vault_share, fee_rate=BESU_FEE.f)
    r = inv.summarize(setup, res, inc, targets, tags, np.random.default_rng(ruin_seed), ruin_paths, ruin_seed)
    w = res.weight / res.weight.sum()
    r["mean_bad_realized"] = float((res.bad_debt * w).sum())
    return r


def bps(x):
    return None if x is None or not np.isfinite(x) else round(1e4 * x, 3)


def fmt_s(s):
    if s < 60:
        return f"{s:g} 秒"
    if s < 3600:
        return f"{s / 60:g} 分"
    return f"{s / 3600:g} 時"


# ── §1 Δ = max(出塊, 推價) ─────────────────────────────────────────────────────

DELTAS_S = [2, 10, 60, 300, 900, 3600, 5400, 21600]


def section_delta(args, S, summary, setups, targets):
    log("§1 Δ 收斂")
    rows = []
    for k, (a, st) in enumerate(setups.items()):
        deltas = [d for d in DELTAS_S if d <= st.day_hours * 3600]
        vs = [bz.Variant(f"d{d}", book_fn(st, 5, 0.05),
                         bz.BesuScenario(f"d{d}", push_s=d, max_price_age_s=max(60.0, d + 2.0),
                                         keeper=bz.KeeperSLA(2.0, 2.0)))
              for d in deltas]
        res = run_variants(st, vs, S["delta_days"], rng_for(args.seed, 10 + k), S["chunk"])
        for d in deltas:
            r = summarize(st, res[f"d{d}"], targets, {"delta_s": d}, S["ruin_paths"], args.seed + 100 + k)
            rows.append({"asset": a, "delta_s": d, "mean_bps": bps(r["mean_loss"]), "p_loss": r["p_loss"],
                         "es99_bps": bps(r["es99"]), "annual_ruin": r["annual_ruin"], "min_vault": r["min_vault"],
                         "n_days": r["n_days"]})
        log(f"  {a} 完成")
    df = pd.DataFrame(rows)
    df.to_csv(TABLES / "delta.csv", index=False, encoding="utf-8")
    summary["delta"] = rows
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.3))
    for i, a in enumerate(setups):
        d = df[df.asset == a]
        axes[0].semilogx(d.delta_s, d.mean_bps, "o-", color=SERIES[i], label=a)
        axes[1].semilogx(d.delta_s, 100 * d.min_vault, "o-", color=SERIES[i], label=a)
    for ax in axes:
        ax.axvline(2, color=INK_2, ls=":", lw=1)
        ax.set_xlabel("Δ = max(出塊間隔, 推價間隔)（秒，對數軸）")
    axes[0].set_ylabel("每日期望壞帳（bps of OI）")
    axes[1].set_ylabel("年破產 < 0.1% 所需保險庫（% of OI）")
    axes[0].set_title("5x、MMR 5%、keeper 下一個區塊清算")
    axes[1].set_title("虛線：出塊間隔 2 秒")
    axes[0].legend()
    save(fig, OUT, "fig01_delta_convergence", DOCS_FIG)


# ── §2 keeper SLA ──────────────────────────────────────────────────────────────

P99_S = [2, 10, 30, 120, 600, 3600]
OUTAGE_RATES = [0.0, 0.01, 0.1, 1.0]


def keeper_variants(st, L, m):
    vs = []
    for p99 in P99_S:
        k = bz.KeeperSLA(median_s=max(2.0, p99 / 5.0), p99_s=float(p99))
        vs.append(bz.Variant(f"p99_{p99}", book_fn(st, L, m), bz.BesuScenario(f"p99_{p99}", keeper=k)))
    for rate in OUTAGE_RATES:
        k = bz.KeeperSLA(median_s=2.0, p99_s=10.0, outage_per_day=rate)
        vs.append(bz.Variant(f"out_{rate}", book_fn(st, L, m), bz.BesuScenario(f"out_{rate}", keeper=k)))
    k = bz.KeeperSLA(median_s=2.0, p99_s=10.0, outage_per_day=0.1, outage_median_min=120.0, outage_p99_min=720.0)
    vs.append(bz.Variant("out_long", book_fn(st, L, m), bz.BesuScenario("out_long", keeper=k)))
    return vs


def section_keeper(args, S, summary, setups, targets):
    log("§2 keeper SLA")
    rows = []
    for k_i, a in enumerate(("ETH", "AAPL")):
        st = setups[a]
        vs = keeper_variants(st, 5, 0.05)
        res = run_variants(st, vs, S["keeper_days"], rng_for(args.seed, 20 + k_i), S["chunk"])
        for v in vs:
            r = summarize(st, res[v.name], targets, {"variant": v.name}, S["ruin_paths"], args.seed + 200 + k_i)
            rows.append({"asset": a, "variant": v.name, "p99_s": v.scen.keeper.p99_s,
                         "outage_per_day": v.scen.keeper.outage_per_day,
                         "outage_median_min": v.scen.keeper.outage_median_min, "mean_bps": bps(r["mean_loss"]),
                         "p_loss": r["p_loss"], "es99_bps": bps(r["es99"]), "annual_ruin": r["annual_ruin"],
                         "min_vault": r["min_vault"]})
        log(f"  {a} 完成")
    df = pd.DataFrame(rows)
    df.to_csv(TABLES / "keeper_sla.csv", index=False, encoding="utf-8")
    summary["keeper"] = rows
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.3))
    for i, a in enumerate(("ETH", "AAPL")):
        d = df[(df.asset == a) & df.variant.str.startswith("p99_")]
        axes[0].semilogx(d.p99_s, 100 * d.min_vault, "o-", color=SERIES[i], label=a)
        d = df[(df.asset == a) & df.variant.str.startswith("out_") & (df.variant != "out_long")]
        x = [max(r, 1e-3) for r in d.outage_per_day]
        axes[1].semilogx(x, 100 * d.min_vault, "o-", color=SERIES[i], label=a)
    axes[0].set_xlabel("keeper 清算延遲 p99（秒，對數軸；中位數 = p99/5，至少 1 個區塊）")
    axes[0].set_ylabel("年破產 < 0.1% 所需保險庫（% of OI）")
    axes[0].set_title("延遲（沒有停擺）")
    axes[1].set_xlabel("keeper 停擺發生率（次/日，對數軸；0 畫在 10⁻³）")
    axes[1].set_title("停擺（中位 10 分、p99 2 時；p99 延遲 10 秒）")
    axes[0].legend()
    save(fig, OUT, "fig02_keeper_sla", DOCS_FIG)


# ── §3 Oracle 停擺 ─────────────────────────────────────────────────────────────

OUTAGE_MIN = [0, 1, 5, 15, 60, 240]
AGES_S = [10, 30, 60, 300, 3600]


def section_oracle(args, S, summary, setups, targets):
    log("§3 Oracle 停擺")
    rows = []
    for k_i, a in enumerate(("ETH", "AAPL")):
        st = setups[a]
        vs = []
        for u in OUTAGE_MIN:
            o = bz.OracleOutage() if u == 0 else bz.OracleOutage(fixed_min=float(u))
            vs.append(bz.Variant(f"fix_{u}", book_fn(st, 5, 0.05),
                                 bz.BesuScenario(f"fix_{u}", keeper=bz.KeeperSLA(2.0, 10.0), oracle=o)))
        for age in AGES_S:
            vs.append(bz.Variant(f"age_{age}", book_fn(st, 5, 0.05),
                                 bz.BesuScenario(f"age_{age}", max_price_age_s=float(age),
                                                 keeper=bz.KeeperSLA(2.0, 10.0),
                                                 oracle=bz.OracleOutage(fixed_min=60.0))))
        for rate in (0.02, 0.2):
            vs.append(bz.Variant(f"rate_{rate}", book_fn(st, 5, 0.05),
                                 bz.BesuScenario(f"rate_{rate}", keeper=bz.KeeperSLA(2.0, 10.0),
                                                 oracle=bz.OracleOutage(rate_per_day=rate))))
        res = run_variants(st, vs, S["oracle_days"], rng_for(args.seed, 30 + k_i), S["chunk"])
        for v in vs:
            r = summarize(st, res[v.name], targets, {"variant": v.name}, S["ruin_paths"], args.seed + 300 + k_i)
            rows.append({"asset": a, "variant": v.name, "outage_min": v.scen.oracle.fixed_min,
                         "rate_per_day": v.scen.oracle.rate_per_day, "max_price_age_s": v.scen.max_price_age_s,
                         "mean_bps": bps(r["mean_loss"]), "p_loss": r["p_loss"], "es99_bps": bps(r["es99"]),
                         "annual_ruin": r["annual_ruin"], "min_vault": r["min_vault"]})
        log(f"  {a} 完成")
    df = pd.DataFrame(rows)
    df.to_csv(TABLES / "oracle_outage.csv", index=False, encoding="utf-8")
    summary["oracle"] = rows
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.3))
    for i, a in enumerate(("ETH", "AAPL")):
        d = df[(df.asset == a) & df.variant.str.startswith("fix_")]
        x = [max(u, 0.3) if u == u else 0.3 for u in d.outage_min]
        axes[0].semilogx(x, d.mean_bps, "o-", color=SERIES[i], label=a)
        d = df[(df.asset == a) & df.variant.str.startswith("age_")]
        axes[1].semilogx(d.max_price_age_s, d.mean_bps, "o-", color=SERIES[i], label=a)
    axes[0].set_xlabel("當日停擺時長（分，對數軸；0 = 沒有停擺，畫在 0.3）")
    axes[0].set_ylabel("當日期望壞帳（bps of OI）")
    axes[0].set_title("推價停擺：恢復時的跳空")
    axes[1].set_xlabel("maxPriceAge（秒，對數軸）")
    axes[1].set_title("停擺 60 分時，maxPriceAge 對壞帳的影響")
    axes[0].legend()
    save(fig, OUT, "fig03_oracle_outage", DOCS_FIG)


# ── §4 maxPriceAge：誤擋 vs 價格時效 ──────────────────────────────────────────

def base_sepolia_stale_ref(n=200_000, seed=1):
    """公鏈現況的價格時效（同一個量的參考值）：推價間隔依實測分布、maxPriceAge 6h。"""
    rng = np.random.default_rng(seed)
    lo, hi = KEEPER.observed_min_min * 60, KEEPER.observed_max_min * 60
    mean_extra = (KEEPER.observed_mean_min - KEEPER.observed_min_min) * 60
    cap = 1 - math.exp(-(hi - lo) / mean_extra)
    g = lo - mean_extra * np.log1p(-rng.random(n) * cap)
    return {"worst": math.sqrt(6 * 3600.0), "mean": float((2 / 3) * np.mean(g**1.5) / np.mean(g))}


def section_maxage(args, S, summary):
    log("§4 maxPriceAge")
    ages = np.unique(np.concatenate([np.geomspace(2, 6 * 3600, 60), [10, 30, 60, 120, 300, 3600, 21600]]))
    ref = base_sepolia_stale_ref()
    base = bz.BESU_BASELINE
    outs = [ORACLE_HICCUP, base.oracle]
    rows = []
    for A in ages:
        se = bz.stale_exposure(A, base.delta_s, outs)
        rows.append({"max_price_age_s": float(A),
                     "blocked_frac": bz.blocked_time_fraction(A, base.delta_s, outs),
                     "blocked_frac_hiccup": bz.blocked_time_fraction(A, base.delta_s, [ORACLE_HICCUP]),
                     "stale_worst_rel": se["worst"] / ref["worst"], "stale_mean_rel": se["mean"] / ref["mean"]})
    df = pd.DataFrame(rows)
    df.to_csv(TABLES / "max_price_age.csv", index=False, encoding="utf-8")
    pick = df[df.max_price_age_s.isin([10, 30, 60, 120, 300, 3600, 21600])]
    summary["maxage"] = {"ref_base_sepolia": ref, "rows": pick.to_dict("records"),
                         "hiccup": asdict(ORACLE_HICCUP), "long_outage": asdict(base.oracle)}
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.3))
    axes[0].loglog(df.max_price_age_s, 86_400 * 365 * df.blocked_frac_hiccup / 60, color=SERIES[0],
                   label="只有短暫中斷")
    axes[0].loglog(df.max_price_age_s, 86_400 * 365 * df.blocked_frac / 60, color=SERIES[1], ls="--",
                   label="短暫中斷＋長停擺")
    axes[0].set_xlabel("maxPriceAge（秒，對數軸）")
    axes[0].set_ylabel("價格過期、交易全數 revert 的時間（分/年）")
    axes[0].set_title("誤擋：maxPriceAge 太短")
    axes[0].set_ylim(1e-3, None)
    axes[0].legend()
    axes[1].semilogx(df.max_price_age_s, df.stale_worst_rel, color=SERIES[2], label="最壞（可接受的最舊價格）")
    axes[1].semilogx(df.max_price_age_s, df.stale_mean_rel, color=SERIES[3], ls="--", label="時間平均")
    axes[1].axhline(1.0, color=INK_2, ls=":", lw=1)
    axes[1].set_xlabel("maxPriceAge（秒，對數軸）")
    axes[1].set_ylabel("開倉價時效暴露（公鏈現況 = 1）")
    axes[1].set_title("價格時效：maxPriceAge 太長（Δ = 2 秒）")
    axes[1].legend()
    save(fig, OUT, "fig04_max_price_age", DOCS_FIG)


# ── §5 逐資產槓桿與 MMR 反推 ───────────────────────────────────────────────────

M_GRID = (0.05, 0.075, 0.10, 0.15)


def section_inverse(args, S, summary, setups, targets):
    log("§5 槓桿與 MMR 反推（Besu 基準情境）")
    recs, tried_all = {}, []
    for k_i, (a, st) in enumerate(setups.items()):
        combos = [(L, m) for L in range(5, 0, -1) for m in M_GRID if m < 1.0 / L - BESU_FEE.f]
        vs = [bz.Variant(f"L{L}_m{m}", book_fn(st, L, m), bz.BESU_BASELINE) for L, m in combos]
        res = run_variants(st, vs, S["inv_days"], rng_for(args.seed, 50 + k_i), S["chunk"])
        best = None
        for (L, m), v in zip(combos, vs):
            r = summarize(st, res[v.name], targets, {"L": L, "m": m}, S["ruin_paths"], args.seed + 500 + k_i)
            row = {"asset": a, "L": L, "m": m, "mean_bps": bps(r["mean_loss"]), "es99_bps": bps(r["es99"]),
                   "annual_ruin": r["annual_ruin"], "min_vault": r["min_vault"], "feasible": r["feasible"]}
            tried_all.append(row)
            if best is None and r["feasible"]:
                best = row
        recs[a] = best
        log(f"  {a}：{best and (best['L'], best['m'])}")
    pd.DataFrame(tried_all).to_csv(TABLES / "inverse_L_m.csv", index=False, encoding="utf-8")
    summary["inverse"] = {"best": recs, "tried": tried_all}
    return {a: (r["L"], r["m"]) if r else (1, 0.05) for a, r in recs.items()}


# ── §6 清算人／保險庫分配 ─────────────────────────────────────────────────────

SHARES = [0.0, 0.20, 0.25, 0.50, 0.95]


def section_liquidator(args, S, summary, setups, targets, lm):
    log("§6 清算人與保險庫分配")
    rows = []
    for k_i, a in enumerate(("ETH", "AAPL")):
        st = setups[a]
        L, m = lm[a]
        res = run_variants(st, [bz.Variant("base", book_fn(st, L, m), bz.BESU_BASELINE)], S["share_days"],
                           rng_for(args.seed, 60 + k_i), S["chunk"])["base"]
        w = res.weight / res.weight.sum()
        for s in SHARES:
            r = summarize(st, res, targets, {"vault_share": s}, S["ruin_paths"], args.seed + 600 + k_i,
                          vault_share=s)
            rows.append({"asset": a, "L": L, "m": m, "vault_share": s, "mean_income_bps": bps(r["mean_income"]),
                         "mean_loss_bps": bps(r["mean_loss"]), "annual_ruin": r["annual_ruin"],
                         "min_vault": r["min_vault"],
                         "liquidator_income_bps": bps(float((res.liquidator_income * w).sum()))})
    df = pd.DataFrame(rows)
    df.to_csv(TABLES / "vault_share.csv", index=False, encoding="utf-8")
    summary["liquidator"] = rows
    fig, ax = plt.subplots(figsize=(7.5, 4.2))
    for i, a in enumerate(("ETH", "AAPL")):
        d = df[df.asset == a]
        ax.plot(100 * d.vault_share, 100 * d.min_vault, "o-", color=SERIES[i], label=f"{a}（{lm[a][0]}x、MMR {lm[a][1]:.1%}）")
    ax.axvline(20, color=INK_2, ls=":", lw=1)
    ax.axvline(25, color=INK_2, ls="--", lw=1)
    ax.set_xlabel("清算剩餘權益進保險庫的比例（%；虛線 20% 現值、25% = 清算人 5% 改進保險庫）")
    ax.set_ylabel("年破產 < 0.1% 所需保險庫（% of OI）")
    ax.set_title("Besu 基準情境")
    ax.legend()
    save(fig, OUT, "fig05_vault_share", DOCS_FIG)


# ── §7 資金費累積間隔 ─────────────────────────────────────────────────────────

INTERVALS_H = [8.0, 4.0, 2.0, 1.0, 0.25, 1 / 60, 2 / 3600]
HOLD_MEDIANS_H = [0.5, 4.0, 72.0]


def section_funding(args, S, summary):
    log("§7 資金費累積間隔")
    rows = []
    for I in INTERVALS_H:
        r = bz.funding_interval_row(I)
        for hm in HOLD_MEDIANS_H:
            r[f"misalloc_hold{hm:g}h"] = bz.snapshot_misallocation(I, hm, 1.5)
        r["catchup_miss_per_year_baseline"] = bz.catchup_miss_per_year(I, bz.BESU_BASELINE.keeper)
        r["catchup_miss_per_year_10x"] = bz.catchup_miss_per_year(
            I, replace(bz.BESU_BASELINE.keeper, outage_per_day=0.1))
        rows.append(r)
    df = pd.DataFrame(rows)
    df.to_csv(TABLES / "funding_interval.csv", index=False, encoding="utf-8")
    summary["funding"] = rows
    # 每區塊累積、以高精度費率（不經整數 bps）時的錯配比例
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.3))
    Is = np.geomspace(2 / 3600, 8, 60)
    for i, hm in enumerate(HOLD_MEDIANS_H):
        axes[0].loglog(Is * 3600, [bz.snapshot_misallocation(I, hm, 1.5) for I in Is], color=SERIES[i],
                       label=f"持有時間中位數 {fmt_s(hm * 3600)}")
    axes[0].axvline(8 * 3600, color=INK_2, ls=":", lw=1)
    axes[0].axvline(2, color=INK_2, ls=":", lw=1)
    axes[0].set_xlabel("累積間隔 I（秒，對數軸；虛線：2 秒、8 小時）")
    axes[0].set_ylabel("快照制錯配比例 E|P − Q| / E[Q]")
    axes[0].set_title("快照制 vs 按持有時間（同一費率）")
    axes[0].legend(fontsize=8)
    ideal = [bz.funding_interval_row(I)["cap_ideal_bps"] for I in Is]
    dz = [1 / c if c >= 1 else 1.0 for c in np.floor(np.array(ideal) + 0.5)]
    axes[1].loglog(Is * 3600, dz, color=SERIES[3], label="整數 bps 的死區 1/cap")
    axes[1].loglog(Is * 3600, [bz.catchup_miss_per_year(I, bz.BESU_BASELINE.keeper) + 1e-4 for I in Is],
                   color=SERIES[4], ls="--", label="keeper 停擺讓補算上限截斷的次數/年（+10⁻⁴）")
    axes[1].set_xlabel("累積間隔 I（秒，對數軸）")
    axes[1].set_title("縮短間隔的代價（只改 constant、上限按比例縮放）")
    axes[1].legend(fontsize=8)
    save(fig, OUT, "fig06_funding_interval", DOCS_FIG)


# ── §8 機構 VaR／ES ────────────────────────────────────────────────────────────

def asset_books(setups, lm, weights):
    return [bi.AssetBook(a, setups[a].proc, setups[a].day_hours, setups[a].year_days, lm[a][0], lm[a][1],
                         BESU_FEE.f, BESU_FEE.r, weights[a]) for a in bi.ASSETS]


def section_institution(args, S, summary, setups, lm, market):
    log("§8 機構 VaR／ES")
    corr = np.array(market["correlation"]["robust"])
    corr_p = np.array(market["correlation"]["pearson"])
    books = asset_books(setups, lm, bi.DEFAULT_OI_WEIGHTS)
    rows, comps, sims = [], {}, {}
    for j, (label, skew, c, cc) in enumerate([("均衡（X = 0）", 0.0, corr, True), ("多方擁擠（X = +0.3）", 0.3, corr, True),
                                               ("空方擁擠（X = −0.3）", -0.3, corr, True),
                                               ("多方擁擠、Pearson 相關", 0.3, corr_p, True),
                                               ("多方擁擠、崩盤不同步", 0.3, corr, False)]):
        sim = bi.simulate_institution(books, c, bz.BESU_BASELINE, S["inst_days"], rng_for(args.seed, 80 + j),
                                      skew=skew, common_crash=cc)
        rm = bi.risk_measures(sim["loss"])
        rm.update(bi.ten_day(sim["loss"], rng_for(args.seed, 90 + j)))
        rb = bi.risk_measures(sim["bad"])
        rows.append({"情境": label, "skew": skew, **{k: float(v) for k, v in rm.items()},
                     "bad_mean": rb["mean"], "bad_es99": rb["es99"]})
        comps[label] = bi.component_es(sim)
        if j < 3:
            sims[label] = sim["loss"]
        log(f"  {label} 完成")
    df = pd.DataFrame(rows)
    df.to_csv(TABLES / "institution_var.csv", index=False, encoding="utf-8")
    summary["institution"] = {"rows": rows, "component_es975": comps, "oi_weights": bi.DEFAULT_OI_WEIGHTS,
                              "lm": lm, "corr_used": "robust"}
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.3))
    for i, (label, loss) in enumerate(sims.items()):
        x = np.sort(100 * loss)
        p = 1 - (np.arange(x.size) + 0.5) / x.size
        axes[0].semilogy(x, p, color=SERIES[i], label=label)
    axes[0].set_xlabel("機構單日損失（% of 全部 OI）")
    axes[0].set_ylabel("P(損失 > x)（對數軸）")
    axes[0].set_title("機構單日損失的尾端")
    axes[0].legend(fontsize=8)
    c = comps["多方擁擠（X = +0.3）"]
    names = list(c)
    dirv = [100 * c[a]["directional"] for a in names]
    badv = [100 * c[a]["bad_debt"] for a in names]
    axes[1].bar(names, dirv, color=SERIES[0], label="方向性（交易者損益）")
    axes[1].bar(names, badv, bottom=dirv, color=SERIES[1], label="壞帳＋未實現虧空")
    axes[1].set_ylabel("對 ES₉₇.₅ 的貢獻（% of 全部 OI）")
    axes[1].set_title("多方擁擠時的成分 ES（Euler 分配）")
    axes[1].legend(fontsize=8)
    save(fig, OUT, "fig07_institution_var", DOCS_FIG)


# ── §9 壓力測試 ────────────────────────────────────────────────────────────────

def section_stress(args, S, summary, setups, lm, market, targets):
    log("§9 壓力測試")
    books = {b.name: b for b in asset_books(setups, lm, bi.DEFAULT_OI_WEIGHTS)}
    rng = rng_for(args.seed, 95)
    rows = []
    for ev in market["stress"]:
        for mode in ("gap", "path"):
            shocks = bi.event_shocks(ev, mode)
            hours = ev.get("hours", 6.5)
            for skew in (-0.3, 0.0, 0.3):
                tot = bad = trader = 0.0
                bad95 = 0.0
                per = {}
                for a, s in shocks.items():
                    b = books[a]
                    r = bi.stress_book_loss(b, s, mode, bz.BESU_BASELINE, rng, hours=hours, skew=skew,
                                            n_books=S["stress_books"])
                    w = b.oi_weight
                    tot += w * r["loss"]
                    bad += w * r["bad"]
                    bad95 += w * r["bad_p95"]
                    trader += w * r["trader"]
                    per[a] = {"shock": s, "loss": r["loss"], "bad": r["bad"]}
                rows.append({"id": ev["id"], "name": ev["name"], "mode": mode, "skew": skew, "loss": tot,
                             "directional": trader, "bad": bad, "bad_p95": bad95,
                             "vault_use": bad / targets.vault_to_oi, "per_asset": per})
    summary["stress"] = rows
    pd.DataFrame([{k: v for k, v in r.items() if k != "per_asset"} for r in rows]).to_csv(
        TABLES / "stress.csv", index=False, encoding="utf-8")
    worst = {}
    for r in rows:
        key = (r["id"], r["mode"])
        if key not in worst or r["loss"] > worst[key]["loss"]:
            worst[key] = r
    ids = [ev["id"] for ev in market["stress"]]
    fig, ax = plt.subplots(figsize=(10, 4.3))
    x = np.arange(len(ids))
    for i, mode in enumerate(("gap", "path")):
        ax.bar(x + (i - 0.5) * 0.38, [100 * worst[(e, mode)]["loss"] for e in ids], 0.38, color=SERIES[i],
               label=f"{'一次跳空' if mode == 'gap' else '區間內線性走到最低點'}：機構損失")
        ax.plot(x + (i - 0.5) * 0.38, [100 * worst[(e, mode)]["bad"] for e in ids], "D", color=SERIES[i + 2],
                label=f"{'跳空' if mode == 'gap' else '線性'}：其中壞帳（同一 OI 失衡）")
    ax.axhline(100 * targets.vault_to_oi, color=INK_2, ls=":", lw=1)
    ax.set_xticks(x, ids)
    ax.set_ylabel("% of 全部 OI（各情境取最不利的 OI 失衡）")
    ax.set_title(f"歷史壓力情境（虛線：保險庫 = OI 的 {targets.vault_to_oi:.0%}）")
    ax.legend(fontsize=8)
    save(fig, OUT, "fig08_stress", DOCS_FIG)


# ── main ───────────────────────────────────────────────────────────────────────

def main(argv=None):
    ap = argparse.ArgumentParser(description="PepeLab Phase 3：Besu 特性重新校準")
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--refresh-market", action="store_true")
    ap.add_argument("--vault-to-oi", type=float, default=0.05)
    ap.add_argument("--es-frac", type=float, default=0.10)
    ap.add_argument("--ruin-target", type=float, default=0.001)
    ap.add_argument("--seed", type=int, default=20261005)
    ap.add_argument("--only", type=str, default=None, help="逗號分隔：" + ",".join(SECTIONS))
    args = ap.parse_args(argv)
    if args.only is not None:
        args.only = {x.strip() for x in args.only.split(",") if x.strip()}
        bad = args.only - set(SECTIONS)
        if bad:
            ap.error(f"未知段落：{sorted(bad)}")
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    mode = "quick" if args.quick else "full"
    S = SIZES[mode]
    global OUT, TABLES, DOCS_FIG
    if args.quick:
        OUT = HERE / "output" / "besu_quick"
        TABLES = OUT / "tables"
        DOCS_FIG = None
    TABLES.mkdir(parents=True, exist_ok=True)
    font = setup_fonts()
    targets = inv.Targets(annual_ruin=args.ruin_target, es99_frac_of_vault=args.es_frac, vault_to_oi=args.vault_to_oi)
    t0 = time.time()
    cals = cal.calibrate_all()
    setups = {a: asset_setup(a, c) for a, c in cals.items()}
    summary = {"mode": mode, "seed": args.seed, "font": font, "targets": asdict(targets),
               "baseline": asdict(bz.BESU_BASELINE), "fee": asdict(BESU_FEE)}
    if want(args, "delta"):
        section_delta(args, S, summary, setups, targets)
    if want(args, "keeper"):
        section_keeper(args, S, summary, setups, targets)
    if want(args, "oracle"):
        section_oracle(args, S, summary, setups, targets)
    if want(args, "maxage"):
        section_maxage(args, S, summary)
    lm = dict(BESU_LM_DEFAULT)
    if want(args, "inverse"):
        found = section_inverse(args, S, summary, setups, targets)
        if not args.quick:
            lm = found
    summary["lm_used"] = lm
    if want(args, "liquidator"):
        section_liquidator(args, S, summary, setups, targets, lm)
    if want(args, "funding"):
        section_funding(args, S, summary)
    if want(args, "institution") or want(args, "stress"):
        market = bi.load_market_stats(refresh=args.refresh_market)
        if want(args, "institution"):
            section_institution(args, S, summary, setups, lm, market)
        if want(args, "stress"):
            section_stress(args, S, summary, setups, lm, market, targets)
    summary["elapsed_s"] = round(time.time() - t0, 1)
    summary["peak_mem_mb"] = round(peak_mem_mb(), 1)
    out = OUT / f"summary_besu_{mode}.json"
    if args.only is not None and out.exists():
        old = json.loads(out.read_text(encoding="utf-8"))
        old.update(summary)
        summary = old
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=1, default=_json_default), encoding="utf-8")
    log(f"完成：{out}（{summary['elapsed_s']} 秒，記憶體峰值 {summary['peak_mem_mb']} MB，字型 {font}）")
    return summary


def _json_default(o):
    if isinstance(o, (np.floating,)):
        return float(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, float) and not math.isfinite(o):
        return str(o)
    return str(o)


if __name__ == "__main__":
    main()
