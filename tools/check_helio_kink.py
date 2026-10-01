# -*- coding: utf-8 -*-
"""check_helio_kink.py — 扫描烘焙日心轨迹的转角/速度剖面，找拼接区折角。
覆盖 2004-05 .. 2004-08（sun/4→saturn/orb 30 天拼接窗）与 1997-10 发射段。"""
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
    return (PP[lo*3] + (PP[hi*3] - PP[lo*3]) * a,
            PP[lo*3+1] + (PP[hi*3+1] - PP[lo*3+1]) * a,
            PP[lo*3+2] + (PP[hi*3+2] - PP[lo*3+2]) * a)


def n3(v):
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def ang(a, b):
    d = sum(a[k] * b[k] for k in range(3)) / (n3(a) * n3(b))
    return math.degrees(math.acos(max(-1.0, min(1.0, d))))


def iso(t):
    return time.strftime("%m-%d %H:%M", time.gmtime(t + J2000))


def et(y, m, d, hh=0, mm=0):
    import calendar
    return calendar.timegm((y, m, d, hh, mm, 0)) - J2000


def scan_helio(label, t0, t1, step, thresh):
    print("=" * 100)
    print(f"[{label}] 日心轨迹 {iso(t0)} .. {iso(t1)}  step={step/60:.0f}min  报告阈值 {thresh}°/h")
    t = t0 + step
    worst = (0.0, None)
    spikes = []
    while t <= t1 - step:
        dt = 3600.0
        v0 = tuple((tpos(t + dt)[k] - tpos(t - dt)[k]) / (2 * dt) for k in range(3))
        v1 = tuple((tpos(t + step + dt)[k] - tpos(t + step - dt)[k]) / (2 * dt) for k in range(3))
        tn = ang(v0, v1) * 3600.0 / step
        sp = n3(v0)
        if tn > thresh:
            spikes.append((t, tn, sp))
        if tn > worst[0]:
            worst = (tn, t)
        t += step
    print(f"  max turn {worst[0]:.2f}°/h @ {iso(worst[1])}, spikes>{thresh}°/h: {len(spikes)}")
    for (t, tn, sp) in spikes[:40]:
        print(f"    {iso(t)}  {tn:7.2f}°/h   |v|={sp:.3f} km/s")


scan_helio("Saturn approach+splice", et(2004, 5, 1), et(2004, 8, 15), 900.0, 1.0)
scan_helio("Launch", et(1997, 10, 15, 9), et(1997, 10, 19), 900.0, 1.0)
