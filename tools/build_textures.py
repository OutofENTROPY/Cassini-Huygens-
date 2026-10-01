# -*- coding: utf-8 -*-
"""build_textures.py — 行星贴图 → data/textures.js（base64 data URI，
规避 file:// 下 WebGL 的图片跨域限制，同时满足 Cloudflare Pages 单文件限制）。"""
import base64, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.join(HERE, "..", "textures")


def prep_iapetus():
    """NASA Cassini ISS 全球镶嵌（灰度）→ 暗区（Cassini Regio）着暖棕。
    真实暗区为棕色有机质（反照率 ~0.05），亮区冰白；镶嵌图本身为灰度，
    按亮度加权乘暖色乘子还原 NASA Eyes 风格色彩。"""
    from PIL import Image
    import numpy as np
    src = os.path.join(HERE, "..", "data_raw", "nasa_textures", "Iapetus.jpg")
    dst = os.path.join(T, "iapetus_cassini_mosaic.jpg")
    im = Image.open(src).convert("RGB")
    a = np.asarray(im, dtype=np.float32) / 255.0
    lum = a.mean(axis=2, keepdims=True)
    t = np.clip((0.62 - lum) / 0.62, 0, 1) ** 1.2          # 暗区权重（亮区 0）
    warm = np.array([1.10, 0.90, 0.66], dtype=np.float32)  # 暖棕乘子
    mul = 1.0 + (warm - 1.0) * t * 0.9
    Image.fromarray((np.clip(a * mul, 0, 1) * 255).astype(np.uint8)).save(dst, quality=90)
    return os.path.basename(dst)


FILES = {
    "sun": "2k_sun.jpg",
    "mercury": "2k_mercury.jpg",
    "venus": "2k_venus_atmosphere.jpg",
    # 地球：NASA Blue Marble 无云地表 + 独立云层贴图（tools/build_earth_texture.py 生成）
    "earth": "4k_earth_daymap.jpg",
    "earthClouds": "2k_earth_clouds.png",
    "moon": "2k_moon.jpg",
    "mars": "2k_mars.jpg",
    "jupiter": "2k_jupiter.jpg",
    "saturn": "2k_saturn.jpg",
    "uranus": "2k_uranus.jpg",
    "neptune": "2k_neptune.jpg",
    "ring": "2k_saturn_ring_alpha.png",
    # Iapetus：NASA Cassini ISS 真实镶嵌（替换程序化贴图；暗区经度对齐见 js/scene.js）
    "iapetus": prep_iapetus(),
}

def main():
    out = {}
    total = 0
    for name, fn in FILES.items():
        p = os.path.join(T, fn)
        with open(p, "rb") as f:
            b = f.read()
        mime = "image/png" if fn.endswith(".png") else "image/jpeg"
        out[name] = f"data:{mime};base64," + base64.b64encode(b).decode("ascii")
        total += len(b)
        print(f"  {name}: {len(b)/1024:.0f} KB")
    dst = os.path.join(HERE, "..", "data", "textures.js")
    with open(dst, "w", encoding="utf-8") as f:
        f.write("/* 行星贴图 (Solar System Scope, CC BY 4.0) — base64 data URI */\n")
        f.write("window.TEXTURE_DATA = ")
        f.write(json.dumps(out, separators=(",", ":")))
        f.write(";\n")
    print(f"total raw {total/1e6:.1f} MB → {os.path.getsize(dst)/1e6:.1f} MB")

if __name__ == "__main__":
    main()
