# -*- coding: utf-8 -*-
"""build_textures.py — 行星贴图 → data/textures.js（base64 data URI，
规避 file:// 下 WebGL 的图片跨域限制，同时满足 Cloudflare Pages 单文件限制）。

贴图来源：
  - 地球全套（地表/云/夜灯/海洋镜面）+ 水星/月球/火星/木星/金星/土星/
    天王星/海王星 + 土星/天王星环条带：NASA Eyes on the Solar System 官方
    立方面贴图（公域），经 tools/stitch_nasa_eyes.py 重投影为等距圆柱投影。
  - 土卫六/二/三/四/五/八（Titan/Enceladus/Rhea/Dione/Tethys/Mimas）：
    NASA Eyes maps/{body}/color_{2048|1024}_{face}.png（tiles 存
    data_raw/nasa_eyes_tiles/），同样经 stitch 重投影。Titan color 官方
    仅 1024²/面（ 表面为雾霾遮蔽，Eyes 以 1024 版渲染）。
  - 土卫八：NASA Cassini ISS 全球镶嵌（data_raw/nasa_textures/Iapetus.jpg）。
  - 太阳保留程序化贴图（proc:sun，NASA 的太阳贴图仅 512²/面）。
"""
import base64, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
T = os.path.join(HERE, "..", "textures")
SRC = os.path.join(T, "src")

# (打包键, 源文件, 输出尺寸 or None=原样, JPEG质量 or None=PNG原样)
# 路径约定：src/ 前缀 = textures/src（stitch 母版），其余在 textures/
PLANETS = [
    # 水星取 2048 LOD：4096 版源图自带 MDIS 镶嵌硬边条带（45-83°E 等），
    # 2048 版为无硬边的干净镶嵌
    ("mercury", "src/nasa_mercury_2k.jpg", None, 85),
    ("venus", "src/nasa_venus_2k.jpg", None, 85),
    ("earth", "4k_earth_daymap.jpg", None, None),      # build_earth_texture.py 产物
    ("earthClouds", "2k_earth_clouds.png", None, None),
    ("earthNight", "src/nasa_earth_night_4k.jpg", None, 85),
    ("earthSpecular", "src/nasa_earth_specular_2k.png", None, None),
    ("moon", "src/nasa_moon_4k.jpg", None, 85),
    ("mars", "src/nasa_mars_4k.jpg", None, 85),
    ("jupiter", "src/nasa_jupiter_4k.jpg", None, 85),
    ("saturn", "src/nasa_saturn_2k.jpg", None, 85),
    ("uranus", "src/nasa_uranus_1k.jpg", None, None),
    ("neptune", "src/nasa_neptune_1k.jpg", None, None),
    ("saturnRing", "nasa_saturn_ring.png", None, None),
    ("uranusRing", "nasa_uranus_ring.png", None, None),
    # Iapetus：NASA Cassini ISS 真实镶嵌（暗区经度对齐见 js/scene.js texOffset）
    ("iapetus", "@iapetus", None, 90),
    # 土星六颗卫星：NASA Eyes color 立方面（1024²/2048²）→ stitch 母版。
    # 打包统一降采样到 2048×1024 q85：卫星在画面中极小，2k 足够，
    # 且 textures.js 单文件须低于 Cloudflare Pages 25 MiB 限制
    ("titan", "src/nasa_titan_2k.jpg", (2048, 1024), 85),
    ("enceladus", "src/nasa_enceladus_4k.jpg", (2048, 1024), 85),
    ("rhea", "src/nasa_rhea_4k.jpg", (2048, 1024), 85),
    ("dione", "src/nasa_dione_4k.jpg", (2048, 1024), 85),
    ("tethys", "src/nasa_tethys_4k.jpg", (2048, 1024), 85),
    ("mimas", "src/nasa_mimas_4k.jpg", (2048, 1024), 85),
]


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
    return dst


def prep_planet(key, src_name, size, quality):
    from PIL import Image
    if src_name == "@iapetus":
        return prep_iapetus()
    src = os.path.normpath(os.path.join(T, src_name))
    im = Image.open(src)
    if quality is None:
        return src  # PNG 原样
    # 主图多为 q95 母版，按打包质量重编码控制 payload
    out = os.path.join(T, "pack_" + os.path.basename(src_name))
    if im.mode != "RGB":
        im = im.convert("RGB")
    if size and im.size != size:
        im = im.resize(size, Image.LANCZOS)
    im.save(out, quality=quality)
    return out


def main():
    out = {}
    total = 0
    for key, src_name, size, quality in PLANETS:
        p = prep_planet(key, src_name, size, quality)
        with open(p, "rb") as f:
            b = f.read()
        mime = "image/png" if p.endswith(".png") else "image/jpeg"
        out[key] = f"data:{mime};base64," + base64.b64encode(b).decode("ascii")
        total += len(b)
        print(f"  {key}: {len(b)/1024:.0f} KB")
    dst = os.path.join(HERE, "..", "data", "textures.js")
    with open(dst, "w", encoding="utf-8") as f:
        f.write("/* 行星贴图 — NASA Eyes on the Solar System 官方贴图（地球含夜灯/海洋镜面；"
                "土星卫星 Titan/Enceladus/Rhea/Dione/Tethys/Mimas 为官方 color 立方面重投影；"
                "土卫八为 Cassini ISS 镶嵌）— base64 data URI */\n")
        f.write("window.TEXTURE_DATA = ")
        f.write(json.dumps(out, separators=(",", ":")))
        f.write(";\n")
    print(f"total raw {total/1e6:.1f} MB → {os.path.getsize(dst)/1e6:.1f} MB")


if __name__ == "__main__":
    main()
