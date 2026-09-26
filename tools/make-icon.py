#!/usr/bin/env python3
"""
生成 PDScope 的品牌图标源图。

产物（写入 assets/，那是「图标源素材」目录，不是构建产物目录）：
  assets/icon.png   1024×1024  主源图，供 tools/make-tauri-icons.py 派发各平台图标
  assets/icon.ico   多尺寸     Windows 直接可用的一份（16~256）

下一步：改完源图后跑 `python tools/make-tauri-icons.py`，它会重新生成
src-tauri/icons/ 下打包所需的整套图标（含手写 ICNS 容器）。

图形构思：
  深色圆角底 + 「PD」字样 + 下方一段方波。
  方波即 BMC/Biphase Mark 的信号形态，比抽象图形更能说明这是一台「信号分析仪」；
  并且「粗笔画 + 高对比」在 16×16 的标题栏尺寸下依然可辨（纯波形会糊成一团）。

用法：python tools/make-icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT_DIR = Path(__file__).resolve().parent.parent / "assets"
S = 1024

BG_TOP = (30, 45, 74)          # 深蓝
BG_BOTTOM = (9, 14, 26)        # 近黑
WAVE = (45, 212, 191)          # 青（teal-400）
WAVE_GLOW = (45, 212, 191, 150)
TEXT = (245, 249, 255)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuib.ttf",   # Segoe UI Bold
    r"C:\Windows\Fonts\arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]

# 方波游程（单位长度，2=宽 1=窄），形似 BMC 编码的高低跳变。
# 刻意用「少数几条宽脉冲」而不是密集窄脉冲：窄脉冲的线宽会超过脉冲宽度，
# 又糊成一团，且缩到 16×16 时完全不可辨。
WAVE_RUNS = [2, 1, 1, 1, 2, 1, 1, 1, 2, 1]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for p in FONT_CANDIDATES:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    raise SystemExit(f"找不到可用字体，请补充 FONT_CANDIDATES：{FONT_CANDIDATES}")


def vertical_gradient(size: int, top, bottom) -> Image.Image:
    """逐行插值出一条竖直渐变（1024 行，够快）。"""
    img = Image.new("RGB", (1, size))
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return img.resize((size, size), Image.NEAREST)


def wave_points(x0: int, x1: int, y_high: int, y_low: int):
    """
    把游程展开成方波折线。

    每个游程要贡献两个顶点：先在同一电平上水平走完这段宽度，再在同一 x 上
    垂直跳到另一电平。少了那个垂直顶点，得到的会是斜线锯齿而不是方波。
    """
    total = sum(WAVE_RUNS)
    unit = (x1 - x0) / total
    pts = [(x0, y_high)]
    x, level = x0, 1
    for run in WAVE_RUNS:
        x += run * unit
        pts.append((x, y_high if level else y_low))   # 水平段收尾
        level ^= 1
        pts.append((x, y_high if level else y_low))   # 垂直跳变
    return pts


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # ── 圆角遮罩 ──────────────────────────────────────────────
    radius = int(S * 0.22)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=radius, fill=255)

    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(vertical_gradient(S, BG_TOP, BG_BOTTOM).convert("RGBA"), (0, 0), mask)

    # ── 方波（先画一层模糊光晕，再压一层实线）────────────────
    x0, x1 = int(S * 0.155), int(S * 0.845)
    y_high, y_low = int(S * 0.655), int(S * 0.795)
    pts = wave_points(x0, x1, y_high, y_low)
    width = int(S * 0.026)

    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).line(pts, fill=WAVE_GLOW, width=width * 2, joint="curve")
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.022))
    icon.alpha_composite(Image.composite(glow, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask))

    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(layer).line(pts, fill=WAVE + (255,), width=width, joint="curve")
    icon.alpha_composite(Image.composite(layer, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask))

    # ── 「PD」字样 ────────────────────────────────────────────
    font = load_font(int(S * 0.40))
    draw = ImageDraw.Draw(icon)
    text = "PD"
    # anchor="mm" 让文字按视觉中心对齐，避免不同字体的基线差异
    draw.text((S / 2, S * 0.40), text, font=font, fill=TEXT + (255,), anchor="mm")

    icon.putalpha(Image.composite(icon.getchannel("A"), Image.new("L", (S, S), 0), mask))

    png = OUT_DIR / "icon.png"
    icon.save(png)
    icon.save(
        OUT_DIR / "icon.ico", format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"✔ {png}")
    print(f"✔ {OUT_DIR / 'icon.ico'}")


if __name__ == "__main__":
    main()
