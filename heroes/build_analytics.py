"""events.json → frontend/public/data/heroes/<chainId>/。
  python build_analytics.py [events.json] [--out <dir>]
資料依鏈分開（#344）：本機展示讀 31337/、公開站讀 84532/。--out 指定別的目錄（fork 演練用，不碰前端的資料）。
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

from herolab.analytics import build_outputs
from herolab.prices import load_prices

HERE = Path(__file__).parent
DATA = HERE.parent / "frontend" / "public" / "data" / "heroes"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("events", nargs="?", default=str(HERE / "out" / "events.json"))
    parser.add_argument("--out", default=None, help="輸出目錄；預設 frontend/public/data/heroes/<chainId>/")
    args = parser.parse_args()

    doc = json.loads(Path(args.events).read_text())
    out = Path(args.out) if args.out else DATA / str(doc["chainId"])
    start, end = (dt.date.fromisoformat(doc["range"][k]) for k in ("from", "to"))
    index, details = build_outputs(doc, load_prices(HERE / "prices", start, end))
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*.json"):  # 上一次回放留下、這次已不存在的交易者
        stale.unlink()
    (out / "index.json").write_text(json.dumps(index, indent=1) + "\n", newline="\n")
    for address, detail in details.items():
        (out / f"{address}.json").write_text(json.dumps(detail) + "\n", newline="\n")
    compressed = " (time-compressed)" if index["timeCompressed"] else ""
    print(f"{out}: index.json + {len(details)} traders, {doc['range']['from']} .. {doc['range']['to']}{compressed}")


if __name__ == "__main__":
    main()
