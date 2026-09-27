# -*- coding: utf-8 -*-
"""check_blend.py — 测量各实体相邻关键帧传播解在中点的分歧，确定机动检测阈值。"""
import math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, orb_pos
from fetch_data import ALL

BODIES = [
    "mercury/sun/orb", "venus/sun/orb", "earth/sun/orb", "mars/sun/orb",
    "jupiter/sun/orb", "saturn/sun/orb", "uranus/sun/orb", "neptune/sun/orb",
    "earth/moon/orb", "saturn/titan/orb", "saturn/enceladus/orb",
    "saturn/iapetus/orb", "saturn/rhea/orb", "saturn/dione/orb",
]
CASSINI = [
    "sc_cassini/earth/launch/orb", "sc_cassini/sun/1/orb",
    "sc_cassini/venus/flyby1/orb", "sc_cassini/sun/2/orb",
    "sc_cassini/venus/flyby2/orb", "sc_cassini/sun/3/orb",
    "sc_cassini/earth/flyby/orb", "sc_cassini/sun/4/orb",
    "sc_cassini/saturn/orb",
]

def max_div(path):
    pts = load_points(path)["points"]
    if len(pts) < 2:
        return 0.0, 0, len(pts)
    worst = 0.0
    wi = -1
    for i in range(len(pts) - 1):
        p0, p1 = pts[i], pts[i + 1]
        tm = 0.5 * (p0[0] + p1[0])
        A = orb_pos(p0, tm)
        B = orb_pos(p1, tm)
        d = math.sqrt(sum((A[k] - B[k]) ** 2 for k in range(3)))
        if d > worst:
            worst, wi = d, i
    return worst, wi, len(pts)

print("== natural bodies (must stay small for safe threshold):")
for b in BODIES:
    try:
        w, wi, n = max_div(b)
        print(f"  {b:28s} n={n:5d}  max mid-divergence = {w:>12,.0f} km")
    except Exception as ex:
        print(f"  {b:28s} ERROR {ex}")

print("== cassini legs (expect huge at maneuvers):")
for b in CASSINI:
    try:
        w, wi, n = max_div(b)
        pts = load_points(b)["points"]
        import time
        J = 946728000
        tt = time.strftime("%Y-%m-%d %H:%M", time.gmtime(pts[wi][0] + J)) if wi >= 0 else "-"
        print(f"  {b:34s} n={n:5d}  max = {w:>12,.0f} km @ kf {tt}")
    except Exception as ex:
        print(f"  {b:34s} ERROR {ex}")
