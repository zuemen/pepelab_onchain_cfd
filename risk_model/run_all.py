"""一鍵重現 Phase 1 風險模型的所有圖表與數字。

用法（在 repo 根目錄）：
    risk_model/.venv/Scripts/python.exe risk_model/run_all.py           # 完整模式（本機約 10–20 分鐘）
    python3 risk_model/run_all.py --quick                               # CI 用小樣本（數分鐘內）
選項：--refresh-data 重抓歷史資料並覆寫快取；--offline 不連網（沒有快取時用內建預設）；
      --vault-to-oi 保險庫規模／OI（預設 0.05）；--es-frac 單日 ES_99 上限佔保險庫比例（預設 0.10）；
      --ruin-target 年破產機率上限（預設 0.001）；--seed 亂數種子（預設 20261005）。
輸出：完整模式寫到 risk_model/output/（圖檔、tables/*.csv、summary_full.json），圖檔另複製到
      docs/figures/risk_model/ 供文件引用；--quick 寫到 risk_model/output/quick/，不覆寫文件用的圖表。
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

from risk_model import calibration as cal  # noqa: E402
from risk_model import funding as fd  # noqa: E402
from risk_model import gap_risk as gr  # noqa: E402
from risk_model import insurance as ins  # noqa: E402
from risk_model import inverse as inv  # noqa: E402
from risk_model import liquidation as lq  # noqa: E402
from risk_model.params import (INFRA_BOT, INFRA_CURRENT, INFRA_IMPROVED, MODEL_TO_ONCHAIN, ONCHAIN,  # noqa: E402
                               ONCHAIN_ASSET_TIER, TIERS, InfraScenario)
from risk_model.plotting import INK_2, SEQ_CMAP, SERIES, save, setup_fonts  # noqa: E402
from risk_model.processes import MertonParams, merton_logpdf  # noqa: E402

import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.colors import LogNorm  # noqa: E402

OUT = HERE / "output"
TABLES = OUT / "tables"
DOCS_FIG = ROOT / "docs" / "figures" / "risk_model"

# 加密資產的崩盤壓力成分：每年 1 次、對數跳幅 N(−15%, 5%²)。
# 依據：校準樣本（2025-10 ~ 2026-10）BTC／ETH 最差 24 小時分別約 −15%、−16%；
# 更早的 2020-03、2021-05 單日跌幅更大。一般跳躍（門檻法）對這種尾端的機率低估。
CRASH = (1.0, -0.15, 0.05)

SIZES = {
    "quick": dict(fp_paths=20_000, fp_steps=48, heat_n=12, merton_liq_paths=4_000, grid_days=150,
                  infra_days=300, book_days=3_000, ruin_paths=5_000, inv_days=1_500, sweep_days=300,
                  share_days=1_500, funding_paths=40, arb_n=40_000, prog_points=400),
    "full": dict(fp_paths=400_000, fp_steps=96, heat_n=30, merton_liq_paths=60_000, grid_days=3_000,
                 infra_days=5_000, book_days=40_000, ruin_paths=50_000, inv_days=12_000, sweep_days=8_000,
                 share_days=20_000, funding_paths=400, arb_n=400_000, prog_points=20_000),
}


SECTIONS = ("calibration", "liquidation", "gap_grid", "gap_infra", "gap_books", "gap_stale", "insurance",
            "funding", "inverse")


def want(args, name: str) -> bool:
    """--only 未指定時全部執行；指定時只跑列出的段落（insurance、inverse 需要的前置會自動補）。"""
    return args.only is None or name in args.only


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def rng_for(seed: int, k: int) -> np.random.Generator:
    """每個段落用獨立的子種子，段落順序或樣本數改變不會影響其他段落。"""
    return np.random.default_rng([seed, k])


def asset_setup(name: str, c: cal.CalibrationResult, with_crash: bool = True) -> inv.AssetSetup:
    p = c.merton()
    if cal.ASSETS[name][2] == "1h":   # 加密 24/7
        if with_crash:
            p = p.with_crash(*CRASH)
        return inv.AssetSetup(name, p, 24.0, 365.0, 365, is_jump=1.0, is_crash=20.0 if with_crash else 1.0)
    return inv.AssetSetup(name, p, 6.5, 252.0, 252, is_jump=30.0, is_crash=1.0)


def fmt_pct(x, d=2):
    return "—" if x is None or (isinstance(x, float) and not math.isfinite(x)) else f"{100 * x:.{d}f}%"


def df_to_md(df: pd.DataFrame) -> str:
    cols = list(df.columns)
    lines = ["| " + " | ".join(map(str, cols)) + " |", "|" + "---|" * len(cols)]
    for _, r in df.iterrows():
        lines.append("| " + " | ".join(str(r[c]) for c in cols) + " |")
    return "\n".join(lines)


# ── 1-1 校準 ───────────────────────────────────────────────────────────────────

def section_calibration(args, S, summary):
    log("1-1 校準")
    cals = cal.calibrate_all(refresh=args.refresh_data, offline=args.offline)
    rows = []
    for a, c in cals.items():
        rows.append({"資產": a, "來源": c.source, "樣本數": c.n_obs, "年數": round(c.years, 2),
                     "GBM σ": round(c.gbm_sigma, 4), "樣本 μ": round(c.gbm_mu, 4),
                     "門檻 σ": round(c.thr_sigma, 4), "門檻 λ/年": round(c.thr_lam, 2),
                     "門檻 μ_J": round(c.thr_mu_j, 4), "門檻 σ_J": round(c.thr_sigma_j, 4),
                     "跳躍數": c.thr_n_jumps,
                     "MLE σ": round(c.mle_sigma, 4), "MLE λ/年": round(c.mle_lam, 1),
                     "MLE μ_J": round(c.mle_mu_j, 4), "MLE σ_J": round(c.mle_sigma_j, 4),
                     "LR(Merton vs GBM)": round(c.lr_stat, 1), "用預設": c.used_defaults})
    df = pd.DataFrame(rows)
    df.to_csv(TABLES / "calibration.csv", index=False, encoding="utf-8")
    summary["calibration"] = {a: c.to_dict() for a, c in cals.items()}

    fig, axes = plt.subplots(2, 2, figsize=(11, 7.5))
    for ax, (a, c) in zip(axes.ravel(), cals.items()):
        dfp, _ = cal.load_prices(a, offline=True)
        if dfp is None:
            ax.set_title(f"{a}：無原始資料（使用 {'已校準參數' if c.from_snapshot else '預設'}）")
            continue
        r = cal.log_returns(dfp)
        lim = np.quantile(np.abs(r), 0.9995) * 1.1
        bins = np.linspace(-lim, lim, 121)
        h, e = np.histogram(r, bins=bins, density=True)
        mid = 0.5 * (e[1:] + e[:-1])
        ax.semilogy(mid, np.where(h > 0, h, np.nan), "o", ms=3, color=INK_2, label="經驗分布")
        g = MertonParams(sigma=c.gbm_sigma, mu=c.gbm_mu)
        ax.semilogy(mid, np.exp(merton_logpdf(mid, c.dt, g)), color=SERIES[0], label="GBM（常態）")
        ax.semilogy(mid, np.exp(merton_logpdf(mid, c.dt, c.merton(mu=c.gbm_mu))), color=SERIES[1],
                    label="Merton（門檻法，模擬主參數）")
        ax.semilogy(mid, np.exp(merton_logpdf(mid, c.dt, c.merton_mle(mu=c.gbm_mu))), color=SERIES[2],
                    ls="--", label="Merton（MLE）")
        ax.set_ylim(max(h[h > 0].min() * 0.3, 1e-3), h.max() * 3)
        freq = "1 小時" if c.dt < 1 / 1000 else "1 日"
        ax.set_title(f"{a}：{freq}對數報酬（{c.n_obs} 筆）")
        ax.set_xlabel("對數報酬")
        ax.set_ylabel("密度（對數軸）")
    axes[0, 0].legend(fontsize=8)
    save(fig, OUT, "fig01_calibration", DOCS_FIG)
    return cals


# ── 1-2 清算價與清算機率 ───────────────────────────────────────────────────────

def section_liquidation(args, S, summary, cals):
    log("1-2 清算價與清算機率")
    m = ONCHAIN.m
    # (a) 清算價對照表
    rows = []
    for tier in ["Low", "Mid", "High"]:
        t = TIERS[tier]
        for L in range(1, t.max_leverage + 1):
            rows.append({"分級": tier, "L": L, "f": t.f, "m": m,
                         "程式 多 S*/S0": round(float(lq.liq_ratio_program(L, m, t.f, lq.LONG)), 4),
                         "程式 多 破產": round(float(lq.bankrupt_ratio_program(L, t.f, lq.LONG)), 4),
                         "任務書 多": round(float(lq.liq_ratio_taskbook(L, m, lq.LONG)), 4),
                         "程式 空 S*/S0": round(float(lq.liq_ratio_program(L, m, t.f, lq.SHORT)), 4),
                         "程式 空 破產": round(float(lq.bankrupt_ratio_program(L, t.f, lq.SHORT)), 4),
                         "任務書 空": round(float(lq.liq_ratio_taskbook(L, m, lq.SHORT)), 4)})
    df = pd.DataFrame(rows)
    df.to_csv(TABLES / "liq_prices.csv", index=False, encoding="utf-8")
    summary["liq_prices"] = rows

    fig, ax = plt.subplots(figsize=(8, 5))
    Ls = np.linspace(1, 10, 200)
    f = TIERS["Low"].f
    ax.plot(Ls, lq.liq_ratio_program(Ls, m, f, lq.LONG), color=SERIES[0], label="多單：程式（線性）")
    ax.plot(Ls, lq.liq_ratio_taskbook(Ls, m, lq.LONG), color=SERIES[0], ls="--", label="多單：任務書（分式）")
    ax.plot(Ls, lq.bankrupt_ratio_program(Ls, f, lq.LONG), color=SERIES[0], ls=":", label="多單：破產價")
    ax.plot(Ls, lq.liq_ratio_program(Ls, m, f, lq.SHORT), color=SERIES[1], label="空單：程式（線性）")
    ax.plot(Ls, lq.liq_ratio_taskbook(Ls, m, lq.SHORT), color=SERIES[1], ls="--", label="空單：任務書（分式）")
    ax.plot(Ls, lq.bankrupt_ratio_program(Ls, f, lq.SHORT), color=SERIES[1], ls=":", label="空單：破產價")
    ax.axvline(5, color=INK_2, lw=1)
    ax.text(5.1, 1.75, "MAX_LEVERAGE = 5", color=INK_2, fontsize=9)
    ax.set_xlabel("槓桿 L")
    ax.set_ylabel("S* / S₀")
    ax.set_title("清算價與破產價（m = 5%、f = 0.10%、h = 0、φ = 0）")
    ax.legend(fontsize=8, ncol=2)
    save(fig, OUT, "fig02_liq_price", DOCS_FIG)

    # (b) 封閉解 vs MC
    rng = rng_for(args.seed, 21)
    T = 1.0 / 365.0
    # 機率要落在 MC 解析得到的範圍（≥ 0.1%），所以低波動的情境用較長期間
    cases = [(5, 0.6, lq.LONG, 7), (5, 0.6, lq.SHORT, 7), (5, 1.0, lq.LONG, 1), (5, 1.5, lq.SHORT, 1),
             (3, 2.0, lq.LONG, 1), (3, 2.5, lq.SHORT, 1), (2, 1.0, lq.LONG, 30), (4, 1.2, lq.LONG, 3)]
    rows = []
    for L, sig, side, days in cases:
        T = days / 365.0
        mu = 0.0
        nu = mu - 0.5 * sig**2
        ratio = float(lq.liq_ratio_program(L, m, f, side))
        bar = math.log(ratio)
        cf = float(lq.liquidation_prob_gbm(L, sig, T, side, m, f, mu))
        est, se = lq.mc_first_passage(bar, nu, sig, T, S["fp_paths"], S["fp_steps"], rng, side=side, bridge=True)
        est_d, se_d = lq.mc_first_passage(bar, nu, sig, T, S["fp_paths"] // 4, S["fp_steps"], rng, side=side,
                                          bridge=False)
        bgk = float(lq.liquidation_prob_gbm(L, sig, T, side, m, f, mu, discrete_dt=T / S["fp_steps"]))
        rows.append({"L": L, "σ": sig, "方向": "多" if side == lq.LONG else "空", "天數": days, "封閉解": cf,
                     "MC（bridge）": est, "MC 標準誤": se, "z": (est - cf) / se if se > 0 else 0.0,
                     "MC（只看格點）": est_d, "格點 標準誤": se_d, "BGK 離散修正": bgk})
    df = pd.DataFrame(rows)
    df.to_csv(TABLES / "fp_closed_vs_mc.csv", index=False, encoding="utf-8")
    summary["fp_closed_vs_mc"] = rows
    summary["fp_max_abs_z"] = float(np.max(np.abs(df["z"])))
    summary["fp_max_abs_err"] = float(np.max(np.abs(df["MC（bridge）"] - df["封閉解"])))

    fig, ax = plt.subplots(figsize=(9, 4.8))
    x = np.arange(len(rows))
    labels = [f"{r['方向']} {r['L']}x\nσ={r['σ']}、{r['天數']}天" for r in rows]
    ax.bar(x - 0.27, df["封閉解"], 0.26, color=SERIES[0], label="封閉解（連續監控）")
    ax.bar(x, df["MC（bridge）"], 0.26, yerr=1.96 * df["MC 標準誤"], color=SERIES[1], label="MC＋Brownian bridge（95% CI）")
    ax.bar(x + 0.27, df["MC（只看格點）"], 0.26, color=SERIES[2], label=f"MC 只看 {S['fp_steps']} 個格點")
    ax.set_xticks(x, labels, fontsize=8)
    ax.set_ylabel("期間內觸及清算價的機率")
    ax.set_title("首次穿越：封閉解 vs Monte Carlo（GBM、μ = 0、Low 分級費率）")
    ax.legend(fontsize=8)
    save(fig, OUT, "fig03_fp_closed_vs_mc", DOCS_FIG)

    # (c) 熱圖 L × σ（24 小時）
    T = 1.0 / 365.0
    Lg = np.arange(1, 11)
    sg = np.linspace(0.2, 2.5, S["heat_n"])
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.6), sharey=True)
    heat = {}
    for ax, side, name in [(axes[0], lq.LONG, "多單"), (axes[1], lq.SHORT, "空單")]:
        Z = np.array([[float(lq.liquidation_prob_gbm(L, s, T, side, m, f)) for L in Lg] for s in sg])
        heat[name] = Z
        im = ax.imshow(np.maximum(Z, 1e-6), origin="lower", aspect="auto", cmap=SEQ_CMAP,
                       norm=LogNorm(vmin=1e-6, vmax=1.0), extent=[Lg[0] - 0.5, Lg[-1] + 0.5, sg[0], sg[-1]])
        ax.grid(False)
        ax.axvline(5.5, color=INK_2, lw=1.2, ls="--")
        ax.set_xlabel("槓桿 L（虛線右側超出 MAX_LEVERAGE）")
        ax.set_title(f"{name}：24h 清算機率（m=5%、f=0.10%、μ=0；色階為對數）")
        for L in (2, 5, 10):
            for s_ in (0.5, 1.0, 1.5, 2.0):
                j = int(np.argmin(np.abs(sg - s_)))
                v = Z[j, L - 1]
                ax.text(L, sg[j], "<1e-6" if v < 1e-6 else f"{v:.2%}", ha="center", va="center", fontsize=7,
                        color="white" if v > 1e-2 else "black")
        fig.colorbar(im, ax=ax, fraction=0.046)
    axes[0].set_ylabel("年化波動度 σ")
    save(fig, OUT, "fig04_heatmap_liq24h", DOCS_FIG)

    # (d) 代表值：各資產以總波動度的 GBM 封閉解，與含跳躍（Merton）的 MC
    rng = rng_for(args.seed, 22)
    reps = []
    for a, c in cals.items():
        p = c.merton()
        day = 1.0 / (365.0 if cal.ASSETS[a][2] == "1h" else 252.0)
        sig_tot = math.sqrt(p.total_var_per_year)
        for L in (1, 2, 5):
            gbm = float(lq.liquidation_prob_gbm(L, sig_tot, day, lq.LONG, m, TIERS["Low"].f))
            mc, se = lq.mc_liquidation_prob_merton(p, L, day, lq.LONG, m, TIERS["Low"].f,
                                                   n_paths=S["merton_liq_paths"], n_steps=96, rng=rng)
            reps.append({"資產": a, "L": L, "總波動 σ": round(sig_tot, 4), "GBM 封閉解": gbm,
                         "Merton MC": mc, "Merton 標準誤": se})
    pd.DataFrame(reps).to_csv(TABLES / "liq24h_representative.csv", index=False, encoding="utf-8")
    summary["liq24h_representative"] = reps
    summary["heat_examples"] = {f"L{L}_sigma{s_}": float(lq.liquidation_prob_gbm(L, s_, T, lq.LONG, m, f))
                                for L in (2, 3, 5) for s_ in (0.5, 0.8, 1.0, 1.5)}

    # (e) 程式整數不等式 vs 封閉式：逐點一致（邊界附近 ±1 wei 以內除外）
    rng = rng_for(args.seed, 23)
    agree, near, total = 0, 0, 0
    for _ in range(S["prog_points"]):
        L = int(rng.integers(1, 6))
        tier = TIERS[["Low", "Mid", "High"][int(rng.integers(0, 3))]]
        side = lq.LONG if rng.random() < 0.5 else lq.SHORT
        margin = int(rng.uniform(10, 1e6) * 1e18)
        entry = int(rng.uniform(1, 1e5) * 1e8) * 10**10
        hours = float(rng.uniform(0, 200))
        beta = lq.beta_borrow(tier.r, hours, L)
        star = float(lq.liq_ratio_program(L, m, tier.f, side, beta))
        x = star * (1 + rng.normal(0, 0.02))
        price8 = max(int(entry / 10**10 * x), 1)
        ca, mm, liq = lq.program_close_amount(margin, L, entry, price8, side == lq.LONG, int(tier.fee_bps),
                                              int(tier.borrow_bps_per_hour), int(hours * 3600), 0,
                                              int(ONCHAIN.mmr_bps))
        ratio = price8 * 10**10 / entry
        closed = ratio <= star if side == lq.LONG else ratio >= star
        total += 1
        if abs(ratio - star) * margin * L < 1e-6 * margin:   # 邊界附近：截斷誤差範圍內
            near += 1
            continue
        agree += int(closed == liq)
    summary["program_vs_closed"] = {"points": total, "agree": agree, "near_boundary_skipped": near}
    return heat


# ── 1-3 跳空壞帳 ───────────────────────────────────────────────────────────────

def section_gap(args, S, summary, cals):
    log("1-3 跳空壞帳")
    m = ONCHAIN.m
    low = TIERS["Low"]

    books = {}
    if want(args, "gap_grid"):
        # (a) 網格：Δ × L × λ × 跳幅分布（帳簿，每單位 OI；常駐 bot，所以 Δ = 推價間隔）
        rng = rng_for(args.seed, 31)
        deltas = [1 / 60, 0.25, 1.0, 1.5, 3.0, 6.0]
        Ls = [2, 3, 5]
        lams = [0.0, 12.0, 52.0, 250.0]
        jumps = {"對稱小跳 N(0, 3%²)": (0.0, 0.03), "崩跌 N(−8%, 4%²)": (-0.08, 0.04)}
        rows = []
        for jn, (mj, sj) in jumps.items():
            for lam in lams:
                if lam == 0 and jn != list(jumps)[0]:
                    continue
                p = MertonParams(sigma=0.5, lam=lam, mu_j=mj, sigma_j=sj)
                for L in Ls:
                    cell_seed = int(rng.integers(0, 2**31))   # 同一 (跳幅, λ, L) 的各 Δ 共用亂數
                    for d in deltas:
                        infra = InfraScenario("grid", "fixed", d, 0.0, max(6.0, d))
                        isj = min(20.0, max(1.0, 200.0 / lam)) if lam > 0 else 1.0
                        res = gr.simulate_gap(p, lambda g: gr.make_book(p, L, low.f, low.r, m, 40, g), infra, 24.0,
                                              S["grid_days"], np.random.default_rng(cell_seed), is_jump=isj,
                                              fine_dt_h=1 / 60)
                        mt = gr.loss_metrics(res.bad_debt_total, res.weight)
                        rows.append({"跳幅": jn if lam > 0 else "無跳躍", "λ": lam, "L": L, "Δ_h": d, **mt})
        grid = pd.DataFrame(rows)
        grid.to_csv(TABLES / "gap_grid.csv", index=False, encoding="utf-8")
        summary["gap_grid_rows"] = len(rows)
        summary["gap_grid_nojump_L5"] = grid[(grid["λ"] == 0) & (grid["L"] == 5)][["Δ_h", "mean", "es99", "p_pos"]].to_dict("records")

        fig, axes = plt.subplots(2, 2, figsize=(12, 8))
        for col, (jn, _) in enumerate(jumps.items()):
            for row, (metric, ylab) in enumerate((("mean", "每日期望壞帳（bps of OI）"), ("es99", "單日壞帳 ES99（bps of OI）"))):
                ax = axes[row, col]
                k = 0
                for lam in lams:
                    sub = grid[(grid["λ"] == lam) & (grid["L"] == 5) & ((grid["跳幅"] == jn) | (grid["λ"] == 0))]
                    if sub.empty:
                        continue
                    ax.plot(sub["Δ_h"], sub[metric] * 1e4, marker="o", color=SERIES[k], label=f"λ = {lam:g}/年")
                    k += 1
                ax.set_xscale("log")
                ax.set_xlabel("檢查間隔 Δ（小時，對數軸；常駐 bot，Δ = 推價間隔）")
                ax.set_ylabel(ylab)
                ax.set_title(f"L = 5、σ = 50%、{jn.replace(chr(0x2212), '-')}")
                ax.legend(fontsize=8)
        save(fig, OUT, "fig05_gap_grid", DOCS_FIG)

    if want(args, "gap_infra"):
        # (b) Δ 拆解：推價間隔 × 清算人反應（ETH 校準＋崩盤，L = 5）
        rng = rng_for(args.seed, 32)
        s_eth = asset_setup("ETH", cals["ETH"])
        pushes = [1 / 60, 0.25, 1.0, 1.5, 3.0]
        rhos = [0.0, 0.25, 1.0, 4.0, 12.0]
        Zm = np.zeros((len(rhos), len(pushes)))
        Zp = np.zeros_like(Zm)
        rows = []
        for i, rho in enumerate(rhos):
            for j, d in enumerate(pushes):
                infra = InfraScenario("dec", "fixed", d, rho, 6.0)
                res = inv.run_book(s_eth, 5, m, "Low", infra, S["infra_days"], rng_for(args.seed, 32), fine_dt_h=1 / 60)
                mt = gr.loss_metrics(res.bad_debt_total, res.weight)
                Zm[i, j] = mt["mean"]
                Zp[i, j] = mt["p_pos"]
                rows.append({"push_h": d, "rho_h": rho, **mt})
        pd.DataFrame(rows).to_csv(TABLES / "gap_push_vs_liquidator.csv", index=False, encoding="utf-8")
        summary["gap_push_vs_liquidator"] = rows
        fig, axes = plt.subplots(1, 2, figsize=(12, 4.4))
        for ax, Z, ttl, scale, unit in [(axes[0], Zm, "每日期望壞帳", 1e4, "bps"), (axes[1], Zp, "P(單日壞帳 > 0)", 100, "%")]:
            im = ax.imshow(Z * scale, origin="lower", cmap=SEQ_CMAP, aspect="auto")
            ax.grid(False)
            ax.set_xticks(range(len(pushes)), ["1 分", "15 分", "1 時", "1.5 時", "3 時"])
            ax.set_yticks(range(len(rhos)), ["bot（0）", "15 分", "1 時", "4 時", "12 時"])
            ax.set_xlabel("推價間隔 Δ_p")
            ax.set_ylabel("清算人平均到達間隔 ρ")
            ax.set_title(f"ETH、L=5：{ttl}（{unit}）")
            for i in range(len(rhos)):
                for j in range(len(pushes)):
                    ax.text(j, i, f"{Z[i, j] * scale:.2f}", ha="center", va="center", fontsize=8,
                            color="white" if (Z[i, j] - Z.min()) > 0.6 * (Z.max() - Z.min() + 1e-300) else "black")
            fig.colorbar(im, ax=ax, fraction=0.046)
        save(fig, OUT, "fig06_push_vs_liquidator", DOCS_FIG)

        # (c) maxPriceAge：實測推價（含 2% 機率 4.5h 停擺）＋手動清算（ρ = 4h）
        rng = rng_for(args.seed, 33)
        rows = []
        for A in [1.0, 2.0, 3.0, 6.0, 24.0]:
            for rho in [0.0, 4.0]:
                infra = InfraScenario("age", "observed", 1.5, rho, A, extra={"outage_h": 4.5, "outage_p": 0.02})
                res = inv.run_book(s_eth, 5, m, "Low", infra, S["infra_days"], rng)
                mt = gr.loss_metrics(res.bad_debt_total, res.weight)
                rows.append({"maxPriceAge_h": A, "rho_h": rho, **mt})
        pd.DataFrame(rows).to_csv(TABLES / "gap_max_price_age.csv", index=False, encoding="utf-8")
        summary["gap_max_price_age"] = rows

    if want(args, "gap_books"):
        # (d) Base Sepolia 現況：各資產鏈上槓桿上限／分級，三種基礎設施
        rng = rng_for(args.seed, 34)
        rows = []
        for a, c in cals.items():
            st = asset_setup(a, c)
            tier = ONCHAIN_ASSET_TIER[MODEL_TO_ONCHAIN[a]]
            L = TIERS[tier].max_leverage
            for infra in (INFRA_CURRENT, INFRA_BOT, INFRA_IMPROVED):
                res = inv.run_book(st, L, m, tier, infra, S["book_days"], rng)
                mt = gr.loss_metrics(res.bad_debt_total, res.weight)
                mr = gr.loss_metrics(res.bad_debt, res.weight)
                rows.append({"資產": a, "鏈上": MODEL_TO_ONCHAIN[a], "分級": tier, "L": L, "情境": infra.name,
                             "E": mt["mean"], "P>0": mt["p_pos"], "VaR95": mt["var95"], "ES95": mt["es95"],
                             "VaR99": mt["var99"], "ES99": mt["es99"], "已實現 E": mr["mean"],
                             "ESS": mt["ess"]})
                books[(a, infra.name)] = (st, tier, L, res)
        df = pd.DataFrame(rows)
        df.to_csv(TABLES / "gap_onchain_assets.csv", index=False, encoding="utf-8")
        summary["gap_onchain_assets"] = rows

        # 同樣的帳簿，但把每個資產都放到 Low 5x（若碳分級允許的話會是什麼風險）
        rows5 = []
        for a, c in cals.items():
            st = asset_setup(a, c)
            res = inv.run_book(st, 5, m, "Low", INFRA_CURRENT, S["book_days"] // 2, rng)
            mt = gr.loss_metrics(res.bad_debt_total, res.weight)
            rows5.append({"資產": a, "L": 5, "情境": "current", "E": mt["mean"], "P>0": mt["p_pos"],
                          "VaR99": mt["var99"], "ES99": mt["es99"]})
            books[(a, "current_L5")] = (st, "Low", 5, res)
        summary["gap_all_L5_current"] = rows5

        fig, ax = plt.subplots(figsize=(9, 4.6))
        k = 0
        for a in cals:
            for infra, ls in ((INFRA_CURRENT, "-"), (INFRA_IMPROVED, "--")):
                key = (a, "current_L5") if infra is INFRA_CURRENT else None
                if key is None:
                    continue
                st, tier, L, res = books[key]
                w = res.weight / res.weight.sum()
                x = res.bad_debt_total
                o = np.argsort(x)
                sf = 1 - np.cumsum(w[o])
                ax.loglog(np.maximum(x[o], 1e-7) * 1e4, np.maximum(sf, 1e-7), color=SERIES[k], ls=ls,
                          label=f"{a}（L=5、現況）")
            k += 1
        ax.set_xlabel("單日壞帳（bps of OI，對數軸）")
        ax.set_ylabel("P(單日壞帳 > x)")
        ax.set_xlim(1e-2, None)
        ax.set_title("單日壞帳的尾端（L = 5 帳簿、現況基礎設施、含崩盤壓力）")
        ax.legend(fontsize=8)
        save(fig, OUT, "fig07_gap_tail", DOCS_FIG)

    # (e) 價格時效與開倉價偏離（相對刻度）
    if want(args, "gap_stale"):
        rng = rng_for(args.seed, 35)
        ages = [5 / 60, 0.25, 0.5, 1.0, 1.5, 2.83, 6.0]
        fig, ax = plt.subplots(figsize=(9, 4.6))
        for k, (a, c) in enumerate(cals.items()):
            p = c.merton()
            crypto = cal.ASSETS[a][2] == "1h"
            dh, yd = (24.0, 365.0) if crypto else (6.5, 252.0)
            vals = np.array([gr.stale_price_mispricing(p, age, rng, n=S["arb_n"], day_hours=dh, year_days=yd)
                             for age in ages])
            ax.plot(ages, vals / vals[-1], marker="o", color=SERIES[k], label=a)
        ax.axvline(1.5, color=INK_2, lw=1, ls="--")
        ax.text(1.55, 0.9, "實測平均推價間隔", fontsize=8, color=INK_2)
        ax.axvline(6.0, color=INK_2, lw=1, ls=":")
        ax.text(6.1, 0.75, "鏈上 maxPriceAge", fontsize=8, color=INK_2)
        ax.set_xscale("log")
        ax.set_xlabel("開倉可用的價格時效（小時，對數軸）")
        ax.set_ylabel("開倉價與市價的期望偏離（相對刻度，6 小時 = 1）")
        ax.set_title("價格時效與開倉價偏離（相對刻度）")
        ax.legend(fontsize=8)
        save(fig, OUT, "fig08_stale_price", DOCS_FIG)
    return books


# ── 1-4 保險庫 ─────────────────────────────────────────────────────────────────

def section_insurance(args, S, summary, cals, books, targets):
    log("1-4 保險庫償付")
    rng = rng_for(args.seed, 41)
    us = [0.0025, 0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.2]
    rows = []
    vault_rows = []
    fig, ax = plt.subplots(figsize=(9, 4.8))
    for k, a in enumerate(cals):
        for key, ls, lab in (((a, "current"), "-", "鏈上槓桿"), ((a, "current_L5"), "--", "L=5")):
            st, tier, L, res = books[key]
            if key[1] == "current_L5" and L == TIERS[ONCHAIN_ASSET_TIER[MODEL_TO_ONCHAIN[a]]].max_leverage:
                continue
            w = res.weight / res.weight.sum()
            incp = ins.VaultIncomeParams(fee_rate=TIERS[tier].f)
            income, loss = ins.daily_series(res.liq_equity, res.bad_debt_total, incp)
            M = ins.ruin_max_stat(income, loss, st.days_per_year, S["ruin_paths"], rng, w)
            ps = [ins.ruin_from_max(M, u) for u in us]
            floor = 1.0 / S["ruin_paths"]
            ax.plot(np.array(us) * 100, np.maximum(ps, floor * 0.5), marker="o", ls=ls, color=SERIES[k],
                    label=f"{a} {lab}（{L}x）")
            lb = ins.lundberg(income, loss, w)
            n_m = M.size
            srt = np.sort(M)
            q = 1 - targets.annual_ruin
            k_idx = n_m * q
            hw = 1.96 * math.sqrt(n_m * q * (1 - q))
            lo_i, hi_i = int(max(math.floor(k_idx - hw), 0)), int(min(math.ceil(k_idx + hw), n_m - 1))
            _, es99 = gr.var_es(loss, 0.99, w)
            vault_rows.append({
                "資產": a, "L": L, "分級": tier,
                "ruin": {f"{u:g}": [pr, 1.96 * math.sqrt(max(pr * (1 - pr), 1.0 / n_m) / n_m)] for u, pr in zip(us, ps)},
                "min_vault_ruin": ins.min_vault_from_max(M, targets.annual_ruin),
                "min_vault_ruin_ci": [max(float(srt[lo_i]), 0.0), max(float(srt[hi_i]), 0.0)],
                "es99": es99, "min_vault_es": es99 / targets.es99_frac_of_vault,
                "mean_income": float((income * w).sum()), "mean_loss": float((loss * w).sum()),
                "lundberg_R": lb["R"]})
            for u, pr in zip(us, ps):
                rows.append({"資產": a, "L": L, "分級": tier, "u0/OI": u, "年破產（MC）": pr,
                             "年破產（單日近似）": ins.ruin_approx(income, loss, u, st.days_per_year, w),
                             "Lundberg 上界": math.exp(-lb["R"] * u) if lb["R"] not in (0.0, float("inf")) else
                             (1.0 if lb["R"] == 0.0 else 0.0)})
    ax.axhline(targets.annual_ruin, color=INK_2, ls=":", lw=1)
    ax.text(0.27, targets.annual_ruin * 1.3, "目標 0.1%", fontsize=8, color=INK_2)
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_ylim(0.4 / S["ruin_paths"], 1.2)
    ax.set_xlabel("保險庫初始規模 u₀（佔該資產 OI 的 %，對數軸）")
    ax.set_ylabel(f"一年內被打穿的機率（MC {S['ruin_paths']:,} 條路徑；0 畫在底線）")
    ax.set_title("保險庫年破產機率（現況基礎設施、清算罰金 20% 進保險庫）")
    ax.legend(fontsize=7, ncol=2)
    save(fig, OUT, "fig09_ruin_vs_vault", DOCS_FIG)
    pd.DataFrame(rows).to_csv(TABLES / "ruin_vs_vault.csv", index=False, encoding="utf-8")
    summary["ruin_vs_vault"] = rows
    summary["vault_table"] = vault_rows

    # 全路徑 MC 對照（ETH L=5：近似式 vs 完整 bootstrap）
    st, tier, L, res = books[("ETH", "current")]
    w = res.weight / res.weight.sum()
    income, loss = ins.daily_series(res.liq_equity, res.bad_debt_total, ins.VaultIncomeParams(fee_rate=TIERS[tier].f))
    checks = []
    M = ins.ruin_max_stat(income, loss, st.days_per_year, S["ruin_paths"], rng, w)
    for u in (0.005, 0.01, 0.02, 0.05):
        mc = ins.ruin_mc(income, loss, u, st.days_per_year, S["ruin_paths"], rng, w)
        checks.append({"u0": u, "single_day_approx": ins.ruin_approx(income, loss, u, st.days_per_year, w),
                       "max_stat": ins.ruin_from_max(M, u), "path_mc": mc["p_ruin"], "path_mc_se": mc["se"],
                       "final_median": mc["final_median"]})
    summary["ruin_mc_check_ETH"] = checks
    lb = ins.lundberg(income, loss, w)
    summary["lundberg_ETH"] = lb

    # 樣本路徑
    fig, ax = plt.subplots(figsize=(9, 4.4))
    pw = w
    cdf = np.cumsum(pw)
    for i in range(30):
        idx = np.minimum(np.searchsorted(cdf, rng.random(365)), cdf.size - 1)
        u = np.empty(366)
        u[0] = 0.02
        for d in range(365):
            u[d + 1] = max(u[d] - loss[idx[d]], 0) + income[idx[d]]
        ax.plot(np.arange(366), u * 100, color=SERIES[0], alpha=0.35, lw=1)
    ax.set_xlabel("天")
    ax.set_ylabel("保險庫餘額（% of OI）")
    ax.set_title("ETH 5x 帳簿、u₀ = 2% OI 的保險庫餘額樣本路徑（30 條）")
    save(fig, OUT, "fig10_vault_paths", DOCS_FIG)

    # 敏感度：保險庫分配比例、ADL 先吸收（反事實）
    rng = rng_for(args.seed, 42)
    s_eth = asset_setup("ETH", cals["ETH"])
    shares = [0.0, 0.1, 0.2, 0.4, 0.6, 0.95]
    sw = inv.vault_share_sweep(s_eth, 5, ONCHAIN.m, "Low", INFRA_CURRENT, shares, S["share_days"], rng, targets,
                               ruin_paths=S["ruin_paths"])
    summary["vault_share_sweep_ETH"] = sw
    pd.DataFrame(sw).to_csv(TABLES / "vault_share_sweep.csv", index=False, encoding="utf-8")

    adl_rows = []
    for a in cals:
        st, tier, L, res = books[(a, "current_L5")]
        w = res.weight / res.weight.sum()
        incp = ins.VaultIncomeParams(fee_rate=TIERS[tier].f)
        income, loss = ins.daily_series(res.liq_equity, res.bad_debt_total, incp)
        loss_adl = np.maximum(loss - res.adl_capacity, 0.0)
        rs = np.random.default_rng([args.seed, 43, len(adl_rows)])
        M1 = ins.ruin_max_stat(income, loss, st.days_per_year, S["ruin_paths"], rs, w)
        rs = np.random.default_rng([args.seed, 43, len(adl_rows)])   # 同一組亂數（common random numbers）
        M2 = ins.ruin_max_stat(income, loss_adl, st.days_per_year, S["ruin_paths"], rs, w)
        adl_rows.append({"資產": a, "L": L,
                         "最小保險庫（程式：先保險庫）": ins.min_vault_from_max(M1, targets.annual_ruin),
                         "最小保險庫（反事實：先 ADL）": ins.min_vault_from_max(M2, targets.annual_ruin)})
    summary["adl_counterfactual"] = adl_rows

    fig, axes = plt.subplots(1, 2, figsize=(12, 4.4))
    axes[0].plot(np.array(shares) * 100, [r["min_vault_ruin"] * 100 for r in sw], marker="o", color=SERIES[0])
    axes[0].axvline(20, color=INK_2, ls=":", lw=1)
    axes[0].set_xlabel("清算罰金進保險庫的比例（%）；清算人固定 5%")
    axes[0].set_ylabel("達到年破產 < 0.1% 的最小保險庫（% of OI）")
    axes[0].set_title("ETH 5x：保險庫分配比例的敏感度")
    xs = np.arange(len(adl_rows))
    axes[1].bar(xs - 0.2, [r["最小保險庫（程式：先保險庫）"] * 100 for r in adl_rows], 0.4, color=SERIES[0],
                label="程式：先保險庫、後 ADL")
    axes[1].bar(xs + 0.2, [r["最小保險庫（反事實：先 ADL）"] * 100 for r in adl_rows], 0.4, color=SERIES[1],
                label="反事實：先 ADL（掃描 25% 的槽）")
    axes[1].set_xticks(xs, [r["資產"] for r in adl_rows])
    axes[1].set_ylabel("最小保險庫（% of OI）")
    axes[1].set_title("L = 5 帳簿：ADL 順序對保險庫需求的影響")
    axes[1].legend(fontsize=8)
    save(fig, OUT, "fig11_vault_sensitivity", DOCS_FIG)


# ── 1-5 資金費率 ───────────────────────────────────────────────────────────────

def section_funding(args, S, summary):
    log("1-5 資金費率")
    rng = rng_for(args.seed, 51)
    xs = np.linspace(-0.995, 0.995, 801)
    rates = np.array([fd.funding_rate_from_x(x) for x in xs])
    summary["funding_examples"] = {"2:1": fd.funding_rate_bps(2 * 10**18, 10**18),
                                   "max_one_side_tiny": fd.funding_rate_bps(10**24, 1),
                                   "dead_zone_x": 1 / 75}
    thetas = [5, 10, 20, 50, 100]
    rows = []
    hours = 24 * 30
    for th in thetas:
        kc, kd = fd.kappa_continuous(th), fd.kappa_discrete(th)
        t, Xb = fd.simulate_imbalance(th, 0.02, "block", hours, 0.25, S["funding_paths"], rng, x0=0.0)
        t, X8 = fd.simulate_imbalance(th, 0.02, "8h", hours, 0.25, S["funding_paths"], rng, x0=0.0)
        rows.append({"θ": th, "κ_block（/h）": kc, "半衰期 block（h）": fd.half_life_h(kc),
                     "κ_8h（/h）": kd, "半衰期 8h（h）": fd.half_life_h(kd),
                     "擬合 κ block": fd.fit_ou_kappa(t, Xb), "擬合 κ 8h": fd.fit_ou_kappa(t, X8)})
    df = pd.DataFrame(rows)
    df.to_csv(TABLES / "funding_half_life.csv", index=False, encoding="utf-8")
    summary["funding_half_life"] = rows

    summary["funding_buffer_exhaust_intervals"] = {
        f"{tier}_{L}x": fd.buffer_exhaust_intervals(L, ONCHAIN.m, TIERS[tier].f)
        for tier, L in (("Low", 5), ("Low", 2), ("Mid", 2), ("High", 1))}

    fig, axes = plt.subplots(1, 3, figsize=(15, 4.4))
    axes[0].step(xs, rates, where="mid", color=SERIES[0], label="程式：兩段截斷（整數 bps）")
    axes[0].plot(xs, 75 * xs, color=SERIES[1], ls="--", lw=1.2, label="線性 75·X")
    axes[0].set_xlabel("OI 失衡 X = (OI_L − OI_S)/(OI_L + OI_S)")
    axes[0].set_ylabel("付方費率（bps／8h）")
    axes[0].set_title("資金費率函數（|X| < 1/75 時為 0）")
    axes[0].legend(fontsize=8)
    ins_ax = axes[0].inset_axes([0.58, 0.08, 0.38, 0.38])
    zx = np.linspace(-0.05, 0.05, 401)
    ins_ax.step(zx, [fd.funding_rate_from_x(v) for v in zx], where="mid", color=SERIES[0])
    ins_ax.plot(zx, 75 * zx, color=SERIES[1], ls="--", lw=1)
    ins_ax.tick_params(labelsize=6)

    th = 20
    t, Xb = fd.simulate_imbalance(th, 0.02, "block", 24 * 14, 0.25, 3, rng, x0=0.6)
    t, X8 = fd.simulate_imbalance(th, 0.02, "8h", 24 * 14, 0.25, 3, rng, x0=0.6)
    t, Xs = fd.simulate_imbalance(th, 0.02, "8h_transient", 24 * 14, 0.25, 3, rng, x0=0.6)
    for i in range(3):
        axes[1].plot(t / 24, Xb[i], color=SERIES[0], lw=1, alpha=0.8, label="每區塊累積（線性）" if i == 0 else None)
        axes[1].plot(t / 24, X8[i], color=SERIES[1], lw=1, alpha=0.8, label="程式：8h＋截斷（回復資金持續持有）" if i == 0 else None)
        axes[1].plot(t / 24, Xs[i], color=SERIES[2], lw=1, alpha=0.8, label="程式：8h 快照、持有時間不加權（回復資金不持續停留）" if i == 0 else None)
    axes[1].plot(t / 24, 0.6 * np.exp(-fd.kappa_continuous(th) * t), color="black", ls=":", lw=1.2, label="OU 理論均值")
    axes[1].set_xlabel("天")
    axes[1].set_ylabel("X")
    axes[1].set_title(f"失衡回復（θ = {th}、η = 0.02/√h）")
    axes[1].legend(fontsize=7)

    tt = np.array(thetas, dtype=float)
    axes[2].plot(tt, [fd.half_life_h(fd.kappa_continuous(v)) for v in tt], marker="o", color=SERIES[0], label="每區塊（理論）")
    axes[2].plot(tt, [fd.half_life_h(fd.kappa_discrete(v)) for v in tt], marker="s", color=SERIES[1], label="8h 一次（理論）")
    axes[2].plot(tt, [math.log(2) / max(r["擬合 κ 8h"], 1e-9) for r in rows], marker="^", ls="--", color=SERIES[2],
                 label="8h＋截斷（模擬擬合）")
    axes[2].set_xscale("log")
    axes[2].set_yscale("log")
    axes[2].set_xlabel("回復彈性 θ（每 8h 修正 θ·費率）")
    axes[2].set_ylabel("半衰期 ln2/κ（小時）")
    axes[2].set_title("半衰期與累積頻率")
    axes[2].legend(fontsize=8)
    save(fig, OUT, "fig12_funding", DOCS_FIG)


# ── 1-6 參數反推 ───────────────────────────────────────────────────────────────

def section_inverse(args, S, summary, cals, targets):
    log("1-6 參數反推")
    rng = rng_for(args.seed, 61)
    recs = []
    for a, c in cals.items():
        st = asset_setup(a, c)
        on_tier = ONCHAIN_ASSET_TIER[MODEL_TO_ONCHAIN[a]]
        for tier in ("Low", "Mid", "High"):
            for infra in (INFRA_CURRENT, INFRA_IMPROVED):
                r = inv.recommend_L_m(st, tier, infra, S["inv_days"], rng, targets, ruin_paths=S["ruin_paths"])
                cur = next((x for x in r["tried"] if x["L"] == TIERS[tier].max_leverage and x["m"] == ONCHAIN.m), None)
                if cur is None:
                    cur = inv.evaluate(st, TIERS[tier].max_leverage, ONCHAIN.m, tier, infra, S["inv_days"], rng,
                                       targets, ruin_paths=S["ruin_paths"])
                b = r["best"]
                recs.append({"資產": a, "鏈上分級": on_tier, "分級": tier, "情境": infra.name,
                             "現值 L": TIERS[tier].max_leverage, "現值 m": ONCHAIN.m,
                             "現值 ES99": cur["es99"], "現值 年破產": cur["annual_ruin"],
                             "現值 最小保險庫": cur["min_vault"],
                             "建議 L": None if b is None else b["L"], "建議 m": None if b is None else b["m"],
                             "建議 ES99": None if b is None else b["es99"],
                             "建議 年破產": None if b is None else b["annual_ruin"],
                             "建議 最小保險庫": None if b is None else b["min_vault"]})
    df = pd.DataFrame(recs)
    df.to_csv(TABLES / "inverse_L_m.csv", index=False, encoding="utf-8")
    summary["inverse_L_m"] = recs

    # 推價間隔 × 清算人反應（ETH Low 5x、建議 m）
    rng = rng_for(args.seed, 62)
    s_eth = asset_setup("ETH", cals["ETH"])
    eth_rec = next(r for r in recs if r["資產"] == "ETH" and r["分級"] == "Low" and r["情境"] == "improved")
    L_e = eth_rec["建議 L"] or 1
    m_e = eth_rec["建議 m"] or ONCHAIN.m
    sw = inv.sweep_infra(s_eth, L_e, m_e, "Low", [1 / 60, 0.25, 1.0, 1.5, 3.0], [0.0, 0.25, 1.0, 4.0],
                         S["sweep_days"], rng, targets, ruin_paths=S["ruin_paths"])
    pd.DataFrame(sw).to_csv(TABLES / "inverse_infra_sweep.csv", index=False, encoding="utf-8")
    summary["inverse_infra_sweep"] = [{k: v for k, v in r.items() if k in ("push_h", "rho_h", "es99", "annual_ruin",
                                                                          "min_vault", "feasible", "mean_loss")}
                                      for r in sw]

    fig, ax = plt.subplots(figsize=(8.5, 4.6))
    pushes = sorted({r["push_h"] for r in sw})
    rhos = sorted({r["rho_h"] for r in sw})
    Z = np.array([[next(r["min_vault"] for r in sw if r["push_h"] == d and r["rho_h"] == rho) for d in pushes]
                  for rho in rhos])
    Zc = np.where(np.isfinite(Z), Z, np.nan) * 100
    im = ax.imshow(Zc, origin="lower", cmap=SEQ_CMAP, aspect="auto")
    ax.grid(False)
    ax.set_xticks(range(len(pushes)), [f"{d * 60:.0f} 分" if d < 1 else f"{d:g} 時" for d in pushes])
    ax.set_yticks(range(len(rhos)), ["bot" if r == 0 else (f"{r * 60:.0f} 分" if r < 1 else f"{r:g} 時") for r in rhos])
    for i in range(len(rhos)):
        for j in range(len(pushes)):
            v = Zc[i, j]
            ax.text(j, i, "∞" if not np.isfinite(v) else f"{v:.2f}%", ha="center", va="center", fontsize=8,
                    color="white" if np.isfinite(v) and (v - np.nanmin(Zc)) > 0.6 * (np.nanmax(Zc) - np.nanmin(Zc) + 1e-300) else "black")
    ax.set_xlabel("推價間隔 Δ_p")
    ax.set_ylabel("清算人平均到達間隔 ρ")
    ax.set_title(f"ETH Low {L_e}x、m={m_e:.1%}：滿足兩個目標所需的最小保險庫（% of OI）")
    fig.colorbar(im, ax=ax, fraction=0.046)
    save(fig, OUT, "fig13_inverse_infra", DOCS_FIG)

    # 保險庫分配比例：滿足 T1 的最小比例
    sw_share = summary.get("vault_share_sweep_ETH", [])
    feas_share = [r["vault_share"] for r in sw_share if r["annual_ruin"] <= targets.annual_ruin]
    summary["min_vault_share_ETH"] = min(feas_share) if feas_share else None

    # 建議參數表
    table = build_recommendation(recs, sw, summary, targets)
    summary["recommendation"] = table
    pd.DataFrame(table).to_csv(TABLES / "recommendation.csv", index=False, encoding="utf-8")
    (TABLES / "recommendation.md").write_text(df_to_md(pd.DataFrame(table)) + "\n", encoding="utf-8")


def build_recommendation(recs, sweep, summary, targets):
    def rec_for(asset, tier, infra):
        return next(r for r in recs if r["資產"] == asset and r["分級"] == tier and r["情境"] == infra)

    rows = []
    # 逐資產（maxLeverageOf／maintenanceMarginBpsOf 都是逐資產 setter）：以鏈上實際分級評估
    for a in ("BTC", "ETH", "AAPL", "TSLA"):
        tier = ONCHAIN_ASSET_TIER[MODEL_TO_ONCHAIN[a]]
        for infra in ("current", "improved"):
            r = rec_for(a, tier, infra)
            lab = "現況" if infra == "current" else "改善後"
            L, m = r["建議 L"], r["建議 m"]
            rows.append({"參數": f"{MODEL_TO_ONCHAIN[a]} 槓桿上限（{tier}）", "基礎設施": lab,
                         "現值": f"{TIERS[tier].max_leverage}x", "建議": "無可行值" if L is None else f"{L}x",
                         "依據": f"現值：ES99 {fmt_pct(r['現值 ES99'], 3)} OI、年破產 {fmt_pct(r['現值 年破產'], 3)}、"
                               f"最小保險庫 {fmt_pct(r['現值 最小保險庫'])} OI"})
            rows.append({"參數": f"{MODEL_TO_ONCHAIN[a]} MMR", "基礎設施": lab, "現值": "500 bps",
                         "建議": "—" if m is None else f"{m * 1e4:.0f} bps",
                         "依據": "—" if L is None else f"建議值：ES99 {fmt_pct(r['建議 ES99'], 3)} OI、"
                                                        f"最小保險庫 {fmt_pct(r['建議 最小保險庫'])} OI"})
    feas = [r for r in sweep if r["feasible"]]
    best_push = max((r["push_h"] for r in feas), default=None)
    best_rho = max((r["rho_h"] for r in feas if r["push_h"] == best_push), default=None) if best_push else None
    rows.append({"參數": "推價間隔 Δ_p", "基礎設施": "—", "現值": "cron 15 分（實測 68–169 分，平均約 90 分）",
                 "建議": "常駐 keeper、分鐘級，並以價格偏離觸發補強",
                 "依據": "價格時效過長屬高風險（見文件 §3.5）；單看壞帳目標，可行的最大間隔為 "
                       f"{'—' if best_push is None else format(best_push * 60, '.0f') + ' 分'}"})
    rows.append({"參數": "清算檢查（清算人反應）", "基礎設施": "—", "現值": "無清算 bot（只有前端手動）",
                 "建議": "常駐清算 bot，每次推價後立即檢查",
                 "依據": f"壞帳目標下可行的最大平均反應時間（Δ_p = {'—' if best_push is None else format(best_push * 60, '.0f') + ' 分'}）："
                       f"{'—' if best_rho is None else ('bot' if best_rho == 0 else format(best_rho * 60, '.0f') + ' 分')}；"
                       "倉位資不抵債時清算人沒有獎勵"})
    rows.append({"參數": "maxPriceAge（exchange）", "基礎設施": "現況", "現值": "6 h（原始碼預設 24 h）",
                 "建議": "降低，下限為實測最長推價間隔",
                 "依據": "低於推價間隔會讓正常運作 revert；高於它只會擴大價格時效風險"})
    rows.append({"參數": "開倉可用的價格時效", "基礎設施": "改善後", "現值": "與 maxPriceAge 相同（6 h）",
                 "建議": "遠小於現值；或延遲成交、以成交後的價格結算",
                 "依據": "價格時效過長屬高風險，風險與 maxPriceAge、推價間隔同向增加；單靠縮短 maxPriceAge 無法完全消除"})
    ms = summary.get("min_vault_share_ETH")
    rows.append({"參數": "清算人獎勵", "基礎設施": "—", "現值": "5%（constant）", "建議": "5%（維持）",
                 "依據": "改動要重新部署；closeAmount ≤ 0 時清算人拿 0，壞帳倉位沒有誘因，必須靠協議自營 bot"})
    rows.append({"參數": "保險庫分配（liquidationPenaltyBps）", "基礎設施": "—", "現值": "20%",
                 "建議": "20%（維持）" if (ms is None or ms <= 0.2) else f"{ms:.0%}",
                 "依據": f"ETH 5x、u₀={targets.vault_to_oi:.0%} 時，滿足年破產 < {targets.annual_ruin:.1%} 的最小比例是 "
                       f"{'—' if ms is None else format(ms, '.0%')}（尾端由單日跳空主導，罰金收入幫助有限）；"
                       f"提高比例可降低所需保險庫：" + "、".join(
                           f"{r['vault_share']:.0%} → {r['min_vault_ruin']:.1%}"
                           for r in summary.get("vault_share_sweep_ETH", []) if r["vault_share"] in (0.0, 0.2, 0.95))
                       + " of OI"})
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description="PepeLab Phase 1 風險模型：一鍵重現")
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--refresh-data", action="store_true")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--vault-to-oi", type=float, default=0.05)
    ap.add_argument("--es-frac", type=float, default=0.10)
    ap.add_argument("--ruin-target", type=float, default=0.001)
    ap.add_argument("--seed", type=int, default=20261005)
    ap.add_argument("--only", type=str, default=None,
                    help="只跑指定段落（逗號分隔）：" + ",".join(SECTIONS))
    args = ap.parse_args(argv)
    if args.only is not None:
        args.only = set(x.strip() for x in args.only.split(",") if x.strip())
        bad = args.only - set(SECTIONS)
        if bad:
            ap.error(f"未知段落：{sorted(bad)}")
        if "insurance" in args.only:
            args.only.add("gap_books")
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass
    mode = "quick" if args.quick else "full"
    S = SIZES[mode]
    global OUT, TABLES, DOCS_FIG
    if args.quick:
        # 小樣本的圖表與表格放 output/quick/（不進版控），不覆寫文件引用的完整模式圖檔
        OUT = HERE / "output" / "quick"
        TABLES = OUT / "tables"
        DOCS_FIG = None
    OUT.mkdir(parents=True, exist_ok=True)
    TABLES.mkdir(parents=True, exist_ok=True)
    font = setup_fonts()
    targets = inv.Targets(annual_ruin=args.ruin_target, es99_frac_of_vault=args.es_frac, vault_to_oi=args.vault_to_oi)
    t0 = time.time()
    summary = {"mode": mode, "seed": args.seed, "font": font, "targets": asdict(targets),
               "crash_overlay": {"lam": CRASH[0], "mu": CRASH[1], "sigma": CRASH[2]},
               "infra": {i.name: asdict(i) for i in (INFRA_CURRENT, INFRA_BOT, INFRA_IMPROVED)},
               "onchain": asdict(ONCHAIN)}
    cals = section_calibration(args, S, summary)
    if want(args, "liquidation"):
        section_liquidation(args, S, summary, cals)
    books = section_gap(args, S, summary, cals)
    if want(args, "insurance"):
        section_insurance(args, S, summary, cals, books, targets)
    if want(args, "funding"):
        section_funding(args, S, summary)
    if want(args, "inverse"):
        section_inverse(args, S, summary, cals, targets)
    summary["elapsed_s"] = round(time.time() - t0, 1)
    out = OUT / f"summary_{mode}.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=1, default=_json_default), encoding="utf-8")
    log(f"完成：{out}（{summary['elapsed_s']} 秒，字型 {font}）")
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
