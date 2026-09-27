# -*- coding: utf-8 -*-
import math, os, sys, time, calendar
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at, cassini_pos, J2000_S

def tt(y, m, d, hh=0):
    return calendar.timegm((y, m, d, hh, 0, 0)) - J2000_S

for day in [(2000,12,28),(2000,12,30),(2001,1,2),(2001,2,15)]:
    t = tt(*day, 6)
    c = cassini_pos(t)
    j = pos_at("jupiter/sun/orb", t)
    lon_c = math.degrees(math.atan2(c[1], c[0]))
    lon_j = math.degrees(math.atan2(j[1], j[0]))
    d3 = math.sqrt(sum((c[i]-j[i])**2 for i in range(3)))
    print(f"{day}: cassini lon={lon_c:8.2f}° |r|={math.hypot(c[0],c[1]):,.0f} | jupiter lon={lon_j:8.2f}° |r|={math.hypot(j[0],j[1]):,.0f} | Δ={d3:,.0f} km")

# 日心经度连续性: 1999-08-19 (地球飞掠后) 到 2004
print("\ncassini heliocentric longitude over sun/4 leg:")
t = tt(1999, 8, 20)
while t <= tt(2004, 5, 30):
    c = cassini_pos(t)
    lon = math.degrees(math.atan2(c[1], c[0]))
    r = math.sqrt(c[0]**2 + c[1]**2)
    print(f"  {time.strftime('%Y-%m-%d', time.gmtime(t+J2000_S))}  lon={lon:8.2f}°  r={r/1.496e8:6.3f} AU")
    t += 86400 * 120
