# -*- coding: utf-8 -*-
"""validate2.py — 用多个已知飞掠事件交叉验证烘焙数据。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at  # 复用

J2000_S = 946728000

CASSINI_LEGS = [
    ("sc_cassini/earth/launch/orb", "earth/sun/orb"),
    ("sc_cassini/sun/1/orb", None),
    ("sc_cassini/venus/flyby1/orb", "venus/sun/orb"),
    ("sc_cassini/sun/2/orb", None),
    ("sc_cassini/venus/flyby2/orb", "venus/sun/orb"),
    ("sc_cassini/sun/3/orb", None),
    ("sc_cassini/earth/flyby/orb", "earth/sun/orb"),
    ("sc_cassini/sun/4/orb", None),
    ("sc_cassini/saturn/orb", "saturn/sun/orb"),
]

_legs_cache = None
def legs():
    global _legs_cache
    if _legs_cache is None:
        _legs_cache = []
        for leg, center in CASSINI_LEGS:
            pts = load_points(leg)["points"]
            _legs_cache.append((leg, center, pts[0][0], pts[-1][0]))
    return _legs_cache

def cassini_pos(t):
    for leg, center, t0, t1 in legs():
        if t0 <= t <= t1:
            c = pos_at(center, t) if center else (0.0, 0.0, 0.0)
            p = pos_at(leg, t)
            return (p[0] + c[0], p[1] + c[1], p[2] + c[2])
    # 窗口外：取最近腿端点
    best = None
    for leg, center, t0, t1 in legs():
        d = min(abs(t - t0), abs(t - t1))
        if best is None or d < best[0]:
            best = (d, leg, center, t0 if abs(t - t0) < abs(t - t1) else t1)
    _, leg, center, tt = best
    c = pos_at(center, tt) if center else (0.0, 0.0, 0.0)
    p = pos_at(leg, tt)
    return (p[0] + c[0], p[1] + c[1], p[2] + c[2])

def et(y, m, d, hh=0, mm=0):
    import calendar
    return calendar.timegm((y, m, d, hh, mm, 0)) - J2000_S

def min_dist(target_path, t0, t1, step=60.0):
    best, bt = 1e18, None
    t = t0
    while t <= t1:
        c = cassini_pos(t)
        p = pos_at(target_path, t)
        d = math.sqrt(sum((c[i] - p[i]) ** 2 for i in range(3)))
        if d < best:
            best, bt = d, t
        t += step
    return best, bt

def show(label, path, t0, t1, step=60.0):
    best, bt = min_dist(path, t0, t1, step)
    iso = time.strftime("%Y-%m-%d %H:%M", time.gmtime(bt + J2000_S))
    print(f"{label:34s} min={best:>14,.0f} km @ {iso}")

if __name__ == "__main__":
    # 已知真实值（NASA 发布）：
    # Titan Ta 2004-10-26: 1,194 km；T-B? 2004-12-13: 1,200 km
    # Iapetus 2004-12-31: ~122,940 km（远掠）
    # Enceladus 2005-07-14: 175 km（E-4? 实际 173/175 km）
    # Enceladus E-21 2015-10-28: 49 km
    # Dione 2011-12-12? ~100 km 级；Rhea 2005-11-26: 500 km
    show("Titan Ta (真实 1,194 km)", "titan/saturn/orb", et(2004,10,26), et(2004,10,27), 30)
    show("Titan T-B (真实 ~1,200 km)", "titan/saturn/orb", et(2004,12,13), et(2004,12,14), 30)
    show("Iapetus (真实 ~122,900 km)", "iapetus/saturn/orb", et(2004,12,31), et(2005,1,1), 60)
    show("Enceladus E-4 (真实 ~175 km)", "enceladus/saturn/orb", et(2005,7,14), et(2005,7,15), 10)
    show("Enceladus E-21 (真实 49 km)", "enceladus/saturn/orb", et(2015,10,28), et(2015,10,29), 5)
    show("Rhea (真实 ~500 km)", "rhea/saturn/orb", et(2005,11,26), et(2005,11,27), 30)
    # SOI 附近土星距离剖面
    print("\nSOI 附近 |cassini-saturn| 剖面:")
    t = et(2004, 6, 30)
    while t <= et(2004, 7, 2):
        c = cassini_pos(t)
        s = pos_at("saturn/sun/orb", t)
        d = math.sqrt(sum((c[i]-s[i])**2 for i in range(3)))
        iso = time.strftime("%m-%d %H:%M", time.gmtime(t + J2000_S))
        print(f"  {iso}  {d:>12,.0f} km")
        t += 1800
