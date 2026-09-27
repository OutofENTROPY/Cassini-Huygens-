# -*- coding: utf-8 -*-
"""dump_boundary.py — 转储地球逃逸边界附近的合并轨迹点与两段根数端点。"""
import base64, json, math, os, struct, time

HERE = os.path.dirname(os.path.abspath(__file__))
raw = open(os.path.join(HERE, "..", "data", "cassini_data.js"), "r", encoding="utf-8").read()
js = json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))
sc = js["spacecraft"]["cassini"]
tt = struct.unpack(f"<{sc['trailN']}d", base64.b64decode(sc["trailT"]))
xyz = struct.unpack(f"<{sc['trailN']*3}f", base64.b64decode(sc["trail"]))
J = 946728000
n = sc["trailN"]

# 找 10-18 15:00-17:00 之间的点（UTC）
import calendar
lo = calendar.timegm(time.strptime("1997-10-18 15:00:00", "%Y-%m-%d %H:%M:%S")) - J
hi = calendar.timegm(time.strptime("1997-10-18 17:30:00", "%Y-%m-%d %H:%M:%S")) - J
idx = [i for i in range(n) if lo <= tt[i] <= hi]
print("points in window:", len(idx))
prev = None
for i in idx:
    d = 0 if prev is None else math.sqrt(sum((xyz[i*3+k]-xyz[prev*3+k])**2 for k in range(3)))
    iso = time.strftime("%H:%M:%S", time.gmtime(tt[i]+J))
    print(f"  {iso}  dt+{tt[i]-tt[prev] if prev is not None else 0:7.0f}s  step={d:14,.0f} km  pos=({xyz[i*3]:,.0f},{xyz[i*3+1]:,.0f},{xyz[i*3+2]:,.0f})")
    prev = i
