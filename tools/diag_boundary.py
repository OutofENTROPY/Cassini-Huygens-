# -*- coding: utf-8 -*-
"""diag_boundary.py — 腿边界伪影诊断：
1) 各腿时间范围与相邻边界原始分歧 |A-B| 曲线（含最近拼接点 tj/dmin）
2) 已烘焙合并轨迹上各边界 ±5 天内的最大台阶与最大转角
"""
import base64, json, math, os, struct, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from bake_data import (load_points, pos_at, _join_epoch, J2000_S,
                       CASSINI_LEGS, LEG_CENTERS)

J = J2000_S


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(t + J))


def composed(leg, t):
    c = LEG_CENTERS.get(leg)
    p = pos_at(leg, t)
    if c:
        cc = pos_at(c, t)
        return (p[0] + cc[0], p[1] + cc[1], p[2] + cc[2])
    return p


print("== leg time ranges ==")
legs = {}
for leg in CASSINI_LEGS:
    pts = load_points(leg)["points"]
    legs[leg] = (pts[0][0], pts[-1][0])
    print(f"  {leg:32s} {iso(pts[0][0])} .. {iso(pts[-1][0])}  ({len(pts)} kf)")

print("\n== raw boundary divergence |A(t)-B(t)| ==")
for i in range(len(CASSINI_LEGS) - 1):
    la, lb = CASSINI_LEGS[i], CASSINI_LEGS[i + 1]
    tb = legs[lb][0]
    ta_end = legs[la][1]
    print(f"\n-- {la} -> {lb}")
    print(f"   A ends {iso(ta_end)}, B starts {iso(tb)}  (A_end - tb = {(ta_end-tb)/3600:+.2f} h)")
    for dtk in (-72, -48, -24, -12, -6, -2, -1, 0):
        t = tb + dtk * 3600
        if t < legs[la][0] or t > ta_end:
            print(f"   {dtk:+4d} h: (outside A)")
            continue
        A = composed(la, t)
        B = composed(lb, t)
        d = math.sqrt(sum((A[k] - B[k]) ** 2 for k in range(3)))
        print(f"   {dtk:+4d} h: |A-B| = {d:>14,.0f} km")

print("\n== baked trail near boundaries: max step & max turn ==")
raw = open(os.path.join("..", "data", "cassini_data.js"), "r", encoding="utf-8").read()
js = json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))
sc = js["spacecraft"]["cassini"]
n = sc["trailN"]
tt = struct.unpack(f"<{n}d", base64.b64decode(sc["trailT"]))
xyz = struct.unpack(f"<{n*3}f", base64.b64decode(sc["trail"]))
print(f"trail: {n} pts, {iso(tt[0])} .. {iso(tt[-1])}")


def scan_window(t_lo, t_hi, label, top=6):
    i0 = 0
    while i0 < n and tt[i0] < t_lo:
        i0 += 1
    events = []
    i = max(1, i0)
    while i < n and tt[i] <= t_hi:
        dt = tt[i] - tt[i - 1]
        a = [xyz[i * 3 + k] - xyz[(i - 1) * 3 + k] for k in range(3)]
        b = [xyz[(i + 1) * 3 + k] - xyz[i * 3 + k] for k in range(3)] if i + 1 < n else None
        la_ = math.sqrt(sum(v * v for v in a))
        step = la_
        turn = None
        if b:
            lb_ = math.sqrt(sum(v * v for v in b))
            if la_ > 1 and lb_ > 1:
                cosang = sum(a[k] * b[k] for k in range(3)) / (la_ * lb_)
                turn = math.degrees(math.acos(max(-1, min(1, cosang))))
        events.append((step, turn, i, dt))
        i += 1
    events.sort(key=lambda e: -e[0])
    print(f"  [{label}] window {iso(t_lo)} .. {iso(t_hi)}")
    for step, turn, i, dt in events[:top]:
        extra = ""
        if turn is not None:
            extra = f"  turn={turn:6.1f}°"
        print(f"    {iso(tt[i])}  dt={dt:8.0f}s  step={step:>13,.0f} km{extra}")
    return events


for i in range(len(CASSINI_LEGS) - 1):
    la, lb = CASSINI_LEGS[i], CASSINI_LEGS[i + 1]
    tb = legs[lb][0]
    scan_window(tb - 5 * 86400, tb + 5 * 86400, f"{la.split('/')[-2]}/{la.split('/')[-1]}->{lb.split('/')[-2]}/{lb.split('/')[-1]}")

print("\n== Grand Finale real periapsis turns (must preserve) ==")
gf0 = time.mktime((2017, 4, 20, 0, 0, 0, 0, 0, 0)) - time.timezone - J
gf1 = time.mktime((2017, 9, 16, 0, 0, 0, 0, 0, 0)) - time.timezone - J
ev = scan_window(gf0, gf1, "Grand Finale", top=8)
