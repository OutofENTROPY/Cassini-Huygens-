# -*- coding: utf-8 -*-
"""probe_sky.py — 分析 8k 银河贴图的银心方位 + 土星环 PNG 布局。"""
from PIL import Image
import os, math

T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "textures")

# ---- 银河贴图：把图缩到小尺寸，找最亮的大块区域（银心方向）----
img = Image.open(os.path.join(T, "8k_stars_milky_way.jpg")).convert("L")
w, h = img.size
small = img.resize((180, 90))
px = small.load()
# 每 4° 网格平均亮度
best = []
for gy in range(90):
    for gx in range(180):
        s = 0
        for dy in range(4):
            for dx in range(4):
                s += px[(gx * 4 + dx) % 180, (gy * 4 + dy) % 90]
        best.append((s / 16, gx * 2 + 1, gy * 2 + 1))  # (亮度, RA°, Dec°=90-2y)
best.sort(reverse=True)
print("size:", w, h)
print("最亮区域 top8 (avg, u_deg, v_deg_as_dec?):")
for b in best[:8]:
    print(f"  {b[0]:6.1f}  col={b[1]:3d}  row={b[2]:3d}")

# ---- 环 PNG ----
ring = Image.open(os.path.join(T, "nasa_saturn_ring.png"))
print("\nring png:", ring.size, ring.mode)
# 检查 alpha 分布：按列统计非透明像素比例（判断径向是横向还是纵向）
a = ring.split()[-1] if "A" in ring.mode else None
if a:
    aw, ah = a.size
    ap = a.load()
    col_opaque = sum(1 for x in range(0, aw, 16) if any(ap[x, y] > 40 for y in range(0, ah, max(1, ah // 24))))
    row_opaque = sum(1 for y in range(0, ah, 16) if any(ap[x, y] > 40 for x in range(0, aw, max(1, aw // 24))))
    print(f"有内容的列(抽样) {col_opaque}/{aw//16}  有内容的行(抽样) {row_opaque}/{ah//16}")
