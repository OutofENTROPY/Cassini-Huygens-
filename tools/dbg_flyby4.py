# -*- coding: utf-8 -*-
"""dbg_flyby4.py — dump 合并轨迹在 flyby→sun/4 交界附近的点，复现拼接采样值。"""
import base64, json, math, os, struct, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at, LEG_CENTERS

J = 946728000


def iso(t):
    return time.strftime("%m-%d %H:%M:%S", time.gmtime(t + J))


def composed(leg, t):
    c = LEG_CENTERS.get(leg)
    p = pos_at(leg, t)
    if c:
        cc = pos_at(c, t)
        return (p[0] + cc[0], p[1] + cc[1], p[2] + cc[2])
    return p


raw = open(os.path.join("..", "data", "cassini_data.js"), "r", encoding="utf-8").read()
js = json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))
sc = js["spacecraft"]["cassini"]
n = sc["trailN"]
tt = struct.unpack(f"<{n}d", base64.b64decode(sc["trailT"]))
xyz = struct.unpack(f"<{n*3}f", base64.b64decode(sc["trail"]))

tb = calendar_timegm = time.strptime("1999-08-19 13:01:04", "%Y-%m-%d %H:%M:%S")
import calendar
tb = calendar.timegm(tb) - J

# 找到交界附近索引
i0 = next(i for i in range(n) if tt[i] >= tb - 2000)
print("== merged trail around flyby->sun/4 (tb=08-19 13:01:04) ==")
for i in range(max(0, i0 - 4), min(n, i0 + 22)):
    if i + 1 >= n:
        break
    d = math.sqrt(sum((xyz[(i + 1) * 3 + k] - xyz[i * 3 + k]) ** 2 for k in range(3)))
    dt = tt[i + 1] - tt[i]
    print(f"  {iso(tt[i])}  dt={dt:8.0f}s  step={d:>12,.0f} km  v={d/dt if dt else 0:6.2f} km/s")

print("\n== composed leg positions at same times ==")
for k in range(-6, 10):
    t = tb + k * 5400
    A = composed("sc_cassini/earth/flyby/orb", t)
    B = composed("sc_cassini/sun/4/orb", t)
    d = math.sqrt(sum((A[j] - B[j]) ** 2 for j in range(3)))
    print(f"  {iso(t)}  |A-B|={d:>14,.0f} km")
