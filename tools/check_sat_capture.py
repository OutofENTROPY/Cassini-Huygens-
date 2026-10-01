# -*- coding: utf-8 -*-
"""check_sat_capture.py — 检查 2004-07 捕获段：土星相对二体能量应为椭圆（被 SOI 点火捕获）。"""
import base64
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


def iso(t):
    return time.strftime("%m-%d %H:%M", time.gmtime(t + J2000))


def et(y, m, d, hh=0, mm=0):
    import calendar
    return calendar.timegm((y, m, d, hh, mm, 0)) - J2000


MU_SAT = 3.7931187e7
print(f"{'t':13s} {'|r_rel| km':>13s} {'|v_rel|':>8s} {'eps km2/s2':>10s}  {'a Mkm(椭)':>9s} {'结论':s}")
for d in range(28, 48):
    for hh in (0, 12):
        t = et(2004, 6, d, hh) if d < 31 else et(2004, 7, d - 30, hh)
        if d == 31 and hh == 0:
            continue
        r = sub(tpos(t), bpos("saturn", t))
        dt = 600.0
        v = tuple((tpos(t+dt)[k] - tpos(t-dt)[k] - (bpos("saturn", t+dt)[k] - bpos("saturn", t-dt)[k])) / (2*dt) for k in range(3))
        rr, vv = n3(r), n3(v)
        eps = vv * vv / 2.0 - MU_SAT / rr
        if eps < 0:
            a = -MU_SAT / (2 * eps) / 1e6
            concl = f"椭圆 a={a:.2f}M apo={2*a - rr/1e6:.2f}M"
        else:
            vinf = math.sqrt(2 * eps)
            concl = f"双曲线 v∞={vinf:.2f} km/s ← 未捕获!"
        print(f"{iso(t):13s} {rr:13,.0f} {vv:8.3f} {eps:10.3f}  {concl}")
