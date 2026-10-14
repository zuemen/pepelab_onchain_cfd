"""events.json → frontend/public/data/heroes/。用法：python build_analytics.py [events.json]"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

from herolab.analytics import build_outputs
from herolab.prices import load_prices

HERE = Path(__file__).parent
OUT = HERE.parent / "frontend" / "public" / "data" / "heroes"


def main() -> None:
    events_path = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "out" / "events.json"
    doc = json.loads(events_path.read_text())
    start, end = (dt.date.fromisoformat(doc["range"][k]) for k in ("from", "to"))
    index, details = build_outputs(doc, load_prices(HERE / "prices", start, end))
    OUT.mkdir(parents=True, exist_ok=True)
    for stale in OUT.glob("*.json"):  # 上一次回放留下、這次已不存在的交易者
        stale.unlink()
    (OUT / "index.json").write_text(json.dumps(index, indent=1) + "\n", newline="\n")
    for address, detail in details.items():
        (OUT / f"{address}.json").write_text(json.dumps(detail) + "\n", newline="\n")
    print(f"{OUT}: index.json + {len(details)} traders, {doc['range']['from']} .. {doc['range']['to']}")


if __name__ == "__main__":
    main()
