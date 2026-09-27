# -*- coding: utf-8 -*-
"""validate3.py — 用合成后的日心坐标验证飞掠距离。"""
import math, os, sys, time, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at, cassini_pos

J2000_S = 946728000

def et(y, m, d, hh=0, mm=0):
    import calendar
    return calendar.timegm((y, m, d, hh, mm, 0)) - J2000_S

def moon_helio(moon_path, center_path, t):
    p = pos_at(moon_path, t)
    c = pos_at(center_path, t)
    return (p[0] + c[0], p[1] + c[1], p[2] + c[2])

def min_dist(fn, t0, t1, step):
    best, bt = 1e18, None
    t = t0
    while t <= t1:
        d = fn(t)
        if d < best:
            best, bt = d, t
        t += step
    return best, bt

def show(label, fn, t0, t1, step):
    best, bt = min_dist(fn, t0, t1, step)
    iso = time.strftime("%Y-%m-%d %H:%M", time.gmtime(bt + J2000_S))
    print(f"{label:36s} min={best:>12,.0f} km @ {iso}")

if __name__ == "__main__":
    def dist_to_moon(moon, center):
        return lambda t: math.sqrt(sum(
            (cassini_pos(t)[i] - moon_helio(moon, center, t)[i]) ** 2 for i in range(3)))

    def dist_to_body(body):
        return lambda t: math.sqrt(sum(
            (cassini_pos(t)[i] - pos_at(body, t)[i]) ** 2 for i in range(3)))

    show("Titan Ta (真实 1,194 km)", dist_to_moon("titan/saturn/orb", "saturn/sun/orb"), et(2004,10,26), et(2004,10,27), 30)
    show("Titan T-B (真实 ~1,200 km)", dist_to_moon("titan/saturn/orb", "saturn/sun/orb"), et(2004,12,13), et(2004,12,14), 30)
    show("Iapetus (真实 ~122,900 km)", dist_to_moon("iapetus/saturn/orb", "saturn/sun/orb"), et(2004,12,31), et(2005,1,1), 60)
    show("Enceladus E-4 (真实 ~173 km)", dist_to_moon("enceladus/saturn/orb", "saturn/sun/orb"), et(2005,7,14), et(2005,7,15), 10)
    show("Enceladus E-21 (真实 49 km)", dist_to_moon("enceladus/saturn/orb", "saturn/sun/orb"), et(2015,10,28), et(2015,10,29), 5)
    show("Rhea (真实 ~500 km)", dist_to_moon("rhea/saturn/orb", "saturn/sun/orb"), et(2005,11,26), et(2005,11,27), 30)
    show("Dione (2005-06-15? ~645 km)", dist_to_moon("dione/saturn/orb", "saturn/sun/orb"), et(2005,6,14), et(2005,6,16), 30)
    show("土星 SOI (记载 ~80,230 km)", dist_to_body("saturn/sun/orb"), et(2004,7,1,1,0), et(2004,7,1,6,0), 60)
