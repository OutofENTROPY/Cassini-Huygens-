# -*- coding: utf-8 -*-
"""probe_escape.py — 地心逃逸方向连续性检验：launch 段末尾 vs sun/1 段内部。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at, J2000_S

earth = "earth/sun/orb"
launch = "sc_cassini/earth/launch/orb"
sun1 = "sc_cassini/sun/1/orb"

def geo_dir(path, t):
    p = pos_at(path, t)
    e = pos_at(earth, t)
    d = (p[0] - e[0], p[1] - e[1], p[2] - e[2])
    r = math.sqrt(sum(v * v for v in d))
    return d, r

print("launch leg (geocentric dir, r):")
lpts = load_points(launch)["points"]
for k in range(-6, 1):
    t = lpts[-1][0] + k * 3600
    t = max(t, lpts[0][0])
    d, r = geo_dir(launch, t)
    print(f"  {time.strftime('%m-%d %H:%M', time.gmtime(t+J2000_S))}  dir=({d[0]/r:+.3f},{d[1]/r:+.3f},{d[2]/r:+.3f})  r={r:,.0f} km")

print("\nsun/1 leg (geocentric dir, r):")
spts = load_points(sun1)["points"]
print("  element epochs:", [time.strftime('%m-%d %H:%M', time.gmtime(p[0]+J2000_S)) for p in spts])
for k in range(0, 8):
    t = spts[0][0] + k * 21600
    d, r = geo_dir(sun1, t)
    print(f"  {time.strftime('%m-%d %H:%M', time.gmtime(t+J2000_S))}  dir=({d[0]/r:+.3f},{d[1]/r:+.3f},{d[2]/r:+.3f})  r={r:,.0f} km")

print("\nsun/1 self-consistency: position at each element's own epoch (should be smooth arc):")
for p in spts:
    q = pos_at(sun1, p[0])
    e = pos_at(earth, p[0])
    d = (q[0]-e[0], q[1]-e[1], q[2]-e[2])
    r = math.sqrt(sum(v*v for v in d))
    print(f"  {time.strftime('%m-%d %H:%M', time.gmtime(p[0]+J2000_S))}  helio=({q[0]:,.0f},{q[1]:,.0f},{q[2]:,.0f})  geo r={r:,.0f} km  a={p[1]:.5g} e={p[2]:.4f} M0={p[4]:.4g}")
