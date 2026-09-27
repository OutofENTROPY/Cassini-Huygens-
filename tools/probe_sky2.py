# -*- coding: utf-8 -*-
from PIL import Image, ImageStat
import os

T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "textures")
img = Image.open(os.path.join(T, "8k_stars_milky_way.jpg"))
print("mode:", img.mode, "size:", img.size)
g = img.convert("L")
st = ImageStat.Stat(g)
print("mean/std:", [round(v, 1) for v in st.mean], [round(v, 1) for v in st.stddev])
small = g.resize((240, 120))
small.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "textures", "_sky_preview.png"))
# 逐行均值（判断银河带在哪）
px = small.load()
W, H = small.size
for band in range(6):
    y0, y1 = band * 20, band * 20 + 20
    s = 0
    for y in range(y0, y1):
        for x in range(W):
            s += px[x, y]
    print(f"rows {y0}-{y1}: mean {s / (W * 20):.1f}")
