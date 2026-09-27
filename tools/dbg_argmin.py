# -*- coding: utf-8 -*-
"""dbg_argmin.py — 复现 bake_data 主流程里近拱点 argmin 搜索，打印最小值附近采样。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at, CASSINI_LEGS

leg_specs = {
    "sc_cassini/earth/launch/orb": ("earth/sun/orb", 86400.0 / 144),
    "sc_cassini/sun/1/orb": (None, 86400.0 / 4),
    "sc_cassini/venus/flyby1/orb": ("venus/sun/orb", 86400.0 / 288),
    "sc_cassini/sun/2/orb": (None, 86400.0 / 4),
    "sc_cassini/venus/flyby2/orb": ("venus/sun/orb", 86400.0 / 288),
    "sc_cassini/sun/3/orb": (None, 86400.0 / 4),
    "sc_cassini/earth/flyby/orb": ("earth/sun/orb", 86400.0 / 288),
    "sc_cassini/sun/4/orb": (None, 86400.0 / 4),
    "sc_cassini/saturn/orb": ("saturn/sun/orb", 86400.0 / 12),
}
center_of_leg = {leg: leg_specs[leg][0] for leg in leg_specs}


def composed_leg(leg, t):
    c = center_of_leg[leg]
    p = pos_at(leg, t)
    if c:
        cc = pos_at(c, t)
        return (p[0] + cc[0], p[1] + cc[1], p[2] + cc[2])
    return p


def gap_ab(la, lb, t):
    A = composed_leg(la, t)
    B = composed_leg(lb, t)
    return sum((A[k] - B[k]) ** 2 for k in range(3))


leg_a, leg_b = "sc_cassini/venus/flyby1/orb", "sc_cassini/sun/2/orb"
pts = load_points(leg_a)["points"]
fa0, fa1 = pts[0][0], pts[-1][0]
print(f"flyby1 leg span: {time.strftime('%m-%d %H:%M', time.gmtime(fa0+946728000))} .. "
      f"{time.strftime('%m-%d %H:%M', time.gmtime(fa1+946728000))}")
tp, gmin = fa0, gap_ab(leg_a, leg_b, fa0)
t = fa0 + 60.0
while t <= fa1:
    d = gap_ab(leg_a, leg_b, t)
    if d < gmin:
        gmin, tp = d, t
    t += 60.0
print(f"argmin(60s) = {time.strftime('%m-%d %H:%M:%S', time.gmtime(tp+946728000))}  gap={math.sqrt(gmin):,.0f} km")
for t in [tp + k * 5.0 for k in range(-12, 13)]:
    d = gap_ab(leg_a, leg_b, t)
    print(f"  {time.strftime('%H:%M:%S', time.gmtime(t+946728000))}  {math.sqrt(d):>12,.0f} km")
# 也打印 14:07 附近的值
print("around 14:07:")
for t in [tp0 + k * 30 for k in range(-6, 7) for tp0 in [0]] if False else []:
    pass
t = 0
import calendar
t14 = calendar.timegm(time.strptime("1998-04-26 14:07:00", "%Y-%m-%d %H:%M:%S")) - 946728000
for k in range(-4, 5):
    tt = t14 + k * 30
    print(f"  {time.strftime('%H:%M:%S', time.gmtime(tt+946728000))}  {math.sqrt(gap_ab(leg_a, leg_b, tt)):>12,.0f} km")
