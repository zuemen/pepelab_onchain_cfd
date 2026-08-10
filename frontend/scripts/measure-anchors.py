# -*- coding: utf-8 -*-
"""Measure the anchor lines the hero layout needs, from the cut-out WebP.

These must come from the *final* transparent art, not the source PNGs.

  groundY  The contact line: where the artwork visually meets the floor. This is
           NOT the bottom-most opaque pixel — every image carries its own glow
           ring / shadow that fades well below the subject, and anchoring on
           that left each piece hovering with its dark ring sitting on top of
           the golden podium instead of merging with it. Instead this is the
           widest row in the lower third, i.e. the major axis of that built-in
           ring, so the podium ends up concentric with it and the two read as
           one stage.

  seatY    (mounts) where a rider stands: the top surface at the centre of the
           mount, then 30% of the way down toward the contact line, so the frog
           sits on the deck rather than perching on the far edge.

Prints JSON keyed by file stem.
"""
import argparse
import json
import os

import numpy as np
from PIL import Image

OPAQUE = 24  # alpha above which a pixel counts as content


def anchors(path: str) -> dict:
    alpha = np.asarray(Image.open(path).convert('RGBA'))[..., 3]
    h, w = alpha.shape
    solid = alpha > OPAQUE

    rows = np.nonzero(solid.any(axis=1))[0]
    top, bottom = int(rows.min()), int(rows.max())

    lower = int(bottom - 0.35 * (bottom - top))
    widths = solid[lower:bottom + 1].sum(axis=1)
    ground = (lower + int(np.argmax(widths))) / h

    cols = np.nonzero(solid.any(axis=0))[0]
    out = {
        'groundY': round(ground, 3),
        'centreX': round(float(cols.min() + cols.max()) / 2 / w, 3),
    }

    centre_band = solid[:, int(w * 0.40):int(w * 0.60)]
    band_rows = np.nonzero(centre_band.any(axis=1))[0]
    if len(band_rows):
        deck = float(band_rows.min()) / h
        out['seatY'] = round(deck + 0.30 * (ground - deck), 3)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('inputs', nargs='+')
    args = ap.parse_args()
    print(json.dumps(
        {os.path.splitext(os.path.basename(p))[0]: anchors(p) for p in args.inputs},
        indent=1,
    ))


if __name__ == '__main__':
    main()
