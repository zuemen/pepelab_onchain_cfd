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
