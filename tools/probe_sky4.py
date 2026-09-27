# -*- coding: utf-8 -*-
from PIL import Image
import os

T = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "textures")
img = Image.open(os.path.join(T, "8k_stars_milky_way.jpg")).convert("L")
small = img.resize((720, 360))
px = small.load()
W, H = small.size
# 在 RA=193° (银北极附近) 的列上, 银河带应经过 dec≈+27°（若未翻转）
for ra in (193, 100, 60):
    x = int(((ra - 90) % 360) / 360 * W) % W
    rows = sorted(range(H), key=lambda y: -sum(px[(x + dx) % W, y] for dx in range(-2, 3)))
    y = rows[0]
    dec = (1 - y / H) * 180 - 90
    print(f"RA {ra}°: 最亮行 dec ≈ {dec:+.1f}°   (次亮: " +
          ", ".join(f"{(1 - yy / H) * 180 - 90:+.0f}" for yy in rows[1:4]) + ")")
