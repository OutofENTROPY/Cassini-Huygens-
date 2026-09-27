# -*- coding: utf-8 -*-
import math, os, sys, time, calendar
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at, orb_pos, J2000_S

pts = load_points("sc_cassini/sun/4/orb")["points"]
p0, p1 = pts[0], pts[1]
t = calendar.timegm((1999, 12, 18, 0, 0, 0)) - J2000_S
print("p0 epoch:", time.gmtime(p0[0] + J2000_S), " a=%.0f e=%.4f n=%.3e M=%.3f" % (p0[1], p0[2], p0[3], p0[4]))
print("p1 epoch:", time.gmtime(p1[0] + J2000_S), " a=%.0f e=%.4f n=%.3e M=%.3f" % (p1[1], p1[2], p1[3], p1[4]))
A = orb_pos(p0, t)
B = orb_pos(p1, t)
print("conic0(t):", [round(v) for v in A], "|r|=%.0f" % math.sqrt(sum(v * v for v in A)))
print("conic1(t):", [round(v) for v in B], "|r|=%.0f" % math.sqrt(sum(v * v for v in B)))
al = (t - p0[0]) / (p1[0] - p0[0])
print("alpha =", round(al, 3))
P = pos_at("sc_cassini/sun/4/orb", t)
print("lerp   :", [round(v) for v in P], "|r|=%.0f" % math.sqrt(sum(v * v for v in P)))

# 检查 p0 元素在自身历元的半径
r0 = orb_pos(p0, p0[0])
print("conic0 at own epoch: |r|=%.0f km (a(1-e)=%.0f)" % (math.sqrt(sum(v*v for v in r0)), p0[1] * (1 - p0[2])))
