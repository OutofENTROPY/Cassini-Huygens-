# -*- coding: utf-8 -*-
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at, cassini_pos, J2000_S

def iso(t):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(t + J2000_S))

print("jupiter heliocentric |r| around flyby:")
import calendar
for (y, m, d) in [(2000,12,28),(2000,12,30),(2001,1,2)]:
    tt = calendar.timegm((y, m, d, 0, 0, 0)) - J2000_S
    p = pos_at("jupiter/sun/orb", tt)
    print(f"  {y}-{m:02d}-{d:02d}: |r|={math.sqrt(sum(v*v for v in p)):,.0f} km  pos={tuple(round(v) for v in p)}")

print("\ncassini heliocentric |r| around flyby:")
import calendar
for (y, m, d) in [(2000,12,28),(2000,12,29),(2000,12,30),(2000,12,31),(2001,1,1)]:
    tt = calendar.timegm((y, m, d, 6, 0, 0)) - J2000_S
    c = cassini_pos(tt)
    print(f"  {y}-{m:02d}-{d:02d} 06:00: |r|={math.sqrt(sum(v*v for v in c)):,.0f} km")

print("\nmin |cassini-jupiter| fine scan 1999-12-01 .. 2001-06-01 (step 1h):")
best, bt = 1e18, None
t0 = calendar.timegm((1999,12,1,0,0,0)) - J2000_S
t1 = calendar.timegm((2001,6,1,0,0,0)) - J2000_S
t = t0
while t <= t1:
    c = cassini_pos(t)
    p = pos_at("jupiter/sun/orb", t)
    dd = math.sqrt(sum((c[i]-p[i])**2 for i in range(3)))
    if dd < best:
        best, bt = dd, t
    t += 3600
print(f"  min={best:,.0f} km @ {iso(bt)}")
