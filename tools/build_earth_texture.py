# -*- coding: utf-8 -*-
"""build_earth_texture.py — NASA 真实地球贴图拆分导出。

地表：NASA Blue Marble Next Generation（world.topo.bathy.200412，公有领域）
      https://eoimages.gsfc.nasa.gov/images/imagerecords/73000/73909/world.topo.bathy.200412.3x5400x2700.jpg
      → 4k_earth_daymap.jpg（无云地表）
云层：fair_clouds_4k.png（NASA 云量合成图导出的透明云层图，白色 RGB + alpha 密度）
      → 2k_earth_clouds.png（独立云层贴图，白色云 + alpha 通道）

云层与地表分离为两张贴图、两个网格；云层由 scene.js 以略快于地表自转的
角速度驱动（见 EARTH_CLOUD_SPEEDUP），形成相对地表的缓慢东向漂移。
"""
import os
from PIL import Image
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.join(HERE, "..", "textures")

SURFACE = os.path.join(T, "src", "nasa_bmng_5400.jpg")
CLOUDS = os.path.join(T, "src", "fair_clouds_4k.png")
OUT_SURF = os.path.join(T, "4k_earth_daymap.jpg")
OUT_CLOUDS = os.path.join(T, "2k_earth_clouds.png")

SURF_SIZE = (4096, 2048)   # 地表：兼顾近观细节与体积
CLOUD_SIZE = (2048, 1024)  # 云层：柔和目标，2k 足够，控制 PNG 体积

def main():
    # ---- 地表（无云）----
    surf = Image.open(SURFACE).convert("RGB").resize(SURF_SIZE, Image.LANCZOS)
    surf.save(OUT_SURF, "JPEG", quality=90, subsampling=1, optimize=True)
    print("saved", OUT_SURF, round(os.path.getsize(OUT_SURF) / 1e6, 2), "MB")

    # ---- 云层（白云 + alpha 密度）----
    clouds = Image.open(CLOUDS).convert("RGBA").resize(CLOUD_SIZE, Image.LANCZOS)
    a = np.asarray(clouds).astype(np.float32)
    # 云量轻微增强（真实云图整体偏淡），软边缘保持平滑
    a[..., 3] = np.clip(a[..., 3] * 1.12, 0.0, 255.0)
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGBA")
    img.save(OUT_CLOUDS, "PNG", optimize=True)
    print("saved", OUT_CLOUDS, round(os.path.getsize(OUT_CLOUDS) / 1e6, 2), "MB")

if __name__ == "__main__":
    main()
