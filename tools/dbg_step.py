# -*- coding: utf-8 -*-
"""dbg_step.py — 逐步复现 pos_at(02:38:40) 的内部计算。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
import bake_data as B

path = "sc_cassini/saturn/orb"
d = B.load_points(path)
pts = d["points"]
J = 946728000
t = time.mktime((2004, 7, 1, 2, 38, 40, 0, 0, 0)) - time.timezone - B.J2000_S
print(f"t = {t:.3f}  ({time.strftime('%H:%M:%S', time.gmtime(t + J))} UTC)")

lo, hi = 0, len(pts) - 1
while hi - lo > 1:
    mid = (lo + hi) >> 1
    if pts[mid][0] <= t:
        lo = mid
    else:
        hi = mid
p0, p1 = pts[lo], pts[hi]
print(f"bracket: lo={lo} ({time.strftime('%m-%d %H:%M:%S', time.gmtime(p0[0]+J))})  hi={hi} ({time.strftime('%m-%d %H:%M:%S', time.gmtime(p1[0]+J))})")

A = B.orb_pos(p0, t)
Bp = B.orb_pos(p1, t)
print(f"A  = ({A[0]:,.1f}, {A[1]:,.1f}, {A[2]:,.1f})  r={math.sqrt(sum(v*v for v in A)):,.1f}")
print(f"B  = ({Bp[0]:,.1f}, {Bp[1]:,.1f}, {Bp[2]:,.1f})  r={math.sqrt(sum(v*v for v in Bp)):,.1f}")
dab = math.sqrt(sum((Bp[k] - A[k]) ** 2 for k in range(3)))
print(f"|A-B| = {dab:,.1f} km")

tj, dmin = B._join_epoch(p0, p1, id(pts), lo)
W = min(600.0, max(30.0, dmin / 40.0))
print(f"tj = {time.strftime('%H:%M:%S', time.gmtime(tj + J))}  dmin = {dmin:,.1f}  W = {W:.1f}s")
print(f"t < tj-W ? {t < tj - W}   (tj-W = {time.strftime('%H:%M:%S', time.gmtime(tj - W + J))})")

P = B.pos_at(path, t)
print(f"pos_at = ({P[0]:,.1f}, {P[1]:,.1f}, {P[2]:,.1f})")
print(f"P == A ? {all(abs(P[k]-A[k]) < 1e-6 for k in range(3))}")
