# -*- coding: utf-8 -*-
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, J2000_S

pts = load_points("sc_cassini/sun/4/orb")["points"]
prev = None
for p in pts:
    t = time.strftime("%Y-%m-%d", time.gmtime(p[0] + J2000_S))
    q = p[5:9]
    norm = math.sqrt(sum(v * v for v in q))
    ang = ""
    if prev is not None:
        dot = abs(sum(a * b for a, b in zip(q, prev)))
        dot = min(1.0, dot)
        ang = f"  Δang={math.degrees(2 * math.acos(dot)):7.2f}°"
    print(f"{t}  q=({q[0]:+.4f},{q[1]:+.4f},{q[2]:+.4f},{q[3]:+.4f}) |q|={norm:.4f}{ang}")
    prev = q
