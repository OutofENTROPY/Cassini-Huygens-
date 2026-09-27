# -*- coding: utf-8 -*-
"""dbg_rogue2.py — 比对 rogue 坐标与各候选来源。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
import bake_data as B

J = 946728000
t = time.mktime((2004, 7, 1, 0, 1, 4, 0, 0, 0)) - time.timezone - J
rogue = (-385727488, 1297181440, -7731338)
print(f"rogue      = ({rogue[0]:,.0f},{rogue[1]:,.0f},{rogue[2]:,.0f})")

for leg in ["sc_cassini/sun/4/orb", "sc_cassini/saturn/orb"]:
    pts = B.load_points(leg)["points"]
    print(f"\n{leg}: kf range {time.strftime('%Y-%m-%d %H:%M', time.gmtime(pts[0][0]+J))} .. {time.strftime('%Y-%m-%d %H:%M', time.gmtime(pts[-1][0]+J))}, n={len(pts)}")
    p = B.pos_at(leg, t)
    print(f"  pos_at            = ({p[0]:,.0f},{p[1]:,.0f},{p[2]:,.0f})")
    # 各关键帧外推
    for kf in (pts[-1], pts[-2], pts[0]):
        q = B.orb_pos(kf, t)
        d = math.sqrt(sum((q[k] - rogue[k]) ** 2 for k in range(3)))
        print(f"  orb_pos(kf {time.strftime('%m-%d %H:%M', time.gmtime(kf[0]+J))}) = ({q[0]:,.0f},{q[1]:,.0f},{q[2]:,.0f})  dist_to_rogue={d:,.0f} km")
    # 手动复现 pos_at 的机动分支（若触发）
    lo = None
    for i in range(len(pts) - 1):
        if pts[i][0] <= t <= pts[i + 1][0]:
            lo = i
            break
    if lo is not None:
        p0, p1 = pts[lo], pts[lo + 1]
        print(f"  bracket: {time.strftime('%m-%d %H:%M:%S', time.gmtime(p0[0]+J))} -> {time.strftime('%m-%d %H:%M:%S', time.gmtime(p1[0]+J))}")
        dmax = B._interval_max_div(p0, p1, (id(pts), lo))
        print(f"  interval max div = {dmax:,.0f} km  -> maneuver branch: {dmax > 2500 and (p1[0]-p0[0]) < 7*86400}")
        if dmax > 2500 and (p1[0] - p0[0]) < 7 * 86400:
            tj, dmin, t_real = B._join_epoch(p0, p1, id(pts), lo)
            W = min(600.0, max(30.0, dmin / 40.0))
            b0, b1 = max(tj - W, t_real), tj + W
            print(f"  tj={time.strftime('%H:%M:%S', time.gmtime(tj+J))} dmin={dmin:,.0f} W={W:.0f} b0={time.strftime('%H:%M:%S', time.gmtime(b0+J))} b1={time.strftime('%H:%M:%S', time.gmtime(b1+J))}")
            A = B.orb_pos(p0, t)
            Bp = B.orb_pos(p1, t)
            print(f"  A=({A[0]:,.0f},{A[1]:,.0f},{A[2]:,.0f})  B=({Bp[0]:,.0f},{Bp[1]:,.0f},{Bp[2]:,.0f})")
