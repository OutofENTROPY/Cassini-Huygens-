# -*- coding: utf-8 -*-
"""scan_inf.py — 找出烘焙段中的非有限位置点并回溯其根数。"""
import math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at, solve_e, orb_pos, CASSINI_LEGS, LEG_CENTERS, J2000_S
import time

for leg in CASSINI_LEGS:
    pts = load_points(leg)["points"]
    t0, t1 = pts[0][0], pts[-1][0]
    n_test = 400
    bad = []
    for i in range(n_test):
        t = t0 + (t1 - t0) * i / (n_test - 1)
        p = pos_at(leg, t)
        if not all(math.isfinite(v) and abs(v) < 1e15 for v in p):
            bad.append((t, p))
    if bad:
        # 回溯：这些时间附近最近的根数点
        t_bad = bad[0][0]
        near = min(pts, key=lambda q: abs(q[0] - t_bad))
        print(f"{leg}: {len(bad)} bad pts, first @ {time.strftime('%Y-%m-%d %H:%M', time.gmtime(t_bad + J2000_S))}")
        print(f"   sample pos={bad[0][1]}")
        print(f"   nearest element: t={time.strftime('%Y-%m-%d', time.gmtime(near[0]+J2000_S))} a={near[1]:.4g} e={near[2]:.6f} n={near[3]:.3g} M={near[4]:.4g}")
        E = solve_e(near[4] + near[3] * (t_bad - near[0]), near[2])
        print(f"   solveE -> {E:.6g}")
