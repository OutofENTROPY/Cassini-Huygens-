# -*- coding: utf-8 -*-
"""dbg_bridge.py — 10s 分辨率检查桥接区 02:36-02:44 的几何。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
import bake_data as B

leg = "sc_cassini/saturn/orb"
t0 = time.mktime((2004, 7, 1, 2, 36, 0, 0, 0, 0)) - time.timezone - B.J2000_S
step = 10.0
n = 49
prev = None
prevd = None
for i in range(n):
    t = t0 + i * step
    p = B.pos_at(leg, t)
    line = f"  {time.strftime('%H:%M:%S', time.gmtime(t + 946728000))}  r={math.sqrt(sum(v*v for v in p)):>9,.0f}  p=({p[0]:>9,.0f},{p[1]:>9,.0f},{p[2]:>9,.0f})"
    if prev is not None:
        d = [p[k] - prev[k] for k in range(3)]
        L = math.sqrt(sum(v * v for v in d))
        line += f"  v={L/step:6.2f}"
        if prevd is not None:
            la = math.sqrt(sum(v * v for v in prevd))
            cosang = sum(prevd[k] * d[k] for k in range(3)) / (la * L)
            line += f"  turn={math.degrees(math.acos(max(-1,min(1,cosang)))):6.1f}"
        prevd = d
    print(line)
    prev = p
