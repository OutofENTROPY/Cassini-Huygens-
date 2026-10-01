# -*- coding: utf-8 -*-
"""check_sat_launch.py — 定位土星 SOI 接近段与发射逃逸段的轨迹异常。
对烘焙 trail 逐采样计算行星相对距离/速度/转角，找折角/回勾/不连续。"""
import base64
import bisect
import json
import math
import os
import struct
import time

HERE = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(HERE, "..", "data", "cassini_data.js"), encoding="utf-8") as f:
    txt = f.read()
DATA = json.loads(txt[txt.index("=", txt.index("CASSINI_DATA")) + 1:].rstrip().rstrip(";"))
J2000 = DATA["meta"]["j2000Ms"] / 1000.0

N = DATA["spacecraft"]["cassini"]["trailN"]
TT = struct.unpack(f"<{N}d", base64.b64decode(DATA["spacecraft"]["cassini"]["trailT"]))
PP = struct.unpack(f"<{N*3}f", base64.b64decode(DATA["spacecraft"]["cassini"]["trail"]))

SEGS = {}
for nm in ("saturn", "earth"):
    SEGS[nm] = [(s["t0"], s["dt"], struct.unpack(f"<{s['n']*3}f", base64.b64decode(s["d"])))
                for s in DATA["bodies"][nm]["segs"]]


def bpos(name, t):
    for (t0, dt, xyz) in SEGS[name]:
        n = len(xyz) // 3
        f = (t - t0) / dt
        if 0 <= f <= n - 1:
            i = min(n - 2, int(math.floor(f)))
            a = f - i
            return [xyz[i*3+k] + (xyz[(i+1)*3+k] - xyz[i*3+k]) * a for k in range(3)]
    return None


def tpos(t):
    lo, hi = 0, N - 1
    if t <= TT[0]:
        lo, hi = 0, 1
    elif t >= TT[-1]:
        lo, hi = N - 2, N - 1
    else:
        while hi - lo > 1:
            m = (lo + hi) >> 1
            if TT[m] <= t:
                lo = m
            else:
                hi = m
    a = (t - TT[lo]) / (TT[hi] - TT[lo] or 1)
    return [PP[lo*3+k] + (PP[hi*3+k] - PP[lo*3+k]) * a for k in range(3)]


def sub(a, b):
    return (a[0]-b[0], a[1]-b[1], a[2]-b[2])


def n3(v):
    return math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2])


def ang(a, b):
    d = sum(a[k]*b[k] for k in range(3))/(n3(a)*n3(b))
    return math.degrees(math.acos(max(-1.0, min(1.0, d))))


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(t + J2000))


def et(y, m, d, hh=0, mm=0):
    import calendar
    return calendar.timegm((y, m, d, hh, mm, 0)) - J2000


def scan(label, planet, t0, t1, step):
    print("=" * 110)
    print(f"[{label}] 相对 {planet}，{iso(t0)} .. {iso(t1)}，步长 {step/60:.0f} min")
    print(f"{'t':17s} {'|r_rel| km':>13s} {'|v_rel| km/s':>12s} {'turn/hr':>8s}")
    t = t0
    prev_v = None
    worst = (0.0, None)
    while t <= t1:
        r = sub(tpos(t), bpos(planet, t))
        dt = 600.0
        v = tuple((tpos(t+dt)[k] - tpos(t-dt)[k] - (bpos(planet, t+dt)[k] - bpos(planet, t-dt)[k])) / (2*dt) for k in range(3))
        turn = ""
        if prev_v is not None:
            tn = ang(v, prev_v) * 3600.0 / (2 * step)  # 每小时转角
            turn = f"{tn:8.2f}"
            if tn > worst[0]:
                worst = (tn, t)
        print(f"{iso(t):17s} {n3(r):13,.0f} {n3(v):12.3f} {turn}")
        prev_v = v
        t += step
    if worst[1]:
        print(f"  → 最大转角 {worst[0]:.1f}°/h @ {iso(worst[1])}")


# 土星 SOI 接近段：进入 SOI 前后 + 7 月捕获段
scan("Saturn SOI approach", "saturn", et(2004, 3, 8), et(2004, 3, 16), 3600.0)
scan("Saturn capture July", "saturn", et(2004, 6, 27), et(2004, 7, 20), 3600.0)
# 发射逃逸段
scan("Launch escape", "earth", et(1997, 10, 15, 6), et(1997, 10, 19), 900.0)
