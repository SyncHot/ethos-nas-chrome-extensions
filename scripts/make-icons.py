#!/usr/bin/env python3
"""Generate the browser-extension icons (no Pillow needed).

Mirrors `scripts/make_icons.py`: a rounded square with the EthOS gradient and a
download arrow glyph, rendered with 3x supersampling then box-filtered down for
clean edges at 16 px.

Run after changing the design:

    .venv/bin/python browser-extension/scripts/make-icons.py
"""

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"
SIZES = (16, 32, 48, 128)
SCALE = 3  # supersampling factor

# Theme colours (index.html: --accent / --surface-0 in dark mode).
TOP = (37, 99, 235)      # blue-600
BOTTOM = (15, 23, 42)    # slate-900
GLYPH = (219, 234, 254)  # blue-100


def _blend(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return (
        round(a[0] + (b[0] - a[0]) * t),
        round(a[1] + (b[1] - a[1]) * t),
        round(a[2] + (b[2] - a[2]) * t),
    )


def _in_rounded_rect(px: float, py: float, x0: float, y0: float, x1: float, y1: float, r: float) -> bool:
    if px < x0 or px >= x1 or py < y0 or py >= y1:
        return False
    cx = min(max(px, x0 + r), x1 - r)
    cy = min(max(py, y0 + r), y1 - r)
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r


def _in_triangle(px: float, py: float, cx: float, y0: float, y1: float, half_width: float) -> bool:
    if not (y0 <= py < y1):
        return False
    t = (py - y0) / max(1e-6, y1 - y0)
    return abs(px - cx) <= half_width * (1.0 - t)


def render(size: int) -> bytes:
    """Return RGBA rows for one icon at `size` px (supersampled internally)."""
    big = size * SCALE
    inset = big * 0.14

    # Download arrow metrics, in supersampled pixels.
    cx = big / 2
    stem_w = big * 0.13
    stem_top = inset + big * 0.10
    stem_bottom = inset + big * 0.40
    head_top = inset + big * 0.33
    head_bottom = inset + big * 0.58
    head_half = big * 0.20
    tray_y0 = inset + big * 0.60
    tray_y1 = inset + big * 0.68
    tray_x0 = inset + big * 0.10
    tray_x1 = big - inset - big * 0.10
    tray_r = (tray_y1 - tray_y0) / 2

    pixels = bytearray()
    for y in range(big):
        pixels.append(0)  # PNG filter type 0
        for x in range(big):
            px, py = x + 0.5, y + 0.5
            if not _in_rounded_rect(px, py, 0, 0, big, big, big * 0.22):
                pixels.extend((0, 0, 0, 0))
                continue
            t = y / max(1, big - 1)
            r, g, b = _blend(TOP, BOTTOM, t)

            in_stem = _in_rounded_rect(
                px, py,
                cx - stem_w / 2, stem_top,
                cx + stem_w / 2, stem_bottom,
                stem_w / 2,
            )
            in_head = _in_triangle(px, py, cx, head_top, head_bottom, head_half)
            in_tray = _in_rounded_rect(px, py, tray_x0, tray_y0, tray_x1, tray_y1, tray_r)

            if in_stem or in_head or in_tray:
                r, g, b = GLYPH
            pixels.extend((r, g, b, 255))

    # Box-filter down to the requested size.
    row_len = big * 4
    out = bytearray()
    for y in range(size):
        for x in range(size):
            rs = gs = bs = als = 0
            for dy in range(SCALE):
                base = (y * SCALE + dy) * row_len + x * SCALE * 4
                for dx in range(SCALE):
                    off = base + dx * 4
                    rs += pixels[off]
                    gs += pixels[off + 1]
                    bs += pixels[off + 2]
                    als += pixels[off + 3]
            count = SCALE * SCALE
            out.extend((rs // count, gs // count, bs // count, als // count))
    return bytes(out)


def write_png(path: Path, size: int, pixels: bytes) -> None:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data)) + kind + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(pixels, 9))
        + chunk(b"IEND", b"")
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)
    print(f"  {path.name}: {size}x{size}, {len(png):,} bytes")


def main() -> None:
    print("Writing extension icons to", OUT)
    for size in SIZES:
        write_png(OUT / f"icon{size}.png", size, render(size))


if __name__ == "__main__":
    main()
