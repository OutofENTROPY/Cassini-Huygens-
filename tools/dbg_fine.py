# -*- coding: utf-8 -*-
"""dbg_fine.py — 60s 步长验证 SOI 近拱点路径的平滑度与总弯折角。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
import bake_data as B

leg = "sc_cassini/saturn/orb"
t0 = time.mktime((2004, 7, 1, 2, 0, 0, 0, 0, 0)) - time.timezone - B.J2000_S
t1 = time.mktime((2004, 7, 1, 3, 40, 0, 0, 0, 0)) - time.timezone - B.J2000_S
step = 60.0
n = int((t1 - t0) / step) + 1
pts = []
for i in range(n):
    t = t0 + i * step
    p = B.pos_at(leg, t)
    pts.append((t, p))
print(f"60s path: {n} pts")
# 每步速度与转角
prev = None
prevd = None
maxturn = 0.0
worst = None
for i, (t, p) in enumerate(pts):
    line = ""
    if prev is not None:
        d = [p[k] - prev[k] for k in range(3)]
        L = math.sqrt(sum(v * v for v in d))
        line = f"  {time.strftime('%H:%M:%S', time.gmtime(t + 946728000))}  r={math.sqrt(sum(v*v for v in p)):>9,.0f}  v={L/step:6.2f} km/s"
        if prevd is not None:
            la = math.sqrt(sum(v * v for v in prevd))
            cosang = sum(prevd[k] * d[k] for k in range(3)) / (la * L)
            turn = math.degrees(math.acos(max(-1, min(1, cosang))))
            line += f"  turn={turn:5.1f}"
            if turn > maxturn:
                maxturn, worst = turn, t
        prevd = d
    print(line) if i % 5 == 0 else None
    prev = p
print(f"\nmax turn per 60s step: {maxturn:.1f} deg @ {time.strftime('%H:%M:%S', time.gmtime(worst + 946728000))}")
# 总弯折角：v(02:10) 与 v(03:30) 方向差
def vel_at(t):
    p0 = B.pos_at(leg, t - 60)
    p1 = B.pos_at(leg, t + 60)
    return [p1[k] - p0[k] for k in range(3)]
v1 = vel_at(t0 + 600)
v2 = vel_at(t1 - 600)
l1 = math.sqrt(sum(v * v for v in v1)); l2 = math.sqrt(sum(v * v for v in v2))
cosang = sum(v1[k] * v2[k] for k in range(3)) / (l1 * l2)
print(f"total bend (v@02:10 vs v@03:38): {math.degrees(math.acos(max(-1,min(1,cosang)))):.1f} deg (期望 ~145)")
