# -*- coding: utf-8 -*-
"""diag_tangent.py — 各腿边界的原始切向夹角 A'(tb) vs B'(tb)、A 的前进速度、
长窗口分歧曲线，用于确定混合窗口宽度。"""
import math, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.chdir(os.path.dirname(os.path.abspath(__file__)))
from bake_data import load_points, pos_at, CASSINI_LEGS, LEG_CENTERS

J = 946728000


def iso(t):
    return time.strftime("%Y-%m-%d %H:%M", time.gmtime(t + J))


def composed(leg, t):
    c = LEG_CENTERS.get(leg)
    p = pos_at(leg, t)
    if c:
        cc = pos_at(c, t)
        return (p[0] + cc[0], p[1] + cc[1], p[2] + cc[2])
    return p


def tangent(leg, t, dt=3600):
    a = composed(leg, t - dt)
    b = composed(leg, t + dt)
    v = [b[k] - a[k] for k in range(3)]
    n = math.sqrt(sum(v[k] * v[k] for k in range(3)))
    return [v[k] / n for k in range(3)], n / (2 * dt)  # unit dir, speed km/s


legs = {}
for leg in CASSINI_LEGS:
    pts = load_points(leg)["points"]
    legs[leg] = (pts[0][0], pts[-1][0])

print("== boundary tangent mismatch & speeds ==")
for i in range(len(CASSINI_LEGS) - 1):
    la, lb = CASSINI_LEGS[i], CASSINI_LEGS[i + 1]
    tb = legs[lb][0]
    ta0 = legs[la][0]
    va, sa = tangent(la, tb - 3600)
    vb, sb = tangent(lb, tb + 3600)
    cosang = sum(va[k] * vb[k] for k in range(3))
    ang = math.degrees(math.acos(max(-1, min(1, cosang))))
    # A 的分歧速度 |dA/dt| 与 B 的 |dB/dt|（数值）
    vsp_a = sa
    vsp_b = sb
    print(f"  {la.split('/')[-2]:>6s}->{lb.split('/')[-2]:<6s} tb={iso(tb)}")
    print(f"     |A'|={vsp_a:6.2f} km/s  |B'|={vsp_b:6.2f} km/s  tangent mismatch={ang:6.1f} deg")

print("\n== long divergence curve |A-B| (sun/4->saturn/orb) ==")
la, lb = CASSINI_LEGS[7], CASSINI_LEGS[8]
tb = legs[lb][0]
for dd in (-150, -120, -90, -60, -45, -30, -20, -10, -5, 0):
    t = tb + dd * 86400
    if t < legs[la][0]:
        continue
    A = composed(la, t)
    B = composed(lb, t)
    d = math.sqrt(sum((A[k] - B[k]) ** 2 for k in range(3)))
    print(f"   {dd:+5d} d: |A-B| = {d:>14,.0f} km")

print("\n== long divergence curve (launch->sun/1) ==")
la, lb = CASSINI_LEGS[0], CASSINI_LEGS[1]
tb = legs[lb][0]
for hh in (-80, -72, -60, -48, -36, -24, -12, -6, 0):
    t = tb + hh * 3600
    if t < legs[la][0]:
        continue
    A = composed(la, t)
    B = composed(lb, t)
    d = math.sqrt(sum((A[k] - B[k]) ** 2 for k in range(3)))
    print(f"   {hh:+4d} h: |A-B| = {d:>14,.0f} km")

print("\n== current baked trail: TOP TURN events near launch boundary ==")
import base64, json, struct
raw = open(os.path.join("..", "data", "cassini_data.js"), "r", encoding="utf-8").read()
js = json.loads(raw[raw.index("=") + 1:].rstrip().rstrip(";"))
sc = js["spacecraft"]["cassini"]
n = sc["trailN"]
tt = struct.unpack(f"<{n}d", base64.b64decode(sc["trailT"]))
xyz = struct.unpack(f"<{n*3}f", base64.b64decode(sc["trail"]))
t_lo = legs[lb][0] - 5 * 86400
t_hi = legs[lb][0] + 2 * 86400
ev = []
for i in range(1, n - 1):
    if not (t_lo <= tt[i] <= t_hi):
        continue
    a = [xyz[i * 3 + k] - xyz[(i - 1) * 3 + k] for k in range(3)]
    b = [xyz[(i + 1) * 3 + k] - xyz[i * 3 + k] for k in range(3)]
    la_ = math.sqrt(sum(v * v for v in a))
    lb_ = math.sqrt(sum(v * v for v in b))
    if la_ > 1 and lb_ > 1:
        cosang = sum(a[k] * b[k] for k in range(3)) / (la_ * lb_)
        ev.append((math.degrees(math.acos(max(-1, min(1, cosang)))), la_ + lb_, i))
ev.sort(key=lambda e: -e[0])
for turn, span, i in ev[:8]:
    print(f"    {iso(tt[i])}  turn={turn:6.1f} deg  span={span:12,.0f} km")
