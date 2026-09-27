# -*- coding: utf-8 -*-
"""dbg_venus1_trail.py — dump 合并轨迹在金星1近拱点附近的点。"""
import base64, json, math, os, struct, sys, time, calendar
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at

J = 946728000
raw = open(os.path.join("..", "data", "cassini_data.js"), encoding="utf-8").read()
js = json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))
sc = js["spacecraft"]["cassini"]
n = sc["trailN"]
tt = struct.unpack(f"<{n}d", base64.b64decode(sc["trailT"]))
xyz = struct.unpack(f"<{n*3}f", base64.b64decode(sc["trail"]))

tp = calendar.timegm(time.strptime("1998-04-26 14:07", "%Y-%m-%d %H:%M")) - J
i0 = next(i for i in range(n) if tt[i] >= tp - 3600)
print("== merged trail around venus-1 periapsis / splice point ==")
for i in range(max(0, i0 - 6), min(n - 1, i0 + 30)):
    d = math.sqrt(sum((xyz[(i + 1) * 3 + k] - xyz[i * 3 + k]) ** 2 for k in range(3)))
    dt = tt[i + 1] - tt[i]
    vp = pos_at("venus/sun/orb", tt[i])
    dv = math.sqrt(sum((xyz[i * 3 + k] - vp[k]) ** 2 for k in range(3)))
    print(f"  {time.strftime('%m-%d %H:%M:%S', time.gmtime(tt[i]+J))}  dt={dt:7.0f}s  "
          f"step={d:>9,.0f} km  |trail-venus|={dv:>9,.0f} km")
