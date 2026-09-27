# -*- coding: utf-8 -*-
"""dbg_launch_kink.py — 发射段窗口行的拐点定位"""
import base64
import json
import math
import struct
import time
import calendar

J = 946728000


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(t + J))


def et(y, m, d, hh=0, mm=0):
    return calendar.timegm((y, m, d, hh, mm, 0)) - J


txt = open("data/cassini_data.js", encoding="utf-8").read()
d = json.loads(txt[txt.index("=") + 1:].strip().rstrip(";"))
w = d["spacecraft"]["cassini"]["soi"]["earth"][0]
n = w["n"]
t = struct.unpack(f"<{n}d", base64.b64decode(w["t"]))
xyz = struct.unpack(f"<{n * 3}f", base64.b64decode(w["d"]))
print("n =", n, " t0 =", iso(t[0]), " tEnd =", iso(t[-1]))
dts = [t[i + 1] - t[i] for i in range(n - 1)]
print("dt: min=%.0f max=%.0f" % (min(dts), max(dts)))
big = [(i, dts[i]) for i in range(n - 1) if dts[i] > 2000]
for i, g in big:
    print("  gap %.0fs @ %s" % (g, iso(t[i])))


def show(t_from, t_to):
    print("--- rows %s .. %s ---" % (iso(t_from), iso(t_to)))
    hist = []
    for i in range(n):
        if not (t_from <= t[i] <= t_to):
            continue
        p = (xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2])
        r = math.sqrt(sum(v * v for v in p))
        line = "%s dt=%6.0fs r=%9.0f km" % (iso(t[i]), t[i] - t[i - 1] if i else 0, r)
        if len(hist) >= 2:
            prev, pp = hist[-1], hist[-2]
            a = tuple(p[k] - prev[k] for k in range(3))
            b = tuple(prev[k] - pp[k] for k in range(3))
            la = math.sqrt(sum(v * v for v in a))
            lb = math.sqrt(sum(v * v for v in b))
            turn = 0.0
            if la > 1 and lb > 1:
                dot = sum(a[k] * b[k] for k in range(3)) / (la * lb)
                turn = math.degrees(math.acos(max(-1, min(1, dot))))
            line += " chord=%7.0f turn=%6.1f" % (la, turn)
        print(line)
        hist.append(p)
        if len(hist) > 2:
            hist.pop(0)


show(et(1997, 10, 16, 10), et(1997, 10, 16, 15))
show(et(1997, 10, 17, 18), et(1997, 10, 17, 21))
