# -*- coding: utf-8 -*-
"""check_moons.py — 卫星轨道关键帧密度与传播分歧分布。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, orb_pos

MOONS = ["moon/earth/orb", "titan/saturn/orb", "enceladus/saturn/orb",
         "iapetus/saturn/orb", "rhea/saturn/orb", "dione/saturn/orb",
         "tethys/saturn/orb", "mimas/saturn/orb"]
for m in MOONS:
    try:
        pts = load_points(m)["points"]
    except Exception as ex:
        print(f"{m:24s} ERROR {ex}")
        continue
    worst, wi, wdt = 0.0, -1, 0
    ndense_big = 0
    for i in range(len(pts) - 1):
        p0, p1 = pts[i], pts[i + 1]
        dt = p1[0] - p0[0]
        tm = 0.5 * (p0[0] + p1[0])
        A = orb_pos(p0, tm)
        B = orb_pos(p1, tm)
        d = math.sqrt(sum((A[k] - B[k]) ** 2 for k in range(3)))
        if d > worst:
            worst, wi, wdt = d, i, dt
        if d > 2500 and dt < 7 * 86400:
            ndense_big += 1
    t = time.strftime("%Y-%m-%d", time.gmtime(pts[wi][0] + 946728000)) if wi >= 0 else "-"
    print(f"{m:24s} n={len(pts):5d} maxdiv={worst:>10,.0f} km @ {t} dt={wdt:.0f}s  dense&big={ndense_big}")
