# -*- coding: utf-8 -*-
"""dbg_finale_end.py — 检查 2017-09-15 任务终段的窗口行形态"""
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
w = d["spacecraft"]["cassini"]["soi"]["saturn"][0]
n = w["n"]
t = struct.unpack(f"<{n}d", base64.b64decode(w["t"]))
xyz = struct.unpack(f"<{n * 3}f", base64.b64decode(w["d"]))

lo, hi = et(2017, 9, 15, 5, 30), et(2017, 9, 15, 9, 0)
hist = []
shown = 0
for i in range(n):
    if not (lo <= t[i] <= hi):
        continue
    p = (xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2])
    r = math.sqrt(sum(v * v for v in p))
    line = "%s dt=%5.0fs r=%9.0f km" % (iso(t[i]), t[i] - t[i - 1] if i else 0, r)
    if len(hist) >= 2:
        prev, pp = hist[-1], hist[-2]
        a = tuple(p[k] - prev[k] for k in range(3))
        b = tuple(prev[k] - pp[k] for k in range(3))
        la = math.sqrt(sum(v * v for v in a))
        lb = math.sqrt(sum(v * v for v in b))
        turn = 0.0
        if la > 1 and lb > 1:
            turn = math.degrees(math.acos(max(-1, min(1, sum(a[k] * b[k] for k in range(3)) / (la * lb)))))
        line += " chord=%7.0f turn=%6.1f" % (la, turn)
    if shown < 130:
        print(line)
        shown += 1
    hist.append(p)
    if len(hist) > 2:
        hist.pop(0)
