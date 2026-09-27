# -*- coding: utf-8 -*-
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bake_data import cassini_pos, pos_at, J2000_S

t0 = -69820368
c = cassini_pos(t0)
e = pos_at("earth/sun/orb", t0)
print("cassini at launch:", [round(v) for v in c], "|r|=%.0f" % math.sqrt(sum(v * v for v in c)))
print("earth  at launch:", [round(v) for v in e], "|r|=%.0f" % math.sqrt(sum(v * v for v in e)))
d = math.sqrt(sum((c[i] - e[i]) ** 2 for i in range(3)))
print("cassini-earth distance: %.0f km" % d)

# 与 data js 中 trail 首点对比
import json, base64, struct
raw = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "cassini_data.js"), "r", encoding="utf-8").read()
js = json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))
tt = struct.unpack("<d", base64.b64decode(js["spacecraft"]["cassini"]["trailT"])[:8])[0]
xyz = struct.unpack("<3f", base64.b64decode(js["spacecraft"]["cassini"]["trail"])[:12])
print("js trail first point: t=", tt, " xyz=", [round(v) for v in xyz])
