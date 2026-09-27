# -*- coding: utf-8 -*-
"""dump_fine.py — 爆点邻域的精确对照：pos_at / 地球 / 合并轨迹。"""
import base64, json, math, os, struct, time, calendar, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at, J2000_S

def iso(t): return time.strftime("%H:%M:%S", time.gmtime(t + J2000_S))

# 1) 原始网格（bake 用同款循环重现 launch 段）
leg = "sc_cassini/earth/launch/orb"
pts = load_points(leg)["points"]
t0, t1 = pts[0][0], pts[-1][0]
step = 86400.0 / 144
n = int(round((t1 - t0) / step)) + 1
earth = "earth/sun/orb"
print("launch leg grid (every 600s), last 8 grid points:")
for i in range(max(0, n - 8), n):
    t = t0 + i * step
    c = pos_at(earth, t)
    p = pos_at(leg, t)
    loc = (p[0] + c[0], p[1] + c[1], p[2] + c[2])
    print(f"  t={iso(t)} (+{(t-t0):.0f}s)  composed={[round(v) for v in loc]}  |loc|={math.sqrt(sum(v*v for v in p)):,.0f}")

# 2) 合并轨迹邻域
HERE = os.path.dirname(os.path.abspath(__file__))
raw = open(os.path.join(HERE, "..", "data", "cassini_data.js"), "r", encoding="utf-8").read()
js = json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))
sc = js["spacecraft"]["cassini"]
tt = struct.unpack(f"<{sc['trailN']}d", base64.b64decode(sc["trailT"]))
xyz = struct.unpack(f"<{sc['trailN']*3}f", base64.b64decode(sc["trail"]))
print("\nmerged trail 15:50-16:05 UTC:")
t_lo = calendar.timegm(time.strptime("1997-10-18 15:50:00", "%Y-%m-%d %H:%M:%S")) - J2000_S
t_hi = calendar.timegm(time.strptime("1997-10-18 16:05:00", "%Y-%m-%d %H:%M:%S")) - J2000_S
for i in range(sc["trailN"]):
    if t_lo <= tt[i] <= t_hi:
        print(f"  t={iso(tt[i])}  pos={[round(v) for v in (xyz[i*3], xyz[i*3+1], xyz[i*3+2])]}")

# 3) earth pos at both times
for s in ("1997-10-18 15:57:11", "1997-10-18 16:01:03"):
    t = calendar.timegm(time.strptime(s, "%Y-%m-%d %H:%M:%S")) - J2000_S
    e = pos_at(earth, t)
    print(f"\nearth @ {s}: {[round(v) for v in e]}")
    p = pos_at(leg, t)
    print(f"  local      : {[round(v) for v in p]}  |loc|={math.sqrt(sum(v*v for v in p)):,.0f}")
