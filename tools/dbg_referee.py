# -*- coding: utf-8 -*-
"""dbg_referee.py — 用地心距判断 flyby 外推 vs sun/4 外推谁更接近真实。
真实参考: 08-18 03:28 近拱 6,571 km 地心距; 24h 后地心距 ~ v_inf*24h ≈ 140 万 km。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at, LEG_CENTERS

J = 946728000


def iso(t):
    return time.strftime("%m-%d %H:%M", time.gmtime(t + J))


def composed(leg, t):
    c = LEG_CENTERS.get(leg)
    p = pos_at(leg, t)
    if c:
        cc = pos_at(c, t)
        return (p[0] + cc[0], p[1] + cc[1], p[2] + cc[2])
    return p


leg_a = "sc_cassini/earth/flyby/orb"
leg_b = "sc_cassini/sun/4/orb"

print("   t           |A-earth|     |B-earth|    |A-B|")
t_peri = time.strptime("1999-08-18 03:28:00", "%Y-%m-%d %H:%M:%S")
import calendar
t_peri = calendar.timegm(t_peri) - J
for hh in range(-30, 73, 6):
    t = t_peri + hh * 3600
    A = composed(leg_a, t)
    B = composed(leg_b, t)
    E = composed("earth/sun/orb", t)  # earth leg center is earth/sun/orb? no: earth 本体
    # earth 本体 = earth/sun/orb 的位置（bodies 里 earth 用它）
    Ea = math.sqrt(sum((A[k] - E[k]) ** 2 for k in range(3)))
    Eb = math.sqrt(sum((B[k] - E[k]) ** 2 for k in range(3)))
    ab = math.sqrt(sum((A[k] - B[k]) ** 2 for k in range(3)))
    print(f"  {iso(t)}  {Ea:>12,.0f}  {Eb:>12,.0f}  {ab:>12,.0f}")
