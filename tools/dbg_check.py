# -*- coding: utf-8 -*-
"""dbg_check.py — 直接验证 pos_at 分支选择。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
import bake_data as B

pts = B.load_points("sc_cassini/saturn/orb")["points"]
J = 946728000
t0 = time.mktime((2004, 7, 1, 2, 20, 57, 0, 0, 0)) - time.timezone - B.J2000_S
lo = next(i for i, p in enumerate(pts) if abs(p[0] - t0) < 60)
p0, p1 = pts[lo], pts[lo + 1]

tj, dmin = B._join_epoch(p0, p1, id(pts), lo)
W = min(600.0, max(30.0, dmin / 40.0))
print(f"tj={time.strftime('%H:%M:%S', time.gmtime(tj+J))} dmin={dmin:,.0f} W={W:.0f}s bridge=[{time.strftime('%H:%M:%S', time.gmtime(tj-W+J))}, {time.strftime('%H:%M:%S', time.gmtime(tj+W+J))}]")

# r_B 转折点扫描复现
n = 64
ta, tb = p0[0], p1[0]
rt = [sum(v * v for v in B.orb_pos(p1, ta + (tb - ta) * i / n)) for i in range(n + 1)]
for i in range(1, n):
    if (rt[i] - rt[i - 1]) * (rt[i + 1] - rt[i]) < 0:
        print(f"  r_B turning @ {time.strftime('%H:%M:%S', time.gmtime(ta + (tb-ta)*i/n + J))}  r={math.sqrt(rt[i]):,.0f}")

for hh, mm, ss in [(2, 38, 40), (2, 39, 0), (2, 39, 30), (2, 40, 0), (2, 40, 30)]:
    t = time.mktime((2004, 7, 1, hh, mm, ss, 0, 0, 0)) - time.timezone - B.J2000_S
    A = B.orb_pos(p0, t)
    Bd = B.orb_pos(p1, t)
    P = B.pos_at("sc_cassini/saturn/orb", t)
    rA = math.sqrt(sum(v * v for v in A)); rB = math.sqrt(sum(v * v for v in Bd))
    rP = math.sqrt(sum(v * v for v in P))
    which = "A" if t < tj - W else ("B" if t > tj + W else "bridge")
    print(f"  {hh:02d}:{mm:02d}:{ss:02d} [{which:>6s}] rA={rA:>9,.0f} rB={rB:>9,.0f} rP={rP:>9,.0f}  P=({P[0]:,.0f},{P[1]:,.0f},{P[2]:,.0f})")
