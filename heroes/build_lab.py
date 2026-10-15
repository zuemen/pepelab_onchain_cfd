"""策略實驗室的資料（issue #332）→ frontend/public/data/lab/。

  python build_lab.py              # 全部組合；資料期間與交易者排行榜相同（2024-10-01 到價格檔最後一天）
  python build_lab.py --end 2026-10-13

只讀 prices/*.csv，不需要本機鏈。同樣的價格檔跑兩次，輸出逐位元組相同。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from build_schedule import FIRST, last_common_close
from herolab.labdata import Lab, combos, result_name
from herolab.prices import load_prices

HERE = Path(__file__).parent
OUT = HERE.parent / "frontend" / "public" / "data" / "lab"

_lab: Lab | None = None


def _init(start: dt.date, end: dt.date) -> None:
    global _lab
    _lab = Lab(load_prices(HERE / "prices", FIRST, end), start, end)


def _one(i: int) -> tuple[str, str]:
    spec, target, params = combos()[i]
    return result_name(spec.id, target, params.values()), json.dumps(_lab.result(spec, target, params),
                                                                      separators=(",", ":"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default="2024-10-01")
    parser.add_argument("--end", default=None)
    parser.add_argument("--workers", type=int, default=os.cpu_count())
    args = parser.parse_args()
    start = dt.date.fromisoformat(args.start)
    end = dt.date.fromisoformat(args.end) if args.end else last_common_close(HERE / "prices")

    began = time.time()
    _init(start, end)
    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("*.json"):
        stale.unlink()
    total = len(combos())
    with ProcessPoolExecutor(args.workers, initializer=_init, initargs=(start, end)) as pool:
        for n, (name, body) in enumerate(pool.map(_one, range(total), chunksize=4), 1):
            (OUT / name).write_text(body + "\n", newline="\n")
            if n % 25 == 0 or n == total:
                print(f"{n}/{total} ({time.time() - began:.0f}s)", flush=True)
    (OUT / "index.json").write_text(json.dumps(_lab.index(), indent=1) + "\n", newline="\n")
    size = sum(p.stat().st_size for p in OUT.glob("*.json"))
    print(f"{OUT}: index.json + {total} results, {start} .. {end}, {size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
