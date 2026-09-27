# -*- coding: utf-8 -*-
"""dbg_join.py — 检查 SOI 区间的交叉时刻与两解几何。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
import bake_data as B

pts = B.load_points("sc_cassini/saturn/orb")["points"]
J = 946728000
# 找到 02:20:57 关键帧的索引
t0 = time.mktime((2004, 7, 1, 2, 20, 57, 0, 0, 0)) - time.timezone - B.J2000_S
lo = None
for i, p in enumerate(pts):
    if abs(p[0] - t0) < 60:
        lo = i
        break
print("kf index:", lo, "t =", time.strftime("%H:%M:%S", time.gmtime(pts[lo][0] + J)))
p0, p1 = pts[lo], pts[lo + 1]
print("interval:", time.strftime("%H:%M:%S", time.gmtime(p0[0] + J)), "->",
      time.strftime("%H:%M:%S", time.gmtime(p1[0] + J)))

tj, dmin = B._join_epoch(p0, p1, id(pts), lo)
print(f"join epoch = {time.strftime('%H:%M:%S', time.gmtime(tj + J))}  min divergence = {dmin:,.0f} km")

# 两解在若干时刻的位置
for hh, mm in [(2, 25), (2, 30), (2, 35), (2, 40), (2, 45), (2, 50), (2, 55), (3, 0)]:
    t = time.mktime((2004, 7, 1, hh, mm, 0, 0, 0, 0)) - time.timezone - B.J2000_S
    A = B.orb_pos(p0, t)
    Bd = B.orb_pos(p1, t)
    P = B.pos_at("sc_cassini/saturn/orb", t)
    rA = math.sqrt(sum(v * v for v in A))
    rB = math.sqrt(sum(v * v for v in Bd))
    rP = math.sqrt(sum(v * v for v in P))
    dab = math.sqrt(sum((A[k] - Bd[k]) ** 2 for k in range(3)))
    print(f"  {hh:02d}:{mm:02d}  rA={rA:>10,.0f} rB={rB:>10,.0f} |A-B|={dab:>10,.0f}  pos_at r={rP:>10,.0f}")
