#!/usr/bin/env python3
"""Generate ChessGUI app icon — a chessboard with Lichess-style green squares."""

from PIL import Image, ImageDraw
import os
import subprocess
import tempfile

ICON_DIR = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")

# Lichess green board colors
LIGHT = (235, 236, 208)   # cream
DARK = (115, 149, 82)     # green


def generate_icon(size):
    """Generate a chessboard icon at given size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    margin = size * 0.06
    r = size * 0.16
    x0, y0 = margin, margin
    x1, y1 = size - margin, size - margin
    board_size = x1 - x0
    sq = board_size / 8

    # Draw rounded rect background (light square color as base)
    draw.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=LIGHT)

    # Draw dark squares
    for row in range(8):
        for col in range(8):
            if (row + col) % 2 == 1:
                sx = x0 + col * sq
                sy = y0 + row * sq
                draw.rectangle([sx, sy, sx + sq, sy + sq], fill=DARK)

    # Mask to rounded corners
    mask = Image.new("L", (size, size), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=255)

    bg = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    img = Image.composite(img, bg, mask)

    return img


def create_icns(icon_path):
    """Create .icns from PNGs using iconutil."""
    iconset_dir = os.path.join(tempfile.mkdtemp(), "icon.iconset")
    os.makedirs(iconset_dir)

    sizes = [16, 32, 64, 128, 256, 512]
    for s in sizes:
        img = generate_icon(s)
        img.save(os.path.join(iconset_dir, f"icon_{s}x{s}.png"))
        img2x = generate_icon(s * 2)
        img2x.save(os.path.join(iconset_dir, f"icon_{s}x{s}@2x.png"))

    subprocess.run(["iconutil", "-c", "icns", iconset_dir, "-o", icon_path], check=True)
    print(f"Created {icon_path}")


def main():
    os.makedirs(ICON_DIR, exist_ok=True)

    for size, name in [(32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png")]:
        img = generate_icon(size)
        path = os.path.join(ICON_DIR, name)
        img.save(path)
        print(f"Created {path}")

    icns_path = os.path.join(ICON_DIR, "icon.icns")
    create_icns(icns_path)

    img16 = generate_icon(16)
    img32 = generate_icon(32)
    img48 = generate_icon(48)
    img256 = generate_icon(256)
    ico_path = os.path.join(ICON_DIR, "icon.ico")
    img256.save(ico_path, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (256, 256)],
                append_images=[img16, img32, img48])
    print(f"Created {ico_path}")


if __name__ == "__main__":
    main()
