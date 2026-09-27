# -*- coding: utf-8 -*-
"""dbg_venus_peri.py — 金星飞掠腿与巡航腿在近拱点附近的分歧曲线。"""
import math, os, sys, time, calendar
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at, LEG_CENTERS

J = 946728000


def composed(leg, t):
    c = LEG_CENTERS.get(leg)
    p = pos_at(leg, t)
    if c:
        cc = pos_at(c, t)
        return (p[0] + cc[0], p[1] + cc[1], p[2] + cc[2])
    return p


for name, sun_leg, fb_leg, peri_utc, tb_utc in [
    ("venus1", "sc_cassini/sun/1/orb", "sc_cassini/venus/flyby1/orb", "1998-04-26 13:45", "1998-04-27 00:01"),
    ("venus2", "sc_cassini/sun/2/orb", "sc_cassini/venus/flyby2/orb", "1999-06-24 20:31", "1999-06-25 02:01"),
]:
    tp = calendar.timegm(time.strptime(peri_utc, "%Y-%m-%d %H:%M")) - J
    tb = calendar.timegm(time.strptime(tb_utc, "%Y-%m-%d %H:%M")) - J
    print(f"== {name}: peri={peri_utc}, tb={tb_utc} (tb-peri={(tb-tp)/3600:.1f} h)")
    for m in range(-30, 61, 5):
        t = tp + m * 60
        F = composed(fb_leg, t)
        S = composed(sun_leg, t)
        d = math.sqrt(sum((F[k] - S[k]) ** 2 for k in range(3)))
        print(f"   peri{m:+5d} min: |flyby-sun| = {d:>14,.0f} km")
    best, bt = 1e18, None
    t = tp - 3600.0
    while t <= tb + 3600:
        F = composed(fb_leg, t)
        S = composed(sun_leg, t)
        d = sum((F[k] - S[k]) ** 2 for k in range(3))
        if d < best:
            best, bt = d, t
        t += 30
    print(f"   argmin |flyby-sun| = {math.sqrt(best):,.0f} km @ "
          f"{time.strftime('%m-%d %H:%M:%S', time.gmtime(bt+J))} (peri{(bt-tp)/60:+.0f} min)")
