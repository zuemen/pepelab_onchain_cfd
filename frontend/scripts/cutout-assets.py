# -*- coding: utf-8 -*-
"""Turn the black-backdrop PNGs into transparent, web-sized WebP.

The generated artwork is drawn on opaque black. That is fine for a single
image on a dark page, but the moment two of them overlap — the frog sitting on
its mount — the upper one's black rectangle occludes the lower one. A CSS mask
cannot fix that: it only shapes the alpha at the edges, it cannot make the
interior black transparent.

So the background is removed here, once, offline:

  * Flood fill inwards from the four corners, following only near-black pixels.
    This is what keeps genuinely black *subject* matter — the elite frog's
    leather jacket, its sunglasses — opaque, because those are not connected to
    the border.
  * Inside a narrow band around that background, fade alpha by luminance
    instead of cutting hard, so the artwork's glow falls off smoothly rather
    than ending on a visible ring.
  * Un-premultiply the partially transparent pixels: the glow was painted
    *over* black, so its stored colour is already darkened by exactly the
    amount the alpha will darken it again.

Originals are left untouched; output goes to <out>/<name>.webp.
"""
import argparse
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

MAGIC = (255, 0, 255)      # sentinel colour the flood fill paints with
FILL_THRESH = 26           # how near-black a pixel must be to count as backdrop
GLOW_KNEE = 72             # luminance at which a band pixel is fully opaque
BAND_PX = 7                # width of the soft edge band, in output pixels


def dilate(mask: np.ndarray, iterations: int) -> np.ndarray:
    """Binary dilation with a plus-shaped kernel, via array shifts."""
    out = mask.copy()
    for _ in range(iterations):
        shifted = out.copy()
        shifted[1:, :] |= out[:-1, :]
        shifted[:-1, :] |= out[1:, :]
        shifted[:, 1:] |= out[:, :-1]
        shifted[:, :-1] |= out[:, 1:]
        out = shifted
    return out


def cutout(path: str, size: int) -> Image.Image:
    img = Image.open(path).convert('RGB')
    if img.size != (size, size):
        img = img.resize((size, size), Image.LANCZOS)

    # 1. Flood fill the connected backdrop from every corner.
    probe = img.copy()
    w, h = probe.size
    for xy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(probe, xy, MAGIC, thresh=FILL_THRESH)

    rgb = np.asarray(img, dtype=np.float32)
    bg = np.all(np.asarray(probe) == np.array(MAGIC, dtype=np.uint8), axis=-1)

    # 2. Alpha: transparent backdrop, opaque subject, luminance ramp between.
    luma = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    alpha = np.where(bg, 0.0, 255.0)
    band = dilate(bg, BAND_PX) & ~bg
    alpha[band] = np.clip(luma[band] / GLOW_KNEE, 0.0, 1.0) * 255.0

    alpha_img = Image.fromarray(alpha.astype(np.uint8), 'L').filter(
        ImageFilter.GaussianBlur(0.8)
    )
    alpha = np.asarray(alpha_img, dtype=np.float32)

    # 3. Un-premultiply so the glow keeps its brightness once composited.
    partial = (alpha > 0) & (alpha < 255)
    scale = np.ones_like(alpha)
    scale[partial] = 255.0 / alpha[partial]
    rgb = np.clip(rgb * scale[..., None], 0, 255)

    out = np.dstack([rgb, alpha]).astype(np.uint8)
    return Image.fromarray(out, 'RGBA')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('inputs', nargs='+', help='PNG files to process')
    ap.add_argument('--out', required=True, help='output directory')
    ap.add_argument('--size', type=int, default=640)
    ap.add_argument('--quality', type=int, default=82)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    total_in = total_out = 0
    for src in args.inputs:
        name = os.path.splitext(os.path.basename(src))[0]
        dst = os.path.join(args.out, name + '.webp')
        cutout(src, args.size).save(dst, 'WEBP', quality=args.quality, method=6)
        a, b = os.path.getsize(src), os.path.getsize(dst)
        total_in += a
        total_out += b
        print('%-28s %6.0f KB -> %5.0f KB' % (name, a / 1024, b / 1024))

    if total_in:
        print('total %.1f MB -> %.2f MB  (%.1f%% of original)'
              % (total_in / 1e6, total_out / 1e6, 100 * total_out / total_in))
    return 0


if __name__ == '__main__':
    sys.exit(main())
