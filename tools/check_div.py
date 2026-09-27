# -*- coding: utf-8 -*-
import math, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))) if False else None
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, orb_pos
J = 946728000
pts = load_points("sc_cassini/saturn/orb")["points"]
rows = []
for i in range(len(pts) - 1):
    p0, p1 = pts[i], pts[i + 1]
    dt = p1[0] - p0[0]
    tm = 0.5 * (p0[0] + p1[0])
    A = orb_pos(p0, tm)
    B = orb_pos(p1, tm)
    d = math.sqrt(sum((A[k] - B[k]) ** 2 for k in range(3)))
    rows.append((d, dt, i, p0[2], p1[2]))
rows.sort(reverse=True)
print("top 15 divergent intervals of saturn/orb:")
for d, dt, i, a0, a1 in rows[:15]:
    t = time.strftime("%Y-%m-%d %H:%M", time.gmtime(pts[i][0] + J))
    print(f"  div={d:>10,.0f} km  dt={dt:>7.0f}s  @ {t}  a: {a0:,.0f} -> {a1:,.0f}")
big = [r for r in rows if r[0] > 2500]
print(f"intervals with div>2500km: {len(big)}; dt<7d: {sum(1 for r in big if r[1] < 7*86400)}; dt>=7d: {sum(1 for r in big if r[1] >= 7*86400)}")
print(f"total intervals: {len(rows)}")
