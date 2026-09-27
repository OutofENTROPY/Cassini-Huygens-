# -*- coding: utf-8 -*-
"""dbg_rogue.py — 定位 2004-07-01 00:01:04 附近 rogue 点的来源段。"""
import base64, bisect, heapq, math, os, struct, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
import bake_data as B

raw = open("../data/cassini_data.js", "r", encoding="utf-8").read()
js = __import__("json").loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))
sc = js["spacecraft"]["cassini"]
J = 946728000
tt = struct.unpack(f"<{sc['trailN']}d", base64.b64decode(sc["trailT"]))
xyz = struct.unpack(f"<{sc['trailN']*3}f", base64.b64decode(sc["trail"]))
t_rogue = time.mktime((2004, 7, 1, 0, 1, 4, 0, 0, 0)) - time.timezone - J
i0 = next(i for i in range(sc["trailN"]) if abs(tt[i] - t_rogue) < 5)
for i in range(max(0, i0 - 2), min(sc["trailN"], i0 + 3)):
    print(f"  merged[{i}] {time.strftime('%m-%d %H:%M:%S', time.gmtime(tt[i]+J))}  xyz=({xyz[i*3]:,.0f},{xyz[i*3+1]:,.0f},{xyz[i*3+2]:,.0f})")

# 重建 segs（与 main() 相同流程）
import calendar
def et(y, m, d, hh=0, mm=0):
    return calendar.timegm((y, m, d, hh, mm, 0)) - B.J2000_S
day = 86400.0
CASSINI_LEGS = B.CASSINI_LEGS
legs = {}
for leg in CASSINI_LEGS:
    d = B.load_points(leg)
    legs[leg] = (d["points"][0][0], d["points"][-1][0])
leg_specs = {
    "sc_cassini/earth/launch/orb": ("earth/sun/orb", day / 288),
    "sc_cassini/sun/1/orb": (None, day / 4),
    "sc_cassini/venus/flyby1/orb": ("venus/sun/orb", day / 4),
    "sc_cassini/sun/2/orb": (None, day / 4),
    "sc_cassini/venus/flyby2/orb": ("venus/sun/orb", day / 4),
    "sc_cassini/sun/3/orb": (None, day / 4),
    "sc_cassini/earth/flyby/orb": ("earth/sun/orb", day / 288),
    "sc_cassini/sun/4/orb": (None, day / 4),
    "sc_cassini/saturn/orb": ("saturn/sun/orb", day / 12),
}
segs = []
for leg, (center, step) in leg_specs.items():
    t0, t1 = legs[leg]
    n = int(round((t1 - t0) / step)) + 1
    pts = []
    for k in range(n):
        tq = t0 + k * step
        c = B.pos_at(center, tq) if center else (0.0, 0.0, 0.0)
        p = B.pos_at(leg, tq)
        pts.append((p[0] + c[0], p[1] + c[1], p[2] + c[2]))
    segs.append((t0, step, pts, leg))
j0, j1 = et(2000, 12, 27), et(2001, 1, 2)
pts = B.bake_segment("sc_cassini/sun/4/orb", None, j0, j1, day / 48)
segs.append((j0, day / 48, pts, "jupiter-fine"))
s0, s1 = et(2004, 6, 29), et(2004, 7, 3)
pts = B.bake_segment("sc_cassini/saturn/orb", "saturn/sun/orb", s0, s1, day / 96)
segs.append((s0, day / 96, pts, "soi-fine"))

print("\nsegments covering 2004-07-01 00:01:04:")
for (t0, step, pts, name) in segs:
    t1 = t0 + step * (len(pts) - 1)
    if t0 - 7200 <= t_rogue <= t1 + 7200:
        k = int(round((t_rogue - t0) / step))
        k = max(0, min(len(pts) - 1, k))
        tk = t0 + k * step
        p = pts[k]
        print(f"  {name:14s} step={step:8.0f}  point[{k}] t={time.strftime('%m-%d %H:%M:%S', time.gmtime(tk+J))}  xyz=({p[0]:,.0f},{p[1]:,.0f},{p[2]:,.0f})")

# 跑一遍去重，看 00:01:04 由哪个段接受
print("\ndedup trace:")
acc_t = []
for (t0, step, pts, name) in sorted(segs, key=lambda s: s[1]):
    tol = 0.55 * step
    tt_ = t0
    kept = 0
    for (x, y, z) in pts:
        if abs(tt_ - t_rogue) < tol + 120:
            i = bisect.bisect_left(acc_t, tt_ - tol)
            dup = i < len(acc_t) and acc_t[i] <= tt_ + tol
            print(f"  {name:14s} t={time.strftime('%m-%d %H:%M:%S', time.gmtime(tt_+J))} step={step:.0f} dup={dup} xyz=({x:,.0f},{y:,.0f},{z:,.0f})")
        i = bisect.bisect_left(acc_t, tt_ - tol)
        if not (i < len(acc_t) and acc_t[i] <= tt_ + tol):
            acc_t = list(heapq.merge(acc_t, [tt_]))
            kept += 1
        tt_ += step
