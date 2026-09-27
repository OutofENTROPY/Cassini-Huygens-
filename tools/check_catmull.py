# -*- coding: utf-8 -*-
"""check_catmull.py — 复现 sun/1 段的烘焙网格与 Catmull 输出时间。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, remove_spikes, catmull_resample, J2000_S

leg = "sc_cassini/sun/1/orb"
pts = load_points(leg)["points"]
t0, t1 = pts[0][0], pts[-1][0]
step = 86400.0 / 4
n = int(round((t1 - t0) / step)) + 1
print("grid n =", n, " step =", step, " t0 =", time.strftime("%H:%M:%S", time.gmtime(t0 + J2000_S)))
seg4 = []
tt_ = t0
for p in pts[:8]:
    seg4.append((tt_, p[1], p[2], p[3]))
    tt_ += step
sm = remove_spikes(seg4)
res = catmull_resample(sm[:5], 2)
print("catmull times (first 10):")
prev = None
for q in res[:10]:
    dt = 0 if prev is None else q[0] - prev
    print(f"  {time.strftime('%H:%M:%S', time.gmtime(q[0] + J2000_S))}  dt={dt:7.1f}s")
    prev = q[0]
