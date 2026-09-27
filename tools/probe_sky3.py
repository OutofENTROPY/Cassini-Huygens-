# -*- coding: utf-8 -*-
from PIL import Image
import os

T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "textures")
img = Image.open(os.path.join(T, "8k_stars_milky_way.jpg")).convert("L")
small = img.resize((720, 360))
px = small.load()
W, H = small.size
# 在银河带 (rows 120-240) 内逐列求均值
col = []
for x in range(W):
    s = 0
    for y in range(120, 240, 2):
        s += px[x, y]
    col.append(s / 60)
mx = max(col)
best = [x for x, v in enumerate(col) if v > mx * 0.985]
# 最亮列的加权中心（局部）
import statistics
center = statistics.median(best)
u_frac = center / W
# 三种假设: u=0 ↔ RA 0 / RA 180 / RA 90
for off in (0, 90, 180, 270):
    ra = (u_frac * 360 + off) % 360
    print(f"offset {off:3d}°: 银心 RA ≈ {ra:6.1f}°")
print("真实银心 RA = 266.4°, Dec = -28.9°")
# 顺便看最亮行(纬度带)位置 → 应在 dec -29 附近
row = []
for y in range(H):
    s = 0
    for x in range(0, W, 4):
        s += px[x, y]
    row.append(s / (W / 4))
mrow = max(range(H), key=lambda y: row[y])
print(f"最亮行 y={mrow}/{H} → v={1 - mrow / H:.3f} → dec ≈ {(1 - mrow / H) * 180 - 90:.1f}°")
