"""Generate a crisp 256x256 Marketplace PNG icon (media/logo.png)."""

from __future__ import annotations

import pathlib
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_PNG = ROOT / "media" / "logo.png"

SIZE = 1024
FINAL_SIZE = 256


def lerp_color(c1: tuple[int, int, int], c2: tuple[int, int, int], t: float) -> tuple[int, int, int, int]:
    return (
        int(c1[0] + (c2[0] - c1[0]) * t),
        int(c1[1] + (c2[1] - c1[1]) * t),
        int(c1[2] + (c2[2] - c1[2]) * t),
        255,
    )


def main() -> None:
    OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded square gradient background
    bg = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(bg)
    top_col = (15, 23, 42)     # #0F172A
    bot_col = (30, 41, 59)     # #1E293B
    for y in range(SIZE):
        col = lerp_color(top_col, bot_col, y / (SIZE - 1))
        bg_draw.line([(0, y), (SIZE, y)], fill=col)

    mask = Image.new("L", (SIZE, SIZE), 0)
    mask_draw = ImageDraw.Draw(mask)
    pad = 32
    mask_draw.rounded_rectangle([pad, pad, SIZE - pad, SIZE - pad], radius=200, fill=255)
    img.paste(bg, (0, 0), mask)

    # Subtle outer border
    draw.rounded_rectangle(
        [pad, pad, SIZE - pad, SIZE - pad],
        radius=200,
        outline=(56, 189, 248, 85),
        width=10,
    )

    # Soft cyan glow behind center tunnel
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse([260, 260, 764, 764], fill=(56, 189, 248, 28))
    img = Image.alpha_composite(img, glow)
    draw = ImageDraw.Draw(img)

    # Top server node (Remote Offline Host)
    card_fill = (30, 58, 138, 110)
    card_outline = (96, 165, 250, 255)
    draw.rounded_rectangle([200, 180, 824, 380], radius=48, fill=card_fill, outline=card_outline, width=22)
    # Status LEDs on top server
    draw.ellipse([268, 256, 316, 304], fill=(52, 211, 153, 255))
    draw.rounded_rectangle([356, 266, 560, 294], radius=14, fill=(148, 163, 184, 190))

    # Bottom node (Local Workstation)
    draw.rounded_rectangle([200, 644, 824, 844], radius=48, fill=card_fill, outline=(56, 189, 248, 255), width=22)
    draw.ellipse([268, 720, 316, 768], fill=(56, 189, 248, 255))
    draw.rounded_rectangle([356, 730, 640, 758], radius=14, fill=(148, 163, 184, 190))

    # Central bidirectional SSH tunnel & upload arrow
    # Vertical shaft
    draw.rounded_rectangle([494, 412, 530, 612], radius=18, fill=(56, 189, 248, 255))
    # Upward arrowhead (deploy + tunnel)
    draw.polygon([(512, 392), (434, 476), (590, 476)], fill=(52, 211, 153, 255))
    # Small side tunnel signal arcs (left & right)
    draw.arc([340, 434, 444, 590], start=115, end=245, fill=(56, 189, 248, 180), width=16)
    draw.arc([580, 434, 684, 590], start=-65, end=65, fill=(56, 189, 248, 180), width=16)

    final = img.resize((FINAL_SIZE, FINAL_SIZE), Image.Resampling.LANCZOS)
    final.save(OUT_PNG, format="PNG", optimize=True)
    print(f"Generated {OUT_PNG} ({OUT_PNG.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
