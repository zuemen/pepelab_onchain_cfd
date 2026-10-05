"""繪圖共用設定：中文字型、配色、存檔。

字型：優先 Microsoft JhengHei（Windows 繁中）；找不到時依序退回 Noto Sans CJK TC／其他 CJK 字型，
都沒有就用 matplotlib 預設字型，不報錯（CI 的 ubuntu 沒有中文字型時，中文字會顯示成方框，但數字與圖形正確）。
配色：類別色依固定順序取用（不循環、不依排名上色）；大小用單一色相由淺到深。
"""
from __future__ import annotations

import logging
import shutil
import warnings
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib import font_manager  # noqa: E402

CANDIDATE_FONTS = ["Microsoft JhengHei", "Microsoft JhengHei UI", "Noto Sans CJK TC", "Noto Sans TC",
                   "PingFang TC", "Heiti TC", "WenQuanYi Zen Hei", "Noto Sans CJK JP", "SimHei"]

# 類別色（固定順序）：藍、橘、青綠、黃、洋紅、綠、紫、紅
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
INK = "#0b0b0b"
INK_2 = "#52514e"
GRID = "#e4e3df"
SURFACE = "#fcfcfb"
SEQ_CMAP = "Blues"

_FONT_USED: str | None = None


def setup_fonts() -> str:
    """設定中文字型並回傳實際使用的字型名稱（沒有 CJK 字型時回傳 'default'）。"""
    global _FONT_USED
    if _FONT_USED is not None:
        return _FONT_USED
    available = {f.name for f in font_manager.fontManager.ttflist}
    chosen = next((f for f in CANDIDATE_FONTS if f in available), None)
    logging.getLogger("matplotlib.font_manager").setLevel(logging.ERROR)
    warnings.filterwarnings("ignore", message="Glyph .* missing from font")
    warnings.filterwarnings("ignore", message=".*findfont.*")
    # DejaVu Sans 放第一：拉丁字母、數字與數學減號（U+2212，JhengHei 沒有）用它，
    # 中文逐字退回 CJK 字型（matplotlib ≥ 3.6 的 font.family 清單支援逐字 fallback）
    plt.rcParams.update({
        "font.family": ["DejaVu Sans", chosen] if chosen else ["DejaVu Sans"],
        "axes.unicode_minus": False,
        "mathtext.fontset": "dejavusans",
        "figure.facecolor": SURFACE,
        "axes.facecolor": SURFACE,
        "axes.edgecolor": INK_2,
        "axes.labelcolor": INK,
        "axes.titlecolor": INK,
        "xtick.color": INK_2,
        "ytick.color": INK_2,
        "axes.grid": True,
        "grid.color": GRID,
        "grid.linewidth": 0.8,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "lines.linewidth": 2.0,
        "lines.markersize": 6,
        "legend.frameon": False,
        "figure.dpi": 110,
        "savefig.dpi": 130,
        "axes.prop_cycle": matplotlib.cycler(color=SERIES),
    })
    _FONT_USED = chosen or "default"
    return _FONT_USED


def save(fig, out_dir: Path, name: str, docs_dir: Path | None = None) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    p = out_dir / f"{name}.png"
    fig.tight_layout()
    fig.savefig(p, bbox_inches="tight")
    plt.close(fig)
    if docs_dir is not None:
        docs_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, docs_dir / p.name)
    return p
