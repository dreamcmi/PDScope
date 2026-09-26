#!/usr/bin/env python3
"""make-tauri-icons.py — 由 assets/icon.png 生成 Tauri 打包所需的全套图标。

Tauri 的 tauri.conf.json → bundle.icon 会引用：
    32x32.png / 128x128.png / 128x128@2x.png / icon.ico / icon.icns
缺任何一个都会导致 `cargo build` / `tauri build` 报错。

为什么不用 `tauri icon`：
    该命令需要先装 @tauri-apps/cli（走 npm）。
    这里用 Pillow 直接产出，让 Rust 侧可以脱离 Node 独立构建。

ICNS 说明：
    Pillow 只能「读」icns 不能「写」，所以这里手写 ICNS 容器 ——
    格式很简单：'icns' + 总字节数(BE u32) + 若干 [类型(4B) + 长度(BE u32) + PNG 数据]。
    现代 macOS（10.7+）支持 ic07~ic14 这几种「PNG 载荷」元素，够用。

用法：
    <venv>/python tools/make-tauri-icons.py
"""
from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "build" / "icon.png"
OUT = ROOT / "src-tauri" / "icons"

# Tauri 主图标 + Windows Store 变体（后者的尺寸只是沿用 Microsoft 的约定）
PNG_SIZES = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "StoreLogo.png": 50,
    "Square30x30Logo.png": 30,
    "Square44x44Logo.png": 44,
    "Square71x71Logo.png": 71,
    "Square89x89Logo.png": 89,
    "Square107x107Logo.png": 107,
    "Square142x142Logo.png": 142,
    "Square150x150Logo.png": 150,
    "Square284x284Logo.png": 284,
    "Square310x310Logo.png": 310,
}

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

# ICNS 元素类型 → 边长
ICNS_TYPES = {
    b"ic07": 128,
    b"ic08": 256,
    b"ic09": 512,
    b"ic10": 1024,
    b"ic11": 32,
    b"ic12": 64,
    b"ic13": 256,
    b"ic14": 512,
}


def square(img: Image.Image) -> Image.Image:
    """居中放到透明正方形画布上，避免非 1:1 源图被拉伸变形。"""
    side = max(img.size)
    if img.size == (side, side):
        return img
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(img, ((side - img.width) // 2, (side - img.height) // 2))
    return canvas


def png_bytes(img: Image.Image, size: int) -> bytes:
    buf = io.BytesIO()
    img.resize((size, size), Image.LANCZOS).save(buf, format="PNG")
    return buf.getvalue()


def build_icns(img: Image.Image) -> bytes:
    body = b""
    for tag, size in ICNS_TYPES.items():
        data = png_bytes(img, size)
        body += tag + struct.pack(">I", len(data) + 8) + data
    return b"icns" + struct.pack(">I", len(body) + 8) + body


def main() -> None:
    if not SRC.exists():
        raise SystemExit(f"找不到源图：{SRC}\n先跑 python tools/make-icon.py 生成它。")

    OUT.mkdir(parents=True, exist_ok=True)
    base = square(Image.open(SRC).convert("RGBA"))
    print(f"源图 {SRC.name} → {base.width}x{base.height}")

    for name, size in PNG_SIZES.items():
        base.resize((size, size), Image.LANCZOS).save(OUT / name, format="PNG")
        print(f"  {name:<24} {size}x{size}")

    base.save(OUT / "icon.ico", sizes=ICO_SIZES)
    print(f"  {'icon.ico':<24} {len(ICO_SIZES)} 种尺寸")

    icns = build_icns(base)
    (OUT / "icon.icns").write_bytes(icns)
    print(f"  {'icon.icns':<24} {len(ICNS_TYPES)} 种尺寸, {len(icns) / 1024:.1f} KB")

    print(f"\n✔ 已写入 {OUT}")


if __name__ == "__main__":
    main()
