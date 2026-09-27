# -*- coding: utf-8 -*-
"""dbg_launch_spike.py — 对比 merged 轨迹点与 pos_at 原始采样，定位尖峰引入环节"""
import base64
import json
import math
import os
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bake_data as B  # noqa

J = B.J2000_S


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(t + J))


txt = open(os.path.join(HERE, "..", "data", "cassini_data.js"), encoding="utf-8").read()
d = json.loads(txt[txt.index("=") + 1:].strip().rstrip(";"))
sc = d["spacecraft"]["cassini"]
trailT = B.__dict__  # noqa
tt = struct.unpack(f"<{sc['trailN']}d", base64.b64decode(sc["trailT"]))
xyz = struct.unpack(f"<{sc['trailN'] * 3}f", base64.b64decode(sc["trail"]))

import calendar  # noqa

t_lo = calendar.timegm((1997, 10, 16, 12, 0, 0)) - J
t_hi = calendar.timegm((1997, 10, 16, 13, 0, 0)) - J

print("=== merged 轨迹点 vs pos_at('sc_cassini/earth/launch/orb') ===")
for i in range(1, len(tt) - 1):
    if not (t_lo <= tt[i] <= t_hi):
        continue
    p = (xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2])
    a = (xyz[(i + 1) * 3] - p[0], xyz[(i + 1) * 3 + 1] - p[1], xyz[(i + 1) * 3 + 2] - p[2])
    b = (p[0] - xyz[(i - 1) * 3], p[1] - xyz[(i - 1) * 3 + 1], p[2] - xyz[(i - 1) * 3 + 2])
    la = math.sqrt(sum(v * v for v in a))
    lb = math.sqrt(sum(v * v for v in b))
    turn = 0.0
    if la > 1 and lb > 1:
        turn = math.degrees(math.acos(max(-1, min(1, sum(a[k] * b[k] for k in range(3)) / (la * lb)))))
    raw = B.pos_at("sc_cassini/earth/launch/orb", tt[i])
    dev = math.sqrt(sum((p[k] - raw[k]) ** 2 for k in range(3)))
    if turn > 1 or dev > 50:
        print("%s dt=%4.0f chord=%7.0f turn=%6.1f  |merged-raw|=%8.0f km" %
              (iso(tt[i]), tt[i] - tt[i - 1], la, turn, dev))
