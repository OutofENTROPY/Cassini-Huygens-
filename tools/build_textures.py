# -*- coding: utf-8 -*-
"""build_textures.py — 行星贴图 → data/textures.js（base64 data URI，
规避 file:// 下 WebGL 的图片跨域限制，同时满足 Cloudflare Pages 单文件限制）。"""
import base64, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.join(HERE, "..", "textures")

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
