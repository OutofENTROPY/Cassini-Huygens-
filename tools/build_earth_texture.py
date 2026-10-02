# -*- coding: utf-8 -*-
"""build_earth_texture.py — NASA Eyes 地球贴图拆分导出。

地表：NASA Eyes on the Solar System 官方地球 color 贴图（6 面 4096² 立方体
      镶嵌，公域），由 tools/stitch_nasa_eyes_earth.py 重投影为等距圆柱投影
      → textures/src/nasa_eyes_color_8k.jpg（8192×4096）
      → 4k_earth_daymap.jpg（无云地表 + 海冰 + 海洋水色）
云层：NASA Eyes 官方地球 decal 云层贴图（白色 RGB + alpha 云量密度）
      → textures/src/nasa_eyes_clouds_4k.png（4096×2048）
      → 2k_earth_clouds.png（独立云层贴图，白云 + alpha 通道）

来源：https://eyes.nasa.gov/assets/static/maps/earth/{color,cloud}_4096_{0..5}.png
立方面→球面映射逆向自 eyes.nasa.gov app.js（SpheroidLODComponent 的
defaultCubeMapFaceFrames + xyzToUVFace，gnomonic 投影；THREE flipY=true
语义下图像顶行为 -up 方向）。

云层与地表分离为两张贴图、两个网格；云层由 scene.js 以略快于地表自转的
角速度驱动（见 EARTH_CLOUD_SPEEDUP），形成相对地表的缓慢东向漂移。
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.join(HERE, "..", "textures")

SURFACE = os.path.join(T, "src", "nasa_eyes_color_8k.jpg")
CLOUDS = os.path.join(T, "src", "nasa_eyes_clouds_4k.png")
OUT_8K = os.path.join(T, "8k_earth_daymap.jpg")
OUT_SURF = os.path.join(T, "4k_earth_daymap.jpg")
OUT_SURF_2K = os.path.join(T, "2k_earth_daymap.jpg")
OUT_CLOUDS = os.path.join(T, "2k_earth_clouds.png")

SURF_SIZE = (4096, 2048)   # 地表：兼顾近观细节与体积（内嵌进 data/textures.js）
CLOUD_SIZE = (2048, 1024)  # 云层：柔和目标，2k 足够，控制 PNG 体积

def main():
    # ---- 地表（无云；NASA Eyes color 含海冰/海洋水色，与云层 decal 分离）----
    surf8k = Image.open(SURFACE).convert("RGB")
    if surf8k.size != (8192, 4096):
        surf8k = surf8k.resize((8192, 4096), Image.LANCZOS)
    surf8k.save(OUT_8K, "JPEG", quality=88, subsampling=1, optimize=True)
    print("saved", OUT_8K, round(os.path.getsize(OUT_8K) / 1e6, 2), "MB")

    surf = surf8k.resize(SURF_SIZE, Image.LANCZOS)
    surf.save(OUT_SURF, "JPEG", quality=90, subsampling=1, optimize=True)
    print("saved", OUT_SURF, round(os.path.getsize(OUT_SURF) / 1e6, 2), "MB")

    surf.resize((2048, 1024), Image.LANCZOS) \
        .save(OUT_SURF_2K, "JPEG", quality=90, subsampling=1, optimize=True)
    print("saved", OUT_SURF_2K, round(os.path.getsize(OUT_SURF_2K) / 1e6, 2), "MB")

    # ---- 云层（白云 + alpha 密度；NASA decal alpha 已按真实云量标定，不再增强）----
    clouds = Image.open(CLOUDS).convert("RGBA").resize(CLOUD_SIZE, Image.LANCZOS)
    clouds.save(OUT_CLOUDS, "PNG", optimize=True)
    print("saved", OUT_CLOUDS, round(os.path.getsize(OUT_CLOUDS) / 1e6, 2), "MB")

if __name__ == "__main__":
    main()
