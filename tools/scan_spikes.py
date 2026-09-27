# -*- coding: utf-8 -*-
"""scan_spikes.py — 在合并轨迹里找方向不连续（折角）最大的位置。"""
import base64, json, math, os, struct, time, sys

HERE = os.path.dirname(os.path.abspath(__file__))
raw = open(os.path.join(HERE, "..", "data", "cassini_data.js"), "r", encoding="utf-8").read()
js = json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))
sc = js["spacecraft"]["cassini"]
tt = struct.unpack(f"<{sc['trailN']}d", base64.b64decode(sc["trailT"]))
xyz = struct.unpack(f"<{sc['trailN']*3}f", base64.b64decode(sc["trail"]))
J = 946728000
n = sc["trailN"]

def ang(a, b):
    la = math.sqrt(sum(v * v for v in a)); lb = math.sqrt(sum(v * v for v in b))
    if la < 1e-9 or lb < 1e-9: return 0.0
    d = sum(a[i] * b[i] for i in range(3)) / (la * lb)
    return math.degrees(math.acos(max(-1, min(1, d))))

# 逐点转角（相邻两段方向差），窗口 ±1 点
spikes = []
for i in range(1, n - 1):
    d1 = [xyz[(i) * 3 + k] - xyz[(i - 1) * 3 + k] for k in range(3)]
    d2 = [xyz[(i + 1) * 3 + k] - xyz[(i) * 3 + k] for k in range(3)]
    a = ang(d1, d2)
    if a > 25:
        spikes.append((a, i, tt[i]))
spikes.sort(reverse=True)
print("top 14 turn-angle spikes:")
for a, i, t in spikes[:14]:
    iso = time.strftime("%Y-%m-%d %H:%M", time.gmtime(t + J))
    # 该点与前后点的间距
    d1 = math.sqrt(sum((xyz[i * 3 + k] - xyz[(i - 1) * 3 + k]) ** 2 for k in range(3)))
    d2 = math.sqrt(sum((xyz[(i + 1) * 3 + k] - xyz[i * 3 + k]) ** 2 for k in range(3)))
    print(f"  {a:6.1f}° @ {iso}  step={d1:,.0f}/{d2:,.0f} km")
if not spikes:
    print("  (no >25° spikes)")
