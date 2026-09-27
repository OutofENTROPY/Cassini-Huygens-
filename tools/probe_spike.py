# -*- coding: utf-8 -*-
"""probe_spike.py — 对比 pos_at 与烘焙轨迹在爆点时刻的值。"""
import math, os, sys, time, calendar
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at, orb_pos, solve_e, J2000_S

leg = "sc_cassini/earth/launch/orb"
pts = load_points(leg)["points"]
print("leg element span:", len(pts),
      time.strftime("%Y-%m-%d %H:%M", time.gmtime(pts[0][0] + J2000_S)), "->",
      time.strftime("%Y-%m-%d %H:%M", time.gmtime(pts[-1][0] + J2000_S)))
print("first elems: a=%.5g e=%.5f n=%.5g M=%.5g" % (pts[0][1], pts[0][2], pts[0][3], pts[0][4]))
print("last  elems: a=%.5g e=%.5f n=%.5g M=%.5g" % (pts[-1][1], pts[-1][2], pts[-1][3], pts[-1][4]))

t_spike = calendar.timegm(time.strptime("1997-10-18 16:01:03", "%Y-%m-%d %H:%M:%S")) - J2000_S
p = pos_at(leg, t_spike)
print("pos_at(leg, spike) =", [round(v) for v in p], "|r|=%.0f" % math.sqrt(sum(v*v for v in p)))

e = pts[-1][2]
M = pts[-1][4] + pts[-1][3] * (t_spike - pts[-1][0])
E = solve_e(M, e)
print("M at spike = %.4f, E = %.4f (e=%.4f)" % (M, E, e))
pp = orb_pos(pts[-1], t_spike)
print("orb_pos(last elem, spike) =", [round(v) for v in pp], "|r|=%.0f" % math.sqrt(sum(v*v for v in pp)))

# 附近逐点
print("\ntrail of pos_at every 600s around spike:")
for k in range(-4, 5):
    t = t_spike + k * 600
    q = pos_at(leg, t)
    iso = time.strftime("%H:%M:%S", time.gmtime(t + J2000_S))
    print(f"  {iso}  {[round(v) for v in q]}  |r|={math.sqrt(sum(v*v for v in q)):,.0f}")
